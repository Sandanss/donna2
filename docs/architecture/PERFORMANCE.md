# Performance Architecture

> Latency budgets, optimization strategies, and resilience patterns for the Donna voice pipeline.

---

## Pipeline Latency Budget

End-to-end voice latency from user speech to Donna's audio response:

```
User speaks → [STT] → [Observer] → [Director] → [LLM] → [TTS] → Audio out
               200ms     0ms         (async)     800ms    300ms
```

| Component | Latency | Type | Notes |
|-----------|---------|------|-------|
| Deepgram STT | ~200-300ms | Streaming | Nova 3, Telnyx L16/16k PCM, interim results |
| Quick Observer | 0ms | Blocking | Regex pattern data, inline |
| Conversation Director | Async | Non-blocking | Groq primary, Gemini fallback; speculative results can be injected same-turn |
| Claude Haiku 4.5 | ~400-900ms | Streaming | Token-by-token via Pipecat; live dev calls showed materially lower TTFB than Sonnet |
| TTS | ~200-400ms | Streaming | ElevenLabs by default; active Telnyx calls request 16kHz PCM for stable output frames |
| **Total perceived** | **~1-2s** | | First audio chunk to user |

**Key insight**: Director LLM analysis runs asynchronously, so Groq/Gemini calls do not sit on the critical path. The only intentional Director delay is the bounded memory prefetch gate on final transcripts (up to 500ms), which trades a small wait for avoiding slower live memory tool calls. Speculative guidance can be injected same-turn when it completes before final transcription, otherwise the previous-turn/fallback guidance is used.

### Audio Quality Policy

Runtime source of truth: `pipecat/bot.py:get_audio_profile()`, `pipecat/bot_gemini.py`, and the active telephony serializer.

Donna keeps audio linear and wideband across the active Telnyx phone path:

- Telnyx media streams use `L16` at `16000Hz`.
- `TELNYX_L16_INPUT_BYTE_ORDER=little` and `TELNYX_L16_OUTPUT_BYTE_ORDER=little` match the verified Telnyx media payload behavior.
- Active Telnyx phone calls request `16000Hz` TTS output to avoid live resampling artifacts.
- `ELEVENLABS_OUTPUT_SAMPLE_RATE=44100` for non-phone ElevenLabs TTS output.
- `CARTESIA_OUTPUT_SAMPLE_RATE=48000` with `pcm_s16le` for non-phone Cartesia Sonic 3 output.
- `GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE=24000` for the Gemini Live evaluation path.
- `DonnaTelnyxFrameSerializer` owns the final Telnyx L16/16k wire boundary.

This avoids the old 8kHz μ-law bottleneck and keeps the production phone path at 16kHz until carrier/PSTN limits take over.

---

## Scheduled Outbound Reminder Prewarm

**Active files**: `services/scheduler.js`, `services/telnyx.js`, `pipecat/api/routes/telnyx.py`

Scheduled reminder calls no longer rely on doing the full senior-context hydrate on the exact dial request. The Node scheduler looks ahead roughly 2-3 minutes, asks Pipecat `/telnyx/prewarm` to assemble the outbound reminder context early, caches that payload locally for a few minutes, and includes it on the eventual `/telnyx/outbound` call.

This shifts the expensive reminder-context work off the dial critical path while keeping the existing safety net:

- Node still re-checks that the reminder is due before dialing.
- Pipecat validates that the prewarmed payload matches `seniorId`, `callType`, `reminderId`, and `scheduledFor`.
- If the warm payload is missing, expired, or mismatched, Pipecat falls back to the existing live hydration path.

Result: scheduled reminder calls usually spend ring time on Telnyx setup and conversation creation, not on memory/context assembly.

---

## Outbound Dispatch & Cross-Replica Capacity

**Active files**: `services/call-queue.js`, `services/pipecat-capacity.js`, `pipecat/services/capacity.py`

The dispatcher reads available capacity from a cross-replica registry before issuing a queue lease, so a hot replica is not handed more calls than it can run. Heartbeat shape:

