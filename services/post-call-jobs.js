import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { encryptJson } from '../lib/encryption.js';
import { writeAudit } from './audit.js';

export const POST_CALL_JOB_TYPES = Object.freeze({
  METRICS_FINALIZE: 'metrics_finalize',
  REMINDER_RECOVERY: 'reminder_recovery',
  ANALYSIS: 'analysis',
  MEMORY_EXTRACTION: 'memory_extraction',
  DAILY_CONTEXT: 'daily_context',
  CAREGIVER_NOTIFICATIONS: 'caregiver_notifications',
  INTEREST_DISCOVERY: 'interest_discovery',
  SNAPSHOT_REBUILD: 'snapshot_rebuild',
});

export const POST_CALL_JOB_STATUSES = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD_LETTER: 'dead_letter',
});

export const POST_CALL_JOB_GRAPH = Object.freeze({
  [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: [],
  [POST_CALL_JOB_TYPES.REMINDER_RECOVERY]: [],
  [POST_CALL_JOB_TYPES.ANALYSIS]: [],
  [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: [],
  [POST_CALL_JOB_TYPES.DAILY_CONTEXT]: [],
  [POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS]: [POST_CALL_JOB_TYPES.ANALYSIS],
  [POST_CALL_JOB_TYPES.INTEREST_DISCOVERY]: [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION],
  [POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD]: [
    POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
    POST_CALL_JOB_TYPES.DAILY_CONTEXT,
  ],
});

export const POST_CALL_RETRY_POLICIES = Object.freeze({
  default: Object.freeze({
    maxAttempts: 5,
    backoffSeconds: Object.freeze([30, 120, 480, 1920]),
  }),
  [POST_CALL_JOB_TYPES.ANALYSIS]: Object.freeze({
    maxAttempts: 5,
    backoffSeconds: Object.freeze([60, 300, 1800, 7200]),
  }),
  [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: Object.freeze({
    maxAttempts: 5,
    backoffSeconds: Object.freeze([60, 300, 1800, 7200]),
  }),
  [POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS]: Object.freeze({
    maxAttempts: 3,
    backoffSeconds: Object.freeze([15, 60]),
  }),
  [POST_CALL_JOB_TYPES.REMINDER_RECOVERY]: Object.freeze({
    maxAttempts: 3,
    backoffSeconds: Object.freeze([10, 30]),
  }),
  [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: Object.freeze({
    maxAttempts: 4,
    backoffSeconds: Object.freeze([60, 300, 1800]),
  }),
});

export const POST_CALL_JOB_PRIORITIES = Object.freeze({
  [POST_CALL_JOB_TYPES.REMINDER_RECOVERY]: 100,
  [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: 90,
  [POST_CALL_JOB_TYPES.ANALYSIS]: 60,
  [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: 60,
  [POST_CALL_JOB_TYPES.DAILY_CONTEXT]: 50,
  [POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS]: 40,
  [POST_CALL_JOB_TYPES.INTEREST_DISCOVERY]: 30,
  [POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD]: 20,
});

export const POST_CALL_PROVIDER_KEYS = Object.freeze({
  DB: 'db',
  ANTHROPIC_HAIKU: 'anthropicHaiku',
  GEMINI_FLASH: 'geminiFlash',
  OPENAI_EMBEDDINGS: 'openAiEmbeddings',
  RESEND: 'resend',
});

export const POST_CALL_PROVIDER_BY_JOB_TYPE = Object.freeze({
  [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: POST_CALL_PROVIDER_KEYS.DB,
  [POST_CALL_JOB_TYPES.REMINDER_RECOVERY]: POST_CALL_PROVIDER_KEYS.DB,
  [POST_CALL_JOB_TYPES.ANALYSIS]: POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
  [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS,
  [POST_CALL_JOB_TYPES.DAILY_CONTEXT]: POST_CALL_PROVIDER_KEYS.DB,
  [POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS]: POST_CALL_PROVIDER_KEYS.RESEND,
  [POST_CALL_JOB_TYPES.INTEREST_DISCOVERY]: POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS,
  [POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD]: POST_CALL_PROVIDER_KEYS.DB,
});

const DEFAULT_PROVIDER_LIMITS = Object.freeze({
  [POST_CALL_PROVIDER_KEYS.DB]: 200,
  [POST_CALL_PROVIDER_KEYS.ANTHROPIC_HAIKU]: 1,
  [POST_CALL_PROVIDER_KEYS.GEMINI_FLASH]: 1,
  [POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS]: 1,
  [POST_CALL_PROVIDER_KEYS.RESEND]: 1,
});

const DEFAULT_JOB_ORDER = Object.freeze([
  POST_CALL_JOB_TYPES.METRICS_FINALIZE,
  POST_CALL_JOB_TYPES.REMINDER_RECOVERY,
  POST_CALL_JOB_TYPES.ANALYSIS,
  POST_CALL_JOB_TYPES.MEMORY_EXTRACTION,
  POST_CALL_JOB_TYPES.DAILY_CONTEXT,
  POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS,
  POST_CALL_JOB_TYPES.INTEREST_DISCOVERY,
  POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD,
]);

const DISALLOWED_PAYLOAD_KEYS = [
  'name',
  'phone',
  'title',
  'description',
  'medical',
  'family',
  'additionalinfo',
  'transcript',
  'summary',
  'content',
  'contextnotes',
  'caregivernote',
  'userresponse',
  'prompt',
];

const ALLOWED_ENCRYPTED_KEYS = new Set([
  'payloadencrypted',
  'contextnotesencrypted',
  'transcriptencrypted',
  'summaryencrypted',
]);

const PHI_SENTINEL_PATTERN = /Donna Phi Sentinel|PHI_SENTINEL_[A-Z_]+/;

function rowsFrom(result) {
  return result?.rows || [];
}

function firstRow(result) {
  return rowsFrom(result)[0] || null;
}

function countFrom(result, fieldName = 'count') {
  const row = firstRow(result);
  return Number(row?.[fieldName] ?? row?.count ?? 0) || 0;
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[_-]/g, '');
}

function safePositiveInteger(value, defaultValue, maxValue = 10000) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, maxValue);
}

function requireString(value, fieldName) {
  const stringValue = String(value || '').trim();
  if (!stringValue) throw new Error(`${fieldName} is required`);
  return stringValue;
}

function boundedIsoDate(value, fieldName) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${fieldName} must be a valid date`);
  return date;
}

function uuidArraySql(ids) {
  const cleanIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
  if (cleanIds.length === 0) return sql`'{}'::uuid[]`;
  return sql`ARRAY[${sql.join(cleanIds.map(id => sql`${id}`), sql`, `)}]::uuid[]`;
}

function jobTypeFilterSql(jobTypes) {
  const cleanTypes = [...new Set((jobTypes || []).map(type => String(type || '').trim()).filter(Boolean))];
  if (cleanTypes.length === 0) return sql`TRUE`;
  return sql`job.job_type IN (${sql.join(cleanTypes.map(type => sql`${type}`), sql`, `)})`;
}

function addSeconds(date, seconds) {
  return new Date(date.getTime() + seconds * 1000);
}

function sanitizeCode(value, fallback = 'unknown_error') {
  return String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]/g, '_')
    .slice(0, 120);
}

function pendingPostCallArtifact(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[Math.max(0, index)];
}

function normalizeProviderKey(provider) {
  const raw = String(provider || '').trim();
  return Object.values(POST_CALL_PROVIDER_KEYS).includes(raw)
    ? raw
    : POST_CALL_PROVIDER_KEYS.DB;
}

function providerLimitValue(value, defaultValue) {
  if (value === Infinity) return Infinity;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function rpmToSlots(value, defaultValue = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, Math.floor(parsed / 60));
}

function tpmToSlots(value, tokensPerJob = 12000, defaultValue = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.max(1, Math.floor(parsed / Math.max(1, tokensPerJob)));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeJobRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversationId ?? row.conversation_id ?? null,
    callSid: row.callSid ?? row.call_sid ?? null,
    seniorId: row.seniorId ?? row.senior_id ?? null,
    jobType: row.jobType ?? row.job_type,
    status: row.status,
    priority: Number(row.priority ?? 0),
    dedupeKey: row.dedupeKey ?? row.dedupe_key,
    dependsOn: row.dependsOn ?? row.depends_on ?? [],
    attemptCount: Number(row.attemptCount ?? row.attempt_count ?? 0),
    maxAttempts: Number(row.maxAttempts ?? row.max_attempts ?? 0),
    leaseOwner: row.leaseOwner ?? row.lease_owner ?? null,
    leaseExpiresAt: row.leaseExpiresAt ?? row.lease_expires_at ?? null,
    runAfter: row.runAfter ?? row.run_after ?? null,
    lastErrorCode: row.lastErrorCode ?? row.last_error_code ?? null,
    lastErrorAt: row.lastErrorAt ?? row.last_error_at ?? null,
    startedAt: row.startedAt ?? row.started_at ?? null,
    completedAt: row.completedAt ?? row.completed_at ?? null,
    deadLetteredAt: row.deadLetteredAt ?? row.dead_lettered_at ?? null,
    deadLetterReason: row.deadLetterReason ?? row.dead_letter_reason ?? null,
    createdAt: row.createdAt ?? row.created_at ?? null,
    updatedAt: row.updatedAt ?? row.updated_at ?? null,
  };
}

function policyForJobType(jobType) {
  return POST_CALL_RETRY_POLICIES[jobType] || POST_CALL_RETRY_POLICIES.default;
}

export function assertPostCallPayloadHasNoPlainPhi(payload, path = 'payload') {
  if (payload == null) return;

  if (typeof payload === 'string') {
    if (PHI_SENTINEL_PATTERN.test(payload)) {
      throw new Error(`${path} may contain raw PHI sentinel text; store PHI only in encrypted source columns`);
    }
    return;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => assertPostCallPayloadHasNoPlainPhi(item, `${path}[${index}]`));
    return;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      const normalized = normalizeKey(key);
      if (!ALLOWED_ENCRYPTED_KEYS.has(normalized) &&
          DISALLOWED_PAYLOAD_KEYS.some(disallowed => normalized.includes(disallowed))) {
        throw new Error(`${path}.${key} looks PHI-bearing; store source IDs or encrypted values only`);
      }
      assertPostCallPayloadHasNoPlainPhi(value, `${path}.${key}`);
    }
  }
}

export function encryptPostCallJobPayload(payload) {
  if (payload == null) return null;
  assertPostCallPayloadHasNoPlainPhi(payload);
  return encryptJson(payload);
}

export function buildPostCallDedupeKey({ callSid, jobType }) {
  return `post-call:${requireString(callSid, 'callSid')}:${requireString(jobType, 'jobType')}`;
}

export function retryPolicyForPostCallJob(jobType) {
  return policyForJobType(jobType);
}

export function resolvePostCallFailureTransition({
  jobType,
  attemptCount,
  maxAttempts,
  now = new Date(),
  errorCode = 'job_failed',
} = {}) {
  const policy = policyForJobType(jobType);
  const attempts = safePositiveInteger(attemptCount, 1);
  const maximum = safePositiveInteger(maxAttempts, policy.maxAttempts);

  if (attempts >= maximum) {
    return {
      status: POST_CALL_JOB_STATUSES.DEAD_LETTER,
      runAfter: null,
      lastErrorCode: sanitizeCode(errorCode),
      deadLetterReason: sanitizeCode(errorCode, 'max_attempts_exhausted'),
      deadLetteredAt: boundedIsoDate(now, 'now'),
    };
  }

  const delay = policy.backoffSeconds[Math.min(attempts - 1, policy.backoffSeconds.length - 1)] || 30;
  return {
    status: POST_CALL_JOB_STATUSES.FAILED,
    runAfter: addSeconds(boundedIsoDate(now, 'now'), delay),
    delaySeconds: delay,
    lastErrorCode: sanitizeCode(errorCode),
    deadLetterReason: null,
    deadLetteredAt: null,
  };
}

export function resolvePostCallProviderCaps({
  anthropicHaikuPeakTpm = 0,
  geminiFlashConcurrent = 0,
  openAiEmbeddingsRpm = 0,
  resendSendRate = 0,
} = {}) {
  return {
    anthropicHaikuTpm: Math.floor(Math.max(0, Number(anthropicHaikuPeakTpm) || 0) * 0.6),
    geminiFlashConcurrent: Math.floor(Math.max(0, Number(geminiFlashConcurrent) || 0) * 0.6),
    openAiEmbeddingsRpm: Math.floor(Math.max(0, Number(openAiEmbeddingsRpm) || 0) * 0.5),
    resendSendRate: Math.floor(Math.max(0, Number(resendSendRate) || 0) * 0.5),
  };
}

export function resolvePostCallProviderLimits({
  providerCaps = {},
  overrides = {},
  anthropicTokensPerJob = 12000,
} = {}) {
  return {
    [POST_CALL_PROVIDER_KEYS.DB]: providerLimitValue(
      overrides[POST_CALL_PROVIDER_KEYS.DB],
      DEFAULT_PROVIDER_LIMITS[POST_CALL_PROVIDER_KEYS.DB],
    ),
    [POST_CALL_PROVIDER_KEYS.ANTHROPIC_HAIKU]: providerLimitValue(
      overrides[POST_CALL_PROVIDER_KEYS.ANTHROPIC_HAIKU],
      tpmToSlots(providerCaps.anthropicHaikuTpm, anthropicTokensPerJob),
    ),
    [POST_CALL_PROVIDER_KEYS.GEMINI_FLASH]: providerLimitValue(
      overrides[POST_CALL_PROVIDER_KEYS.GEMINI_FLASH],
      providerLimitValue(providerCaps.geminiFlashConcurrent, DEFAULT_PROVIDER_LIMITS[POST_CALL_PROVIDER_KEYS.GEMINI_FLASH]),
    ),
    [POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS]: providerLimitValue(
      overrides[POST_CALL_PROVIDER_KEYS.OPENAI_EMBEDDINGS],
      rpmToSlots(providerCaps.openAiEmbeddingsRpm),
    ),
    [POST_CALL_PROVIDER_KEYS.RESEND]: providerLimitValue(
      overrides[POST_CALL_PROVIDER_KEYS.RESEND],
      rpmToSlots(providerCaps.resendSendRate),
    ),
  };
}

export function providerForPostCallJobType(jobType, {
  analysisProvider = POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
} = {}) {
  if (jobType === POST_CALL_JOB_TYPES.ANALYSIS) {
    return normalizeProviderKey(analysisProvider);
  }
  return POST_CALL_PROVIDER_BY_JOB_TYPE[jobType] || POST_CALL_PROVIDER_KEYS.DB;
}

export function createPostCallArtifactVerificationHandlers({
  database = db,
} = {}) {
  async function requireConversationCompleted(job) {
    const callSid = requireString(job.callSid, 'job.callSid');
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM conversations
      WHERE call_sid = ${callSid}
        AND status = 'completed'
        AND ended_at IS NOT NULL
    `);
    if (countFrom(result) < 1) {
      throw pendingPostCallArtifact('conversation_completion_pending');
    }
  }

  async function requireCallMetricsFinalized(job) {
    const callSid = requireString(job.callSid, 'job.callSid');
    await requireConversationCompleted(job);
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM call_metrics
      WHERE call_sid = ${callSid}
    `);
    if (countFrom(result) < 1) {
      throw pendingPostCallArtifact('metrics_finalize_pending');
    }
  }

  async function requireReminderRecoverySettled(job) {
    const callSid = requireString(job.callSid, 'job.callSid');
    await requireConversationCompleted(job);
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM reminder_deliveries
      WHERE call_sid = ${callSid}
        AND status = 'delivered'
    `);
    if (countFrom(result) > 0) {
      throw pendingPostCallArtifact('reminder_recovery_pending');
    }
  }

  async function requireAnalysisPersisted(job) {
    const callSid = requireString(job.callSid, 'job.callSid');
    await requireConversationCompleted(job);
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM call_analyses ca
      JOIN conversations c ON c.id::text = ca.conversation_id
      WHERE c.call_sid = ${callSid}
    `);
    if (countFrom(result) < 1) {
      throw pendingPostCallArtifact('analysis_artifact_pending');
    }
  }

  async function requireDailyContextPersisted(job) {
    const callSid = requireString(job.callSid, 'job.callSid');
    await requireConversationCompleted(job);
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM daily_call_context
      WHERE call_sid = ${callSid}
    `);
    if (countFrom(result) < 1) {
      throw pendingPostCallArtifact('daily_context_pending');
    }
  }

  async function requireSnapshotRebuilt(job) {
    const seniorId = String(job.seniorId || '').trim();
    await requireConversationCompleted(job);
    if (!seniorId) return;
    const result = await database.execute(sql`
      SELECT count(*)::int AS count
      FROM seniors
      WHERE id = ${seniorId}
        AND (
          call_context_snapshot IS NOT NULL
          OR call_context_snapshot_encrypted IS NOT NULL
        )
    `);
    if (countFrom(result) < 1) {
      throw pendingPostCallArtifact('snapshot_rebuild_pending');
    }
  }

  return {
    [POST_CALL_JOB_TYPES.METRICS_FINALIZE]: requireCallMetricsFinalized,
    [POST_CALL_JOB_TYPES.REMINDER_RECOVERY]: requireReminderRecoverySettled,
    [POST_CALL_JOB_TYPES.ANALYSIS]: requireAnalysisPersisted,
    [POST_CALL_JOB_TYPES.MEMORY_EXTRACTION]: requireConversationCompleted,
    [POST_CALL_JOB_TYPES.DAILY_CONTEXT]: requireDailyContextPersisted,
    [POST_CALL_JOB_TYPES.CAREGIVER_NOTIFICATIONS]: requireConversationCompleted,
    [POST_CALL_JOB_TYPES.INTEREST_DISCOVERY]: requireConversationCompleted,
    [POST_CALL_JOB_TYPES.SNAPSHOT_REBUILD]: requireSnapshotRebuilt,
  };
}

