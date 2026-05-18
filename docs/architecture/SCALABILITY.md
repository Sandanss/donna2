# Scalability Architecture

> How Donna scales to 8,000 daily users with 500 concurrent calls.

---

## Target Capacity

| Metric | Target |
|--------|--------|
| Total users | 8,000 |
| Daily calls | 8,000 (1 per user) |
| Peak concurrent calls | 500 (morning 7-9 AM) |
| Call duration | ~10 minutes average |
| Zero tolerance for dropped calls | Users are elderly, depends on medication reminders |

---

## Admission Control

**File**: `pipecat/main.py`

### Semaphore-Based Concurrency Limiting

```python
MAX_CALLS = settings.max_concurrent_calls
_call_semaphore = asyncio.Semaphore(MAX_CALLS)
```

WebSocket handler flow:
1. Accept WebSocket connection from Telnyx
2. Parse the Telnyx start frame and validate `call_control_id` + `ws_token` before consuming active-call capacity
3. Try to acquire `_call_semaphore` immediately
4. If at capacity: close with code 1013 (Try Again Later)
5. After capacity is reserved, consume the single-use `ws_token`
6. Start STT/LLM/TTS services and increment `_active_calls`
7. On disconnect: release semaphore in `finally` block

### Telnyx Capacity Handling

**File**: `pipecat/main.py`

Call metadata is created by `pipecat/api/routes/telnyx.py`. The WebSocket handler validates the token before reserving active-call capacity, then closes with `1013` when the service is full.

### Monitoring

Health endpoint exposes real-time capacity:

```json
{
  "active_calls": 12,
  "peak_calls": 47,
  "max_calls": 50,
  "pool": { "size": 15, "idle": 8, "max": 50, "min": 5 }
}
```

---

## Database Optimization

### Connection Pool

**File**: `pipecat/db/client.py`

| Setting | Default | Env Var | Purpose |
|---------|---------|---------|---------|
| min_size | 5 | `DB_POOL_MIN` | Warm connections ready |
| max_size | 50 | `DB_POOL_MAX` | Upper bound for concurrent queries |

Pool stats exposed on `/health` endpoint. Slow query logging at 100ms threshold.

### Indexes (11 total)

**File**: `db/migrations/001_add_indexes.sql`

Applied to production Neon database using `CREATE INDEX CONCURRENTLY` (no table locks):

| Index | Table | Impact |
|-------|-------|--------|
| `idx_conversations_call_sid` | conversations | WebSocket message lookup |
| `idx_memories_senior_id` | memories | Memory search (4-8x per call) |
| `idx_conversations_senior_started` | conversations | Context loading at call start |
| `idx_reminders_active_scheduled` | reminders | Scheduler polling (every 60s) |
| `idx_reminders_recurring` | reminders | Recurring reminder queries |
| `idx_deliveries_reminder_scheduled` | reminder_deliveries | Delivery lookups |
| `idx_deliveries_status` | reminder_deliveries | Status-based queries |
| `idx_daily_context_senior_date` | daily_call_context | Daily context per call |
| `idx_analyses_senior_created` | call_analyses | Post-call interest scoring |
| `idx_memories_embedding_hnsw` | memories | **HNSW vector index** — O(log n) semantic search |

The HNSW vector index is the highest-impact single change: turns O(n) full-table scan into O(log n) approximate nearest neighbor search for memory retrieval.

---

## Scheduler And Outbound Call Initiation

**Active file**: `services/scheduler.js`

The Node.js scheduler is authoritative for production reminder and welfare calls. Pipecat's scheduler module remains for helper parity, reminder context handoff, and explicit Python-side experiments; it must stay disabled unless the architecture changes.

Node builds a unified call plan, prioritizes reminders over welfare checks, gates all calls through the senior's local calling window, retries service-to-service Telnyx outbound requests, and asks Pipecat `/telnyx/outbound` to create the calls.

For scheduled reminder calls, the leader scheduler also runs a short lookahead sweep and prewarms reminder context before the call is due. It asks Pipecat `/telnyx/prewarm` to build the outbound senior context, stores that payload in a short-lived local cache keyed by `reminder_id + scheduled_for`, and reuses it on the later `/telnyx/outbound` request. If the warm entry is missing or stale, Pipecat falls back to live hydration.

Pipecat's helper scheduler still supports parallel initiation with a limiter:

```python
sem = asyncio.Semaphore(10)  # 10 concurrent Telnyx call requests

async def _limited_trigger(item):
    async with sem:
        return await trigger_reminder_call(...)

results = await asyncio.gather(
    *[_limited_trigger(item) for item in due],
    return_exceptions=True,
)
```

- 100 reminders × 10 parallel = ~50 seconds