| Field | Source | Used for |
|---|---|---|
| `instance_id` | Pipecat env (`HOSTNAME` / `RAILWAY_REPLICA_ID`) | dedupe heartbeats |
| `active_calls` | Pipecat in-process counter | per-instance occupancy |
| `inbound_active_calls` | Pipecat counter (calls without `is_outbound=true`) | subtract inbound load from outbound capacity |
| `max_calls` | Pipecat `MAX_CALLS` config | per-instance ceiling |
| `pending_start_count` | active reservations not yet attached to a call | overbook protection |
| `draining` | `_is_draining()` global | dispatcher excludes the replica |
| `healthy` | heartbeat publisher health | dispatcher/autoscaler health signal |
| `ready` | readiness warm-up and health gate | dispatcher excludes unready replicas |
| `warmup_gate_green` | `services/readiness.py` warm-up gate | autoscaler readiness signal |
| `db_pool_stats_available` | asyncpg pool inspection | tells operators whether pool stats are present |
| `db_pool_size` | asyncpg pool stats | DB pressure signal |
| `db_pool_idle` | `asyncpg` pool stats | back-pressure signal |
| `circuit_breakers_open` | breaker registry | back-pressure signal |

Publisher: `pipecat/services/capacity.py` writes to `pipecat:instance:{id}` every 5 s with a 15 s TTL. Reader: `services/pipecat-capacity.js` lists all `pipecat:instance:*` heartbeats via Redis (TCP) or Upstash REST, drops stale entries, and exposes available slots per instance to the dispatcher. There is no local heartbeat-registry fallback; without shared state, the queue code either falls back to configured batch-size capacity or blocks when the registry is required.

**Lease mechanics**: `services/call-queue.js:leaseQueuedCalls` uses `FOR UPDATE SKIP LOCKED` over `call_queue` and writes `(lease_owner, lease_expires_at)`. `reconcileQueueLeases` recovers expired leases and expires overdue queued rows past `latest_at`.

**Lane policy**: `DEFAULT_LANE_RESERVE_POLICY` reserves queue dispatch capacity for `manual`, `hard_reminder`, `reminder_retry`, `scheduled_checkin`, `welfare`, and `low_priority_retry`. Inbound calls are not queue-leased; they are reflected in `inbound_active_calls` and reduce available outbound capacity through the heartbeat totals. Lane reserves are computed against the summed available slots across replicas, not a single replica's slack.

**Rate-limit at the edge**: `pipecat/api/middleware/rate_limit.py` uses Redis storage when `REDIS_RATE_LIMITS_ENABLED=true` (fail-closed via `swallow_errors=False`). Service-to-service traffic from the labeled dispatcher API key bypasses the per-IP public limit — see [SECURITY.md](SECURITY.md) for the carve-out shape.

---

## Post-Call Job Workflow (Phase 6)

**Active files**: `services/post-call-jobs.js`, `scripts/run-post-call-worker-once.js`, `db/migrations/012_post_call_job_state_machine.sql`

Phase 6 adds a queued path for post-call work. When `POST_CALL_QUEUE_ENABLED=true`, Pipecat seeds the job DAG and defers heavy analysis, memory extraction, daily context, notifications, interest discovery, and snapshot rebuild to the Pipecat post-call worker. Jobs lease via `FOR UPDATE SKIP LOCKED` on `post_call_jobs`, respect the dependency DAG (`depends_on UUID[]`), and retry with PHI-free error codes.

**Provider/work concurrency caps:** the JS shadow worker still exposes provider semaphores (`db=200`, `anthropicHaiku=1`, `geminiFlash=1`, `openAiEmbeddings=1`, `resend=1`). The Pipecat execution worker has bounded per-process concurrency (`--concurrency`, default 2); fleet-wide caps still require operational worker-count control or a future distributed limiter.

**Retry policy:** default `maxAttempts=5` with backoff `[30, 120, 480, 1920]` seconds; `analysis` and `memory_extraction` use a longer schedule (`[60, 300, 1800, 7200]`). After `maxAttempts`, the job is moved to `dead_letter` with a PHI-free reason code; the partial index `idx_post_call_jobs_dead_letter` keeps dead-letter scans cheap.

**Shadow/evidence runner:** `scripts/run-post-call-worker-once.js` requires `--confirm-db-writes` before it will run. `handler-mode=artifact_verification` validates existing artifacts, but the worker still mutates lease/status rows as part of the job lifecycle. Use this mode for Phase 6 backlog-drain and provider-concurrency evidence only where those DB writes are intentional.