export function createPostCallShadowVerificationHandlers(options = {}) {
  return createPostCallArtifactVerificationHandlers(options);
}

export function createPostCallWorkflowHandlers({
  database = db,
  mode = process.env.POST_CALL_WORKER_HANDLER_MODE || 'artifact_verification',
  adapter = null,
} = {}) {
  if (adapter) {
    return Object.fromEntries(DEFAULT_JOB_ORDER.map(jobType => [
      jobType,
      (job, context) => adapter.handle(jobType, job, context),
    ]));
  }

  if (mode === 'artifact_verification') {
    return createPostCallArtifactVerificationHandlers({ database });
  }

  if (mode === 'disabled') {
    return {};
  }

  throw new Error(`Unknown post-call workflow handler mode: ${mode}`);
}

export class PostCallProviderSemaphores {
  constructor(limits = {}) {
    this.limits = {
      ...DEFAULT_PROVIDER_LIMITS,
      ...Object.fromEntries(
        Object.entries(limits).map(([provider, limit]) => [
          normalizeProviderKey(provider),
          providerLimitValue(limit, DEFAULT_PROVIDER_LIMITS[normalizeProviderKey(provider)] || 1),
        ]),
      ),
    };
    this.active = new Map();
    this.queues = new Map();
    this.maxObserved = new Map();
  }

