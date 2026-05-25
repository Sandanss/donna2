# Donna Pipecat — Architecture Overview

> Active Python voice pipeline for Donna, running alongside the Node.js API/scheduler backend.

## High-Level Architecture

```
                     ┌──────────────────────────────────────┐
                     │          Telnyx Voice Call            │
                     └─────────────┬────────────────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ /telnyx/events, /prewarm,    │
                    │ /outbound                    │
                    │ Reuses or fetches senior     │
                    │ context, creates conversation│
                    │ starts media stream to /ws   │
                    └──────────────┬───────────────┘
                                   │ WebSocket
                    ┌──────────────▼──────────────┐
                    │        main.py /ws            │
                    │   Accepts WS, validates       │
                    │   Telnyx start frame + token  │
                    │   before active-call capacity │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │        Pipecat Pipeline       │
                    │        (see below)            │
                    └──────────────────────────────┘
```

## Pipecat Pipeline (bot.py)

Linear pipeline of `FrameProcessor`s. The Conversation Director sits in the pipeline but is **non-blocking for LLM analysis** — Groq/Gemini work runs in background `asyncio.create_task()` calls, while final transcripts may briefly wait for the memory prefetch cache before Claude responds.

```
Telnyx Audio ──► FastAPIWebsocketTransport
                        │
                        ▼
                ┌───────────────┐
                │  Deepgram STT  │  (Speech-to-Text, Nova 3)
                └───────┬───────┘
                        │ TranscriptionFrame
                        ▼
              ┌─────────────────────┐
              │   Quick Observer     │  Layer 1: Instant regex (0ms)
              │   (BLOCKING)         │  → patterns: goodbye, emotion,
              │   (regex patterns)   │    family, activity
              │                      │  → Injects guidance for THIS turn
              │   Goodbye detected → │  → EndFrame after configurable delay
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐     ┌──────────────────────────┐
              │ Conversation         │     │  Background Analysis      │
              │ Director             │────►│  (asyncio.create_task)    │
              │ (PASS-THROUGH)       │     │                           │
              │                      │     │  Groq primary             │
              │ 1. Injects guidance  │     │  Gemini fallback          │
              │    (same-turn via    │     │  Result cached → injected │
              │    speculative, or   │     │  on NEXT turn (or same    │
              │    previous-turn)    │     │  via speculative)         │
              │ 2. Injects news when │     │                           │
              │    Director signals  │     │  Also handles:            │
              │ 3. Brief memory gate │     │  • Memory prefetch        │
              │    before Claude     │     │    (2 waves + interim)    │
              │ 4. Fires background  │     │  • Mid-call memory refresh│
              │    analysis ────────►│     │    (after 5+ min)         │
              │ 5. Passes other      │     │  • Force winding-down 9min│
              │    frames through    │     │                           │
              │                      │     │                           │
              │                      │     │                           │
              └─────────┬───────────┘     └──────────────────────────┘
                        │ (0-500ms memory gate)
                        ▼
              ┌─────────────────────┐
              │  Context Aggregator  │  Builds LLM context from
              │  (user side)         │  transcription frames
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │   Anthropic LLM      │  Claude Haiku 4.5 (streaming)
              │   + Flow Manager     │  2 tools, conditional reminder + main/wind-down/closing
              └─────────┬───────────┘
                        │ TextFrame
                        ▼
              ┌─────────────────────┐
              │  Guidance Stripper   │  Removes <guidance>...</guidance>
              │                      │  tags and [BRACKETED] directives
              │                      │  before TTS and transcript
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │ Conversation Tracker │  Tracks topics, questions,
              │                      │  advice per call. Stores
              │                      │  stripped transcript text
              └─────────┬───────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │   TTS Service        │  Telnyx calls use 16kHz PCM;
              │                      │  non-phone paths can use higher rates
              └─────────┬───────────┘
                        │ AudioFrame
                        ▼
              FastAPIWebsocketTransport ──► Telnyx Audio (16kHz L16)
                        │
                        ▼
              ┌─────────────────────┐
              │  Context Aggregator  │  Tracks assistant responses
              │  (assistant side)    │  for conversation history
              └─────────────────────┘
```

## How Pipeline Components Communicate

The pipeline processors don't call each other directly. They communicate through two mechanisms:

1. **Frame injection** — Quick Observer and Conversation Director inject guidance into the LLM context by pushing `LLMMessagesAppendFrame` frames. These get appended to Claude's message history before it generates a response, but they don't trigger an LLM call on their own (`run_llm=False`). The next `TranscriptionFrame` reaching the Context Aggregator triggers the actual LLM call, at which point all injected guidance is already in context.