### Retry with Exponential Backoff
Telnyx call initiation retries on Node:
- **Node.js** (`retryTelnyxCall()`): 3 attempts, 1s → 2s → 4s delays

### Pending Context Cleanup
In-memory Maps (`pendingReminderCalls`, `prefetchedContextByPhone`) have automatic TTL cleanup:
- Entries older than 30 minutes are evicted every 5 minutes
- Prevents unbounded memory growth during sustained operation

---

## Leader Election

**Files**: `pipecat/services/scheduler.py`, `services/scheduler.js`

Both backends use PostgreSQL advisory locks to ensure only one scheduler instance runs:

```python
SCHEDULER_LOCK_ID = 8675309

async def _try_acquire_leader_lock() -> bool:
    row = await query_one(
        "SELECT pg_try_advisory_lock($1) AS acquired",
        SCHEDULER_LOCK_ID,
    )
    return row and row.get("acquired", False)
```

- Lock is session-scoped (released on disconnect)
- Non-blocking: `pg_try_advisory_lock` returns immediately
- Same lock ID used by both Python and Node.js schedulers
- If leader dies, another instance claims leadership on next poll cycle

---

## Redis Shared State (Multi-Instance)

**File**: `pipecat/lib/redis_client.py`

Optional Redis layer for multi-instance deployment. Activated by setting `REDIS_URL`, or by setting both `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### Dual Implementation

| Class | Backend | When Used |
|-------|---------|-----------|
| `InMemoryState` | Python dict | Default (single instance) |
| `RedisState` | Redis asyncio | When `REDIS_URL` is set |
| `UpstashRestState` | Upstash Redis REST API | When `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set |

Dev and production are wired to Railway Redis through `REDIS_URL` service references:
- dev: `REDIS_URL=${{Redis.REDIS_URL}}`
- production: `REDIS_URL=${{Redis-sJE8.REDIS_URL}}`

Those URLs resolve on Railway private networking, so local `railway run` commands cannot use them directly from a developer machine. Use `railway ssh --service donna-pipecat --environment <env> ...` for Redis smoke tests that need to run inside the Railway network.

`UpstashRestState` remains available as a code-level fallback for non-Railway deployments. It is not the active dev or production path. If an Upstash endpoint returns an HTTP/DNS error, it marks itself temporarily unavailable and callers continue on local state until the retry window passes. That keeps a single-replica deployment functional, but multi-replica routing still requires a valid Redis or Upstash endpoint.

Both implement the same async interface:
- `set(key, value, ttl)` / `get(key)` / `delete(key)`
- `set_hash(key, field, value)` / `get_hash(key, field)`
- `keys(pattern)` / `cleanup()`

### What's Stored in Redis
- `call_metadata:{call_control_id}` — encrypted call context for WebSocket handler (TTL: 30 min)
- `reminder_ctx:{call_control_id}` — encrypted Pipecat-scheduler reminder context for outbound reminder calls (TTL: 30 min)

These payloads can contain PHI-bearing memory context, reminders, transcript fragments, senior profile fields, and caregiver note content. Shared-state writes use `pipecat/lib/shared_state_phi.py`, which encrypts the dict before it enters Redis and still accepts legacy raw dict payloads during rollout.

### Cross-Instance Flow
1. `/telnyx/events` and `/telnyx/outbound` store call metadata in local dict + Redis
2. `/ws` reads metadata from local dict first, falls back to Redis
3. Pipecat-side reminder initiation stores reminder context in local dict + Redis
4. Telnyx call setup reads reminder context from local dict first, falls back to Redis, then falls back to the database delivery row for Node-scheduled reminders
5. On call completion, metadata and reminder context are cleaned from both local dict and Redis

---

## Multi-Instance Readiness Checklist

| Requirement | Status | How |
|-------------|--------|-----|
| Shared call metadata | Ready | Redis client module |
| Shared reminder context | Ready | Pipecat scheduler writes `reminder_ctx:{call_control_id}` with TTL; Telnyx setup loads local-first, Redis-second |
| Scheduler deduplication | Ready | PostgreSQL advisory locks |
| Connection pool per instance | Ready | Each instance creates own pool |
| Health monitoring | Ready | Per-instance `/health` endpoint |
| WebSocket affinity | Not required for current flow | Each Telnyx media stream stays on one WebSocket connection; Redis-backed metadata lets startup land on any Pipecat instance |
| Rate limiting | Needed | Redis-backed slowapi (currently in-memory) |
| Context cache sharing | Needed | Redis-backed cache (currently in-memory) |

---

## Production Rollout

**File**: `pipecat/scripts/rollout.sh`

Gradual cohort-based onboarding with health gates:

```
500 users → monitor 5min → pass? →
  1,000 users → monitor 5min → pass? →
    2,000 users → monitor 5min → pass? →
      4,000 users → monitor 5min → pass? →
        8,000 users → complete
```

