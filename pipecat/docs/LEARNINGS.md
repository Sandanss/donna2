# Donna Voice Pipeline — Engineering Learnings

Hard-won lessons from building and optimizing the real-time voice pipeline. Each learning comes from production debugging, live call testing, or architectural iteration. Verified against the current codebase (March 2026).

---

## Pipeline Architecture

### LLM Tool Calls Are Unreliable for Critical Actions
Claude says "goodbye" in text but inconsistently calls the `transition_to_winding_down` tool. The call stays open and the senior hears silence. **Solution:** Quick Observer detects goodbye via regex (0ms) and injects `EndFrame` programmatically after the configured goodbye delay. Never rely on Claude tool calls for call-ending logic.

### Non-Blocking Director Is Essential
The Conversation Director must never block on LLM analysis. Groq/Gemini work runs in `asyncio.create_task()`, while the only intentional wait is the bounded final-transcript memory gate (up to 500ms) used to pick up prefetch results before Claude responds. A synchronous Director LLM call would add 200-700ms to every turn. The tradeoff: guidance is injected same-turn (via speculative) or previous-turn (fallback), never synchronously.

### Two-Director Split: Query vs Guidance
A single Director prompt doing everything (query extraction + guidance + phase detection + reminders) costs ~700ms. Splitting into two specialized calls halves the latency on the critical path:
- **Query Director** (~200ms): Extracts `memory_queries` only. Fires continuously on interims.
- **Guidance Director** (~400ms): Conversation guidance, phase, reminders. Fires on silence-based speculative only.

The key insight: memory query extraction can happen mid-speech. Guidance can wait until a natural pause.

### Regular Analysis on Final Transcription Is Redundant
The silence-based speculative already runs full guidance analysis during the 250ms pause before the final transcription arrives. Running another analysis on the final text doesn't help the current turn (Claude already started responding) and only marginally helps the next turn. Removing it simplifies the architecture with no quality loss.

### Ephemeral Context Prevents Prompt Bloat
All Director-injected messages (guidance, memories, web results) are tagged with `[EPHEMERAL:` prefix and stripped before each new turn. Without this, the LLM context grows linearly — each turn adds ~200 tokens of guidance that never gets cleaned up. Ephemeral stripping keeps the context stable and prompt caching effective.

### Guidance Message Conflicts Between Layers
Quick Observer (Layer 1) and Director (Layer 2) can inject contradictory guidance. Example: Quick Observer detects goodbye and injects `[GOODBYE]`, but Director's stale cached analysis injects `[RE-ENGAGE]`. **Solution:** `_goodbye_in_progress` flag in `session_state` suppresses Director guidance during goodbye transitions. Layer 1 always takes priority over Layer 2.

---

## Web Search

### Regex-Based Question Detection Fails on Conversational Speech
Detecting factual questions via `?` character or regex patterns triggers on conversational speech: "How much? I'm about to..." and "from India. Remember?" both fired false web searches. Blocklist approaches (listing social questions to skip) can't cover all cases. **Current decision:** do not run Director-owned web search gating. In-call factual questions go through Claude's explicit `web_search` tool, while the Query Director only returns `memory_queries`.

### Web Search Caching Causes More Harm Than Good
Caching web search results to prevent duplicate API calls seems smart but is dangerous: one wrong answer from Tavily poisons all subsequent similar queries for the entire call. The containment-matching algorithm also caused cross-topic false matches ("2026" appearing in both "Orlando Magic score 2026" and "Austin weather 2026"). **Decision:** Remove web search caching entirely. The in-flight dedup (`if task not done: return`) prevents rapid-fire duplicates without caching stale results.

### Query Similarity Is Harder Than It Looks
Simple word overlap fails on shared generic tokens (years, dates). TF-IDF requires dependencies. Embeddings are too slow (<5ms budget). **Best approach for short queries:** Noise word removal + lemmatization + containment/Jaccard hybrid + bigram bonus. Zero dependencies, <0.1ms. Kept as a utility (`query_similarity()` in `conversation_director.py`) even though web search caching was removed — useful for future dedup needs.