2. **Shared `session_state` dict** — A mutable dictionary initialized in `main.py` and passed to every processor. Key shared state:
   - `_transcript` — Rolling conversation history (max 40 turns), written by ConversationTracker after guidance stripping, read by ConversationDirector for its Groq/Gemini analysis
   - `_goodbye_in_progress` — Set by QuickObserver when strong goodbye detected, read by Director to suppress stale guidance injection
   - `_call_start_time` — Set in bot.py, read by Director for time-based fallbacks
   - `_conversation_tracker` — Reference to the ConversationTracker processor, read by Flow nodes to build tracking summaries
   - `_prefetch_cache` — `PrefetchCache` instance, written by Director memory prefetch and read by proactive memory injection
   - `_news_injected` — Boolean flag, set by Director after injecting news context (one-shot per call)
   - `news_context` — Pre-fetched news string, read by Director for dynamic injection when `should_mention_news` is true
   - `_last_quick_analysis` — `AnalysisResult` from Quick Observer, read by prefetch engine for family/activity signals

3. **Pipeline task reference** — Both QuickObserver and Director receive a `set_pipeline_task(task)` call after pipeline creation. This lets them queue `EndFrame` directly to force call termination, bypassing the normal frame flow.

---

## Senior Context Assembly

Flow nodes build senior-specific prompt context from decrypted profile fields before the main flow starts:

- Current local date/time from the senior timezone
- Name, location, and English/Spanish call-language instruction
- Age and birthday awareness from `familyInfo.dateOfBirth`
- Interest IDs plus caregiver/AI detail text from `familyInfo.interestDetails`
- Additional family context from `additional_info`
- Topics to avoid from `familyInfo.topicsToAvoid`, with fallback to `preferred_call_times.topicsToAvoid` for onboarding-created rows
- Health notes, memory context, prior-call follow-ups, recent turns, and same-day context

Each section is also recorded in the context trace for observability. Application logs still use masked identifiers and must not print raw profile context.

---

## Runtime Audio Profile

Runtime source of truth is `bot.py:get_audio_profile()` plus the active serializer. Telnyx's default wire format is `16kHz` L16, and active Telnyx calls request TTS at that native phone rate for stable packet cadence. Non-phone/browser paths can still keep TTS/model audio at higher internal rates:

| Segment | Default | Config |
|---|---:|---|
| Incoming telephony wire | 16kHz L16 | Telnyx media streaming |
| STT/internal input | 16kHz PCM | `TELEPHONY_INTERNAL_INPUT_SAMPLE_RATE` |
| Telnyx phone TTS output | 16kHz PCM | Selected TTS provider, matched to Telnyx |
| Cartesia non-phone output | 48kHz `pcm_s16le` | `CARTESIA_OUTPUT_SAMPLE_RATE` |
| ElevenLabs non-phone output | 44.1kHz PCM | `ELEVENLABS_OUTPUT_SAMPLE_RATE` |
| Gemini Live output | 24kHz PCM | `GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE` |
| Telnyx output wire | 16kHz L16 | `DonnaTelnyxFrameSerializer` final conversion |

The rule is to keep TTS/model audio as PCM and avoid live telephony resampling whenever the carrier path already defines a stable native rate. Cartesia must remain PCM; using telephony-compressed output from the TTS provider double-encodes and produces garbled phone audio.

---

## 2-Layer Observer Architecture

### Layer 1: Quick Observer (0ms)

Instant regex-based analysis across Quick Observer categories:

| Category | Patterns | Effect |
|----------|----------|--------|
| **Emotion** | 25+ patterns with valence/intensity | Emotional tone detection |
| **Family** | 25+ relationship patterns including pets | Context enrichment |
| **Engagement** | Response length analysis | Engagement level tracking |
| **Goodbye** | Strong/weak goodbye detection | **EndFrame after configurable delay** |
| **Factual/Curiosity** | Question patterns ("what year", "how tall") | Direct-answer guidance |

**Guidance injection**: When patterns match, Quick Observer builds a guidance string (e.g., `[HEALTH] They mentioned pain. Ask how they are feeling.`) and pushes it as an `LLMMessagesAppendFrame` with `run_llm=False`. This appends a user-role message to Claude's context before the next LLM call, steering the response without adding latency.

**Model recommendations**: Quick Observer also generates token budget recommendations based on signal priority (16 ordered rules). Crisis situations get 350 tokens; simple questions get 100. This data is available on the `AnalysisResult` but is not currently consumed by the pipeline — it's designed for future dynamic token routing.

**Programmatic Goodbye**: When a strong goodbye signal is detected (e.g., "goodbye", "talk to you later"), Quick Observer schedules an `EndFrame` after `call_settings.goodbye_delay_seconds` or the 5-second default via the pipeline task reference. This bypasses unreliable LLM tool-calling for call termination. It also sets `session_state["_goodbye_in_progress"] = True` to suppress Director guidance injection during the goodbye.

### Layer 2: Conversation Director (non-blocking, speculative pre-processing)

Primary LLM: **Groq** (`gpt-oss-20b`). Fallback for full guidance: **Gemini Flash**. Runs via `asyncio.create_task()` — never blocks the pipeline.

The Director receives the senior's **location (city/state)** and **today's date** in every turn template, improving guidance and memory query specificity.