Each cohort transition:
1. Verify health (`/health` returns `status: ok`, `database: ok`)
2. Enable the next batch of users
3. Monitor for 5 minutes (health check every 30s)
4. Check alerts: capacity >80%, circuit breakers open
5. Abort if 3+ consecutive health failures

### Alert Thresholds

| Metric | Threshold | Action |
|--------|-----------|--------|
| Active calls | >80% of MAX_CONCURRENT_CALLS | Warning: approaching capacity |
| Circuit breakers | Any in "open" state | Warning: external service failure |
| Health failures | 3+ consecutive | Abort rollout |
| DB pool idle | <5 connections | Warning: approaching exhaustion |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MAX_CONCURRENT_CALLS` | 50 | Semaphore limit for concurrent WebSocket sessions |
| `DB_POOL_MIN` | 5 | Minimum warm database connections |
| `DB_POOL_MAX` | 50 | Maximum database connections |
| `REDIS_URL` | *(empty)* | Optional — enables Redis protocol shared state. Dev and production use Railway Redis service references. |
| `UPSTASH_REDIS_REST_URL` | *(empty)* | Optional fallback for non-Railway deployments — enables Upstash REST shared state when paired with token |
| `UPSTASH_REDIS_REST_TOKEN` | *(empty)* | Optional fallback for non-Railway deployments — Upstash REST bearer token |
| `SCHEDULER_ENABLED` | false | Pipecat-side scheduler toggle; keep false because Node `services/scheduler.js` is authoritative |
| `TELEPHONY_INTERNAL_INPUT_SAMPLE_RATE` | 16000 | Internal STT input rate after telephony serializer conversion |
| `ELEVENLABS_OUTPUT_SAMPLE_RATE` | 44100 | Non-phone ElevenLabs TTS output rate; active Telnyx calls override to 16kHz |
| `CARTESIA_OUTPUT_SAMPLE_RATE` | 48000 | Non-phone Cartesia PCM output rate; active Telnyx calls override to 16kHz |
| `GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE` | 24000 | Internal Gemini Live output rate before telephony serializer conversion |

---

## Load Test Results (March 2026)

**Test setup**: Locust → Neon PostgreSQL (us-east-1), 204 seniors, 5,429 memories with 1536-dim embeddings, HNSW + B-tree indexes applied.

### 100 Concurrent Users (via pooler)

| Query | Requests | Failures | Avg | p50 | p95 | p99 |
|-------|----------|----------|-----|-----|-----|-----|
| Director memory retrieval (pgvector HNSW) | 5,492 | **0%** | 105ms | 98ms | 110ms | 460ms |
| get_recent_summaries | 4,130 | **0%** | 98ms | 96ms | 110ms | 150ms |
| get_critical_memories | 2,745 | **0%** | 98ms | 96ms | 110ms | 150ms |
| get_due_reminders | 1,233 | **0%** | 98ms | 96ms | 110ms | 150ms |
| **Total** | **13,803 / 60s** | **0%** | **100ms** | **96ms** | | |

### 500 Concurrent Users (via pooler)

| Query | Requests | Failures | Avg | p50 | p95 | p99 |
|-------|----------|----------|-----|-----|-----|-----|
| Director memory retrieval (pgvector HNSW) | 16,210 | **0%** | 737ms | 710ms | 820ms | 1.3s |
| get_recent_summaries | 12,229 | **0%** | 728ms | 710ms | 810ms | 1.0s |
| get_critical_memories | 8,120 | **0%** | 732ms | 710ms | 820ms | 1.2s |
| get_due_reminders | 4,099 | **0%** | 725ms | 710ms | 800ms | 940ms |
| **Total** | **40,658 / 90s (~450 req/s)** | **0%** | **731ms** | **710ms** | | |

### 500 Concurrent Users (direct connection — FAILED)

| Metric | Value |
|--------|-------|
| Failure rate | **69%** |
| Error | `TooManyConnectionsError` — Neon direct connection limit exhausted |

**Key finding**: Neon's PgBouncer pooler (`-pooler` hostname) is mandatory for >100 concurrent. Production already uses the pooled connection string.

### What Latency Means

The ~700ms at 500 users includes network round-trip from macOS to us-east-1 Neon. In production on Railway (also us-east-1), same-region latency is ~5-10ms. Expected production latency: **~50-100ms per query at 500 concurrent**.

---

## External Provider Capacity Audit (April 2026)

### Current Limits vs. 500 Concurrent Calls

| Provider | Service | Current Limit | Need at 500 Concurrent | Status |
|----------|---------|---------------|------------------------|--------|
| **Anthropic** | Claude Haiku 4.5 | 1,000 RPM / 450K input TPM | ~1,000 RPM / ~5M input TPM | **BLOCKER** — input tokens 11x over limit |
| **ElevenLabs** | TTS Streaming | ~5 concurrent (Creator tier) | 500 concurrent | **BLOCKER** — 100x under capacity |
| **Deepgram** | STT Streaming (Nova 3) | Unknown (pay-as-you-go) | 500 concurrent streams | **VERIFY** — contact Deepgram |
| **Telnyx** | Voice Calls | Active Voice API application | 500 concurrent | **VERIFY** — confirm account capacity and WebSocket media limits |
| **OpenAI** | Embeddings | 3,000 RPM / 1M TPM | ~2,000-4,000 RPM | **AT RISK** — prefetch cache mitigates |
| **Groq** | Director primary | Verify account limits | 500 concurrent Director calls | **VERIFY** — current primary Director provider |
| **Gemini** | Director fallback + Analysis | 1,500 RPM (free tier) | Fallback Director + ~500 post-call burst | **AT RISK** — post-call bursts can contend with fallback Director |

### Anthropic — HARD BLOCKER

```
Current tier rate limits:
  Requests:      1,000 RPM
  Input tokens:  450,000 TPM
  Output tokens: 90,000 TPM