---

## Capacity Planning (Phase 8)

**Active files**: `services/phase8-capacity-plan.js`, `services/phase8-autoscaler.js`, `services/railway-scaling.js`

The Phase 8 planner reads future `call_queue` rows for a window, current queue backlog, critical post-call backlog, and live `pipecat:instance:*` heartbeats, then emits a single `recommendation`:

| Action | Trigger |
|---|---|
| `scale_up` | projected demand or backlog exceeds current usable capacity. Budget/readiness/lane checks gate autoscaler application; the recommendation can still be emitted for operator visibility. |
| `wait_for_readiness` | one or more current replicas have not crossed the warm-up gate yet — do not count them as usable |
| `hold` | current count meets the window |
| `scale_down` | current count > target + safety; only applied if operator confirms checks pass |

**Warm-up window:** `PHASE8_WARMUP_MINUTES` (default 20) + `PHASE8_READY_MINUTES_BEFORE_WINDOW` (default 10). The autoscaler must apply `scale_up` early enough that new replicas finish warmup before the window opens; the planner is invoked at least 30 minutes ahead of a known call window per the runbook.

**Budget guard:** `hourly_cost_budget` is checked as `cost-per-replica-hour × targetReplicas ≤ hourly-budget`. A failed budget check short-circuits `scale_up` even if traffic would justify it; the operator gets a planner output explaining the gap and must use the admin override path to proceed.

**Defaults are safety-first.** `PHASE8_AUTOSCALER_DRY_RUN=true` and `PHASE8_AUTOSCALER_CONFIRM_SCALE=false` mean the long-running autoscaler loop is off by default. Production enables it only after Phase 7 exits cleanly. Every actuation writes an audit row with `operation=phase8_operator_override` (when manual) or the planner's reason code. Lane reserves from the dispatcher are summed across replicas the same way they are at lease time — the planner cannot recommend a target that violates the active lane policy.

---

## Predictive Context Engine

**File**: `pipecat/services/prefetch.py`

Speculative memory prefetch that starts while the user is still speaking:

### Two-Wave Prefetch

```
User starts speaking
    │
    ├── Wave 1: Interim transcription arrives (~200ms)
    │   └── Raw utterance query → memory search starts
    │
    └── Wave 2: Query Director analysis (~200ms)
        └── Memory query extraction → memory search starts
            │
            ▼
    Cache populated BEFORE user finishes speaking
    │
    ▼
    Director memory injection → cache HIT (~0ms)
```

### Cache Design
- **Jaccard fuzzy matching**: Query "tell me about his garden" matches cached "gardening interests" (similarity > 0.3)
- **TTL**: 30 seconds per entry
- **Max entries**: 10 (LRU eviction)
- **Hit rate**: Reduces repeated memory context lookups from ~200-300ms to ~0ms

### Impact
Without prefetch: each live memory lookup = embedding generation + pgvector query (~200-300ms)
With prefetch: cache hit = dict lookup (~0ms), avoiding repeated embedding API calls per call

---

## Database Performance

### HNSW Vector Index

**File**: `db/migrations/001_add_indexes.sql`

```sql
CREATE INDEX idx_memories_embedding_hnsw
  ON memories USING hnsw(embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

| Metric | Before (Sequential Scan) | After (HNSW) |
|--------|-------------------------|--------------|
| 1K memories | ~50ms | ~5ms |
| 10K memories | ~500ms | ~5ms |
| 100K memories | ~5,000ms | ~8ms |
| Complexity | O(n) | O(log n) |

### B-Tree Indexes (10 total)

Hot path queries optimized with targeted indexes:

| Query Path | Table | Index | Frequency |
|------------|-------|-------|-----------|
| WebSocket message lookup | conversations | call_sid | Every WS message |
| Memory search | memories | senior_id | 4-8x per call |
| Context loading | conversations | senior_id + started_at DESC | Call start |
| Scheduler polling | reminders | scheduled_time WHERE active | Every 60s |
| Daily context | daily_call_context | senior_id + call_date | Call start |

### Slow Query Detection

**File**: `pipecat/db/client.py`

All database operations (`query_one`, `query_many`, `execute`) are wrapped with timing:

```python
_SLOW_QUERY_THRESHOLD_MS = 100

