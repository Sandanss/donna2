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
| `gemini_analysis` | 15s | 3 | 60s | Use default post-call analysis fallback |
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
    "gemini_analysis": "closed",
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

## Graceful Shutdown

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
    "gemini_analysis": "closed",
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