  _active(provider) {
    return this.active.get(provider) || 0;
  }

  _setActive(provider, value) {
    this.active.set(provider, value);
    this.maxObserved.set(provider, Math.max(this.maxObserved.get(provider) || 0, value));
  }

  async acquire(providerName) {
    const provider = normalizeProviderKey(providerName);
    const limit = this.limits[provider] ?? 1;
    if (this._active(provider) < limit) {
      this._setActive(provider, this._active(provider) + 1);
      return () => this.release(provider);
    }

    return new Promise(resolve => {
      const queue = this.queues.get(provider) || [];
      queue.push(() => {
        this._setActive(provider, this._active(provider) + 1);
        resolve(() => this.release(provider));
      });
      this.queues.set(provider, queue);
    });
  }

  release(providerName) {
    const provider = normalizeProviderKey(providerName);
    this._setActive(provider, Math.max(0, this._active(provider) - 1));
    const queue = this.queues.get(provider) || [];
    const next = queue.shift();
    if (queue.length > 0) this.queues.set(provider, queue);
    else this.queues.delete(provider);
    if (next) next();
  }

  async run(provider, task) {
    const release = await this.acquire(provider);
    try {
      return await task();
    } finally {
      release();
    }
  }

  snapshot() {
    return {
      limits: { ...this.limits },
      active: Object.fromEntries(this.active.entries()),
      maxObserved: Object.fromEntries(this.maxObserved.entries()),
      queued: Object.fromEntries(
        [...this.queues.entries()].map(([provider, queue]) => [provider, queue.length]),
      ),
    };
  }
}