elapsed_ms = (time.monotonic() - t0) * 1000
if elapsed_ms > _SLOW_QUERY_THRESHOLD_MS:
    logger.warning("Slow query ({ms:.0f}ms): {sql}", ms=elapsed_ms, sql=sql[:120])
```

### Connection Pool Monitoring

Pool statistics available on every `/health` response:

```json
{
  "pool": {
    "size": 15,
    "idle": 8,
    "max": 50,
    "min": 5
  }
}
```

Alert thresholds:
- `idle < 5` — approaching pool exhaustion
- `size == max` — all connections in use, new queries will wait

---

## Circuit Breakers

**File**: `pipecat/lib/circuit_breaker.py`

Prevents cascading failures when external services are slow or unavailable:

```
CLOSED ──(failure_threshold reached)──► OPEN ──(recovery_timeout elapsed)──► HALF_OPEN
  ▲                                       │                                      │
  │                                       │ (returns fallback)                   │
  └──────(success in half_open)───────────┘◄──────(success)──────────────────────┘
                                          │
                                          └──────(failure)──► OPEN (reset timer)
```

### Configured Breakers

| Breaker | Timeout | Failures to Open | Recovery | Fallback |
|---------|---------|-------------------|----------|----------|
| `groq_director` | 8s | 5 | 60s | Fall back to Gemini/full guidance path where available |
| `groq_speculative` | 5s | 3 | 30s | Skip same-turn speculative guidance |
| `groq_query` | 3s | 3 | 30s | Skip query-derived memory prefetch for that turn |
| `gemini_director` | 10s | 3 | 60s | Skip fallback Director analysis (call continues without guidance) |
| `anthropic_analysis` | 15s | 3 | 60s | Use default post-call analysis fallback |
| `openai_news` | 10s | 3 | 60s | Skip cached news fetch |
| `tavily_search` | 8s | 3 | 60s | Fall back to OpenAI web search |
| `openai_embedding` | 10s | 3 | 60s | Skip memory store/search for that turn |

### Health Reporting

Circuit breaker states exposed on `/health`:

```json
{
  "circuit_breakers": {
    "groq_director": "closed",
    "groq_speculative": "closed",
    "groq_query": "closed",
    "gemini_director": "closed",
    "anthropic_analysis": "closed",
    "openai_news": "closed",
    "tavily_search": "closed",
    "openai_embedding": "closed"
  }
}
```

### Degraded Operation
When a circuit breaker opens, the call continues in degraded mode:
- **Director open**: No same-turn guidance or fallback guidance — Claude responds based on system prompt and existing context
- **News/search open**: Donna skips cached news or uses the fallback search provider where possible
- **Embedding open**: No memory search/store — call relies on pre-loaded context only
- Both are non-fatal: the user still has a conversation, just with less contextual awareness

---

## Graceful Shutdown (Multi-Instance Aware)

Two coordinated drain sequences run on shutdown:

**Pipecat** (`pipecat/main.py`):
- `_is_draining()` returns true on SIGTERM or when `PIPECAT_DRAINING=true`.
- New websocket connections are rejected (`/ws` closes with 1001).
- Capacity heartbeat reports `draining=true` so the dispatcher excludes the replica from new dial decisions within one heartbeat (≤ 5 s).
- Existing calls continue to completion under the in-process active-call counter.
- `/health` returns `status: "draining"` with 503 so load balancers stop sending new HTTP traffic.

**Node** (`index.js`):
- `setQueueDispatcherDraining(true)` stops new lease cycles.
- `drainQueueDispatcherReservations()` waits up to `NODE_DISPATCHER_DRAIN_TIMEOUT_MS` (default 30 s) for in-flight reservations to release.
- Reservations not released within the deadline are forcibly cleaned up; their associated `call_queue` rows are still recoverable by the next replica's reconciler via expired lease recovery.



**File**: `pipecat/main.py` (lines 278-299)

Prevents mid-call disconnections during deployment:

```python
@app.on_event("shutdown")
async def shutdown():
    _shutting_down = True

    if _active_tasks:
        # Give active calls 7s to finish (Railway gives 10s)
        done, pending = await asyncio.wait(list(_active_tasks), timeout=7.0)
        if pending:
            for t in pending:
                t.cancel()
            await asyncio.wait(pending, timeout=2.0)

    await close_pool()  # Close DB pool last