**Dynamic news injection**: News context is NOT in the system prompt (saves ~300 tokens/turn). Instead, the Director signals `should_mention_news: true` when contextually appropriate, and the processor injects news into the guidance. One-shot: injected at most once per call.

**Speculative pre-processing** enables same-turn guidance injection:

1. On each `InterimTranscriptionFrame` (while user speaks):
   - Stores latest interim text, resets 250ms silence timer
   - Cancels any running speculative analysis (text changed)
   - Debounced memory prefetch (1s gap, 15+ chars)
2. After 250ms gap in interims (silence detected):
   - Starts speculative Groq analysis using last interim text
3. On `TranscriptionFrame` (after VAD 1.2s silence):
   - **Checks speculative result**: if done + Jaccard(interim, final) ≥ 0.7 → injects **SAME-TURN** guidance
   - Otherwise falls back to **PREVIOUS-TURN** cached guidance (original behavior)
   - Takes fallback actions (force end, wrap-up injection)
   - If speculative wasn't used → starts regular background analysis
   - Starts 1st-wave regex prefetch (non-blocking)
4. Background analysis calls Groq (→ Gemini fallback for full guidance) with full conversation context
5. After analysis completes, starts 2nd-wave director-driven prefetch

**Metrics** (logged on EndFrame): `[Director] Call summary: 8 turns, 6/7 speculative hits (86%), 1 cancels`

**Fallback Actions** (when Claude misses things):
- **Force winding-down** at 9 minutes — overrides call phase to winding_down
- **Force call end** at 12 minutes — queues EndFrame after 3s delay
- **Force closing** when Director says closing + call > 8min — EndFrame after 5s

#### Director Output Schema

The Director classifies calls into 5 analytical phases (including "rapport" between opening and main), while the Flows state machine uses 4 phases (opening, main, winding_down, closing). The Director's `call_phase` is informational guidance — it doesn't directly control Flows transitions.

```json
{
  "analysis": {
    "call_phase": "opening|rapport|main|winding_down|closing",
    "engagement_level": "high|medium|low",
    "current_topic": "string",
    "emotional_tone": "positive|neutral|concerned|sad"
  },
  "direction": {
    "stay_or_shift": "stay|transition|wrap_up",
    "next_topic": "string or null",
    "should_mention_news": false,
    "news_topic": "string or null",
    "pacing_note": "good|too_fast|dragging|time_to_close"
  },
  "reminder": {
    "should_deliver": false,
    "which_reminder": "string or null",
    "delivery_approach": "how to weave in naturally"
  },
  "guidance": {
    "tone": "warm|empathetic|cheerful|gentle|serious",
    "priority_action": "main thing to do",
    "specific_instruction": "actionable guidance"
  },
  "prefetch": {
    "memory_queries": ["gardening", "grandson Jake"]
  }
}
```

#### Compact Guidance Injection

Director output is condensed into a single-line string injected as a `[Director guidance]` user message:

```
main/medium/warm | REMIND: Call Emma | (engaged)
winding_down/high/gentle | WINDING DOWN: Summarize key points, begin warm sign-off.
closing/medium/warm | CLOSING: Say a warm goodbye. Keep it brief.
```

### Predictive Context Engine (Speculative Prefetch)

The Director orchestrates a 2-wave speculative memory prefetch that eliminates memory tool-call latency. Memories are pre-fetched in the background and cached in `session_state["_prefetch_cache"]` so relevant memory context can be injected before Claude responds.

**Implementation**: `services/prefetch.py` (cache + extraction + runner), orchestrated by `conversation_director.py`.

#### Prefetch Timeline

```
User speaking...
  ├─ InterimTranscriptionFrame (every ~200ms from Deepgram)
  │   └─ Debounced prefetch (1s gap, 15+ chars, text changed)
  │      Regex topic extraction only → memory.search() → cache
  │
  └─ TranscriptionFrame (final, after VAD silence)
      │
      ├─ 1st wave (0ms): Regex extraction
      │   Topics (_TOPIC_PATTERNS from conversation_tracker)
      │   Entities ("my grandson", "my friend")
      │   Names ("My grandson Jake" → "Jake")
      │   Activities ("went to church", "played bingo")
      │   Quick Observer signals (family, activity)
      │   → memory.search() → cache
      │
      └─ 2nd wave (~70ms): Query Director analysis (Groq)
          next_topic → anticipatory memory prefetch
          which_reminder → reminder context prefetch
          news_topic → personal connection prefetch
          current_topic (2+ turns) → sustained topic prefetch
          memory_queries → memory.search() → cache
```

#### Cache Design (PrefetchCache)

- **TTL**: 30 seconds per entry
- **Max entries**: 10 (evicts oldest on overflow)
- **Lookup**: Jaccard word-overlap similarity (threshold=0.3), no embeddings needed
- **Dedup**: Skips queries already cached via `get_recent_queries()`
- **Concurrency**: Max 2 concurrent `memory.search()` calls per wave
- **Metrics**: Hits/misses/hit rate logged at call end via MetricsLogger

