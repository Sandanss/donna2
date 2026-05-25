# Donna on Pipecat: Full Migration Architecture

> Historical migration design. Use `DIRECTORY.md`, `pipecat/docs/ARCHITECTURE.md`, and the runtime code in `pipecat/bot.py` as the current source of truth.
> Some embedded examples predate the current audio profile, websocket token admission flow, and active Node scheduler ownership.
> Current live calls use Telnyx L16/16k, Claude Haiku 4.5, Groq Director with Gemini fallback, Claude Haiku post-call analysis, ElevenLabs Flash, and email/in-app notifications only.
> Statements below that say "current" or "today" refer to the historical migration date, not the May 2026 runtime.

> Complete mapping of Donna's current codebase to a Pipecat + Pipecat Flows implementation in Python.

---

## Architecture Overview

```
Phone (PSTN)
  ↓
Twilio → TwiML <Stream> → WebSocket
  ↓
┌─────────────────────────────────────────────────────────┐
│  FastAPI Server (Pipecat Runner)                        │
│                                                         │
│  Per-call pipeline:                                     │
│  ┌─────────────────────────────────────────────────┐   │
│  │ FastAPIWebsocketTransport (TwilioFrameSerializer)│   │
│  │  ↓                                               │   │
│  │ SileroVAD                                        │   │
│  │  ↓                                               │   │
│  │ DeepgramSTT                                      │   │
│  │  ↓                                               │   │
│  │ QuickObserverProcessor (Donna-specific, 0ms)     │   │
│  │  ↓                                               │   │
│  │ UserContextAggregator                            │   │
│  │  ↓                                               │   │
│  │ AnthropicLLMService (Claude Haiku, tools)        │   │
│  │  ↓                                               │   │
│  │ GuidanceStripperProcessor (strip <guidance> tags)│   │
│  │  ↓                                               │   │
│  │ ElevenLabsTTSService (WebSocket, word timestamps)│   │
│  │  ↓                                               │   │
│  │ FastAPIWebsocketTransport output                 │   │
│  │  ↓                                               │   │
│  │ AssistantContextAggregator                       │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  FlowManager (call phase state machine)                 │
│  ├── opening node                                       │
│  ├── rapport node                                       │
│  ├── main node (free-form, all tools)                   │
│  ├── winding_down node                                  │
│  └── closing node                                       │
│                                                         │
│  Companion API Server (FastAPI)                         │
│  ├── /api/seniors, /api/reminders, etc.                 │
│  ├── /api/admin-auth                                    │
│  └── /api/caregivers                                    │
└─────────────────────────────────────────────────────────┘
  ↓
PostgreSQL + pgvector (unchanged)
```

---

## File-by-File Migration Map

### Current → Pipecat Equivalent

| Current File | LOC | Pipecat Equivalent | Notes |
|---|---|---|---|
| `pipelines/v1-advanced.js` | 1,592 | `bot.py` + `processors/` + `flows/` | Split into pipeline definition, custom processors, and flow nodes |
| `pipelines/quick-observer.js` | 1,196 | `processors/quick_observer.py` | Direct port of regex patterns as `FrameProcessor` |
| `pipelines/fast-observer.js` | 647 | **Eliminated** — replaced by Flows + tools | Director responsibilities absorbed into flow nodes and tool calls |
| `websocket/media-stream.js` | 202 | **Eliminated** — Pipecat handles transport | `FastAPIWebsocketTransport` + `TwilioFrameSerializer` |
| `adapters/elevenlabs-streaming.js` | 270 | **Eliminated** — `ElevenLabsTTSService` | Built-in WebSocket TTS with word timestamps |
| `adapters/llm/index.js` | 157 | **Eliminated** — `AnthropicLLMService` / `GoogleLLMService` | Built-in multi-provider support |
| `services/memory.py` | 329 | `services/memory.py` | Port to Python (asyncpg + pgvector) |
| `services/daily-context.js` | 197 | `services/daily_context.py` | Port to Python |
| `services/greetings.js` | 258 | `services/greetings.py` | Port to Python (pure logic) |
| `services/call-analysis.js` | 257 | `services/call_analysis.py` | Port to Python, use as `post_action` |
| `services/scheduler.js` | 515 | `services/scheduler.py` | Port to Python (APScheduler or custom) |
| `services/news.js` | 104 | `services/news.py` | Port to Python (OpenAI SDK) |
| `services/conversations.js` | 172 | `services/conversations.py` | Port to Python |
| `services/seniors.js` | 66 | `services/seniors.py` | Port to Python |
| `services/caregivers.js` | 84 | `services/caregivers.py` | Port to Python |
| `db/schema.js` | 130 | `db/models.py` | Drizzle → SQLAlchemy or raw asyncpg |
| `routes/*.js` (13 files) | 1,316 | `api/routes/*.py` | Express → FastAPI |
| `middleware/auth.js` | 196 | `api/middleware/auth.py` | Clerk + JWT → FastAPI dependencies |
| `audio-utils.js` | 135 | **Eliminated** — `TwilioFrameSerializer` | Pipecat handles codec conversion |
| `index.js` | 93 | `main.py` + `bot.py` | Server setup in FastAPI |