export function buildPostCallJobSpecs({
  conversationId,
  callSid,
  seniorId = null,
  payloadByType = {},
  jobTypes = DEFAULT_JOB_ORDER,
} = {}) {
  const cleanCallSid = requireString(callSid, 'callSid');
  const cleanConversationId = requireString(conversationId, 'conversationId');
  const requested = new Set(jobTypes);
  const selected = [
    ...DEFAULT_JOB_ORDER.filter(jobType => requested.has(jobType)),
    ...[...requested].filter(jobType => !DEFAULT_JOB_ORDER.includes(jobType)),
  ];

  return selected.map(jobType => {
    if (!POST_CALL_JOB_GRAPH[jobType]) {
      throw new Error(`Unknown post-call job type: ${jobType}`);
    }
    return {
      conversationId: cleanConversationId,
      callSid: cleanCallSid,
      seniorId,
      jobType,
      status: POST_CALL_JOB_STATUSES.QUEUED,
      priority: POST_CALL_JOB_PRIORITIES[jobType] ?? 0,
      dedupeKey: buildPostCallDedupeKey({ callSid: cleanCallSid, jobType }),
      payloadEncrypted: encryptPostCallJobPayload(payloadByType[jobType]),
      dependsOnTypes: POST_CALL_JOB_GRAPH[jobType].filter(type => selected.includes(type)),
      maxAttempts: policyForJobType(jobType).maxAttempts,
    };
  });
}

