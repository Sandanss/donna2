# Donna Voice AI: Framework Analysis, SOTA Takeaways & Migration Plan

> Historical framework analysis. Donna has since migrated active live-call handling to the Pipecat service.
> Use `DIRECTORY.md`, `docs/architecture/ARCHITECTURE.md`, and `pipecat/docs/ARCHITECTURE.md` for current architecture.
> Embedded Twilio, Sonnet, Gemini post-call, and framework-migration examples are historical and should not be copied into current Telnyx/Claude Haiku work.
> Statements below that say "current" or "today" refer to the analysis date, not the May 2026 runtime.

> **Purpose:** Deep analysis of open-source voice AI frameworks (Pipecat, LiveKit) compared to Donna's current implementation, with SOTA best practices and a concrete migration plan.

## Sources

- [Voice AI & Voice Agents Guide (SOTA)](https://voiceaiandvoiceagents.com/)
- [Pipecat Framework](https://github.com/pipecat-ai/pipecat) | [Pipecat Docs](https://docs.pipecat.ai) | [Pipecat Flows](https://deepwiki.com/pipecat-ai/pipecat-flows/1-overview)
- [LiveKit Agents Node.js](https://github.com/livekit/agents-js) | [LiveKit Docs](https://docs.livekit.io/agents/)
- [TEN Framework](https://github.com/TEN-framework/ten-framework)
- [OpenAI Realtime API](https://platform.openai.com/docs/guides/realtime)
- [AssemblyAI Orchestration Comparison](https://www.assemblyai.com/blog/orchestration-tools-ai-voice-agents)
- [Pipecat Cloud](https://www.daily.co/products/pipecat-cloud/)

---

## Prior Finding: Claude Sonnet TTFT for Voice

**The SOTA guide reports Claude Sonnet's median TTFT at ~1,410ms**, calling it "unsuitable for voice despite its capabilities." For comparison: GPT-4o achieves ~460ms and Gemini 2.0 Flash reaches ~380ms.

Donna previously used Claude Sonnet as the **primary voice model**. That meant the LLM step alone could consume 1,000-1,400ms of the ~600-1,100ms target voice-to-voice latency. Donna's default voice LLM is now Claude Haiku 4.5 after live tests showed good quality with lower latency.

**Implication:** Switching to Gemini Flash for the voice model (keeping Claude for complex reasoning tasks) could cut LLM TTFT by ~1,000ms. This is potentially the single highest-impact latency improvement available — more impactful than any framework migration.

---

## Donna's Current Architecture: Gaps Identified

Deep analysis of the codebase revealed these specific architectural gaps:

| Gap | Current State | Impact |
|-----|---------------|--------|
| **No VAD** | Relies solely on Deepgram endpointing (300ms) + silence timer (1.5s) | False interruptions from coughs, TV; cuts off seniors mid-pause |
| **No interruption context tracking** | `isSpeaking`/`wasInterrupted` flags; doesn't track what user actually heard | Context mismatches after barge-in |
| **TTS WebSocket per response** | `ElevenLabsStreamingTTS` instance created per response, not pooled | ~50-100ms connection overhead per turn |
| **In-memory session state** | `sessions` and `callMetadata` stored in `Map` objects | Cannot horizontally scale; state lost on restart |
| **Monolithic pipeline** | `v1-advanced.js` is 1,582 lines handling STT, LLM, TTS, state, tracking | Hard to test, modify, or swap components |
| **Duplicated JSON repair** | Identical `repairJson()` in `fast-observer.js` and `call-analysis.js` | Maintenance burden |
| **HTTP→WS metadata bridging** | Polling loop (100ms intervals, up to 1s) in WebSocket handler | Up to 1s latency on call connect |
| **200ms inter-sentence delay** | Hard-coded `await sleep(200)` between sentences sent to TTS | Adds 200ms × (sentences-1) per response |
| **No word-level TTS timestamps** | ElevenLabs output treated as opaque audio chunks | Cannot reconstruct context after interruption |
| **Simple turn detection** | Silence timeout + Deepgram UtteranceEnd | Misses semantic cues; poor for elderly pauses |

---

## Part 1: Pipecat Framework Deep Analysis

### 1.1 Core Architecture: Frames & Processors

Pipecat's fundamental abstraction is the **Frame** — every piece of data (audio chunks, text tokens, control signals, system events) flows through the pipeline as a Frame object. This is the key architectural pattern that makes Pipecat powerful.

**Frame Types:**
- `AudioRawFrame` / `AudioFrame` — raw audio data with sample rate, channels
- `TextFrame` — text tokens from STT or LLM
- `TranscriptionFrame` — STT output with metadata
- `LLMFullResponseStartFrame` / `LLMFullResponseEndFrame` — LLM lifecycle markers
- `TTSStartedFrame` / `TTSStoppedFrame` — TTS lifecycle markers
- `UserStartedSpeakingFrame` / `UserStoppedSpeakingFrame` — VAD signals
- `BotStartedSpeakingFrame` / `BotStoppedSpeakingFrame` — bot speech lifecycle
- `EndFrame` / `CancelFrame` — pipeline control

**FrameProcessor** is the base class for all processing units. Each processor:
1. Receives frames from upstream
2. Processes or transforms them
3. Pushes frames downstream (or upstream for control signals)

```
Pipeline: [Transport Input] → [STT] → [Context Aggregator] → [LLM] → [TTS] → [Transport Output]
                                        ↑                                    |
                                        └── Control frames flow upstream ────┘
```

**What this means for Donna:** Donna's current architecture is essentially a hand-rolled version of this pattern. The key difference is Pipecat makes it **composable and pluggable** — you can swap STT/TTS/LLM providers by swapping Processor instances, whereas Donna's pipeline is hard-wired in `v1-advanced.js`.

### 1.2 Pipecat Flows: Conversation State Machine

**Pipecat Flows** is a state-driven conversation management system built on top of Pipecat. This maps directly to Donna's call phase management (opening → rapport → main → winding_down → closing).

**Core Concepts:**

**FlowManager** (central orchestrator):
- Maintains `current_node` (active conversation state)
- Manages `state` dictionary (persistent session data)
- Handles function registration with LLM
- Executes pre/post-actions around LLM inference
- Supports multiple LLM providers via adapter pattern

**NodeConfig** (conversation states):
```python
NodeConfig(
    task_messages=[...],           # Instructions for this state
    role_messages=[...],           # Bot personality for this state
    functions=[...],               # LLM-callable tools
    pre_actions=[...],             # Before LLM runs (setup, validation)
    post_actions=[...],            # After bot speaks (cleanup, transitions)
    context_strategy="append",     # How history carries between states
    respond_immediately=True       # Auto-run LLM on node entry
)
```

**Function Types:**
- **Edge Functions** — Return `(result, next_node)` tuple, triggering state transitions
- **Node Functions** — Return result only, staying in current state

**Context Strategies:**

| Strategy | Behavior | Donna Equivalent |
|----------|----------|-----------------|
| `APPEND` | Keep full history across transitions | Current: last 20 turns raw |
| `RESET` | Clear history on state change | Not implemented |
| `RESET_WITH_SUMMARY` | LLM-summarize then clear | Not implemented (should be) |

**Action System:**
- `tts_say` — Speak specific text
- `end_conversation` — Terminate pipeline
- `function` — Execute custom async functions
- Custom actions can be registered

**What this means for Donna:** Pipecat Flows solves Donna's call phase management much more cleanly than the current Director-based approach. The `RESET_WITH_SUMMARY` strategy is exactly what Donna needs for long calls. The action system maps to Donna's reminder delivery and greeting patterns.

### 1.3 Transport Layer

Pipecat abstracts transports through `BaseInputTransport` and `BaseOutputTransport`:

- **DailyTransport** — WebRTC via Daily.co (primary, recommended)
- **WebSocketTransport** — For Twilio Media Streams, generic WebSocket
- **SmallWebRTCTransport** — Lightweight peer-to-peer (no server needed)
- **SIP** — Telephony integration

Each transport handles:
- Audio I/O and buffering
- Client lifecycle events (connect, disconnect, reconnect)
- Media stream management
- Codec conversion

**Twilio Integration:** Pipecat has native Twilio support through a WebSocket transport that handles Twilio Media Streams directly. This is the same pattern Donna uses today.

### 1.4 Voice Endpoint Management (STT/TTS)

Pipecat manages STT and TTS as FrameProcessors with:

**STT Processors:**
- Receive `AudioRawFrame` → emit `TranscriptionFrame`
- Handle WebSocket lifecycle internally (connect, disconnect, reconnect)
- Providers: Deepgram, Gladia, AssemblyAI, OpenAI Whisper, Google
- VAD integration: Silero VAD runs before STT to filter non-speech

**TTS Processors:**
- Receive `TextFrame` → emit `AudioRawFrame`
- Stream text input, stream audio output
- Word-level timestamps tracked per frame
- Providers: ElevenLabs, Cartesia, Deepgram, Azure, Google, Rime
- Sentence buffering handled by the processor (not the caller)

**What this means for Donna:** Donna's `adapters/elevenlabs-streaming.js` (269 lines) and Deepgram connection management in `v1-advanced.js` are reinventing what Pipecat provides out of the box — including reconnection, buffering, and lifecycle management.

### 1.5 Interruption Handling

Pipecat's interruption system:
1. VAD detects user speech while bot is speaking
2. `UserStartedSpeakingFrame` pushed **upstream** through pipeline
3. All queued data frames in processor queues are **cancelled**
4. Context is updated to reflect only text that was **actually spoken** (using word timestamps)
5. Bot stops, STT begins transcribing user's interruption

**Donna comparison:** Donna uses `isSpeaking`/`wasInterrupted` flags and manual Twilio `clear` events. Pipecat's approach is more robust because it's built into the pipeline architecture — every processor knows how to handle cancellation.

### 1.6 The Python Problem

**Pipecat's server-side framework is Python-only.** The JavaScript SDKs (`pipecat-client-web`, `pipecat-client-react-native`) are **client-side only** — they connect to a Python Pipecat server via WebRTC.

Architecture:
```
Browser/Phone → [JS Client SDK] → WebRTC/WebSocket → [Python Pipecat Server] → AI Services
```

**For Donna, this means:**
- Cannot run Pipecat's pipeline natively in Node.js
- Would need to either:
  - **A)** Rewrite Donna's backend in Python (major effort)
  - **B)** Run Pipecat as a Python sidecar service alongside Node.js
  - **C)** Study Pipecat's patterns and implement them in Node.js (inspired-by, not using)

---

## Part 2: LiveKit Agents Node.js Deep Analysis

### 2.1 AgentSession Model

LiveKit's equivalent of Pipecat's Pipeline is the **AgentSession** — a container managing the full lifecycle of a voice conversation.

```typescript
const session = new AgentSession({
  stt: new deepgram.STT({ model: "nova-3" }),
  llm: new openai.LLM({ model: "gpt-4o-mini" }),
  tts: new cartesia.TTS({ model: "sonic-3" }),
  vad: silero.VAD.load(),
  turnDetection: livekit.turnDetection.EOUModel({ multilingual: true }),
});

await session.start(room, participant);
```

**Key lifecycle hooks:**
- `session.on('agentStateChanged')` — idle, listening, thinking, speaking
- `session.on('userStateChanged')` — connected, speaking, listening
- `session.on('conversationItemAdded')` — new message in context
- `session.on('functionCallsCollected')` — tool calls from LLM

### 2.2 Pipeline Nodes & Middleware Injection

**This is critical for Donna.** LiveKit supports **pipeline node overrides** — custom functions that intercept processing between stages:

```typescript
session.on('llm_node', async (node, context) => {
  // Custom logic BEFORE LLM inference
  // This is where Donna's Quick Observer + Director would run

  const guidance = await quickObserver.analyze(context.lastUserMessage);
  context.systemPrompt += guidance;

  // Call the actual LLM
  const response = await node.default(context);
  return response;
});

session.on('tts_node', async (node, text) => {
  // Custom logic before TTS
  const cleanedText = stripGuidanceTags(text);
  return node.default(cleanedText);
});
```

**Available pipeline nodes:**
- `stt_node` — Override STT processing
- `llm_node` — Override LLM inference (add context, modify prompts)
- `tts_node` — Override TTS processing (filter text, change voice)
- `before_llm_cb` / `after_llm_cb` — Hooks around LLM calls

**What this means for Donna:** The `llm_node` override is exactly where Donna's 2-layer Observer pattern would live. Quick Observer (regex, 0ms) runs synchronously before LLM inference, Director (Gemini) runs in parallel, and both inject guidance into the context.

### 2.3 Turn Detection System

LiveKit has the most sophisticated turn detection of any framework, with 5 modes:

**1. Turn Detector Model (Recommended):**
- Custom open-weights transformer model
- Context-aware: understands when a sentence is actually complete
- Works on top of Silero VAD signals
- `livekit.turnDetection.EOUModel({ multilingual: true })`

**2. VAD Only:**
- Silero VAD with configurable parameters
- Language-agnostic but less contextually aware
- `turn_detection: "vad"`

**3. STT Endpointing:**
- Uses provider's phrase endpointing (AssemblyAI recommended)
- Less responsive to interruptions

**4. Realtime Models:**
- Built-in turn detection from OpenAI/Gemini Realtime APIs

**5. Manual Control:**
- Push-to-talk via `session.interrupt()`, `session.commit_user_turn()`

**Configuration parameters:**

| Parameter | Default | Purpose |
|-----------|---------|---------|
| `allow_interruptions` | true | Can user interrupt bot |
| `min_interruption_duration` | 0.5s | Minimum speech to count as interrupt |
| `min_endpointing_delay` | 0.5s | Wait before marking turn complete |
| `max_endpointing_delay` | 3.0s | Max wait when model suggests continuation |
| `false_interruption_timeout` | 2.0s | Classify as false positive |
| `resume_false_interruption` | true | Resume speech after false positive |

**Donna comparison:** Donna's turn detection is a simple silence timeout (1.5s) + Deepgram UtteranceEnd (1000ms). LiveKit's semantic model understands context, reducing both false positives (seniors pausing mid-thought) and false negatives (seniors trailing off).

### 2.4 Interruption Handling

LiveKit's interruption system:
1. VAD detects user speech
2. Agent speech paused immediately
3. **Conversation history truncated to only what user heard** (using TTS word timestamps)
4. False interruption detection classifies no-speech interrupts
5. Optionally resumes speaking after false positives

**This is superior to Donna's approach** which doesn't track what was actually spoken, leading to context mismatches.

### 2.5 Anthropic/Claude Support

**Critical finding:** The Anthropic Claude plugin exists for LiveKit **but only in Python, not Node.js**.

**Workarounds:**
1. **OpenAI plugin with base URL override** — Anthropic's API is not OpenAI-compatible, so this won't work directly
2. **Custom LLM node** — Implement a custom `llm_node` that calls Claude's API directly. This is the right approach:

```typescript
session.on('llm_node', async (node, context) => {
  // Custom Claude integration
  const response = await anthropic.messages.stream({
    model: 'claude-sonnet-4-20250514',
    messages: context.messages,
    system: context.systemPrompt,
  });
  return response;
});
```

3. **Google Gemini plugin** — Available for Node.js, would work if switching LLM

### 2.6 Transport & Telephony

LiveKit handles telephony via SIP bridging:
```
Phone (PSTN) → Twilio SIP Trunk → LiveKit SIP Bridge → LiveKit Room → Agent
```

- Calls are bridged into LiveKit "rooms" as participants
- No changes to agent code needed — phone callers are just another participant
- Supports DTMF, call transfers, secure trunking, HD voice, noise cancellation
- Region pinning for latency optimization

**Donna comparison:** Donna connects to Twilio Media Streams via WebSocket. LiveKit replaces this with SIP → WebRTC, which provides better audio quality, built-in echo cancellation, and noise reduction.

### 2.7 Worker & Scaling Model

```
LiveKit Server → dispatches jobs to → Worker Pool → each worker runs → Agent Instances
```

- Workers connect to LiveKit server via authenticated WebSocket
- Jobs (calls) are dispatched to workers with load balancing
- Each worker can run multiple agent instances
- Prewarm functions allow pre-loading models/connections
- Graceful shutdown: SIGTERM prevents new jobs, maintains active sessions
- Horizontal scaling via adding more workers

---

## Part 3: SOTA Takeaways (from voiceaiandvoiceagents.com)

> Note: Specific latency/cost numbers are evolving rapidly. The patterns and architectural recommendations below are what matter.

### 3.1 Cascaded vs Speech-to-Speech

**Cascaded (STT → LLM → TTS):** Maximum control, supports any LLM, enables function calling, but adds component latency. This is what Donna uses.

**Speech-to-Speech (e.g., OpenAI Realtime):** Lower latency, preserves speech nuance, but expensive for long calls, worse instruction following, limited function calling. Audio uses ~13x more tokens than equivalent text — prohibitive for 5-30 minute calls.

**Hybrid Approach (Gemini):** Process latest user message as native audio, keep history as text. Gets audio understanding (tone, emotion) with text-mode efficiency (~10x token reduction per turn). Ideal for Donna's use case where emotional nuance matters.

### 3.2 LLM Selection: Latency vs Quality

| Model | Median TTFT | Voice Suitability | Cost |
|-------|------------|-------------------|------|
| Gemini 2.0 Flash | ~380ms | Excellent | ~$0.0004/3min |
| GPT-4o | ~460ms | Good (industry standard) | ~$0.009/3min |
| Claude Sonnet | ~1,410ms | Poor for real-time voice | Higher |

**Donna previously used Claude Sonnet** — the slowest option for voice. The SOTA guide's recommendation is to use fast models for the real-time voice path and reserve heavier models for async tasks or escalation. Donna's default voice LLM is now Claude Haiku 4.5.

### 3.3 TTS Provider Comparison

| Provider | Cost/min | Median TTFB | P95 TTFB | Strengths |
|----------|----------|-------------|----------|-----------|
| **Cartesia** | $0.02 | **190ms** | 260ms | State-space architecture, streaming, word timestamps |
| **Deepgram** | $0.008 | **150ms** | 320ms | Lowest cost, reliable |
| **ElevenLabs Flash** | $0.08 | 300ms | 510ms | Best emotional realism |
| **Rime** | $0.024 | 340ms | 980ms | Conversational fine-tuning |

**Donna uses ElevenLabs** — the most expensive and 2nd slowest option. Cartesia offers word-level timestamps (critical for interruption context), lower latency, and lower cost. Trade-off: ElevenLabs has the most emotionally realistic voices, which matters for elderly companionship.

### 3.4 Turn Detection Is a Solved Problem

The SOTA guide and LiveKit both converge on: **Silero VAD + context-aware transformer model** is the gold standard. Simple silence timeouts (what Donna uses) lead to:
- Cutting off seniors mid-thought during natural pauses
- Not detecting when a senior has trailed off
- False interruptions from coughs, background noise

**Smart Turn** (open-source, from Pipecat team) is a fully open model + training data for semantic turn detection. LiveKit's EOUModel is the other leading option.

### 3.5 Network Transport: WebRTC > WebSocket

The SOTA guide strongly recommends WebRTC over WebSocket for real-time voice:
- **UDP-based** — no head-of-line blocking (TCP WebSocket suffers from this)
- **Built-in congestion control** — Opus codec adapts to network conditions
- **Forward error correction** — handles packet loss gracefully
- **Automatic timestamping** — simplifies playout and interruption handling
- **Echo cancellation + noise reduction** — built into the stack
- **Network proximity matters enormously** — UK→US adds ~140ms RTT vs UK→EU at ~15ms

Donna currently uses Twilio Media Streams (WebSocket). LiveKit's SIP bridge would give us WebRTC transport without changing the phone experience.

### 3.6 Interruption Context Reconstruction

After interruption, the conversation context must reflect **what the user actually heard**, not what was generated. This requires word-level TTS timestamps. Both Pipecat and LiveKit handle this automatically. Donna does not.

### 3.7 Context Management for Long Calls

Donna's target calls are 5-30 minutes. Context grows linearly. **Cost scales super-linearly** — a 30-minute conversation costs ~100x more than a 3-minute session without optimization. SOTA recommends:
- **Retroactive summarization** — Compress older turns
- **Token caching** — All major providers support it (reduces TTFT + cost). Anthropic and Google both offer implicit caching.
- **Strategic trimming** — Not all turns need to be kept verbatim
- **STT error correction** — Prompt the LLM to silently correct transcription errors using conversation context
- Pipecat's `RESET_WITH_SUMMARY` context strategy is exactly this pattern

### 3.8 Content Guardrails Are a Safety Requirement

For a product serving elderly users with health-adjacent conversations, guardrails are not optional:
- Medical advice hallucination detection
- Prompt injection filtering
- Emotional safety (not reinforcing hopelessness)
- NVIDIA NeMo Guardrails or Meta llama-guard are open-source options
- Run as a **separate async model** for robustness against main model weaknesses

### 3.9 Voice AI Evals Don't Exist (Build Them)

No off-the-shelf evaluation framework for voice AI. Must build custom:
- Voice-to-voice latency (measure with audio editor, not programmatic timers — server metrics are inaccurate)
- Turn detection accuracy (false positive/negative rates)
- Interruption handling (context accuracy after interruption)
- Function calling reliability across multi-turn contexts
- Conversation quality (engagement, appropriateness)
- Reminder delivery success rate

---

## Part 4: Both Migration Paths Explored

### Path A: Pipecat-Inspired Node.js Refactor

**Approach:** Don't adopt Pipecat directly (Python mismatch), but refactor Donna's architecture using Pipecat's proven patterns.

**What to adopt:**
1. **Frame-based pipeline** — Replace Donna's monolithic `v1-advanced.js` (1,581 lines) with composable processors
2. **Pipecat Flows state machine** — Replace Director-based call phases with NodeConfig-style states
3. **Context strategies** — Implement RESET_WITH_SUMMARY for long calls
4. **Processor lifecycle** — Each service (STT, TTS, LLM) as a self-contained processor with its own connection management
5. **Interruption via pipeline** — Replace flag-based approach with upstream control frames

**Proposed Donna Pipeline Architecture (inspired by Pipecat):**
```
[TwilioTransport]
  → [SileroVAD Processor]
  → [DeepgramSTT Processor]
  → [QuickObserver Processor]      ← Donna-specific (0ms regex)
  → [DirectorProcessor]            ← Donna-specific (parallel Gemini analysis)
  → [ContextAggregator]            ← Manages conversation history + summarization
  → [LLMProcessor]                 ← Claude/Gemini streaming
  → [GuidanceStripper Processor]   ← Strips <guidance> tags before TTS
  → [ElevenLabsTTS Processor]
  → [TwilioTransport Output]
```

**Pros:**
- Stay in Node.js (no language migration)
- Keep all Donna-specific logic (25+ patterns, reminders, memory)
- Incremental refactor (one processor at a time)
- No new infrastructure dependencies

**Cons:**
- Building our own framework instead of using a battle-tested one
- No community ecosystem of plugins
- Must implement transport, VAD, turn detection ourselves
- Missing LiveKit's semantic turn detection model

**Effort:** 4-6 weeks for core refactor, ongoing for polish

### Path B: LiveKit Agents Migration

**Approach:** Migrate to LiveKit Agents (Node.js) as the pipeline framework, porting Donna's custom logic as pipeline node overrides and middleware.

**Migration Map:**

| Donna Component | LiveKit Equivalent |
|----------------|-------------------|
| `websocket/media-stream.js` | LiveKit SIP Transport + Room |
| `pipelines/v1-advanced.js` | `AgentSession` + pipeline nodes |
| `pipelines/quick-observer.js` | Custom `llm_node` hook (pre-processing) |
| `pipelines/fast-observer.js` | Custom parallel task in `llm_node` |
| `adapters/elevenlabs-streaming.js` | `@livekit/agents-plugin-elevenlabs` |
| Deepgram STT connection | `@livekit/agents-plugin-deepgram` |
| Silence-based turn detection | LiveKit EOUModel (semantic) |
| `isSpeaking`/`wasInterrupted` flags | Built-in interruption handling |
| Sentence buffering | Built-in TTS streaming |
| `services/memory.js` | Custom via `llm_node` context injection |
| `services/greetings.js` | Custom via session `start` event |
| `services/daily-context.js` | Custom state in AgentSession |

**Architecture:**
```
Phone → Twilio SIP Trunk → LiveKit Server → LiveKit Room
                                                ↓
                                         Donna Agent (Node.js)
                                         ├── STT: Deepgram plugin
                                         ├── VAD: Silero plugin
                                         ├── Turn: EOUModel
                                         ├── LLM: Custom node (Claude + Quick Observer + Director)
                                         ├── TTS: ElevenLabs plugin
                                         └── Custom: Memory, Reminders, Greetings, Analysis
```

**Pros:**
- WebRTC transport (superior to WebSocket for real-time audio)
- Semantic turn detection out-of-the-box (huge improvement for seniors)
- Built-in interruption handling with context reconstruction
- Built-in VAD (Silero)
- Plugin ecosystem for STT/TTS (managed connections, reconnection, buffering)
- Production scaling infrastructure (workers, job dispatch, load balancing)
- Active Node.js SDK (v1.0, recently released)
- Community and ecosystem growth

**Cons:**
- Requires LiveKit server infrastructure (self-hosted or LiveKit Cloud — additional cost)
- Anthropic Claude plugin **not available for Node.js** (must implement custom `llm_node`)
- Newer ecosystem (v1.0, smaller community than Pipecat)
- Twilio → SIP trunk migration needed (different from current Media Streams approach)
- Risk: LiveKit Node.js SDK maturity unknown for production telephony
- Donna's 2-layer observer pattern needs creative integration via pipeline nodes

**Effort:** 6-10 weeks for full migration, 2-3 weeks for POC

### Recommendation: Hybrid Approach

**Phase 1 (Now):** Adopt Pipecat patterns in Node.js — refactor `v1-advanced.js` into composable processors, add Silero VAD, implement context summarization. This captures 70% of the value with minimal risk.

**Phase 2 (Weeks 3-4):** Build LiveKit POC — validate SIP/Twilio integration, test semantic turn detection with elderly speech patterns, benchmark latency vs current approach.

**Phase 3 (Based on POC results):** If LiveKit POC shows clear improvements, migrate fully. If not, continue with Pipecat-inspired Node.js architecture.

---

## Part 5: Concrete TODO Plan

### Immediate: Pipecat-Inspired Refactor (Weeks 1-2)

#### TODO 1: Introduce Frame/Processor Architecture
- Create `pipeline/frame.js` — Base Frame types (AudioFrame, TextFrame, ControlFrame, etc.)
- Create `pipeline/processor.js` — Base FrameProcessor class with `process(frame)` + upstream/downstream push
- Create `pipeline/pipeline.js` — Pipeline orchestrator that chains processors
- **Goal:** Replace the monolithic `processUserUtterance()` in v1-advanced.js with a pipeline

#### TODO 2: Extract STT as a Processor
- Create `processors/deepgram-stt.js` — Wraps Deepgram WebSocket with connection lifecycle, reconnection, error handling
- Input: AudioFrame → Output: TranscriptionFrame
- Move Deepgram connection management out of v1-advanced.js (lines 821-883)

#### TODO 3: Extract TTS as a Processor
- Create `processors/elevenlabs-tts.js` — Wraps ElevenLabs WebSocket
- Input: TextFrame → Output: AudioFrame
- Add word-level timestamp tracking
- Move from `adapters/elevenlabs-streaming.js` into processor pattern

#### TODO 4: Add Silero VAD Processor
- Create `processors/silero-vad.js`
- Integrate `@silero/vad` npm package
- Input: AudioFrame → Output: AudioFrame (filtered) + UserSpeaking/StoppedSpeaking frames
- Configure for elderly speech patterns (longer pauses, lower confidence threshold)

#### TODO 5: Implement Context Manager with Summarization
- Create `services/context-manager.js`
- Implement Pipecat Flows-style context strategies:
  - `APPEND` — Current behavior (keep all turns)
  - `RESET_WITH_SUMMARY` — Summarize older turns, keep last 5 verbatim
- Use fast LLM for summarization between turns
- Apply when conversation exceeds 15 turns

#### TODO 6: Implement Call Phase State Machine
- Create `pipeline/flow-manager.js` (inspired by Pipecat Flows)
- Define NodeConfig for each call phase:
  - `opening` — Greeting templates, initial rapport
  - `rapport` — Light conversation, interest-based followups
  - `main` — Core conversation, reminder delivery, memory engagement
  - `winding_down` — Wrap-up signals, final reminders
  - `closing` — Goodbye detection, call termination
- Replace Director's `call_phase` tracking with explicit state machine
- Each phase has its own system prompt additions, allowed actions, and transition conditions

### Short Term: SOTA Best Practices (Weeks 2-4)

#### TODO 7: Enable Token/Context Caching
- Enable Anthropic prompt caching for system prompt (changes rarely within a call)
- Enable Google context caching for Director's conversation context
- **Files:** `adapters/llm/index.js`

#### TODO 8: Add Content Guardrails
- Create `processors/guardrails.js`
- Run async safety check on LLM responses before TTS
- Focus: medical advice hallucination, emotional safety, prompt injection
- Use lightweight model (Gemini Flash or guardrail-specific model)
- Non-blocking: flags concerning content for caregiver review

#### TODO 9: Build Voice AI Eval Framework
- Create `tests/voice-evals/`
- Metrics: voice-to-voice latency (50th/95th), turn detection accuracy, interruption context accuracy, reminder delivery success rate
- Record test conversations, measure via audio analysis
- Automated regression testing

#### TODO 10: Connection Resilience
- Add circuit breaker pattern to all external service connections (Deepgram, ElevenLabs, LLM)
- Auto-reconnect with exponential backoff
- Fallback to non-streaming mode if WebSocket fails
- Health checks with latency tracking
- **Files:** New `pipeline/circuit-breaker.js`, updates to STT/TTS processors

### Medium Term: LiveKit Evaluation (Weeks 4-8)

#### TODO 11: LiveKit POC
- Set up LiveKit server (start with LiveKit Cloud for easy testing)
- Create minimal Donna agent on LiveKit with:
  - Twilio SIP trunk integration
  - Deepgram STT plugin
  - ElevenLabs TTS plugin
  - Custom `llm_node` with Claude integration
  - Basic conversation (no reminders/memory yet)
- **Test with actual seniors:** Compare call quality, turn detection, latency
- Document findings and decision: migrate or stay with Pipecat-inspired approach

#### TODO 12: If LiveKit wins — Full Migration
- Port Quick Observer as `llm_node` pre-processing hook
- Port Director as parallel async task in `llm_node`
- Port memory system as context injection in `llm_node`
- Port reminder tracking as custom session state
- Port greeting rotation as session start handler
- Set up Twilio SIP trunk (replace Media Streams)
- Configure LiveKit workers for production scaling

### Long Term: Advanced Features (Months 2-3)

#### TODO 13: Gemini Native Audio (Hybrid Approach)
- Test Gemini's native audio input for latest user message
- Keep conversation history as text (10x token reduction per SOTA guide)
- Gain emotional tone detection from audio (hesitation, sadness, confusion)
- Critical for Donna's elderly audience

#### TODO 14: Semantic Turn Detection Tuning
- Whether via LiveKit EOUModel or standalone model
- Tune for elderly speech patterns:
  - Longer natural pauses (don't cut off)
  - Trailing off (detect end of thought)
  - Background TV/radio (filter false triggers)
  - Hearing aid feedback (filter)

#### TODO 15: Browser-Based Calls
- Add WebRTC browser transport (no phone needed)
- LiveKit provides this natively; Pipecat via SmallWebRTCTransport or Daily
- Enables caregiver app to connect directly to Donna

---

## Part 6: Other Open Source Projects to Leverage

| Project | Use For | Priority |
|---------|---------|----------|
| [Silero VAD](https://github.com/snakers4/silero-vad) | Voice Activity Detection — filter non-speech, CPU-efficient | **Immediate** |
| [Pipecat Flows](https://github.com/pipecat-ai/pipecat) | Study: State machine pattern for call phases | **Immediate** (study) |
| [Cartesia TTS](https://cartesia.ai/) | Evaluate: Faster TTFB (190ms), word timestamps, lower cost | **Immediate** (evaluate) |
| [LiveKit Agents JS](https://github.com/livekit/agents-js) | POC: Evaluate as pipeline framework (Node.js SDK available) | **Short term** |
| [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails) | Content safety for medical advice | **Short term** |
| [llama-guard](https://github.com/meta-llama/llama-guard) | Async safety check on responses | **Short term** |
| [Smart Turn](https://github.com/pipecat-ai/smart-turn) | Semantic turn detection — open model + training data | **Medium term** |
| [Groq Whisper](https://groq.com/) | STT alternative — <300ms TTFT, making Whisper viable for real-time | **Medium term** (evaluate) |
| [Krisp](https://krisp.ai/) | Speaker isolation — suppress background speech for better STT | **Medium term** |
| [FastRTC](https://github.com/fastrtc/fastrtc) | Browser-based WebRTC calls (serverless) | **Long term** |

---

## Verification Plan

After each phase, verify:

1. **Latency:** Record 10 test calls, measure voice-to-voice timing with audio editor (not server metrics)
2. **Turn detection:** Count false positive interruptions and missed turn endings per call
3. **Interruption handling:** Verify conversation context accuracy after interruption
4. **Conversation quality:** Listen to full calls, rate naturalness, reminder delivery, emotional appropriateness
5. **Regression:** Compare metrics against baseline from current architecture
6. **Senior testing:** At least 3 calls with actual elderly users per phase before production deploy

---

*Last updated: February 2026*