**Lines eliminated by Pipecat:** ~2,456 (v1-advanced pipeline logic, WebSocket handler, ElevenLabs adapter, LLM adapter, audio utils)

**Lines to port:** ~3,544 (services, routes, middleware, DB schema)

---

## Project Structure

```
donna-pipecat/
├── bot.py                          ← Pipeline definition + Twilio entry point
├── main.py                         ← FastAPI server (API + WebSocket mount)
├── processors/
│   ├── quick_observer.py           ← Layer 1: Regex pattern matching (FrameProcessor)
│   └── guidance_stripper.py        ← Strip <guidance> tags before TTS
├── flows/
│   ├── nodes.py                    ← Call phase NodeConfigs (opening → closing)
│   ├── tools.py                    ← Tool definitions (search_memories, etc.)
│   └── actions.py                  ← Custom pre/post actions
├── services/
│   ├── memory.py                   ← Semantic memory (pgvector + OpenAI embeddings)
│   ├── daily_context.py            ← Same-day cross-call memory
│   ├── greetings.py                ← Time-aware greeting rotation
│   ├── call_analysis.py            ← Post-call Gemini analysis
│   ├── scheduler.py                ← Reminder scheduling + delivery
│   ├── news.py                     ← News via OpenAI web search
│   ├── conversations.py            ← Conversation history CRUD
│   ├── seniors.py                  ← Senior profile CRUD
│   └── caregivers.py               ← Caregiver relationships
├── api/
│   ├── routes/
│   │   ├── seniors.py              ← /api/seniors CRUD
│   │   ├── reminders.py            ← /api/reminders CRUD
│   │   ├── calls.py                ← /api/calls management
│   │   ├── memories.py             ← /api/memories
│   │   ├── conversations.py        ← /api/conversations
│   │   ├── caregivers.py           ← /api/caregivers
│   │   ├── stats.py                ← /api/stats
│   │   ├── admin_auth.py           ← /api/admin-auth (JWT)
│   │   ├── call_analyses.py        ← /api/call-analyses
│   │   ├── daily_context.py        ← /api/daily-context
│   │   └── health.py               ← /health
│   └── middleware/
│       ├── auth.py                 ← Clerk + JWT + cofounder auth
│       ├── rate_limit.py           ← Rate limiting
│       └── validation.py           ← Pydantic validation
├── db/
│   ├── client.py                   ← asyncpg connection pool
│   ├── models.py                   ← SQLAlchemy or raw SQL schema
│   └── setup_pgvector.py           ← pgvector initialization
├── scripts/
│   └── create_admin.py             ← Admin user seed script
├── apps/
│   ├── admin/                      ← React admin dashboard (unchanged)
│   ├── consumer/                   ← React consumer app (unchanged)
│   └── observability/              ← React observability dashboard (unchanged)
├── pyproject.toml                  ← Dependencies
├── Dockerfile
├── .env
└── pcc-deploy.toml                 ← Pipecat Cloud deployment config (optional)
```

---

## Core Implementation

### `bot.py` — Pipeline Definition