async function upsertPostCallJob({ database, spec, dependsOnIds = [], now = new Date() }) {
  const row = firstRow(await database.execute(sql`
    INSERT INTO post_call_jobs (
      conversation_id,
      call_sid,
      senior_id,
      job_type,
      status,
      priority,
      dedupe_key,
      payload_encrypted,
      depends_on,
      attempt_count,
      max_attempts,
      run_after,
      created_at,
      updated_at
    )
    VALUES (
      ${spec.conversationId},
      ${spec.callSid},
      ${spec.seniorId},
      ${spec.jobType},
      ${spec.status},
      ${spec.priority},
      ${spec.dedupeKey},
      ${spec.payloadEncrypted},
      ${uuidArraySql(dependsOnIds)},
      0,
      ${spec.maxAttempts},
      ${now},
      ${now},
      ${now}
    )
    ON CONFLICT (dedupe_key) DO UPDATE SET
      conversation_id = COALESCE(post_call_jobs.conversation_id, EXCLUDED.conversation_id),
      senior_id = COALESCE(post_call_jobs.senior_id, EXCLUDED.senior_id),
      depends_on = EXCLUDED.depends_on,
      max_attempts = EXCLUDED.max_attempts,
      payload_encrypted = COALESCE(post_call_jobs.payload_encrypted, EXCLUDED.payload_encrypted),
      updated_at = EXCLUDED.updated_at
    RETURNING id, conversation_id, call_sid, senior_id, job_type, status, priority, dedupe_key,
              depends_on, attempt_count, max_attempts, lease_owner, lease_expires_at,
              run_after, last_error_code, last_error_at, started_at, completed_at,
              dead_lettered_at, dead_letter_reason, created_at, updated_at
  `));
  return normalizeJobRow(row);
}

export async function enqueuePostCallJobGraph({
  database = db,
  conversationId,
  callSid,
  seniorId = null,
  payloadByType = {},
  jobTypes = DEFAULT_JOB_ORDER,
  now = new Date(),
} = {}) {
  const specs = buildPostCallJobSpecs({ conversationId, callSid, seniorId, payloadByType, jobTypes });
  const byType = new Map();
  const jobs = [];

  for (const spec of specs) {
    const dependsOnIds = spec.dependsOnTypes.map(type => byType.get(type)?.id).filter(Boolean);
    const job = await upsertPostCallJob({ database, spec, dependsOnIds, now });
    byType.set(spec.jobType, job);
    jobs.push(job);
  }

  return jobs;
}

export async function leaseReadyPostCallJobs({
  database = db,
  workerId,
  jobTypes = [],
  limit = 10,
  leaseSeconds = 120,
  now = new Date(),
} = {}) {
  const owner = requireString(workerId, 'workerId');
  const batchLimit = safePositiveInteger(limit, 10, 500);
  const leaseExpiresAt = addSeconds(boundedIsoDate(now, 'now'), safePositiveInteger(leaseSeconds, 120, 3600));

  const result = await database.execute(sql`
    WITH ready AS (
      SELECT job.id
      FROM post_call_jobs job
      WHERE job.status IN (${POST_CALL_JOB_STATUSES.QUEUED}, ${POST_CALL_JOB_STATUSES.FAILED})
        AND job.run_after <= ${now}
        AND job.attempt_count < job.max_attempts
        AND ${jobTypeFilterSql(jobTypes)}
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(job.depends_on) AS dep(job_id)
          LEFT JOIN post_call_jobs parent ON parent.id = dep.job_id
          WHERE parent.id IS NULL OR parent.status <> ${POST_CALL_JOB_STATUSES.COMPLETED}
        )
      ORDER BY job.priority DESC, job.run_after ASC, job.created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchLimit}
    )
    UPDATE post_call_jobs job
    SET status = ${POST_CALL_JOB_STATUSES.LEASED},
        lease_owner = ${owner},
        lease_expires_at = ${leaseExpiresAt},
        attempt_count = job.attempt_count + 1,
        updated_at = ${now}
    FROM ready
    WHERE job.id = ready.id
    RETURNING job.id, job.conversation_id, job.call_sid, job.senior_id, job.job_type,
              job.status, job.priority, job.dedupe_key, job.depends_on, job.attempt_count,
              job.max_attempts, job.lease_owner, job.lease_expires_at, job.run_after,
              job.last_error_code, job.last_error_at, job.started_at, job.completed_at,
              job.dead_lettered_at, job.dead_letter_reason, job.created_at, job.updated_at
  `);

  return rowsFrom(result).map(normalizeJobRow);
}