#### Proactive Memory Injection

The Director checks the prefetch cache before passing the final transcription onward:

```
Senior mentions gardening
  → _prefetch_cache.get("gardening")  (Jaccard fuzzy match, threshold=0.3)
  → HIT: inject memory context (~0ms)
  → MISS: continue naturally
```

#### Active Web Search Tool

Web search is handled by Claude's active `web_search` tool, not Director gating. The tool asks `services.news.web_search_query()` to use Tavily raw snippets first and OpenAI web search as fallback.

#### Director Guidance Hints

When the prefetch cache has entries, the Director attaches hints to its guidance:
```
main/medium/warm | CONTEXT AVAILABLE: Memories about gardening, grandson
```
This gives Claude the relevant memory directly without requiring a separate `search_memories` tool call.

## Pipecat Flows — Call Phase Management

The opening phase is merged into main — the bot starts directly in main (or reminder if pending) with the greeting prepended. This eliminates the `transition_to_main` double-LLM-call penalty (~3-5s saved on every call).

```
┌──────────────┐                            ┌──────────────┐
│   Reminder    │    transition_to_main      │    Main       │
│  (conditional)│ ─────────────────────────► │               │
│               │                            │ • Greeting +  │
│ • Greeting +  │                            │   Conversation│
│   reminders   │                            │ • Reminders   │
│ • respond_    │                            │ • Memory tools│
│   immediately │                            │ • News search │
│ (when initial)│                            │ • respond_    │
│               │                            │   immediately │
│               │                            │ (when initial)│
└──────────────┘                            └───────┬───────┘
                                                     │
                                    transition_to_winding_down
                                                     │
                                                     ▼
                                            ┌──────────────┐
                                            │ Winding Down  │
                                            │               │
                                            │ • Last remind │
                                            │ • Summary     │
                                            │ • Save details│
                                            └───────┬───────┘
                                                     │
                                        transition_to_closing
                                                     │
                                                     ▼
                                            ┌──────────────┐
                                            │   Closing     │
                                            │               │
                                            │ • Warm goodbye│
                                            │ • post_action:│
                                            │   end_convo   │
                                            │ • No tools    │
                                            └──────────────┘
```

### LLM Tools Available Per Phase

| Phase | Tools |
|-------|-------|
| **Reminder** *(conditional)* | `mark_reminder_acknowledged`, `transition_to_main` |
| **Main** | `web_search`, `mark_reminder_acknowledged`, `transition_to_winding_down` |
| **Winding Down** | `mark_reminder_acknowledged`, `transition_to_closing` |
| **Closing** | *(none — post_action ends call)* |

*Note: Memory and caregiver-note context is prefetched/injected. Web search remains an active Claude tool.*

### Context Strategies Per Phase

| Phase | Strategy | Effect |
|-------|----------|--------|
| **Reminder** *(when initial)* | APPEND / respond_immediately | Greeting + reminders, responds right away |
| **Main** *(when initial)* | APPEND / respond_immediately | Greeting + full conversation, responds right away |
| **Main** *(after reminder)* | APPEND | Full in-call context retention (no summary truncation) |
| **Winding Down** | APPEND | Preserves recent context for summary |
| **Closing** | APPEND | Preserves goodbye context |

### Tool Descriptions

| Tool | Purpose |
|------|---------|
| `mark_reminder_acknowledged` | Track reminder delivery with acknowledgment status |
| `web_search` | Search current information via Tavily first, OpenAI fallback |

## Post-Call Processing

When the telephony client disconnects, `run_post_call()` in `services/post_call.py` executes:

1. **Complete conversation** — Updates DB with duration, status, transcript
2. **Call analysis** — Gemini Flash generates a companion-call summary, engagement score (1-10), mood, and caregiver takeaways. Legacy concern/action/follow-up fields remain empty for compatibility. The encrypted JSON still includes a legacy `caregiver_sms` key, but SMS delivery is inactive.
2.5. **Caregiver notes + notifications** — Marks caregiver notes delivered only when assistant transcript evidence shows Donna delivered them. POSTs to Node.js API for call_completed notifications, raising on non-2xx responses and retrying transient failures once. Node sends email/in-app notification records; SMS is inactive.
3. **Summary persistence** — Writes analysis summary to `conversations.summary` (enables `get_recent_summaries()` and cross-call context)
3.5. **Interest discovery** — Maps new topics to predefined interest categories and updates `seniors.interests` plus editable `familyInfo.interestDetails`
3.6. **Interest scores** — Computes engagement scores per interest topic
4. **Memory extraction** — OpenAI extracts facts/preferences/events from transcript, stores with embeddings
5. **Daily context** — Saves topics, advice, reminders, and summary for same-day cross-call memory
6. **Reminder cleanup** — Waits briefly for any in-flight reminder acknowledgment write, re-reads `reminder_deliveries.status`, and marks unacknowledged reminders for retry
7. **Cache clearing** — Clears senior context cache and reminder context
8. **Snapshot rebuild** — Rebuilds `seniors.call_context_snapshot` JSONB (analysis, summaries, turns, daily context) so next call reads a single column instead of 6 queries