```

- Active calls tracked via `_active_tasks` set
- 7-second drain period on SIGTERM
- Railway's grace period is 10 seconds
- DB pool closed only after all calls drained

---

## Context Strategy: Full APPEND

All call phases use `APPEND` context management (no summary truncation):

| Strategy | Behavior | Trade-off |
|----------|----------|-----------|
| **APPEND** (used) | Full conversation history retained | More tokens, better coherence |
| RESET_WITH_SUMMARY | Summarize then clear | Fewer tokens, loses nuance |

For a 10-minute call (~30 turns), APPEND uses ~15K input tokens per LLM call by the end. This is well within Claude's context window and provides superior conversation quality for elderly users who may reference earlier topics.

---

## Call Ending Optimization

### Problem
LLM tool calls for ending calls are unreliable — Claude says goodbye in text but doesn't call transition tools, leading to awkward hanging calls.

### Solution: Programmatic EndFrame

**File**: `pipecat/processors/quick_observer.py`

```
User: "Bye Donna!"
    │
    ├── Quick Observer detects STRONG goodbye pattern
    ├── Sets _goodbye_in_progress flag (suppresses Director)
    ├── If call is at least 60s old, starts 5s timer (default)
    │
    ▼ (5s later — lets Claude/TTS finish the goodbye)
    │
    EndFrame injected → Pipeline shutdown → active telephony serializer terminates call
```

- 60s minimum call-age guard reduces false early hangups
- Single "bye", "take care", and "have a good day" style phrases are weak signals and do not force-end by themselves
- Same-utterance continuations such as "goodbye... oh wait" are downgraded and do not force-end
- 5s default delay allows Claude/TTS to complete a natural goodbye response
- Bypasses LLM decision-making entirely (100% reliable)
- Director suppressed during goodbye to prevent stale "RE-ENGAGE" guidance

---

## Performance Monitoring

### Liveness Endpoint (`/live`)

Railway deploy health checks use Pipecat's lightweight `/live` endpoint. It
only verifies that the FastAPI process is serving requests and does not touch
Postgres, Redis, LLM providers, or other external dependencies. This keeps
deploys from failing during a short staging cold-start window before the
readiness smoke test can run.

### Readiness Endpoint (`/health`)

`/health` remains the readiness endpoint for CI smoke tests and monitoring. It
verifies database reachability and reports pool, cache, circuit breaker, and
call metrics.

```json
{
  "status": "ok",
  "service": "donna-pipecat",
  "active_calls": 12,
  "peak_calls": 47,
  "max_calls": 50,
  "uptime_seconds": 86400,
  "database": "ok",
  "pool": { "size": 15, "idle": 8, "max": 50, "min": 5 },
  "circuit_breakers": {
    "groq_director": "closed",
    "groq_speculative": "closed",
    "groq_query": "closed",
    "gemini_director": "closed",
    "anthropic_analysis": "closed",
    "openai_news": "closed",
    "tavily_search": "closed",
    "openai_embedding": "closed"
  }
}
```

### What to Monitor

| Metric | Source | Alert Threshold |
|--------|--------|----------------|
| Active calls | `/health` | >80% of max_calls |
| Pool idle | `/health` pool.idle | <5 |
| Circuit breakers | `/health` circuit_breakers | Any "open" |
| Slow queries | Railway logs | >100ms |
| Call duration | conversations table | Avg >15min (possible hang) |
| Post-call time | Railway logs | >15s (parallelization regression) |

---

## Key Files

| File | Purpose |
|------|---------|
| `pipecat/services/prefetch.py` | Predictive context prefetch engine |
| `pipecat/lib/circuit_breaker.py` | Circuit breaker pattern |
| `pipecat/db/client.py` | Pool config, slow query logging |
| `pipecat/main.py` | Health endpoint, graceful shutdown |
| `pipecat/processors/quick_observer.py` | Programmatic call ending |
| `db/migrations/001_add_indexes.sql` | HNSW + B-tree indexes |