/**
 * Recover leased post-call jobs whose lease has expired (worker crashed,
 * batch ran long, network partition). Mirrors `recoverExpiredQueueLeases`
 * in services/call-queue.js so a stranded job can be re-leased on the next
 * cycle.
 *
 * IMPORTANT: only recovers status=LEASED. Jobs that already transitioned to
 * RUNNING (via markPostCallJobRunning) are the worker's responsibility —
 * their external side effects may have partially fired, so auto-retrying
 * could cause duplicates. Stuck RUNNING jobs are surfaced by the dead-letter
 * admin UI for operator triage.
 *
 * Preserves attempt_count (already incremented at lease time) so the retry
 * policy still bounds total attempts.
 */
export async function recoverExpiredPostCallJobLeases({
  limit = 100,
  now = new Date(),
} = {}, { database = db } = {}) {
  const safeLimit = safePositiveInteger(limit, 100, 5000);
  const currentTime = boundedIsoDate(now, 'now');

  const result = await database.execute(sql`
    WITH candidates AS (
      SELECT id
      FROM post_call_jobs
      WHERE status = ${POST_CALL_JOB_STATUSES.LEASED}
        AND lease_expires_at <= ${currentTime}
      ORDER BY lease_expires_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT ${safeLimit}
    )
    UPDATE post_call_jobs job
    SET status = ${POST_CALL_JOB_STATUSES.QUEUED},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = ${currentTime}
    FROM candidates
    WHERE job.id = candidates.id
    RETURNING job.id, job.job_type, job.attempt_count, job.max_attempts
  `);

  // Return list to caller for observability (count surfaces in
  // runPostCallWorkerOnce return value and the reconciler wrapper).
  return rowsFrom(result);
}

export async function reconcilePostCallJobLeases(options = {}, { database = db } = {}) {
  const recovered = await recoverExpiredPostCallJobLeases(options, { database });
  return { recovered: recovered.length };
}

export async function executePostCallJob({
  database = db,
  job,
  workerId,
  handlers = {},
  providerSemaphores = new PostCallProviderSemaphores(),
  analysisProvider = POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
  now = new Date(),
} = {}) {
  if (!job) throw new Error('job is required');
  const owner = requireString(workerId, 'workerId');
  const jobType = job.jobType || job.job_type;
  const provider = providerForPostCallJobType(jobType, { analysisProvider });
  const handler = handlers[jobType] || handlers.default;
  if (!handler) {
    const failed = await failPostCallJob({
      database,
      jobId: job.id,
      workerId: owner,
      errorCode: 'handler_missing',
      now,
    });
    return {
      jobId: job.id,
      jobType,
      provider,
      status: failed?.status || POST_CALL_JOB_STATUSES.FAILED,
      errorCode: 'handler_missing',
    };
  }

  return providerSemaphores.run(provider, async () => {
    const running = await markPostCallJobRunning({
      database,
      jobId: job.id,
      workerId: owner,
      now,
    });
    if (!running) {
      return {
        jobId: job.id,
        jobType,
        provider,
        status: 'skipped',
        reason: 'lease_not_owned_or_expired',
      };
    }

    try {
      await handler(running, { provider, workerId: owner });
      const completed = await completePostCallJob({
        database,
        jobId: running.id,
        workerId: owner,
        now: new Date(),
      });
      return {
        jobId: running.id,
        jobType: running.jobType,
        provider,
        status: completed?.status || POST_CALL_JOB_STATUSES.COMPLETED,
      };
    } catch (error) {
      const failed = await failPostCallJob({
        database,
        jobId: running.id,
        workerId: owner,
        errorCode: sanitizeCode(error?.code || error?.message || 'handler_failed'),
        now: new Date(),
      });
      return {
        jobId: running.id,
        jobType: running.jobType,
        provider,
        status: failed?.status || POST_CALL_JOB_STATUSES.FAILED,
        errorCode: sanitizeCode(error?.code || error?.message || 'handler_failed'),
      };
    }
  });
}

export async function runPostCallWorkerOnce({
  database = db,
  workerId,
  handlers = {},
  providerSemaphores = new PostCallProviderSemaphores(),
  analysisProvider = POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
  jobTypes = [],
  limit = 10,
  leaseSeconds = 120,
  now = new Date(),
} = {}) {
  const owner = requireString(workerId, 'workerId');
  const recoveredLeases = await recoverExpiredPostCallJobLeases({ now }, { database });
  const blocked = await deadLetterBlockedPostCallDependents({ database, now });
  const jobs = await leaseReadyPostCallJobs({
    database,
    workerId: owner,
    jobTypes,
    limit,
    leaseSeconds,
    now,
  });
  const results = await Promise.all(jobs.map(job => executePostCallJob({
    database,
    job,
    workerId: owner,
    handlers,
    providerSemaphores,
    analysisProvider,
    now,
  })));

  const counts = {};
  for (const result of results) {
    counts[result.status] = (counts[result.status] || 0) + 1;
  }

  return {
    leased: jobs.length,
    blockedDeadLettered: blocked.length,
    recoveredLeases: recoveredLeases.length,
    counts,
    results,
    providerSemaphores: providerSemaphores.snapshot(),
  };
}

