# Infrastructure Reliability for 8000+ Users

> Historical scale plan. Use `docs/architecture/SCALABILITY.md` for current capacity assumptions, Telnyx voice, and provider-limit blockers.

**Date:** 2026-03-07
**Branch:** `feat/droid-4-workspace`
**Timeline:** 3-4 weeks (phased, alongside other feature work)
**Status:** Complete

---

## Overview

Build the infrastructure foundation (feature flags, observability, reliability) that enables safe scaling to 8000+ users.

Three pillars:
1. **GrowthBook** — Feature flags + A/B experiments
2. **Observability App** — Operational metrics + dashboards
3. **Reliability Hardening** — Circuit breakers, graceful shutdown, memory safety

---

## Pillar 1: GrowthBook (Feature Flags + Experiments)

**Status:** Complete (all environments deployed)
**Timeline:** Week 1-2

### Deployment: GrowthBook Cloud

**Decision:** Use GrowthBook Cloud (app.growthbook.io) instead of self-hosting.

Self-hosting was attempted but abandoned due to:
- FerretDB v2.x requires the DocumentDB PostgreSQL extension (Neon doesn't support it)
- FerretDB v1.x had auth compatibility issues
- GrowthBook requires two ports (3000 UI + 3100 API) but Railway only exposes one public domain per service

GrowthBook Cloud's free tier supports unlimited feature flags, which is all we need. No Railway services to maintain.

```
Admin UI:    https://app.growthbook.io (manage flags here)
SDK API:     https://cdn.growthbook.io (Pipecat + Node.js connect here)
Client Key:  Set as GROWTHBOOK_CLIENT_KEY on donna-pipecat + donna-api
```

### SDK Integration

**Pipecat (Python)** — Flags resolve once per call, cached in session state:

```python
from growthbook import GrowthBook

# In bot.py, on call start
gb = GrowthBook(
    api_host=config.settings.growthbook_api_host,
    client_key=config.settings.growthbook_client_key,
    attributes={
        "id": senior_id,
        "timezone": senior.get("timezone"),
        "call_type": session_state.get("call_type"),
    },
)
await gb.load_features()
session_flags = {
    "director_enabled": gb.is_on("director_enabled"),
    "news_search_enabled": gb.is_on("news_search_enabled"),
    "memory_search_enabled": gb.is_on("memory_search_enabled"),
    "tts_fallback": gb.is_on("tts_fallback"),
}
```

**Node.js (Express)** — Flags resolve per scheduler cycle:

```javascript
const { GrowthBook } = require("@growthbook/growthbook");

const gb = new GrowthBook({
    apiHost: process.env.GROWTHBOOK_API_HOST,
    clientKey: process.env.GROWTHBOOK_CLIENT_KEY,
    attributes: { id: seniorId, timezone: senior.timezone },
});
await gb.loadFeatures();
const callStagger = gb.getFeatureValue("scheduler_call_stagger_ms", 5000);
```

### Initial Flags (Kill Switches First)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `director_enabled` | boolean | true | Disable Director if Gemini/Groq goes down |
| `news_search_enabled` | boolean | true | Disable web search if OpenAI is down |
| `memory_search_enabled` | boolean | true | Disable semantic search if embeddings fail |
| `tts_fallback` | boolean | false | Switch TTS provider if ElevenLabs degrades |
| `scheduler_call_stagger_ms` | number | 5000 | Tune call spacing without redeploying |
| `context_cache_enabled` | boolean | true | Disable pre-caching if it causes load |
| `post_call_analysis_enabled` | boolean | true | Disable post-call if Gemini quota exceeded |

### Cleanup

Delete the dead DB-backed feature flag system:
- `pipecat/lib/feature_flags.py`
- `pipecat/db/migrations/create_feature_flags.sql`
- `refresh_flags()` call in `pipecat/main.py` (lines 215-220)
- Unused config fields: `cofounder_api_key_1`, `cofounder_api_key_2` in `pipecat/config.py`

Also delete unused middleware files:
- `pipecat/api/middleware/api_auth.py`
- `pipecat/api/middleware/twilio.py`

### Implementation Steps

1. [x] Clean up dead code (feature flags, unused middleware, config fields)
2. [x] Add `growthbook>=1.0.0` to `pipecat/pyproject.toml`
3. [x] Add `@growthbook/growthbook` to root `package.json`
4. [x] Add GrowthBook config fields to `pipecat/config.py`
5. [x] Create GrowthBook helper modules (`pipecat/lib/growthbook.py` + `lib/growthbook.js`)
6. [x] Integrate into `bot.py` — resolve flags at call start
7. [x] Integrate into `services/scheduler.js` — resolve flags per cycle
8. [x] Wire flags into existing code paths (Director, news, memory, post-call analysis)
9. [x] Deploy GrowthBook + FerretDB on Railway (dev environment)
10. [x] Create initial org + SDK connection in GrowthBook Cloud
11. [x] Set `GROWTHBOOK_CLIENT_KEY` on donna-pipecat + donna-api (all environments)
12. [x] Seed initial flags via GrowthBook REST API
13. [x] Deploy to staging + production (GrowthBook Cloud — no self-hosted services)

---

## Pillar 2: Observability App (Operational Metrics)

**Status:** Complete (data collection, API, dashboards, Sentry breadcrumbs done)
**Timeline:** Week 2-3

### Metrics to Track

**Call Health:**
- Active concurrent calls (real-time gauge)
- Call success/failure rate (hourly, daily)
- Average call duration by phase (opening, main, winding_down, closing)
- Calls ended by: goodbye detection, Director timeout, user hangup, error

**Latency:**
- STT transcription latency (Deepgram)
- LLM time-to-first-token (Claude)
- TTS generation latency (ElevenLabs)
- Director analysis latency (Gemini/Groq)
- End-to-end turn latency (user speaks → Donna responds)

**Infrastructure:**
- Circuit breaker states (closed/open/half_open) for each service
- Database connection pool utilization (active/idle/max)
- Memory usage per Pipecat instance
- Scheduler queue depth (pending reminders)

**Errors:**
- Sentry error rate (grouped by service)
- API error rate by endpoint
- External service failure rate (Anthropic, Deepgram, ElevenLabs, OpenAI, Google)

### Architecture

```
Pipecat Pipeline                    Node.js API
     │                                   │
     ├── MetricsLogger processor         ├── Scheduler metrics
     │   (already exists, expand it)     │   (add timing + counters)
     │                                   │
     └──► POST /api/metrics ◄────────────┘
              │
              ▼
         Neon Postgres
         (call_metrics table)
              │
              ▼
    Observability App (apps/observability/)
    ├── Dashboard: Real-time call map
    ├── Dashboard: Latency trends
    ├── Dashboard: Circuit breaker states
    └── Dashboard: Error rates (Sentry API)
```

### Data Collection

Expand the existing `MetricsLogger` processor (`pipecat/processors/metrics_logger.py`) to emit structured metrics:

```python
# Emit per-call metrics at call end
metrics = {
    "call_sid": call_sid,
    "duration_seconds": duration,
    "phases": {"opening": 12, "main": 480, "winding_down": 60, "closing": 15},
    "latency": {"stt_avg_ms": 120, "llm_ttft_ms": 340, "tts_avg_ms": 200},
    "breakers": {"memory": "closed", "director": "closed", "news": "open"},
    "end_reason": "goodbye_detected",  # or "director_timeout", "user_hangup", "error"
    "turns": 24,
    "tools_called": ["search_memories", "get_news"],
}
```

### New Database Table

```sql
CREATE TABLE IF NOT EXISTS call_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_sid TEXT NOT NULL,
    senior_id UUID REFERENCES seniors(id),
    duration_seconds INTEGER,
    end_reason TEXT,
    turn_count INTEGER,
    phase_durations JSONB,
    latency JSONB,
    breaker_states JSONB,
    tools_used TEXT[],
    error_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_call_metrics_created_at ON call_metrics(created_at DESC);
CREATE INDEX idx_call_metrics_senior_id ON call_metrics(senior_id);
```

### Observability App Upgrades

Add 4 dashboard pages to `apps/observability/`:

1. **Live Calls** — Real-time view of active calls, duration, phase
2. **Latency** — Time-series charts of STT/LLM/TTS latency (1h, 24h, 7d)
3. **Reliability** — Circuit breaker states, error rates, uptime
4. **Capacity** — Concurrent calls, DB pool utilization, scheduler queue

### Sentry Alerting

Configure Sentry alert rules (via Sentry UI, not code):
- **P1:** Any unhandled exception in Pipecat → email immediately
- **P2:** Error rate > 5% over 5 minutes → email
- **P3:** Circuit breaker opens → email (log event from circuit_breaker.py)

### Implementation Steps

1. [x] Create `call_metrics` table migration
2. [x] Expand `MetricsLogger` processor to collect full metrics
3. [x] Add metrics persistence in `post_call.py` (write to `call_metrics` after analysis)
4. [x] Add `/api/metrics` endpoint to Pipecat for real-time queries
5. [x] Add circuit breaker state change logging (Sentry breadcrumbs)
6. [x] Upgrade observability app: infrastructure dashboard page
7. [ ] Configure Sentry alert rules (via Sentry UI, not code)

---

## Pillar 3: Reliability Hardening

**Status:** Complete
**Timeline:** Week 3-4

### Circuit Breakers → GrowthBook Kill Switches

Wire existing circuit breakers to GrowthBook flags so you can disable failing services from the admin UI without redeploying:

```python
# In services/memory.py
async def search_memories(senior_id, query, limit=5):
    if not gb_flags.get("memory_search_enabled", True):
        return []  # Graceful skip
    if memory_breaker.is_open:
        return []  # Circuit breaker tripped
    # ... normal search
```

Same pattern for Director, news, TTS, and post-call analysis.

### Graceful Shutdown

When Pipecat receives SIGTERM (Railway restart/deploy):

```python
import signal

async def graceful_shutdown(sig):
    logger.info("Shutdown signal received, draining calls...")
    # 1. Stop accepting new WebSocket connections
    # 2. Wait for active calls to finish (max 2 minutes)
    # 3. Run post-call processing for any in-flight calls
    # 4. Close DB pool
    # 5. Exit

signal.signal(signal.SIGTERM, lambda s, f: asyncio.create_task(graceful_shutdown(s)))
```

Currently, a Railway deploy kills active calls immediately. With graceful shutdown, in-progress calls finish naturally (up to a 2-minute drain period).

### Memory Leak Prevention

**Problem:** In-memory caches (`pending_reminder_calls`, `prefetched_context_by_phone`, `_cache`) grow unbounded if cleanup fails.

**Fix:** Add TTL-based background cleanup:

```python
async def cache_cleanup_loop():
    """Run every 5 minutes, evict expired entries."""
    while True:
        await asyncio.sleep(300)
        now = time.time()
        # Clean context cache
        expired = [k for k, v in _cache.items() if now > v.get("expires_at", 0)]
        for k in expired:
            del _cache[k]
        # Clean stale pending calls (older than 30 min)
        stale = [k for k, v in pending_reminder_calls.items()
                 if now - v.get("created_at", 0) > 1800]
        for k in stale:
            del pending_reminder_calls[k]
```

### Health Endpoint Improvements

Upgrade `/health` from basic "ok" to detailed service health:

```json
{
    "status": "healthy",
    "version": "4.1.0",
    "uptime_seconds": 86400,
    "active_calls": 12,
    "db_pool": {"active": 3, "idle": 7, "max": 10},
    "breakers": {
        "memory": "closed",
        "director": "closed",
        "news": "half_open",
        "call_analysis": "closed"
    },
    "cache": {
        "context_entries": 142,
        "pending_calls": 2,
        "prefetched_phones": 5
    },
    "flags": {
        "source": "growthbook",
        "last_refresh": "2026-03-07T10:00:00Z"
    }
}
```

### Implementation Steps

1. [x] Wire circuit breakers to GrowthBook kill switches
2. [x] Implement graceful shutdown (SIGTERM handler + drain period) — already existed, added connection rejection
3. [x] Add TTL-based cache cleanup loop (`lib/cache_cleanup.py`)
4. [x] `created_at` timestamps already present on all in-memory cache entries
5. [x] Upgrade `/health` endpoint with cache sizes, active calls, shutdown state
6. [x] Active call counter via `_active_tasks` set (increment on connect, decrement on done)
7. [x] Circuit breaker state reflected in health endpoint (status=degraded if any open)

---

## Phased Rollout

| Week | Focus | Deliverables |
|------|-------|-------------|
| **Week 1** | Pillar 1a: Cleanup + GrowthBook deploy | Dead code removed, GrowthBook + FerretDB running on Railway dev |
| **Week 2** | Pillar 1b: SDK integration + Pillar 2a: Metrics collection | Flags wired into Pipecat + Node.js, MetricsLogger expanded, call_metrics table |
| **Week 3** | Pillar 2b: Observability dashboards | 4 dashboard pages in observability app, Sentry alerts configured |
| **Week 4** | Pillar 3: Reliability hardening | Kill switches wired, graceful shutdown, cache cleanup, health endpoint v2 |

---

## Cleanup Checklist (Pre-Implementation)

- [x] Delete `pipecat/lib/feature_flags.py`
- [x] Delete `pipecat/db/migrations/create_feature_flags.sql`
- [x] Remove `refresh_flags()` from `pipecat/main.py`
- [ ] Remove `cofounder_api_key_1/2` from `pipecat/config.py` (kept — auth.py reads via os.getenv)
- [x] Delete `pipecat/api/middleware/api_auth.py`
- [x] Delete `pipecat/api/middleware/twilio.py`
- [x] Delete `docs/guides/DEPLOYMENT_PLAN.md`
- [x] Delete root `vercel.json`
- [x] Remove `@google/generative-ai` from root `package.json`
- [x] Remove `services/daily-context.js` (Node.js, unused)
- [x] Fix broken links in `README.md`
- [x] Fix duplicate entries in `pipecat/docs/ARCHITECTURE.md`
- [x] Update `DIRECTORY.md` references

---

*Design validated 2026-03-07. Implementation complete. Deployed to dev, staging, and production.*
