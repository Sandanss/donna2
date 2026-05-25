/**
 * Behavioral simulation of Postgres FOR UPDATE SKIP LOCKED for the
 * 4/8/16-worker and 10k-row dispatcher load tests. NOT a substitute for a
 * real Postgres — it does not validate vendor-level lock semantics. It DOES
 * validate the application logic by serializing leasing through a mutex so
 * no two simulated workers can claim the same queue row.
 *
 * Mimics the surface the dispatcher consumes from `db.execute(sql\`...\`)`:
 *   - INSERT INTO call_queue ... ON CONFLICT (dedupe_key) DO NOTHING ... RETURNING *
 *   - lease query (UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT N))
 *   - outbound_call_guards INSERT ... ON CONFLICT (guard_key) DO NOTHING
 *   - markOutboundCallGuardInitiatingIfCallable transactional flip
 *
 * Sufficient for the dispatcher's race-correctness assertions; not the only
 * truth. The real-DB harness in postgres.js is the gold standard when
 * `TEST_DATABASE_URL` is set.
 */

let queueAutoId = 0;
let attemptAutoId = 0;
let guardAutoId = 0;

function nowOrParse(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string') return new Date(value);
  return new Date();
}

export function createFakeDb({
  seniors = new Map(),
  capacityHint = 1000,
} = {}) {
  const callQueue = [];           // { id, seniorId, status, leaseOwner, leaseExpiresAt, ... }
  const callAttempts = [];        // { id, queueId, attemptNumber, status, ... }
  const outboundGuards = new Map(); // guard_key -> row
  const seniorRows = new Map(seniors);

  // A single mutex serializes lease/guard transactions to emulate SKIP LOCKED.
  let lockChain = Promise.resolve();
  function transact(fn) {
    const next = lockChain.then(() => fn(), () => fn());
    lockChain = next.catch(() => undefined);
    return next;
  }

  function seedSenior(seniorId, { is_active = true, deleted_at = null } = {}) {
    seniorRows.set(seniorId, { is_active, deleted_at });
  }

  function deactivateSenior(seniorId) {
    const row = seniorRows.get(seniorId);
    if (row) {
      row.is_active = false;
      row.deleted_at = new Date();
    }
  }

  function insertQueueRow(row) {
    return transact(async () => {
      if (callQueue.find(r => r.dedupe_key === row.dedupeKey)) return null;
      const inserted = {
        id: `q${++queueAutoId}`,
        senior_id: row.seniorId,
        call_type: row.callType,
        priority_lane: row.priorityLane,
        priority_score: row.priorityScore || 0,
        target_at: nowOrParse(row.targetAt),
        earliest_at: nowOrParse(row.earliestAt),
        latest_at: nowOrParse(row.latestAt),
        status: row.status || 'queued',
        dedupe_key: row.dedupeKey,
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 0,
        last_attempt_id: null,
      };
      callQueue.push(inserted);
      return inserted;
    });
  }

  async function leaseRows({ owner, limit, now, leaseSeconds, priorityLane = null, canaryPercent = 100, canarySeniorIds = [] }) {
    return transact(async () => {
      const currentTime = nowOrParse(now);
      const candidates = callQueue.filter(row =>
        row.status === 'queued' &&
        (!priorityLane || row.priority_lane === priorityLane) &&
        row.earliest_at <= currentTime &&
        row.latest_at > currentTime
      );
      // Cohort filter — match canaryCohortFilterSql semantics
      const inCohort = (sid) => {
        if (canarySeniorIds.includes(sid)) return true;
        if (canaryPercent >= 100) return true;
        if (canaryPercent <= 0) return false;
        // Use the same bucket math as JS canaryBucketForSeniorId-equivalent
        return Math.abs(hashString(sid)) % 100 < canaryPercent;
      };
      const eligible = candidates.filter(c => inCohort(c.senior_id));
      const claimed = eligible.slice(0, limit).map(row => {
        row.status = 'leased';
        row.lease_owner = owner;
        row.lease_expires_at = new Date(currentTime.getTime() + leaseSeconds * 1000);
        return { ...row };
      });
      return claimed;
    });
  }

  async function acquireGuard(input) {
    return transact(async () => {
      if (outboundGuards.has(input.guardKey)) {
        return { acquired: false, guard: outboundGuards.get(input.guardKey) };
      }
      const guard = {
        id: `g${++guardAutoId}`,
        senior_id: input.seniorId,
        guard_key: input.guardKey,
        call_type: input.callType,
        architecture: input.architecture,
        queue_id: input.queueId || null,
        target_at: nowOrParse(input.targetAt),
        expires_at: nowOrParse(input.expiresAt),
        status: 'active',
        call_control_id: null,
      };
      outboundGuards.set(input.guardKey, guard);
      return { acquired: true, guard };
    });
  }

  async function markGuardInitiatingIfCallable({ guardId, guardKey }) {
    return transact(async () => {
      const guard = guardKey
        ? outboundGuards.get(guardKey)
        : [...outboundGuards.values()].find(g => g.id === guardId);
      if (!guard) {
        return { initiated: false, guard: null, suppressReason: 'guard_unavailable' };
      }
      const senior = seniorRows.get(guard.senior_id);
      if (!senior || senior.is_active === false || senior.deleted_at) {
        guard.status = 'cancelled';
        return { initiated: false, guard, suppressReason: 'senior_inactive_or_missing' };
      }
      guard.status = 'initiating';
      return { initiated: true, guard, suppressReason: null };
    });
  }

  async function releaseGuard({ guardId, guardKey }) {
    return transact(async () => {
      const key = guardKey ?? [...outboundGuards.entries()].find(([, g]) => g.id === guardId)?.[0];
      if (!key) return null;
      const guard = outboundGuards.get(key);
      if (!guard || guard.call_control_id) return null;
      outboundGuards.delete(key);
      return guard;
    });
  }

  async function recordCallAttempt(input) {
    return transact(async () => {
      const existing = callAttempts.find(a =>
        a.queue_id === input.queueId && a.attempt_number === input.attemptNumber
      );
      if (existing) return { inserted: false, row: existing };
      const row = {
        id: `a${++attemptAutoId}`,
        queue_id: input.queueId,
        senior_id: input.seniorId,
        attempt_number: input.attemptNumber,
        status: input.status || 'initiating',
        call_control_id: input.callControlId || null,
        reservation_id: input.reservationId || null,
        architecture: input.architecture,
        cohort: input.cohort || null,
        test_run_id: input.testRunId || null,
      };
      callAttempts.push(row);
      return { inserted: true, row };
    });
  }

  /**
   * Reconciler-side helpers.
   *
   * `recoverExpiredLeases` flips rows whose lease has elapsed back to `queued`,
   * mirroring the production `recoverExpiredQueueLeases` SQL.
   * `expireOverdueQueuedCalls` retires rows whose dispatch window closed,
   * mirroring the production `expireOverdueQueuedCalls` SQL.
   * Both serialize through the same mutex used by leaseRows so a single
   * reconciler cycle is internally race-safe under fake-db.
   */
  async function recoverExpiredLeases({ now = new Date() } = {}) {
    return transact(async () => {
      const currentTime = nowOrParse(now);
      const recovered = [];
      for (const row of callQueue) {
        if (row.status === 'leased'
          && row.lease_expires_at instanceof Date
          && row.lease_expires_at <= currentTime
          && row.latest_at > currentTime) {
          row.status = 'queued';
          row.lease_owner = null;
          row.lease_expires_at = null;
          recovered.push({ ...row });
        }
      }
      return recovered;
    });
  }

  async function expireOverdueQueuedCalls({ now = new Date() } = {}) {
    return transact(async () => {
      const currentTime = nowOrParse(now);
      const expired = [];
      for (const row of callQueue) {
        if ((row.status === 'queued' || row.status === 'leased')
          && row.latest_at <= currentTime) {
          row.status = 'expired';
          row.lease_owner = null;
          row.lease_expires_at = null;
          row.cancel_reason = 'dispatch_window_expired';
          expired.push({ ...row });
        }
      }
      return expired;
    });
  }

  /**
   * Materializer simulation. Each call attempts to enqueue a derived row for
   * one due schedule; the mutex serializes the dedupe-key check so two
   * concurrent materializer cycles cannot produce two rows for the same
   * `(scheduleId, localDate)` pair. This is the in-process analog of the
   * production advisory lock + ON CONFLICT (dedupe_key) DO NOTHING pair.
   */
  async function materializeFromSchedule(schedule) {
    return transact(async () => {
      const dedupeKey = schedule.dedupeKey;
      if (callQueue.find(r => r.dedupe_key === dedupeKey)) {
        return { inserted: false, row: null };
      }
      const inserted = {
        id: `q${++queueAutoId}`,
        senior_id: schedule.seniorId,
        schedule_id: schedule.scheduleId || null,
        call_type: schedule.callType || 'schedule',
        priority_lane: schedule.priorityLane || 'scheduled_checkin',
        priority_score: schedule.priorityScore || 0,
        target_at: nowOrParse(schedule.targetAt),
        earliest_at: nowOrParse(schedule.earliestAt || schedule.targetAt),
        latest_at: nowOrParse(schedule.latestAt || schedule.targetAt),
        status: 'queued',
        dedupe_key: dedupeKey,
        lease_owner: null,
        lease_expires_at: null,
        attempt_count: 0,
        last_attempt_id: null,
      };
      callQueue.push(inserted);
      return { inserted: true, row: inserted };
    });
  }

  /**
   * Drive a single materializer cycle over a list of due schedules. The mutex
   * inside `materializeFromSchedule` ensures that even if many cycles run in
   * parallel (`Promise.all`), each dedupe_key is inserted at most once.
   */
  async function materializeDueSchedules(schedules) {
    let inserted = 0;
    let existing = 0;
    for (const schedule of schedules) {
      const result = await materializeFromSchedule(schedule);
      if (result.inserted) inserted++;
      else existing++;
    }
    return { scanned: schedules.length, inserted, existing };
  }

  /**
   * Count rows by status — convenience helper for assertions that need to
   * reason about the queue without poking at internal arrays.
   */
  function countByStatus() {
    const counts = { queued: 0, leased: 0, initiating: 0, started: 0, cancelled: 0, expired: 0 };
    for (const row of callQueue) {
      counts[row.status] = (counts[row.status] || 0) + 1;
    }
    return counts;
  }

  return {
    insertQueueRow,
    leaseRows,
    acquireGuard,
    markGuardInitiatingIfCallable,
    releaseGuard,
    recordCallAttempt,
    recoverExpiredLeases,
    expireOverdueQueuedCalls,
    materializeFromSchedule,
    materializeDueSchedules,
    countByStatus,
    seedSenior,
    deactivateSenior,
    state: { callQueue, callAttempts, outboundGuards, seniorRows },
    capacityHint,
  };
}

function hashString(value) {
  let hash = 5381;
  const str = String(value);
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
