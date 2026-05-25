import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (...parts) => fs.readFileSync(path.join(process.cwd(), ...parts), 'utf8');

const schemaSource = read('db', 'schema.js');
const migrationSource = read('db', 'migrations', '010_call_queue_foundation.sql');
const concurrentMigrationSource = read('db', 'migrations', '011_call_queue_concurrent_indexes.sql');
const pipecatMigrationSource = read('pipecat', 'db', 'migrations', '023_call_queue_foundation.sql');
const pipecatConcurrentMigrationSource = read('pipecat', 'db', 'migrations', '024_call_queue_concurrent_indexes.sql');
const retentionSource = read('services', 'data-retention.js');
const serviceSource = read('services', 'call-queue.js');
const scheduleServiceSource = read('services', 'call-schedules.js');
const schedulerSource = read('services', 'scheduler.js');
const seniorServiceSource = read('services', 'seniors.js');
const pipecatRetentionSource = read('pipecat', 'services', 'data_retention.py');
const pipecatHardDeleteSource = read('pipecat', 'services', 'hard_delete.py');
const backfillScriptSource = read('scripts', 'backfill-call-schedules.js');
const deliveryKeyBackfillScriptSource = read('scripts', 'backfill-reminder-delivery-keys.js');
const idempotencyPreflightScriptSource = read('scripts', 'phase1-idempotency-preflight.js');
const rolloutConfigScriptSource = read('scripts', 'validate-call-rollout-config.js');
const nodeExportSource = read('routes', 'seniors.js');
const pipecatExportSource = read('pipecat', 'api', 'routes', 'export.py');