```python
import os
from loguru import logger
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.runner.types import RunnerArguments
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from processors.quick_observer import QuickObserverProcessor
from processors.guidance_stripper import GuidanceStripperProcessor
from flows.nodes import create_opening_node
from flows.tools import register_donna_tools
from services.memory import memory_service
from services.seniors import senior_service
from services.daily_context import daily_context_service
from services.greetings import greeting_service
from services.scheduler import scheduler_service

from pipecat_flows import FlowManager


async def bot(runner_args: RunnerArguments):
    """Entry point for each call — spawned per Twilio WebSocket connection."""

    # Parse Twilio stream metadata
    _, call_data = await parse_telephony_websocket(runner_args.websocket)
    stream_sid = call_data["stream_id"]
    call_sid = call_data["call_id"]

    # Extract custom parameters (senior_id, reminder context, etc.)
    custom_params = call_data.get("custom_parameters", {})
    senior_id = custom_params.get("senior_id")

    # Load senior context
    senior = await senior_service.get_by_id(senior_id) if senior_id else None
    if not senior:
        # Try to find by caller phone
        from_number = call_data.get("from_number")
        senior = await senior_service.find_by_phone(from_number) if from_number else None

    # Pre-fetch all context (no real-time DB calls during conversation)
    memory_context = await memory_service.build_context(senior["id"]) if senior else ""
    daily_context = await daily_context_service.get_todays_context(
        senior["id"], senior.get("timezone", "America/New_York")
    ) if senior else None
    reminder_context = await scheduler_service.get_reminder_context(call_sid)
    greeting = greeting_service.get_greeting(
        name=senior["name"],
        timezone=senior.get("timezone"),
        interests=senior.get("interests", []),
        daily_context=daily_context,
    ) if senior else None

    # Per-call session state (accessible via flow_manager.state)
    session_state = {
        "senior": senior,
        "senior_id": senior["id"] if senior else None,
        "call_sid": call_sid,
        "stream_sid": stream_sid,
        "memory_context": memory_context,
        "daily_context": daily_context,
        "reminder_context": reminder_context,
        "greeting": greeting,
        "topics_discussed": [],
        "reminders_delivered": set(),
        "questions_asked": [],
        "advice_given": [],
        "call_start_time": None,
        "transcript": [],
    }

    # --- Transport ---
    serializer = TwilioFrameSerializer(
        stream_sid=stream_sid,
        call_sid=call_sid,
        account_sid=os.getenv("TWILIO_ACCOUNT_SID", ""),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN", ""),
    )

    transport = FastAPIWebsocketTransport(
        websocket=runner_args.websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    # --- Services ---
    stt = DeepgramSTTService(
        api_key=os.getenv("DEEPGRAM_API_KEY"),
        live_options={
            "model": "nova-3-general",
            "language": "en",
            "sample_rate": 8000,
            "encoding": "linear16",
            "channels": 1,
            "interim_results": True,
            "smart_format": True,
            "punctuate": True,
        },
    )

    llm = AnthropicLLMService(
        api_key=os.getenv("ANTHROPIC_API_KEY"),
        model="claude-sonnet-4-20250514",
    )

    tts = ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY"),
        voice_id="21m00Tcm4TlvDq8ikWAM",  # Rachel
        model="eleven_flash_v2_5",
        params=ElevenLabsTTSService.InputParams(
            stability=0.4,
            similarity_boost=0.75,
            style=0.2,
            use_speaker_boost=True,
            speed=0.87,
        ),
    )

    # --- Register tools ---
    register_donna_tools(llm, session_state)

    # --- Context ---
    messages = [
        {
            "role": "system",
            "content": build_base_system_prompt(senior, memory_context, daily_context),
        },
    ]
    context = LLMContext(messages)

    # --- Aggregators (with VAD) ---
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=SileroVADAnalyzer(
                params=VADParams(
                    confidence=0.6,    # Lower threshold for elderly voices
                    start_secs=0.2,
                    stop_secs=0.8,     # Longer pause tolerance for seniors
                    min_volume=0.5,
                )
            ),
        ),
    )

    # --- Custom Processors ---
    quick_observer = QuickObserverProcessor()
    guidance_stripper = GuidanceStripperProcessor()

    # --- Pipeline ---
    pipeline = Pipeline([
        transport.input(),
        stt,
        quick_observer,         # Regex analysis → injects signals into context
        user_aggregator,        # Collects transcriptions → LLM context
        llm,                    # Claude Haiku with tools
        guidance_stripper,      # Strip <guidance> tags before TTS
        tts,                    # ElevenLabs WebSocket TTS
        transport.output(),     # Audio back to Twilio
        assistant_aggregator,   # Records what was actually spoken
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            enable_metrics=True,
        ),
    )

    # --- Flow Manager (call phase state machine) ---
    flow_manager = FlowManager(
        task=task,
        llm=llm,
        context_aggregator=user_aggregator,  # For context management
        transport=transport,
    )
    flow_manager.state = session_state

    # --- Event Handlers ---
    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info(f"Call connected: {call_sid}")
        session_state["call_start_time"] = __import__("time").time()
        await flow_manager.initialize(create_opening_node(session_state))

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"Call disconnected: {call_sid}")
        await run_post_call(session_state, context)
        await task.cancel()

    # --- Run ---
    runner = PipelineRunner(handle_sigint=runner_args.handle_sigint, force_gc=True)
    await runner.run(task)


def build_base_system_prompt(senior, memory_context, daily_context):
    """Build the base system prompt — updated per call phase via Flows."""
    parts = [
        "You are Donna, a warm and friendly AI companion who makes phone calls to elderly individuals.",
        "You speak naturally, like a caring friend. Keep responses conversational and concise.",
        "Never mention being an AI unless directly asked.",
    ]
    if senior:
        parts.append(f"\nYou're speaking with {senior['name']}.")
        if senior.get("interests"):
            parts.append(f"Their interests: {', '.join(senior['interests'])}.")
        if senior.get("family_info"):
            parts.append(f"Family: {senior['family_info']}")
        if senior.get("medical_notes"):
            parts.append(f"Health notes: {senior['medical_notes']}")
    if memory_context:
        parts.append(f"\n{memory_context}")
    if daily_context:
        from services.daily_context import format_todays_context
        parts.append(f"\n{format_todays_context(daily_context)}")
    return "\n".join(parts)


async def run_post_call(session_state, context):
    """Post-call processing — async, non-blocking."""
    from services.call_analysis import analyze_completed_call, save_call_analysis
    from services.memory import memory_service
    from services.daily_context import daily_context_service
    from services.conversations import conversation_service

    try:
        transcript = session_state.get("transcript", [])
        senior = session_state.get("senior")
        if not transcript or not senior:
            return

        # Save daily context
        await daily_context_service.save_call_context(
            senior_id=senior["id"],
            call_sid=session_state["call_sid"],
            data={
                "topics_discussed": session_state["topics_discussed"],
                "reminders_delivered": list(session_state["reminders_delivered"]),
                "advice_given": session_state["advice_given"],
            },
        )

        # Extract and save memories
        await memory_service.extract_from_conversation(
            senior_id=senior["id"],
            transcript=transcript,
            conversation_id=session_state["call_sid"],
        )

        # Run post-call analysis
        analysis = await analyze_completed_call(transcript, senior)
        if analysis:
            await save_call_analysis(
                conversation_id=session_state["call_sid"],
                senior_id=senior["id"],
                analysis=analysis,
            )
    except Exception as e:
        logger.error(f"Post-call processing error: {e}")


if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
```