export async function markPostCallJobRunning({
  database = db,
  jobId,
  workerId,
  now = new Date(),
} = {}) {
  const row = firstRow(await database.execute(sql`
    UPDATE post_call_jobs
    SET status = ${POST_CALL_JOB_STATUSES.RUNNING},
        started_at = COALESCE(started_at, ${now}),
        updated_at = ${now}
    WHERE id = ${requireString(jobId, 'jobId')}
      AND lease_owner = ${requireString(workerId, 'workerId')}
      AND status = ${POST_CALL_JOB_STATUSES.LEASED}
      AND lease_expires_at > ${now}
    RETURNING id, conversation_id, call_sid, senior_id, job_type, status, priority,
              dedupe_key, depends_on, attempt_count, max_attempts, lease_owner,
              lease_expires_at, run_after, last_error_code, last_error_at, started_at,
              completed_at, dead_lettered_at, dead_letter_reason, created_at, updated_at
  `));
  return normalizeJobRow(row);
}

export async function completePostCallJob({
  database = db,
  jobId,
  workerId,
  now = new Date(),
} = {}) {
  const row = firstRow(await database.execute(sql`
    UPDATE post_call_jobs
    SET status = ${POST_CALL_JOB_STATUSES.COMPLETED},
        completed_at = ${now},
        lease_owner = NULL,
        lease_expires_at = NULL,
        updated_at = ${now}
    WHERE id = ${requireString(jobId, 'jobId')}
      AND lease_owner = ${requireString(workerId, 'workerId')}
      AND status IN (${POST_CALL_JOB_STATUSES.LEASED}, ${POST_CALL_JOB_STATUSES.RUNNING})
    RETURNING id, conversation_id, call_sid, senior_id, job_type, status, priority,
              dedupe_key, depends_on, attempt_count, max_attempts, lease_owner,
              lease_expires_at, run_after, last_error_code, last_error_at, started_at,
              completed_at, dead_lettered_at, dead_letter_reason, created_at, updated_at
  `));
  return normalizeJobRow(row);
}

export async function failPostCallJob({
  database = db,
  jobId,
  workerId,
  errorCode = 'job_failed',
  now = new Date(),
} = {}) {
  const current = firstRow(await database.execute(sql`
    SELECT id, job_type, attempt_count, max_attempts
    FROM post_call_jobs
    WHERE id = ${requireString(jobId, 'jobId')}
      AND lease_owner = ${requireString(workerId, 'workerId')}
      AND status IN (${POST_CALL_JOB_STATUSES.LEASED}, ${POST_CALL_JOB_STATUSES.RUNNING})
    FOR UPDATE
  `));
  if (!current) return null;

  const transition = resolvePostCallFailureTransition({
    jobType: current.job_type,
    attemptCount: current.attempt_count,
    maxAttempts: current.max_attempts,
    now,
    errorCode,
  });

  const row = firstRow(await database.execute(sql`
    UPDATE post_call_jobs
    SET status = ${transition.status},
        run_after = ${transition.runAfter},
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${transition.lastErrorCode},
        last_error_at = ${now},
        dead_letter_reason = ${transition.deadLetterReason},
        dead_lettered_at = ${transition.deadLetteredAt},
        updated_at = ${now}
    WHERE id = ${current.id}
    RETURNING id, conversation_id, call_sid, senior_id, job_type, status, priority,
              dedupe_key, depends_on, attempt_count, max_attempts, lease_owner,
              lease_expires_at, run_after, last_error_code, last_error_at, started_at,
              completed_at, dead_lettered_at, dead_letter_reason, created_at, updated_at
  `));

  return normalizeJobRow(row);
}

export async function deadLetterBlockedPostCallDependents({
  database = db,
  now = new Date(),
  limit = 500,
} = {}) {
  const batchLimit = safePositiveInteger(limit, 500, 5000);
  const result = await database.execute(sql`
    WITH blocked AS (
      SELECT child.id
      FROM post_call_jobs child
      WHERE child.status IN (
        ${POST_CALL_JOB_STATUSES.QUEUED},
        ${POST_CALL_JOB_STATUSES.FAILED},
        ${POST_CALL_JOB_STATUSES.LEASED}
      )
        AND EXISTS (
          SELECT 1
          FROM unnest(child.depends_on) AS dep(job_id)
          JOIN post_call_jobs parent ON parent.id = dep.job_id
          WHERE parent.status = ${POST_CALL_JOB_STATUSES.DEAD_LETTER}
        )
      ORDER BY child.created_at ASC
      LIMIT ${batchLimit}
    )
    UPDATE post_call_jobs child
    SET status = ${POST_CALL_JOB_STATUSES.DEAD_LETTER},
        lease_owner = NULL,
        lease_expires_at = NULL,
        dead_letter_reason = 'dependency_dead_lettered',
        dead_lettered_at = ${now},
        updated_at = ${now}
    FROM blocked
    WHERE child.id = blocked.id
    RETURNING child.id, child.conversation_id, child.call_sid, child.senior_id,
              child.job_type, child.status, child.priority, child.dedupe_key,
              child.depends_on, child.attempt_count, child.max_attempts,
              child.lease_owner, child.lease_expires_at, child.run_after,
              child.last_error_code, child.last_error_at, child.started_at,
              child.completed_at, child.dead_lettered_at, child.dead_letter_reason,
              child.created_at, child.updated_at
  `);
  return rowsFrom(result).map(normalizeJobRow);
}

export async function listDeadLetterPostCallJobs({
  database = db,
  limit = 100,
} = {}) {
  const result = await database.execute(sql`
    SELECT id, conversation_id, call_sid, senior_id, job_type, status, priority,
           dedupe_key, depends_on, attempt_count, max_attempts, lease_owner,
           lease_expires_at, run_after, last_error_code, last_error_at, started_at,
           completed_at, dead_lettered_at, dead_letter_reason, created_at, updated_at
    FROM post_call_jobs
    WHERE status = ${POST_CALL_JOB_STATUSES.DEAD_LETTER}
    ORDER BY dead_lettered_at DESC NULLS LAST, created_at DESC
    LIMIT ${safePositiveInteger(limit, 100, 500)}
  `);
  return rowsFrom(result).map(normalizeJobRow);
}