describe('queue architecture database foundation', () => {
  it('defines the additive queue tables in schema and migration', () => {
    for (const table of [
      'senior_call_schedules',
      'call_queue',
      'call_attempts',
      'post_call_jobs',
      'outbound_call_guards',
      'scheduler_shadow_comparisons',
    ]) {
      expect(schemaSource).toContain(`pgTable('${table}'`);
      expect(migrationSource).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(pipecatMigrationSource).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('keeps operational queue tables free of plaintext PHI fields', () => {
    const callQueueStart = schemaSource.indexOf("pgTable('call_queue'");
    const callAttemptsStart = schemaSource.indexOf("pgTable('call_attempts'");
    const postCallJobsStart = schemaSource.indexOf("pgTable('post_call_jobs'");
    const outboundGuardsStart = schemaSource.indexOf("pgTable('outbound_call_guards'");

    const callQueueSchema = schemaSource.slice(callQueueStart, callAttemptsStart);
    const callAttemptsSchema = schemaSource.slice(callAttemptsStart, postCallJobsStart);
    const outboundGuardSchema = schemaSource.slice(outboundGuardsStart);

    for (const source of [callQueueSchema, callAttemptsSchema, outboundGuardSchema]) {
      expect(source).not.toContain("name'");
      expect(source).not.toContain("phone'");
      expect(source).not.toContain("title'");
      expect(source).not.toContain("description'");
      expect(source).not.toContain("transcript'");
      expect(source).not.toContain("medical");
    }

    const scheduleStart = schemaSource.indexOf("pgTable('senior_call_schedules'");
    const scheduleSchema = schemaSource.slice(scheduleStart, callQueueStart);
    expect(scheduleSchema).toContain('contextNotesEncrypted');
    expect(scheduleSchema).toContain("text('context_notes_encrypted')");

    const jobSchema = schemaSource.slice(postCallJobsStart, outboundGuardsStart);
    expect(jobSchema).toContain('payloadEncrypted');
    expect(jobSchema).toContain("text('payload_encrypted')");
    expect(jobSchema).not.toContain('payloadJson');
  });

  it('adds idempotency indexes and keeps concurrent hot-table indexes outside transactional migrations', () => {
    for (const indexName of [
      'idx_call_queue_dedupe_key',
      'idx_call_queue_ready',
      'idx_call_attempts_queue_attempt',
      'idx_call_attempts_call_control_id',
      'idx_post_call_jobs_dedupe_key',
      'idx_outbound_call_guards_guard_key',
    ]) {
      expect(migrationSource).toContain(indexName);
    }

    for (const indexName of [
      'idx_conversations_call_sid_unique',
      'idx_reminder_deliveries_delivery_key_unique',
    ]) {
      expect(migrationSource).not.toContain(indexName);
      expect(pipecatMigrationSource).not.toContain(indexName);
      expect(concurrentMigrationSource).toContain(indexName);
      expect(pipecatConcurrentMigrationSource).toContain(indexName);
    }
    expect(migrationSource).not.toContain('CONCURRENTLY');
    expect(pipecatMigrationSource).not.toContain('CONCURRENTLY');
    expect(concurrentMigrationSource).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(pipecatConcurrentMigrationSource).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
    expect(pipecatConcurrentMigrationSource).toContain('idx_call_metrics_call_sid_unique');

    expect(serviceSource).toContain('FOR UPDATE SKIP LOCKED');
    expect(serviceSource).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(serviceSource).toContain('ON CONFLICT (guard_key) DO NOTHING');
    expect(serviceSource).toContain('ON CONFLICT (queue_id, attempt_number) DO NOTHING');
    expect(serviceSource).toContain('markOutboundCallGuardInitiated');
    expect(serviceSource).toContain('markOutboundCallGuardInitiatingIfCallable');
    expect(serviceSource).toContain('markCallAttemptSuppressed');
    expect(serviceSource).toContain('senior_inactive_or_missing');
    expect(serviceSource).toContain('releaseOutboundCallGuard');
    expect(serviceSource).toContain('materializeLegacyCallPlan');
    expect(serviceSource).toContain('buildQueueInputFromLegacyCallSpec');
    expect(serviceSource).toContain('recordSchedulerShadowComparison');
    expect(serviceSource).toContain("action: 'shadow_decision'");
    expect(serviceSource).toContain("resourceType: 'senior'");
    expect(serviceSource).toContain('dryRunDispatchQueuedCalls');
    expect(serviceSource).toContain('estimateAvailablePipecatCapacity');
    expect(serviceSource).toContain('buildLaneCapacityPlan');
    expect(serviceSource).toContain("serviceLabel = 'dispatcher'");
    expect(serviceSource).toContain('countReadyQueuedCallsByLane');
    expect(serviceSource).toContain('recoverExpiredQueueLeases');
    expect(serviceSource).toContain('expireOverdueQueuedCalls');
    expect(scheduleServiceSource).toContain('materializeDueNormalizedSchedules');
    expect(scheduleServiceSource).toContain('syncSeniorCallSchedulesFromPreferredCallTimes');
    expect(scheduleServiceSource).toContain('CALL_SCHEDULE_MATERIALIZER_LOCK_ID');
    expect(scheduleServiceSource).toContain('pg_try_advisory_xact_lock');
    expect(scheduleServiceSource).toContain('JOIN seniors s ON s.id = scs.senior_id');
    expect(scheduleServiceSource).toContain('np.pause_calls = true');
    expect(backfillScriptSource).toContain('syncSeniorCallSchedulesFromPreferredCallTimes');
    expect(backfillScriptSource).toContain('--dry-run');
    expect(deliveryKeyBackfillScriptSource).toContain('backfillReminderDeliveryKeys');
    expect(deliveryKeyBackfillScriptSource).toContain('delivery_key');
    expect(deliveryKeyBackfillScriptSource).toContain('reminder_delivery:');
    expect(deliveryKeyBackfillScriptSource).toContain('--dry-run');
    expect(deliveryKeyBackfillScriptSource).toContain('--write');
    expect(deliveryKeyBackfillScriptSource).toContain('collisionRows');
    expect(deliveryKeyBackfillScriptSource).toContain('scanReminderDeliveryKeyCollisions');
    expect(deliveryKeyBackfillScriptSource).toContain('blocked: true');
    expect(idempotencyPreflightScriptSource).toContain('runPhase1IdempotencyPreflight');
    expect(idempotencyPreflightScriptSource).toContain('conversations_call_sid_unique_ready');
    expect(idempotencyPreflightScriptSource).toContain('call_metrics_call_sid_unique_ready');
    expect(idempotencyPreflightScriptSource).toContain('reminder_deliveries_delivery_key_backfill_collisions');
  });

  it('keeps queue real dialing disabled unless a live queue mode opts in', () => {
    expect(serviceSource).toContain("LEGACY_ONLY: 'legacy_only'");
    expect(serviceSource).toContain('REAL_DIAL_MODES');
    expect(serviceSource).toContain('requestedRealDial && REAL_DIAL_MODES.has(mode)');
    expect(serviceSource).toContain('CALL_QUEUE_TEST_RUN_ID');
    expect(serviceSource).toContain('CALL_QUEUE_MATERIALIZER_LIMIT');
    expect(serviceSource).toContain('CALL_QUEUE_DISPATCHER_ENABLED');
    expect(serviceSource).toContain('CALL_QUEUE_RECONCILER_ENABLED');
    expect(serviceSource).toContain('CALL_QUEUE_SHADOW_CAPACITY');
    expect(serviceSource).toContain('CALL_QUEUE_COHORT_ALLOWLIST');
    expect(serviceSource).toContain('isSeniorInQueueCanaryCohort');
    expect(serviceSource).toContain('canaryBucketForSeniorId');
    expect(serviceSource).toContain('validateCallArchitectureConfig');
    expect(serviceSource).toContain('CALL_DISPATCH_MAX_BATCH_SIZE');
    expect(serviceSource).toContain('CALL_DISPATCH_LEASE_SECONDS');
    expect(serviceSource).toContain('CALL_DISPATCH_OVERBOOK_FACTOR');
    expect(serviceSource).toContain('CALL_LANE_POLICY_VERSION');
    expect(rolloutConfigScriptSource).toContain('validateCallArchitectureConfig');
  });

  it('wires shadow dispatch through dry-run leasing while legacy remains dial authority', () => {
    expect(schedulerSource).toContain('dryRunDispatchQueuedCalls');
    expect(schedulerSource).toContain('acquireOutboundCallGuard');
    expect(schedulerSource).toContain('Outbound call suppressed by durable guard');
    expect(schedulerSource).toContain('reconcileQueueLeases');
    expect(schedulerSource).toContain('callArchitecture.shadowDispatch && callArchitecture.dispatcherEnabled');
    expect(schedulerSource).toContain('respectLanePolicy: true');
    expect(schedulerSource).toContain('callArchitecture.shadowCapacitySlots');
    expect(schedulerSource).toContain('filterLegacyExecutableCallPlan');
    expect(schedulerSource).toContain('Canary queue owns part of call plan; legacy execution filtered');
    expect(schedulerSource).toContain('Queue shadow cycle failed; legacy scheduler remains dial authority');
    expect(schedulerSource).toContain('schedulerService.triggerOutboundCall(spec, baseUrl)');
  });

  it('extends retention to new senior-linked queue tables', () => {
    for (const key of [
      'RETENTION_CALL_QUEUE_DAYS',
      'RETENTION_CALL_ATTEMPTS_DAYS',
      'RETENTION_POST_CALL_JOBS_DAYS',
      'RETENTION_OUTBOUND_CALL_GUARDS_DAYS',
      'RETENTION_SCHEDULER_SHADOW_COMPARISONS_DAYS',
    ]) {
      expect(retentionSource).toContain(key);
    }

    for (const table of [
      'call_queue',
      'call_attempts',
      'post_call_jobs',
      'outbound_call_guards',
      'scheduler_shadow_comparisons',
    ]) {
      expect(retentionSource).toContain(`${table}:`);
      expect(pipecatRetentionSource).toContain(`"${table}"`);
    }
  });

  it('has a PHI sentinel guard for queue operational data', () => {
    expect(serviceSource).toContain('PHI_SENTINEL_[A-Z_]+');
    expect(serviceSource).toContain('assertOperationalPayloadHasNoPlainPhi');
    expect(serviceSource).toContain('PHI-bearing field');
    expect(serviceSource).toContain('SHADOW_SKIP_REASONS');
    expect(serviceSource).toContain('CAPACITY_DECISIONS');
  });

  it('keeps normalized schedule sync off senior read paths', () => {
    const listStart = seniorServiceSource.indexOf('async list()');
    const getByIdStart = seniorServiceSource.indexOf('async getById(id)');
    const deleteStart = seniorServiceSource.indexOf('async delete(id)');

    const listSource = seniorServiceSource.slice(listStart, getByIdStart);
    const getByIdSource = seniorServiceSource.slice(getByIdStart, deleteStart);

    expect(listSource).not.toContain('syncCallSchedulesIfEnabled');
    expect(getByIdSource).not.toContain('syncCallSchedulesIfEnabled');
  });

  it('covers new senior-linked queue tables during hard delete and legal hold checks', () => {
    for (const table of [
      'senior_call_schedules',
      'call_queue',
      'call_attempts',
      'post_call_jobs',
      'outbound_call_guards',
      'scheduler_shadow_comparisons',
    ]) {
      expect(seniorServiceSource).toContain(`FROM ${table}`);
      expect(seniorServiceSource).toContain(`DELETE FROM ${table}`);
      expect(pipecatHardDeleteSource).toContain(`FROM ${table}`);
      expect(pipecatHardDeleteSource).toContain(`DELETE FROM ${table}`);
    }

    for (const resourceType of [
      'senior_call_schedule',
      'call_queue',
      'call_attempt',
      'post_call_job',
      'outbound_call_guard',
      'scheduler_shadow_comparison',
    ]) {
      expect(seniorServiceSource).toContain(`lh.resource_type = '${resourceType}'`);
      expect(pipecatHardDeleteSource).toContain(`lh.resource_type = '${resourceType}'`);
    }
  });

  it('covers new senior-linked queue tables during authorized exports', () => {
    for (const identifier of [
      'seniorCallSchedules',
      'callQueue',
      'callAttempts',
      'post_call_jobs',
      'outboundCallGuards',
      'schedulerShadowComparisons',
    ]) {
      expect(nodeExportSource).toContain(identifier);
    }

    for (const table of [
      'senior_call_schedules',
      'call_queue',
      'call_attempts',
      'post_call_jobs',
      'outbound_call_guards',
      'scheduler_shadow_comparisons',
    ]) {
      expect(pipecatExportSource).toContain(table);
    }

    expect(nodeExportSource).toContain('decryptExportSeniorCallSchedule');
    expect(nodeExportSource).toContain('decryptExportPostCallJob');
    expect(pipecatExportSource).toContain('_decrypt_call_schedules');
    expect(pipecatExportSource).toContain('_decrypt_post_call_jobs');
  });
});