### `processors/quick_observer.py` — Layer 1 Regex Analysis

```python
"""
Quick Observer — Direct port of pipelines/quick-observer.js (1,196 lines).
Pure regex-based pattern matching. Runs synchronously (0ms added latency).
Intercepts TranscriptionFrames and injects guidance into context.
"""
import re
from pipecat.frames.frames import Frame, TranscriptionFrame, LLMMessagesAppendFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# Pattern categories — direct port from quick-observer.js
HEALTH_PATTERNS = [
    (re.compile(r"\b(headache|head hurts|migraine)\b", re.I), "pain", "medium"),
    (re.compile(r"\b(dizzy|dizziness|lightheaded|vertigo)\b", re.I), "dizziness", "high"),
    (re.compile(r"\b(fell|fall|tripped|stumbled)\b", re.I), "fall", "high"),
    # ... all 74 health patterns from quick-observer.js
]

SAFETY_PATTERNS = [
    (re.compile(r"\b(scam|scammed|fraud|suspicious call)\b", re.I), "scam", "high"),
    # ... all 23 safety patterns
]

EMOTION_PATTERNS = [
    (re.compile(r"\b(lonely|lonesome|all alone|no one)\b", re.I), "loneliness", "negative", "high"),
    # ... all 32 emotion patterns
]

GOODBYE_PATTERNS = [
    (re.compile(r"\b(goodbye|bye bye|talk to you later|have a good)\b", re.I), "strong"),
    # ... all 12 goodbye patterns
]

WEB_SEARCH_PATTERNS = [
    re.compile(r"\b(what('s| is) (?:happening|going on) (?:in|with|around))\b", re.I),
    # ... all 18 web search patterns
]

# ... remaining pattern categories


class QuickObserverProcessor(FrameProcessor):
    """Intercepts transcriptions, runs regex analysis, injects guidance."""

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            text = frame.text
            analysis = self.analyze(text)

            # If patterns detected, inject guidance into LLM context
            if analysis["guidance"]:
                guidance_message = {
                    "role": "system",
                    "content": analysis["guidance"],
                }
                guidance_frame = LLMMessagesAppendFrame(
                    messages=[guidance_message],
                    run_llm=False,  # Don't trigger LLM — let normal flow handle it
                )
                await self.push_frame(guidance_frame, direction)

        # Always push the original frame through
        await self.push_frame(frame, direction)

    def analyze(self, text: str) -> dict:
        """Run all pattern categories against the text."""
        health_signals = []
        safety_signals = []
        emotion_signals = []
        needs_web_search = False
        goodbye_strength = None
        guidance_parts = []

        # Health patterns
        for pattern, signal, severity in HEALTH_PATTERNS:
            if pattern.search(text):
                health_signals.append({"signal": signal, "severity": severity})
                if severity == "high":
                    guidance_parts.append(
                        f"[HEALTH] {signal} detected — ask with gentle concern, "
                        f"don't diagnose or give medical advice."
                    )

        # Safety patterns
        for pattern, signal, severity in SAFETY_PATTERNS:
            if pattern.search(text):
                safety_signals.append({"signal": signal, "severity": severity})
                guidance_parts.append(
                    f"[SAFETY] {signal} detected — ask what happened, "
                    f"suggest contacting family if serious."
                )

        # Emotion patterns
        for pattern, signal, valence, intensity in EMOTION_PATTERNS:
            if pattern.search(text):
                emotion_signals.append({
                    "signal": signal, "valence": valence, "intensity": intensity
                })
                if valence == "negative" and intensity == "high":
                    guidance_parts.append(
                        f"[EMOTIONAL] {signal} detected — respond with empathy, "
                        f"validate their feelings."
                    )

        # Goodbye detection
        for pattern, strength in GOODBYE_PATTERNS:
            if pattern.search(text):
                goodbye_strength = strength
                guidance_parts.append(
                    f"[GOODBYE] {strength} goodbye signal — begin wrapping up warmly."
                )

        # Web search triggers
        for pattern in WEB_SEARCH_PATTERNS:
            if pattern.search(text):
                needs_web_search = True

        guidance = "\n".join(guidance_parts) if guidance_parts else None

        return {
            "health_signals": health_signals,
            "safety_signals": safety_signals,
            "emotion_signals": emotion_signals,
            "goodbye_strength": goodbye_strength,
            "needs_web_search": needs_web_search,
            "guidance": guidance,
        }
```