## Multi-Instance Runtime State (Phase 3 of scale-2000 rollout)

When more than one Pipecat replica is running, three pieces of state must be globally consistent:

1. **Active-call capacity** — The Node dispatcher needs to know which replica has slots before issuing a lease.
2. **Telnyx stream-start / websocket-token dedupe** — A signed Telnyx event can race itself; a `ws_token` must consume exactly once.
3. **Rate-limit counters** — Per-IP and per-key limits must reflect requests across replicas, not per-replica.

### Shared-state backend (`pipecat/lib/redis_client.py`)

Three modes, picked at startup:

| Backend | Trigger | `is_shared` |
|---|---|---|
| Redis TCP | `REDIS_URL` set | `True` |
| Upstash REST | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` set, no `REDIS_URL` | `True` while healthy (60 s circuit-breaker on failure) |
| In-memory | no shared backend configured | `False` |

`require_shared_state()` runs at startup and aborts when `PIPECAT_REQUIRE_REDIS=true` but no shared backend is available. `check_shared_state_health()` exposes the live result on `/health`.

**Fail-closed semantics:** SlowAPI rate limiting uses `swallow_errors=False` when configured to use Redis storage — a Redis outage causes 429 rather than silent in-memory fallback. Telnyx stream-start dedupe and websocket-token consumption only fall back to in-memory when `shared_state_required()` is false.

### Capacity heartbeat (`pipecat/services/capacity.py`)

```
publish_capacity_heartbeat() every 5 s ──► pipecat:instance:{id} hash (TTL 15 s)
   includes: instance_id, active_calls, max_calls, inbound_active_calls,
             pending_start_count, draining, healthy, db_pool_idle,
             circuit_breakers_open

list_capacity_instances() (Node side via services/pipecat-capacity.js):
   scans pipecat:instance:* keys
   drops entries older than 15 s
   sums available slots per instance, subject to lane-reserve policy