export async function requeueDeadLetterPostCallJob({
  database = db,
  jobId,
  now = new Date(),
  auditWriter = writeAudit,
  replayedBy = null,
  replayedByRole = 'admin',
  ipAddress = null,
  userAgent = null,
} = {}) {
  const id = requireString(jobId, 'jobId');
  const row = firstRow(await database.execute(sql`
    UPDATE post_call_jobs
    SET status = ${POST_CALL_JOB_STATUSES.QUEUED},
        attempt_count = 0,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error_at = NULL,
        dead_letter_reason = NULL,
        dead_lettered_at = NULL,
        run_after = ${now},
        updated_at = ${now}
    WHERE id = ${id}
      AND status = ${POST_CALL_JOB_STATUSES.DEAD_LETTER}
    RETURNING id, conversation_id, call_sid, senior_id, job_type, status, priority,
              dedupe_key, depends_on, attempt_count, max_attempts, lease_owner,
              lease_expires_at, run_after, last_error_code, last_error_at, started_at,
              completed_at, dead_lettered_at, dead_letter_reason, created_at, updated_at
  `));
  const job = normalizeJobRow(row);

  if (job && auditWriter && replayedBy) {
    await auditWriter({
      userId: replayedBy,
      userRole: replayedByRole,
      action: 'update',
      resourceType: 'post_call_job',
      resourceId: job.id,
      ipAddress,
      userAgent,
      metadata: {
        operation: 'dead_letter_replay',
        jobType: job.jobType,
      },
    });
  }

  return job;
}

export async function runPostCallStampedeSimulation({
  completions = 600,
  providerLimits = resolvePostCallProviderLimits(),
  handlerDurationsMs = {},
  criticalSloMs = 5 * 60 * 1000,
  nonCriticalSloMs = 30 * 60 * 1000,
  dbPoolStatsProvider = async () => ({ idle: 17, max: 20 }),
  analysisProvider = POST_CALL_PROVIDER_KEYS.GEMINI_FLASH,
} = {}) {
  const totalCompletions = safePositiveInteger(completions, 600, 5000);
  const semaphores = new PostCallProviderSemaphores(providerLimits);
  const startedAt = Date.now();
  const criticalCompletionMs = [];
  const allCompletionMs = [];
  const totalJobs = totalCompletions * DEFAULT_JOB_ORDER.length;
  const durationFor = jobType => Math.max(0, Number.parseInt(handlerDurationsMs[jobType] ?? 1, 10) || 0);
  const criticalTypes = new Set([
    POST_CALL_JOB_TYPES.METRICS_FINALIZE,
    POST_CALL_JOB_TYPES.REMINDER_RECOVERY,
  ]);

  for (const jobType of DEFAULT_JOB_ORDER) {
    const provider = providerForPostCallJobType(jobType, { analysisProvider });
    await Promise.all(Array.from({ length: totalCompletions }, async (_, index) => {
      await semaphores.run(provider, async () => {
        await sleep(durationFor(jobType));
      });
      const elapsed = Date.now() - startedAt;
      allCompletionMs.push(elapsed);
      if (criticalTypes.has(jobType)) {
        criticalCompletionMs[index] = Math.max(criticalCompletionMs[index] || 0, elapsed);
      }
    }));
  }

  const dbPoolStats = await dbPoolStatsProvider();
  const dbPoolIdleRatio = dbPoolStats?.max > 0 ? dbPoolStats.idle / dbPoolStats.max : null;
  const snapshot = semaphores.snapshot();
  const providerCapViolations = Object.entries(snapshot.maxObserved)
    .filter(([provider, observed]) => observed > (snapshot.limits[provider] ?? observed));
  const criticalP95Ms = percentile(criticalCompletionMs, 0.95);
  const nonCriticalDrainMs = allCompletionMs.length ? Math.max(...allCompletionMs) : 0;

  const checks = [
    {
      name: 'critical_jobs_p95',
      status: criticalP95Ms != null && criticalP95Ms <= criticalSloMs ? 'passed' : 'failed',
      p95Ms: criticalP95Ms,
      targetMs: criticalSloMs,
    },
    {
      name: 'provider_concurrency_caps',
      status: providerCapViolations.length === 0 ? 'passed' : 'failed',
      maxObserved: snapshot.maxObserved,
      limits: snapshot.limits,
    },
    {
      name: 'db_pool_idle',
      status: dbPoolIdleRatio != null && dbPoolIdleRatio >= 0.15 ? 'passed' : 'failed',
      idleRatio: dbPoolIdleRatio == null ? null : Math.round(dbPoolIdleRatio * 10000) / 10000,
      target: 0.15,
    },
    {
      name: 'non_critical_backlog_drain',
      status: nonCriticalDrainMs <= nonCriticalSloMs ? 'passed' : 'failed',
      drainMs: nonCriticalDrainMs,
      targetMs: nonCriticalSloMs,
    },
  ];

  return {
    ok: checks.every(check => check.status === 'passed'),
    completions: totalCompletions,
    totalJobs,
    providerLimits: snapshot.limits,
    providerMaxObserved: snapshot.maxObserved,
    criticalP95Ms,
    nonCriticalDrainMs,
    dbPoolIdleRatio,
    checks,
  };
}