### `processors/guidance_stripper.py` — Strip Tags Before TTS

```python
"""Strip <guidance> tags and internal markers from LLM output before TTS."""
import re
from pipecat.frames.frames import Frame, TextFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

GUIDANCE_PATTERN = re.compile(r"<guidance>.*?</guidance>", re.DOTALL)
BRACKET_PATTERN = re.compile(r"\[.*?\]")


class GuidanceStripperProcessor(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, TextFrame):
            cleaned = GUIDANCE_PATTERN.sub("", frame.text)
            cleaned = BRACKET_PATTERN.sub("", cleaned).strip()
            if cleaned:
                frame.text = cleaned
                await self.push_frame(frame, direction)
            # If empty after stripping, don't push (skip silent frames)
        else:
            await self.push_frame(frame, direction)
```

### `flows/nodes.py` — Call Phase State Machine

```python
"""
Pipecat Flows node definitions for Donna's call phases.
Replaces the Conversation Director's phase tracking.
"""
from pipecat_flows import (
    FlowArgs, FlowManager, FlowsFunctionSchema, NodeConfig,
    ContextStrategy, ContextStrategyConfig,
)
from flows.tools import DONNA_TOOLS, CLOSING_TOOLS


def create_opening_node(session_state: dict) -> NodeConfig:
    """Opening phase — greeting + initial rapport."""

    greeting_text = session_state.get("greeting", {}).get("greeting", "Hello!")
    senior = session_state.get("senior", {})
    name = senior.get("name", "there")

    async def transition_to_main(
        args: FlowArgs, flow_manager: FlowManager
    ) -> tuple[None, NodeConfig]:
        flow_manager.state["topics_discussed"].append("opening_rapport")
        return None, create_main_node(flow_manager.state)

    return NodeConfig(
        name="opening",
        role_messages=[{
            "role": "system",
            "content": (
                f"You are Donna, calling {name} for a friendly check-in. "
                "Be warm, natural, and conversational. Never mention being an AI."
            ),
        }],
        task_messages=[{
            "role": "system",
            "content": (
                "You just connected. Greet them warmly and ask how they're doing. "
                "Listen to their response and build rapport. "
                "When they've responded to your greeting and you've exchanged pleasantries, "
                "call transition_to_main to move into the main conversation."
            ),
        }],
        pre_actions=[
            {"type": "tts_say", "text": greeting_text},
        ],
        functions=[
            *DONNA_TOOLS,
            FlowsFunctionSchema(
                name="transition_to_main",
                handler=transition_to_main,
                description="Move to main conversation after initial greeting exchange",
                properties={},
                required=[],
            ),
        ],
    )


def create_main_node(session_state: dict) -> NodeConfig:
    """Main conversation — free-form companionship with all tools available."""

    senior = session_state.get("senior", {})
    reminder_context = session_state.get("reminder_context")

    task_content = (
        "You're in the main conversation. Be a warm, engaged companion. "
        "Follow the senior's lead on topics. Use search_memories when they reference "
        "past conversations. Use get_news when they're curious about current events.\n"
    )

    if reminder_context:
        task_content += (
            f"\nReminder to deliver naturally: {reminder_context.get('reminder_prompt', '')}. "
            "Find a natural moment to weave this in — don't force it."
        )

    topics = session_state.get("topics_discussed", [])
    if topics:
        task_content += f"\nTopics already discussed: {', '.join(topics)}. Don't repeat these."

    async def transition_to_closing(
        args: FlowArgs, flow_manager: FlowManager
    ) -> tuple[None, NodeConfig]:
        return None, create_closing_node(flow_manager.state)

    return NodeConfig(
        name="main",
        task_messages=[{
            "role": "system",
            "content": task_content,
        }],
        context_strategy=ContextStrategyConfig(
            strategy=ContextStrategy.RESET_WITH_SUMMARY,
            summary_prompt=(
                f"Summarize this conversation with {senior.get('name', 'the senior')}. "
                "Include: topics discussed, any health concerns mentioned, emotional state, "
                "reminders delivered and whether acknowledged, and any important details shared. "
                "Keep it concise but complete."
            ),
        ),
        functions=[
            *DONNA_TOOLS,
            FlowsFunctionSchema(
                name="begin_closing",
                handler=transition_to_closing,
                description=(
                    "Begin wrapping up the call. Use when: the senior says goodbye, "
                    "the conversation has naturally wound down, or the call has been going "
                    "for 15+ minutes."
                ),
                properties={},
                required=[],
            ),
        ],
    )


def create_closing_node(session_state: dict) -> NodeConfig:
    """Closing phase — warm goodbye, deliver any remaining reminders."""

    undelivered = session_state.get("reminder_context")
    delivered = session_state.get("reminders_delivered", set())

    task_content = "Wrap up the call warmly. "
    if undelivered and undelivered.get("reminder", {}).get("id") not in delivered:
        task_content += (
            "IMPORTANT: You haven't delivered the reminder yet. "
            "Mention it naturally before saying goodbye: "
            f"{undelivered.get('reminder_prompt', '')}"
        )
    task_content += " Say a warm goodbye and wish them well."

    return NodeConfig(
        name="closing",
        task_messages=[{
            "role": "system",
            "content": task_content,
        }],
        functions=CLOSING_TOOLS,
        post_actions=[
            {"type": "end_conversation"},
        ],
    )
```