### Tavily `include_answer` Hallucinates — Use Raw Results Only
Tavily's `include_answer=True` parameter runs an LLM on top of search results to generate a synthesized answer. This answer hallucinated incorrect data in production (e.g., wrong NBA standings — "Lakers leading Western Conference" when they weren't). The raw `results` array contains real snippets from actual web pages and is accurate. **Decision:** Removed `include_answer`, return raw result snippets (title + content) to Claude. Claude already synthesizes the result into speech anyway, so the extra LLM layer adds hallucination risk with no benefit. Same speed (Tavily's answer generation actually adds latency), more accurate.

### Web Search Path
The active flow is simpler: Claude calls the `web_search` tool, the tool tells the senior it is checking, and `services.news.web_search_query()` uses Tavily raw snippets first with OpenAI web search as fallback. The previous Director-gating design was removed from the active pipeline because false positives and stale cached results created worse answers than an explicit tool call.

---

## Speculative Pre-Processing

### Continuous Speculative Window Tuning
Too aggressive (20 chars) → fires on useless fragments like "Not much. How are you". Too conservative (50+ chars) → misses questions entirely. **Current settings:**
- First fire: 45 chars (~8-9 words, enough for "Do you know what the weather is like tomorrow")
- Re-fires: 60+ total chars AND 25 new chars since last fire
- Interval: 500ms minimum between fires

### Silence-Based Speculative Still Needed
The continuous speculative (interims) handles query extraction mid-speech. But for same-turn guidance injection, the silence-based speculative (250ms pause) is essential — it fires the full Guidance Director analysis close to when the user finishes speaking, giving the best chance of a speculative hit at harvest time.

### Speculative Results Build Cache Even on Miss
Completed speculative analyses that don't match the final transcription text still contribute: their memory prefetch results populate the cache, and their `_last_result` serves as previous-turn guidance. Don't cancel running speculatives — let them complete.

---

## Latency Optimization

### Every Claude Tool Call Costs ~4.3 Seconds
Two sequential LLM round trips: one to generate the tool call, one to generate the response after seeing the result. This is the single biggest latency penalty. **Eliminated tools:**
- `search_memories` → Director injects memories as ephemeral context (500ms gate)
- `save_important_detail` → Removed; post-call `extract_from_conversation` handles it
- `check_caregiver_notes` → Pre-fetched at call start, injected into system prompt

### Fire-and-Forget for Non-Critical DB Writes
`mark_reminder_acknowledged` handler returns immediately with a success response. The actual DB write runs in `asyncio.create_task()` so Claude's next spoken response is not delayed, but post-call processing waits briefly and re-reads `reminder_deliveries.status` before deciding whether to retry. Caregiver notes are no longer marked delivered on connect; post-call marks them only when the assistant transcript contains delivery evidence.

### Memory Gate: 500ms Wait Saves 4.3s
Before passing the final transcription to Claude, wait up to 500ms for the memory prefetch cache to populate. The prefetch started on interim transcriptions while the user was still speaking — most of the time it's already cached. Worst case: 500ms delay. Best case: 0ms (cache hit). Compared to Claude calling `search_memories` tool: ~4.3s saved.

### Prompt Shortening Directly Reduces Latency
The Guidance Director prompt went from ~200 tokens (everything) to ~130 tokens (guidance only). Query Director prompt is ~60 tokens. Shorter prompts = less prefill time = faster Groq responses. The split also reduces output tokens (150 max for queries vs 500 for full analysis).

---

## Pipecat Framework (v0.0.101)

### Do NOT Replace OpenAILLMContext with LLMContext
`AnthropicLLMService.create_context_aggregator()` calls `set_llm_adapter()` which only exists on `OpenAILLMContext`. Using the generic `LLMContext` causes an instant crash with no error logs. This is a Pipecat v0.0.101 limitation — revisit when the Anthropic adapter is updated.

### Cartesia TTS Must Output PCM
Cartesia with `pcm_mulaw` encoding caused garbled telephony audio because Donna's serializers expect `TTSAudioRawFrame` data to be PCM. Double-encoding or pre-compressing audio before the serializer boundary is unsafe. Always output PCM from TTS and let the active telephony serializer handle the final wire format.

Current runtime code explicitly requests `pcm_s16le` from Cartesia. `pcm_s16le` is the sample format, not the sample rate: it can be used at `8kHz`, `16kHz`, `44.1kHz`, or `48kHz`. For Telnyx L16 calls, Donna uses 16kHz PCM at the wire boundary with `DonnaTelnyxFrameSerializer`.

### Telnyx Phone Audio Is 16kHz L16
Do not reintroduce the old 8kHz μ-law bottleneck. The current default profile in `bot.py` is:

- **Telnyx wire input/output**: `L16` at `16000Hz`, little-endian payloads.
- **Telephony/STT input**: `16000Hz` PCM.
- **Telnyx phone TTS output**: `16000Hz` PCM from the selected TTS provider.
- **Cartesia non-phone output**: `CARTESIA_OUTPUT_SAMPLE_RATE=48000`, `pcm_s16le`.
- **ElevenLabs non-phone output**: `ELEVENLABS_OUTPUT_SAMPLE_RATE=44100`.
- **Gemini Live output**: `GEMINI_INTERNAL_OUTPUT_SAMPLE_RATE=24000`.

For active Telnyx calls, TTS output is requested at 16kHz before the serializer. Live testing showed that resampling 48kHz TTS at the Telnyx serializer could produce an oversized first output frame and audible buzz. Browser/internal playback can still use higher-rate PCM when not constrained by the phone wire format.

### VAD Settings Are Caller-Type Dependent
Senior calls use `stop_secs=1.2` — elderly speakers pause longer between thoughts, have softer voices, and speak more slowly. Default settings cut them off. **Tuned settings:** `confidence=0.68`, `start_secs=0.3`, `stop_secs=1.2`, `min_volume=0.5`.

Onboarding calls use `stop_secs=0.8` — these are adult caregivers with typical speech pace. The longer elderly pause tolerance makes the bot feel sluggish for them. `bot.py` switches `stop_secs` based on `call_type == "onboarding"`.

### Import Pipeline Modules at Startup
Importing `run_bot` inside the WebSocket handler (lazy import) causes a 17-second cold start on the first call due to Pipecat module loading. Import at the top of `main.py` instead.

---

## Deployment & Operations

### Railway Environments Are NOT Git Branches
`make deploy-dev` uploads your current working directory to the dev Railway environment regardless of which git branch you're on. The only automated git→deploy connections: PR to main → staging, push to main → production.

### Always Deploy Pipecat from the Correct Directory
Railway CLI in `donna2/` (repo root) is linked to `donna-api` (Node.js). Railway CLI in `donna2-pipecat/pipecat/` is linked to `donna-pipecat` (Python). Deploying from the wrong directory sends the wrong codebase to the wrong service.

### asyncpg Returns UUID Objects
Always `str(senior_id)` before string operations (slicing, logging, comparison). asyncpg returns Python `UUID` objects, not strings. This causes silent failures in string comparisons and dict lookups.

### Scheduler Conflict Prevention
Only one scheduler instance should run across all environments. Set `SCHEDULER_ENABLED=false` in Pipecat — the Node.js backend runs the scheduler. Two active schedulers = double reminder calls.

### `datetime.utcnow()` Breaks Recurring Reminder Scheduling on Non-UTC Servers
`datetime.utcnow()` returns a naive datetime. When `.astimezone(ZoneInfo(senior_tz))` is called on a naive datetime, Python assumes the value is in the **server's local timezone**, not UTC. On a UTC server this happens to work — but if Railway ever runs in a non-UTC zone, recurring reminders fire at the wrong local time. **Fix:** Always use `datetime.now(timezone.utc)` which returns a timezone-aware datetime. `.astimezone()` then correctly converts from UTC.

---

## Testing

### Mock Both Directors in Tests
Tests that run the pipeline need to mock `analyze_turn_speculative` (Guidance Director, silence-based), `analyze_queries` (Query Director, continuous), and `analyze_turn` when the test can hit the full-analysis fallback path. Pre-set `processor._last_result` to simulate previous-turn guidance when testing guidance injection.

### Regression Tests Need Pre-Set Guidance State
Tests that verify Director actions (force end and force winding-down) no longer need pre-seeded guidance state. `_take_actions()` is checked on every final transcription, even when no guidance was injected.

---

## Gemini Live S2S (April 2026 — Evaluated, Not Production)

### Gemini 3.1 Flash Live Sync-Only Tool Calls Make It Unsuitable for Memory-Heavy Calls
Gemini 3.1 Flash Live only supports synchronous function calling — the model goes completely silent while waiting for a tool response. Our `search_memories` tool takes ~600-800ms (OpenAI embedding + pgvector HNSW). Combined with Gemini audio generation startup after receiving the result, this creates 2-3 second silent gaps that are unacceptable in a conversational call. The Claude pipeline avoids this via the Director's speculative memory prefetch — memories are pre-fetched before Claude ever asks, so tool "calls" return from cache in ~0ms.

### GeminiLiveLLMService Requires a Context Aggregator for Tool Calls to Work
Without a context aggregator in the pipeline, tool results never reach Gemini. The path is: `result_callback → FunctionCallResultFrame → context aggregator → LLMContextFrame → _handle_context → _process_completed_function_calls → session.send_tool_response()`. With no context aggregator, the `FunctionCallResultFrame` flows through with nothing to process it, and Gemini waits in silence indefinitely. Workaround: call `params.llm._tool_result()` directly, bypassing the context path.

### No Mid-Call Context Injection with Gemini 3.1 Live
The Director's ephemeral context injection (via `LLMMessagesAppendFrame`) has no equivalent with Gemini Live. `send_client_content` is limited to initial session seeding only in Gemini 3.1. `InputTextRawFrame` injects text as user speech, not system guidance. Gemini manages its own internal context and provides no API to push messages mid-conversation. The entire speculative prefetch + Director architecture cannot be ported.

### Valid Gemini 3.1 Flash Live Configuration
- **Model**: `models/gemini-3.1-flash-live-preview` (recommended; `gemini-2.5-flash-native-audio-preview-12-2025` is deprecated)
- **Voices**: Full 30-voice TTS list applies (Aoede, Kore, Charon, Puck, etc.) — NOT the small subset in older Pipecat docs
- **Audio in**: Set `audio_in_sample_rate=16000` — the active Telnyx path already delivers 16kHz L16, which is what Gemini expects.
- **Audio out**: `audio_out_sample_rate=24000` by default — keep Gemini audio at its native internal rate; the active telephony serializer converts only at the edge.
- **Tool format**: `[{"function_declarations": [...]}]` passed as-is to `GeminiLiveLLMService(tools=...)` — Pipecat falls through to raw dict when not a `ToolsSchema`.
- **Greeting trigger**: Send `InputTextRawFrame(text="[Begin]")` ~1.5s after pipeline start to trigger Donna to speak first on outbound calls.

### Gemini 3.1 vs 2.5 Key Differences
- Sync-only tool calls (2.5 had async/non-blocking option)
- `thinkingLevel` replaces `thinkingBudget`
- `send_client_content` for initial seeding only (2.5 supported ongoing)
- Affective dialog and proactive audio not supported
- Single server event can contain multiple content parts simultaneously

---

*Last updated: May 2026 — Gemini Live evaluation, Split Director architecture, ephemeral context, and current subscriber/onboarding tool surfaces*