```

The heartbeat publisher is started by `start_capacity_heartbeat()` in `main.py`. The drain flag (`_is_draining()`) flows directly into the heartbeat so the dispatcher excludes a draining replica within one publish cycle.

### Drain semantics (`main.py`)

- `_is_draining()` returns true on SIGTERM or when `PIPECAT_DRAINING=true`.
- `/ws` closes new connections with 1001 when draining.
- `/health` returns 503 with `status: "draining"` so load balancers stop sending HTTP traffic.
- Active calls run to completion; capacity heartbeat continues advertising the replica as `draining=true`.
- Inbound active calls are tracked separately (`_inbound_active_calls`) so the dispatcher can apply the inbound lane reserve.

### Dual-path call seeding (`pipecat/api/routes/telnyx.py`)

`TelnyxOutboundCallRequest` accepts optional `queue_id` and `reservation_id` from the dispatcher. Both flow into call metadata so post-call processing and audit trails can attribute the call to the queue path. When the legacy scheduler dials, those fields are absent and the metadata records `architecture=legacy`.

### Capacity heartbeat hardening (Phase 8 follow-up)

When shared state is required (`PIPECAT_REQUIRE_REDIS=true`), the heartbeat publisher fails closed instead of degrading silently: a failed publish raises and the replica stops advertising stale capacity rather than letting the Node dispatcher read a successful-looking ghost heartbeat. The fix is covered by `pipecat/tests/test_capacity_heartbeat_failure_propagation.py`.

The Node-side Phase 8 actuator (`services/phase8-autoscaler.js`) reads the same `pipecat:instance:*` keys and refuses to count a replica as usable until its warm-up gate is green — this is the `wait_for_readiness` recommendation surfaced through `routes/scale-operations.js`. The actuator never bypasses the dispatcher's lane reserves; the capacity it plans against is the same lane-adjusted slot count that `services/pipecat-capacity.js` already exposes to `services/call-queue.js`.

### Post-call queue seam (Phase 6 — gated)

Phase 6 wires the seam to move post-call work onto the Node-managed `post_call_jobs` queue. When `POST_CALL_QUEUE_ENABLED=true`, `services/post_call.py` calls `services/post_call_jobs.maybe_enqueue_post_call_job_graph` after writing the conversation record, and the Node worker (`services/post-call-jobs.js`) leases and runs jobs under per-provider semaphores. The flag is **off by default**: the active runtime still executes the full inline analyzer chain in `services/post_call.py`. Pipecat's responsibility under the new path is limited to writing a clean, deduped seed row per call; the DAG (`metrics_finalize`, `reminder_recovery`, `analysis`, `memory_extraction`, `daily_context`, `caregiver_notifications`, `interest_discovery`, `snapshot_rebuild`) and dead-letter handling live on the Node side. See [`docs/architecture/ARCHITECTURE.md`](../../docs/architecture/ARCHITECTURE.md#post-call-job-workflow-phase-6) for the provider-semaphore and retry-policy contract.

## Directory Structure

```
pipecat/
├── main.py                          ← FastAPI entry point, /health, /ws, middleware
├── bot.py                           ← Pipeline assembly + run_bot()
├── bot_gemini.py                    ← Gemini Live evaluation pipeline
├── config.py                        ← All env vars centralized
├── prompts.py                       ← System prompts + phase task instructions
│
├── api/
│   ├── routes/
│   │   ├── telnyx.py                ← /telnyx/events, /telnyx/outbound, Telnyx signature validation
│   │   ├── call_context.py          ← Shared call metadata and ws_token storage
│   │   ├── calls.py                 ← /api/call, /api/calls, /api/calls/:sid/end
│   │   ├── metrics.py               ← /api/metrics/* (call metrics for observability)
│   │   ├── auth.py                  ← token revocation/logout endpoints
│   │   ├── export.py                ← HIPAA right-to-access export bundle
│   │   └── data.py                  ← retention management endpoints
│   ├── middleware/
│   │   ├── auth.py                  ← 3-tier auth (cofounder key, JWT, Clerk)
│   │   ├── rate_limit.py            ← Rate limiting (slowapi)
│   │   ├── security.py              ← Security headers (HSTS, X-Frame-Options)
│   │   └── error_handler.py         ← Global error handlers
│   └── validators/
│       └── schemas.py               ← Pydantic input validation
│
├── flows/
│   ├── nodes.py                     ← 4 call phase NodeConfigs + system prompts
│   └── tools.py                     ← LLM tool schemas + async handlers (2 active tools: web_search, mark_reminder_acknowledged)
│
├── processors/
│   ├── patterns.py                  ← Regex pattern data
│   ├── quick_observer.py            ← Layer 1: analysis logic + goodbye EndFrame
│   ├── conversation_director.py     ← Layer 2: Groq/Gemini guidance (non-blocking)
│   ├── conversation_tracker.py      ← In-call topic/question/advice tracking + transcript
│   ├── metrics_logger.py            ← Call metrics logging processor
│   ├── goodbye_gate.py              ← False-goodbye grace period (NOT in active pipeline — available but unused)
│   └── guidance_stripper.py         ← Strips <guidance> tags and [BRACKETED] directives
│
├── services/
│   ├── prefetch.py                  ← Predictive Context Engine: cache, extraction, runner
│   ├── director_llm.py              ← Groq/Gemini Director analysis + prefetch hints
│   ├── post_call.py                 ← Post-call orchestration (analysis, memory, cleanup, snapshot rebuild)
│   ├── reminder_delivery.py         ← Reminder delivery CRUD + prompt formatting
│   ├── call_analysis.py             ← Post-call analysis + call quality scoring
│   ├── memory.py                    ← Semantic memory (pgvector, HNSW, circuit breaker)
│   ├── greetings.py                 ← Sentiment-aware greeting templates + rotation
│   ├── conversations.py             ← Conversation CRUD + transcript history
│   ├── interest_discovery.py        ← Interest extraction, category mapping, editable details
│   ├── seniors.py                   ← Senior profile CRUD + encrypted PHI fields + per-senior call_settings
│   ├── caregivers.py                ← Caregiver relationships + notes delivery
│   ├── scheduler.py                 ← Pipecat-side scheduler helpers + encrypted Redis context handoff; Node scheduler is active
│   ├── call_snapshot.py             ← Pre-computed call context snapshot
│   ├── context_cache.py             ← Pre-cache senior context + news persistence (5 AM local)
│   ├── daily_context.py             ← Cross-call same-day memory
│   └── news.py                      ← Cached OpenAI news + Tavily/OpenAI in-call web search + circuit breakers
│
├── db/
│   ├── client.py                    ← asyncpg pool + query helpers + health check
│   └── migrations/                  ← SQL migrations (HNSW index, call_context_snapshot, call_metrics)
│
├── lib/
│   ├── circuit_breaker.py           ← Async circuit breaker for external services + Sentry breadcrumbs
│   ├── encryption.py                ← AES-256-GCM field-level PHI encryption
│   ├── redis_client.py              ← shared Redis client helpers
│   ├── growthbook.py                ← GrowthBook SDK wrapper (feature flags + kill switches)
│   ├── phi.py                       ← PHI-safe serialization helpers
│   ├── shared_state_phi.py          ← encrypted shared-state payload helpers
│   ├── cache_cleanup.py             ← Background TTL-based cache eviction loop
│   └── sanitize.py                  ← PII-safe logging (phone, name masking)
│
├── docs/
│   └── ARCHITECTURE.md              ← This file
│
├── tests/                           ← unit, regression, integration, and scenario tests
│   ├── test_*.py                    (test modules — unit, frame, pipeline, simulation)
│   ├── test_regression_scenarios.py ← Scenario-based regression tests
│   ├── helpers/                     pipeline_builder, assertions
│   ├── mocks/                       mock_llm, mock_services, mock_stt, mock_transport, mock_tts
│   ├── scenarios/                   emotional_support, reminder, memory_recall, etc.
│   ├── llm_simulation/              conversation_runner, senior_simulator, observer
│   ├── conftest.py                  shared fixtures
│   └── TESTING_DESIGN.md            test architecture docs
│
├── pyproject.toml                   ← Dependencies + project config
├── railway.toml                     ← Railway deployment config
└── Dockerfile                       ← python:3.12-slim + uv
```

## Two-Backend Architecture (by design)

```
┌─────────────────────────────────┐    ┌──────────────────────────────────┐
│    Pipecat (Python)              │    │    Node.js (Express)              │
│    Railway — PORT 7860           │    │    Railway — PORT 3001            │
│                                  │    │                                   │
│  • Pipecat FrameProcessor pipe   │    │  • REST APIs for frontends       │
│  • Pipecat Flows (4 phases)      │    │  • Reminder scheduler            │
│  • Quick Observer (patterns)     │    │  • Call initiation (Telnyx)      │
│  • Conversation Director (L2)    │    │  • Admin/consumer/observability  │
│  • TTS via Pipecat               │    │    API endpoints                 │
│  • Deepgram STT (Pipecat)        │    │                                   │
│  • FastAPI + WebSocket           │    │  SCHEDULER_ENABLED=true           │
│  • SCHEDULER_ENABLED=false       │    │                                   │
│                                  │    │  Frontends → this API             │
│  Telnyx voice → this service     │    │                                   │
└─────────────────────────────────┘    └──────────────────────────────────┘
                │                                       │
                └───────────┬───────────────────────────┘
                            │
                ┌───────────▼───────────┐
                │   Shared Resources     │
                │                        │
                │  • Neon PostgreSQL DB   │
                │  • Same DB schema       │
                │  • DONNA_API_KEYS       │
                │  • Same JWT_SECRET      │
                │  • FIELD_ENCRYPTION_KEY │
                └────────────────────────┘
```

Running separate backends is an explicit decision. Pipecat handles real-time voice, Node.js handles REST APIs and scheduling.

### Key Differences from Node.js Stack

| Aspect | Node.js | Pipecat |
|--------|---------|---------|
| **Pipeline** | Frontend/API only; legacy custom streaming code is inactive | Pipecat FrameProcessor pipeline |
| **Call phases** | Legacy custom state machine is inactive | Pipecat Flows (4 NodeConfigs) |
| **Director** | Legacy inline implementation is inactive | Separate non-blocking FrameProcessor |
| **Transport** | Frontend/API only; legacy custom streaming code is inactive | FastAPIWebsocketTransport + DonnaTelnyxFrameSerializer |
| **LLM** | Claude (streaming, sentence-by-sentence) | AnthropicLLMService (Pipecat managed) |
| **TTS** | Not active for live calls | ElevenLabs or Cartesia via Pipecat |
| **STT** | Not active for live calls | DeepgramSTTService (Pipecat managed) |
| **Goodbye** | Not active for live calls | Quick Observer → EndFrame after configured delay |
| **Scheduler** | Active (SCHEDULER_ENABLED=true) | Disabled (prevents dual-scheduler) |

## Tech Stack

| Component | Technology | Details |
|-----------|------------|---------|
| **Runtime** | Python 3.12 | asyncio, FastAPI |
| **Framework** | Pipecat v0.0.101+ | FrameProcessor pipeline |
| **Flows** | pipecat-ai-flows v0.0.22+ | 4-phase call state machine |
| **Hosting** | Railway | Docker (python:3.12-slim), port 7860 |
| **Phone** | Telnyx Voice API media streaming | WebSocket audio (L16 16kHz) |
| **Voice LLM** | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | AnthropicLLMService (prompt caching enabled) |
| **Director** | Groq (`gpt-oss-20b`) | Primary fast provider |
| **Director Fallback** | Gemini 3 Flash Preview (`gemini-3-flash-preview`) | Full guidance fallback when Groq unavailable |
| **Post-Call** | Gemini 3 Flash Preview (`gemini-3-flash-preview`) | Summary, engagement, caregiver takeaways |
| **STT** | Deepgram Nova 3 | Telnyx 16kHz L16 is passed through as internal 16kHz PCM before STT; language follows `familyInfo.donnaLanguage` |
| **TTS** | ElevenLabs by default; Cartesia behind provider flag | Telnyx calls request 16kHz PCM; optional Spanish voice IDs selected for Spanish calls |
| **VAD** | Silero | confidence=0.68, start_secs=0.3, min_volume=0.5; stop_secs=1.2 (senior calls), 0.8 (onboarding) |
| **Database** | Neon PostgreSQL + pgvector | asyncpg, connection pooling |
| **Embeddings** | OpenAI text-embedding-3-small | 1536 dimensions |
| **News** | OpenAI GPT-4o-mini | Web search tool, 1hr cache |

## Database Schema (shared)

Core shared tables, same schema as Node.js:

| Table | Purpose |
|-------|---------|
| `seniors` | Senior profiles (name, phone, timezone, interests, encrypted family/additional context, call_settings JSONB, call_context_snapshot JSONB, cached_news TEXT) |
| `conversations` | Call records (duration, metrics, transcript) |
| `memories` | Semantic memories (pgvector embeddings, HNSW index, decay) |
| `reminders` | Scheduled reminders |
| `reminder_deliveries` | Delivery tracking per call |
| `caregivers` | Caregiver-senior relationships |
| `caregiver_notes` | Notes from caregivers delivered during calls |
| `call_analyses` | Post-call AI analysis |
| `daily_call_context` | Cross-call same-day memory |
| `call_metrics` | Per-call observability metrics (latency, phases, tokens) |
| `admin_users` | Admin dashboard accounts (bcrypt) |

### Memory System

- **Embedding**: OpenAI `text-embedding-3-small` (1536 dimensions)
- **Index**: HNSW (cosine_ops, m=16, ef_construction=64)
- **Similarity**: Cosine similarity, 0.7 minimum threshold
- **Deduplication**: Skip if cosine > 0.9 with existing memory
- **Decay**: Effective importance = `base * 0.5^(days/30)` (30-day half-life)
- **Access Boost**: +10 importance if accessed in last week
- **Tiered Retrieval**: Critical → Contextual → Background
- **Mid-Call Refresh**: After 5+ minutes, topic-aware context refresh
- **Circuit Breaker**: Embedding calls protected (10s timeout, 3-failure threshold)

## Environment Variables

```bash
# Server
PORT=7860                        # Different from Node.js (3001)
ENVIRONMENT=production           # Enables fail-closed production checks
PIPECAT_PUBLIC_URL=https://...   # Stable public URL for signed Telnyx webhooks + wss:// stream

# Telnyx
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
TELNYX_PHONE_NUMBER=+1...
TELNYX_CONNECTION_ID=...
TELNYX_ANSWERING_MACHINE_DETECTION=premium
TELNYX_VOICEMAIL_MESSAGE="Hi, it's Donna. I was calling to check in. I'll try again later. Take care."
TELNYX_VOICEMAIL_VOICE=female
TELNYX_VOICEMAIL_FALLBACK_DELAY_SECONDS=8

# Database (shared with Node.js)
DATABASE_URL=...

# AI Services
ANTHROPIC_API_KEY=...            # Claude Haiku (voice LLM)
ANTHROPIC_MODEL=claude-haiku-4-5-20251001
GOOGLE_API_KEY=...               # Gemini Flash (Director + Analysis)
DEEPGRAM_API_KEY=...             # STT
ELEVENLABS_API_KEY=...           # TTS
ELEVENLABS_VOICE_ID=...          # Voice ID (optional, has default)
ELEVENLABS_VOICE_ID_ES=...       # Optional Spanish Donna voice
CARTESIA_API_KEY=...             # Optional TTS provider
CARTESIA_VOICE_ID=...            # Optional Cartesia voice override
CARTESIA_VOICE_ID_ES=...         # Optional Spanish Cartesia voice
OPENAI_API_KEY=...               # Embeddings + news search
TAVILY_API_KEY=...               # Optional in-call web_search fast path

# Auth (shared with Node.js)
JWT_SECRET=...
DONNA_API_KEYS=pipecat:...,scheduler:...
COFOUNDER_API_KEY_1=...          # Cofounder auth
COFOUNDER_API_KEY_2=...          # Cofounder auth
FIELD_ENCRYPTION_KEY=...         # 32-byte base64url key for PHI encryption

# Scheduler (MUST be false to prevent conflicts)
SCHEDULER_ENABLED=false

# Audio profile
TELNYX_STREAM_CODEC=L16
TELNYX_STREAM_SAMPLE_RATE=16000
TELNYX_STREAM_TRACK=inbound_track
TELNYX_BIDIRECTIONAL_TARGET_LEGS=both
TELNYX_L16_INPUT_BYTE_ORDER=little
TELNYX_L16_OUTPUT_BYTE_ORDER=little

# Director models
FAST_OBSERVER_MODEL=gemini-3-flash-preview   # Gemini fallback model
GROQ_API_KEY=...                             # Groq primary Director

# Shared state / flags
REDIS_URL=redis://...             # Required before horizontally scaling Pipecat
PIPECAT_REQUIRE_REDIS=true        # Fail closed when Redis is required but missing
TTS_PROVIDER=elevenlabs           # Optional: cartesia
ELEVENLABS_MODEL=eleven_flash_v2_5
VOICE_BACKEND=claude              # Optional: gemini_live for evaluation path

# Testing
RUN_DB_TESTS=1                   # Set to run DB integration tests
```

---

*Last updated: April 2026 — current Groq/Gemini Director, memory prefetch, active web_search tool, GrowthBook feature flags, call metrics observability, enhanced health endpoint*