### `flows/tools.py` — Tool Definitions

```python
"""
LLM-callable tools for Donna.
Replaces: fast-observer.js memory search, news lookup, reminder tracking.
The LLM decides when to call these — no more automatic per-turn searches.
"""
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams


# --- Tool Handlers ---

async def handle_search_memories(params: FunctionCallParams):
    """Semantic memory search — called when senior references past conversations."""
    from services.memory import memory_service

    query = params.arguments["query"]
    senior_id = params.function_call_context.get("senior_id")
    if not senior_id:
        await params.result_callback("No senior context available.")
        return

    results = await memory_service.search(senior_id, query, limit=3)
    if results:
        formatted = "\n".join(
            f"- {m['content']} ({m['type']}, {m['created_at']:%b %d})"
            for m in results
        )
        await params.result_callback(f"Relevant memories:\n{formatted}")
    else:
        await params.result_callback("No matching memories found.")


async def handle_get_news(params: FunctionCallParams):
    """Fetch news on a topic the senior is curious about."""
    from services.news import news_service

    topic = params.arguments["topic"]
    news = await news_service.get_news_for_topic(topic, limit=2)
    if news:
        await params.result_callback(news)
    else:
        await params.result_callback(f"I couldn't find recent news about {topic}.")


async def handle_mark_reminder(params: FunctionCallParams):
    """Mark a reminder as acknowledged by the senior."""
    from services.scheduler import scheduler_service

    reminder_id = params.arguments["reminder_id"]
    response = params.arguments.get("user_response", "")
    status = params.arguments.get("status", "acknowledged")

    await scheduler_service.mark_reminder_acknowledged(reminder_id, status, response)
    await params.result_callback(f"Reminder {reminder_id} marked as {status}.")


async def handle_save_detail(params: FunctionCallParams):
    """Save an important detail about the senior for future calls."""
    from services.memory import memory_service

    content = params.arguments["detail"]
    category = params.arguments["category"]
    senior_id = params.function_call_context.get("senior_id")

    if senior_id:
        await memory_service.store(
            senior_id=senior_id,
            type=category,
            content=content,
            source="conversation",
            importance=70,
        )
        await params.result_callback(f"Noted: {content}")
    else:
        await params.result_callback("Could not save — no senior context.")


# --- Schema Definitions ---

search_memories_schema = FunctionSchema(
    name="search_memories",
    description=(
        "Search the senior's conversation memories. Use when they say things like "
        "'remember when I told you about...', 'we talked about...', or reference "
        "past conversations. Also use to check what you know about a topic."
    ),
    properties={
        "query": {
            "type": "string",
            "description": "What to search for in memories",
        },
    },
    required=["query"],
)

get_news_schema = FunctionSchema(
    name="get_news",
    description=(
        "Look up recent news about a topic the senior is interested in or asking about. "
        "Use when they ask about current events, news, weather, sports, or politics."
    ),
    properties={
        "topic": {
            "type": "string",
            "description": "The news topic to search for",
        },
    },
    required=["topic"],
)

mark_reminder_schema = FunctionSchema(
    name="mark_reminder_acknowledged",
    description=(
        "Mark a medication or appointment reminder as acknowledged after the senior "
        "confirms they'll do it or says they already did it."
    ),
    properties={
        "reminder_id": {
            "type": "string",
            "description": "The reminder ID",
        },
        "status": {
            "type": "string",
            "enum": ["acknowledged", "confirmed"],
            "description": "acknowledged = will do, confirmed = already done",
        },
        "user_response": {
            "type": "string",
            "description": "What the senior said in response to the reminder",
        },
    },
    required=["reminder_id", "status"],
)

save_detail_schema = FunctionSchema(
    name="save_important_detail",
    description=(
        "Save something important the senior shared for future conversations. "
        "Use for: new health info, family updates, preferences, concerns, or "
        "meaningful stories they'd want you to remember."
    ),
    properties={
        "detail": {
            "type": "string",
            "description": "The detail to remember",
        },
        "category": {
            "type": "string",
            "enum": ["fact", "preference", "event", "concern", "relationship"],
            "description": "Category of the detail",
        },
    },
    required=["detail", "category"],
)


def register_donna_tools(llm, session_state):
    """Register all tool handlers with the LLM service."""
    llm.register_function("search_memories", handle_search_memories)
    llm.register_function("get_news", handle_get_news)
    llm.register_function("mark_reminder_acknowledged", handle_mark_reminder)
    llm.register_function("save_important_detail", handle_save_detail)

    # Inject senior_id into function call context
    for func_name in ["search_memories", "mark_reminder_acknowledged", "save_important_detail"]:
        llm.set_function_call_context(func_name, {"senior_id": session_state.get("senior_id")})


# Schemas bundled for use in FlowsFunctionSchema
from pipecat_flows import FlowsFunctionSchema

DONNA_TOOLS = [
    FlowsFunctionSchema.from_function_schema(search_memories_schema),
    FlowsFunctionSchema.from_function_schema(get_news_schema),
    FlowsFunctionSchema.from_function_schema(mark_reminder_schema),
    FlowsFunctionSchema.from_function_schema(save_detail_schema),
]

CLOSING_TOOLS = [
    FlowsFunctionSchema.from_function_schema(mark_reminder_schema),
]
```