500 concurrent calls × 2 LLM calls/min:
  Requests:      1,000 RPM  → AT LIMIT
  Input tokens:  ~5,000,000 TPM → 11x OVER LIMIT
  Output tokens: ~500,000 TPM → 5.5x OVER LIMIT
```

**Fix**: Upgrade to Build tier (4,000 RPM / 2M input TPM) or Scale tier (8,000 RPM / 4M+ TPM). Contact Anthropic for custom limits at 500 concurrent.

### ElevenLabs — HARD BLOCKER

```
Current plan: Creator ($22/mo)
  Concurrent streams: ~5
  Character limit: 148,460/month

500 concurrent calls need:
  Concurrent streams: 500
  Characters/month: ~40M (8,000 calls × 10min × ~500 chars/min)
```

**Fix**: Upgrade to Enterprise plan. Even Scale tier (25 concurrent) is insufficient. Need custom agreement for 500 concurrent WebSocket streams.

### Groq/Gemini Director Capacity — VERIFY

Groq is the current primary Director provider (`GROQ_API_KEY`, `GROQ_DIRECTOR_MODEL`). Gemini remains the fallback for full guidance analysis and is also used for post-call analysis, so fallback Director traffic can contend with post-call bursts.

**Fix**: Verify Groq RPM/concurrency limits for the Director workload and ensure Gemini limits cover fallback plus post-call analysis, or move Director fallback to a HIPAA-eligible paid tier.

### OpenAI Embeddings — AT RISK

```
Current limits: 3,000 RPM / 1,000,000 TPM
Peak demand: 500 calls × 4-8 memory retrieval/prefetch attempts per call = 2,000-4,000 RPM
```

Mitigated by predictive prefetch cache and Director-owned memory injection; most repeated memory requests hit the session cache at ~0ms and Claude no longer calls a separate `search_memories` tool in the live path. Real embedding API calls estimated at ~500-1,000 RPM after cache hits. **Should be OK** but monitor during rollout.

### Required Actions Before 500 Concurrent

| Action | Priority | Who | Estimated Cost |
|--------|----------|-----|----------------|
| Upgrade Anthropic tier to Build/Scale | **P0** | Account admin | ~$1,000-5,000/mo |
| Upgrade ElevenLabs to Enterprise | **P0** | Account admin | Custom pricing |
| Verify Groq Director limits and Gemini fallback/post-call headroom | **P0** | DevOps | Depends on plan |
| Verify Deepgram concurrent stream limit | **P1** | Account admin | Contact sales |
| Verify Telnyx concurrent call capacity | **P1** | Account admin | Check dashboard/support limits |
| Set Railway instance to 8GB+ RAM | **P1** | DevOps | ~$20-40/mo |
| Consider multi-instance (2-3 replicas) | **P2** | Engineering | Architecture work |

---

## Key Files

| File | Purpose |
|------|---------|
| `pipecat/main.py` | Semaphore, health endpoint, graceful shutdown |
| `pipecat/db/client.py` | Connection pool, slow query logging |
| `pipecat/lib/redis_client.py` | Redis/InMemory shared state |
| `services/scheduler.js` | Active Node scheduler, call planning, reminder prewarm, outbound retries |
| `pipecat/services/scheduler.py` | Pipecat-side scheduler helpers and Redis reminder-context handoff; disabled for active production scheduling |
| `pipecat/api/routes/telnyx.py` | Telnyx webhooks, context prewarm, outbound call creation, call termination |
| `pipecat/scripts/rollout.sh` | Production rollout script |
| `db/migrations/001_add_indexes.sql` | Database index definitions |