---

## What Gets Eliminated vs. Ported

### Eliminated (handled by Pipecat)

| What | Current LOC | Replaced By |
|------|-------------|-------------|
| WebSocket handler + audio routing | 202 | `FastAPIWebsocketTransport` + `TwilioFrameSerializer` |
| ElevenLabs WebSocket TTS adapter | 270 | `ElevenLabsTTSService` (with word timestamps) |
| Deepgram connection management | ~60 | `DeepgramSTTService` (with reconnection) |
| LLM adapter factory + model registry | 157 | `AnthropicLLMService` / `GoogleLLMService` |
| Audio codec conversion (mulaw↔PCM) | 135 | `TwilioFrameSerializer` |
| Conversation Director (fast-observer) | 647 | Pipecat Flows nodes + tools |
| Sentence buffering + streaming | ~200 | Built-in TTS sentence aggregation |
| Barge-in / interruption handling | ~80 | Built-in pipeline cancellation + word timestamps |
| Silence detection + call ending | ~100 | Silero VAD + Flows `end_conversation` action |
| **Total eliminated** | **~1,851** | |

### Ported (business logic, same patterns)

| What | Current LOC | Port Complexity |
|------|-------------|-----------------|
| Quick Observer regex patterns | 1,196 | Mechanical — regex is identical in Python |
| Memory service (pgvector) | 329 | Medium — asyncpg replaces Drizzle, OpenAI SDK same |
| Greeting rotation | 258 | Easy — pure logic, no dependencies |
| Scheduler service | 515 | Medium — Twilio SDK, APScheduler |
| Call analysis | 257 | Easy — Gemini API call same pattern |
| Daily context | 197 | Easy — DB queries |
| Conversations service | 172 | Easy — CRUD |
| Seniors service | 66 | Easy — CRUD |
| Caregivers service | 84 | Easy — CRUD |
| News service | 104 | Easy — OpenAI SDK |
| REST API routes (13 files) | 1,316 | Medium — Express → FastAPI |
| Auth middleware | 196 | Medium — Clerk + JWT |
| DB schema | 130 | Easy — Drizzle → SQLAlchemy/raw |
| **Total to port** | **~4,820** | |

### New code (Pipecat-specific)

| What | Est. LOC | Purpose |
|------|----------|---------|
| `bot.py` (pipeline + entry) | ~200 | Pipeline definition, context loading |
| `flows/nodes.py` | ~150 | Call phase state machine |
| `flows/tools.py` | ~200 | Tool definitions + handlers |
| `processors/quick_observer.py` | ~300 | FrameProcessor wrapper around ported regex |
| `processors/guidance_stripper.py` | ~30 | Tag stripping processor |
| **Total new** | **~880** | |

---

## Key Architectural Decisions

### 1. No More Director — Tools + Flows Replace It

The Conversation Director (Gemini Flash, ~150ms) currently:
- Tracks call phase → **Flows nodes handle this**
- Manages topic transitions → **LLM + `RESET_WITH_SUMMARY` handle this**
- Decides when to deliver reminders → **LLM decides via system prompt per node**
- Monitors engagement → **Quick Observer detects low engagement, injects guidance**
- Recommends token count → **Per-node configuration or dynamic via processor**

This eliminates 647 lines and removes a ~150ms parallel LLM call from every turn.

### 2. Memory Search Is a Tool, Not Automatic

Current: Director searches memories every turn (~100ms, often unnecessary).
Pipecat: LLM calls `search_memories` tool when the senior references past conversations.

Trade-off: The LLM might miss opportunities to reference memories. Mitigation: the pre-fetched `memory_context` in the system prompt provides the most important memories upfront.

### 3. Context Summarization Built In

Current: Last 20 turns kept raw, no compression.
Pipecat Flows: `RESET_WITH_SUMMARY` automatically summarizes and compresses context when it exceeds the threshold. Critical for 15-30 minute calls.

### 4. VAD + Word Timestamps Come Free

Current: No VAD, no word timestamps, simple silence timer.
Pipecat: Silero VAD filters non-speech. ElevenLabs word timestamps enable accurate interruption context. Both are zero additional code.

---

## Deployment Options

### Option A: Self-Hosted (Railway, Fly.io, any Docker host)

```dockerfile
FROM dailyco/pipecat-base:latest
ENV UV_COMPILE_BYTECODE=1
ENV UV_LINK_MODE=copy

RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

COPY . .
EXPOSE 7860
CMD ["uv", "run", "bot.py", "-t", "twilio"]
```

Same deployment pattern as current Railway setup. Twilio webhooks point to your server.

### Option B: Pipecat Cloud

```toml
# pcc-deploy.toml
[deploy]
agent_name = "donna"
```

```bash
pipecat cloud deploy
```

- $0.01/min active agent + $0.018/min PSTN telephony
- Could replace Twilio entirely (Daily telephony)
- Autoscaling, HIPAA compliant, managed infrastructure
- ~$0.28/call for a 10-minute call (infrastructure only)

---

## Migration Effort Estimate

| Phase | Work | Duration |
|-------|------|----------|
| **Phase 1: Core pipeline** | bot.py, processors, flows, basic tools | 3-4 days |
| **Phase 2: Port services** | memory, scheduler, greetings, news, daily-context, call-analysis | 3-4 days |
| **Phase 3: Port API** | FastAPI routes, auth middleware, DB layer | 2-3 days |
| **Phase 4: Quick Observer** | Port all 200+ regex patterns to Python | 1-2 days |
| **Phase 5: Integration testing** | End-to-end calls, tool execution, context management | 3-5 days |
| **Phase 6: Senior testing** | Real calls with elderly users, tuning VAD/timing | 2-3 days |
| **Total** | | **14-21 days** |

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Twilio audio quality bugs in Pipecat | Choppy audio for seniors | Test thoroughly; fallback to Daily telephony on Pipecat Cloud |
| Anthropic system prompt can't update dynamically | Can't inject per-turn context | Use `LLMMessagesAppendFrame` for dynamic context; role_messages set once per node |
| ParallelPipeline bugs (if needed later) | Can't run parallel processors | Not needed — Director is eliminated. Quick Observer is synchronous |
| Python async learning curve | Slower development | Python asyncio is well-documented; FastAPI is familiar REST pattern |
| Pipecat Flows too rigid for long free-form calls | Stuck in wrong node | `main` node is open-ended; LLM transitions when appropriate |

---

*This document maps every file in Donna's current Node.js codebase to its Pipecat Python equivalent. The migration eliminates ~1,851 lines of infrastructure code, ports ~4,820 lines of business logic, and adds ~880 lines of Pipecat-specific integration code.*
