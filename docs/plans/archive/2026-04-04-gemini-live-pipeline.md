# Gemini 3.1 Flash Live Pipeline Implementation Plan

> Historical implementation plan. Do not use this as runtime source of truth.
> Current runtime source of truth is `pipecat/bot_gemini.py`, `pipecat/config.py`, and `pipecat/docs/ARCHITECTURE.md`.
> Superseded detail: Gemini Live evaluation uses 16kHz internal input and 24kHz internal output; active Telnyx calls use L16/16k at the serializer edge.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Gemini 3.1 Flash Live as a parallel voice pipeline selectable via GrowthBook `voice_backend` flag, with full tool support (memory search, web search, reminders, save detail).

**Architecture:** `bot.py` routes to `bot_gemini.py` after flag resolution. `bot_gemini.py` runs a 3-processor pipeline (`transport.input() → GeminiLiveLLMService → transport.output()`) — no Deepgram STT, no ElevenLabs/Cartesia TTS, no Director, no Observer, no FlowManager. GeminiLiveLLMService handles speech-to-speech natively with Aoede voice. Tool handlers are reused from `flows/tools.py` with a thin adapter for Pipecat's `register_function` interface.

**Tech Stack:** `pipecat-ai[google]` (GeminiLiveLLMService), `models/gemini-3.1-flash-live-preview`, GrowthBook flag `voice_backend` = `"claude"` (default) or `"gemini_live"`

---

## Key Facts Before You Start

- **`GOOGLE_API_KEY`** is already set in Railway (used for post-call analysis). No new key needed.
- **Pipecat import path**: `from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService` (requires `pipecat-ai[google]` extra)
- **Old path is deprecated** since v0.0.90: `pipecat.services.gemini_multimodal_live` → do NOT use
- **Model ID**: `"models/gemini-3.1-flash-live-preview"` (the `models/` prefix is required)
- **Voice**: `"Aoede"`
- **GeminiLiveLLMService replaces STT + LLM + TTS** — remove Deepgram, ElevenLabs/Cartesia from the Gemini pipeline
- **No FlowManager** — single-phase design, all context in one system prompt, `end_call` tool for graceful shutdown
- **Tool calling is synchronous** in Gemini 3.1 (model pauses ~150ms, runs tool, continues). No async/NON_BLOCKING.
- **Pipecat `register_function` signature**: `async def handler(function_name, tool_call_id, args, llm, context, result_callback)` — needs wrapper around existing `(args) -> dict` handlers in `flows/tools.py`
- **Audio format**: Gemini Live inputs 16-bit PCM 16kHz, outputs 24kHz. `TwilioFrameSerializer` handles mulaw conversion. Set `audio_in_sample_rate=8000` in PipelineParams (Twilio sends 8kHz mulaw).
- **Session limit**: 15 minutes. Current hard-limit is 12 min via Director force-end (which won't exist in Gemini pipeline — include `end_call` tool or accept WebSocket disconnect as termination).

---

## Task 1: Dependencies + GrowthBook flag

**Files:**
- Modify: `pipecat/pyproject.toml:7`
- Modify: `pipecat/lib/growthbook.py:88-97`

**Step 1: Add `google` extra to pipecat-ai**

In `pipecat/pyproject.toml`, change line 7:

```toml
# Before:
"pipecat-ai[anthropic,cartesia,deepgram,elevenlabs,silero,websocket,runner]>=0.0.101",
# After:
"pipecat-ai[anthropic,cartesia,deepgram,elevenlabs,google,silero,websocket,runner]>=0.0.101",
```

**Step 2: Add `voice_backend` flag to GrowthBook defaults**

In `pipecat/lib/growthbook.py`, add to the `defaults` dict inside `resolve_flags()` (around line 88):

```python
defaults = {
    "director_enabled": True,
    "news_search_enabled": True,
    "memory_search_enabled": True,
    "tts_fallback": False,
    "tts_provider": "elevenlabs",
    "context_cache_enabled": True,
    "post_call_analysis_enabled": True,
    "scheduler_call_stagger_ms": 5000,
    "voice_backend": "claude",  # "claude" or "gemini_live"
}
```

Also update the flag resolution loop — `voice_backend` is a string value, not bool. The existing `else` branch handles `get_feature_value` for non-bool defaults, so no other change needed.

**Step 3: Commit**

```bash
cd /Users/davidzuluaga/code/donna2
git add pipecat/pyproject.toml pipecat/lib/growthbook.py
git commit -m "feat: add google pipecat extra and voice_backend GrowthBook flag"
```

---

## Task 2: Gemini tool schemas + handler adapter

**Files:**
- Create: `pipecat/flows/gemini_tools.py`

The existing handlers in `flows/tools.py` use `async def handler(args: dict) -> dict`. Pipecat's `register_function` uses a different signature. We need a thin adapter plus Gemini-format tool schemas.

**Step 1: Create `pipecat/flows/gemini_tools.py`**

```python
"""Gemini Live tool schemas and handler adapters.

Adapts existing flows/tools.py handlers for use with GeminiLiveLLMService.

Two pieces:
1. GEMINI_TOOLS_SCHEMA - list[dict] in Gemini function_declarations format
2. register_gemini_tools() - registers handlers via llm.register_function()
"""

from __future__ import annotations

from datetime import date
from loguru import logger


# ---------------------------------------------------------------------------
# Tool schemas in Gemini function_declarations format
# ---------------------------------------------------------------------------

def _build_gemini_tools(session_state: dict) -> list[dict]:
    """Build Gemini-format tool schema list.

    Returns a list with a single function_declarations entry containing
    all tools available during the call.
    """
    today = date.today().strftime("%B %d, %Y")

    declarations = [
        {
            "name": "search_memories",
            "description": (
                "Search the senior's memory bank for relevant past conversations, "
                "preferences, or details. Use when they mention something you might "
                "have discussed before, or when you need context about their life."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for (e.g., 'gardening', 'grandson birthday', 'medication')",
                    }
                },
                "required": ["query"],
            },
        },
        {
            "name": "web_search",
            "description": (
                f"Search the web for current information. Today is {today}. "
                "Use when the senior asks about news, weather, sports, facts, or "
                "anything you're unsure about. Always say a brief filler aloud "
                "before calling this tool — 'Let me look that up' or 'One moment' — "
                "so the senior hears something while the search runs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": f"What to search for (include {date.today().year} for recent events)",
                    }
                },
                "required": ["query"],
            },
        },
        {
            "name": "save_important_detail",
            "description": (
                "Save an important detail the senior mentioned that should be remembered "
                "for future calls. Use for significant life events, health changes, new "
                "interests, family updates, or emotional state changes."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "detail": {
                        "type": "string",
                        "description": "The detail to remember (e.g., 'Grandson Jake graduated from college')",
                    },
                    "category": {
                        "type": "string",
                        "enum": ["health", "family", "preference", "life_event", "emotional", "activity"],
                        "description": "Category of the detail",
                    },
                },
                "required": ["detail", "category"],
            },
        },
        {
            "name": "mark_reminder_acknowledged",
            "description": (
                "Mark a reminder as acknowledged after you have delivered it and the senior "
                "has responded. Call this after delivering a reminder and getting their response."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reminder_id": {
                        "type": "string",
                        "description": "The ID of the reminder that was delivered",
                    },
                    "status": {
                        "type": "string",
                        "enum": ["acknowledged", "confirmed"],
                        "description": "Whether the senior acknowledged or confirmed the reminder",
                    },
                    "user_response": {
                        "type": "string",
                        "description": "Brief summary of what the senior said about the reminder",
                    },
                },
                "required": ["reminder_id", "status"],
            },
        },
        {
            "name": "end_call",
            "description": (
                "End the call gracefully. Call this ONLY when the senior says goodbye "
                "and is clearly done — 'goodbye', 'talk to you later', 'I gotta go', etc. "
                "Say your goodbye first, THEN call this tool. The call will end immediately."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    ]

    return [{"function_declarations": declarations}]


# ---------------------------------------------------------------------------
# Handler adapter: wrap (args) -> dict handlers for Pipecat register_function
# ---------------------------------------------------------------------------

def _pipecat_adapter(name: str, handler):
    """Wrap a simple async (args: dict) -> dict handler for Pipecat's register_function.

    Pipecat's register_function callback signature:
        async def cb(function_name, tool_call_id, args, llm, context, result_callback)

    result_callback expects a string or dict result.
    """
    async def adapted(function_name, tool_call_id, args, llm, context, result_callback):
        logger.info("Gemini tool CALL: {name}({args})", name=name, args=args)
        try:
            result = await handler(args or {})
            result_str = result.get("result", "ok") if isinstance(result, dict) else str(result)
        except Exception as e:
            logger.error("Gemini tool ERROR {name}: {err}", name=name, err=str(e))
            result_str = "Tool unavailable. Continue naturally."
        logger.info("Gemini tool RESULT: {name} → {r}", name=name, r=result_str[:100])
        await result_callback(result_str)
    return adapted


def register_gemini_tools(llm, session_state: dict, task_ref: list) -> None:
    """Register all tool handlers on a GeminiLiveLLMService instance.

    Args:
        llm: GeminiLiveLLMService instance
        session_state: call session state dict
        task_ref: single-element list holding the PipelineTask (set after task creation)
    """
    from flows.tools import make_tool_handlers
    from pipecat.frames.frames import EndFrame

    handlers = make_tool_handlers(session_state)

    # Register existing handlers with adapter
    for name, handler in handlers.items():
        llm.register_function(name, _pipecat_adapter(name, handler))

    # Register end_call — uses task_ref to queue EndFrame
    async def handle_end_call(function_name, tool_call_id, args, llm_ref, context, result_callback):
        logger.info("Gemini tool: end_call triggered")
        session_state["_end_reason"] = "gemini_end_call_tool"
        await result_callback("Call ended.")
        if task_ref[0] is not None:
            import asyncio
            await asyncio.sleep(0.5)  # Brief pause so goodbye TTS plays
            await task_ref[0].queue_frame(EndFrame())

    llm.register_function("end_call", handle_end_call)
```

**Step 2: Commit**

```bash
cd /Users/davidzuluaga/code/donna2
git add pipecat/flows/gemini_tools.py
git commit -m "feat: Gemini Live tool schemas and Pipecat adapter"
```

---

## Task 3: Gemini bot pipeline

**Files:**
- Create: `pipecat/bot_gemini.py`

**Step 1: Create `pipecat/bot_gemini.py`**

```python
"""Donna voice pipeline — Gemini 3.1 Flash Live variant.

Replaces the 3-hop STT→Claude→TTS stack with a single native audio model.

Pipeline:
    Twilio transport.input()
    → GeminiLiveLLMService (Aoede voice, Gemini 3.1 Flash Live)
    → ConversationTrackerProcessor (transcript for post-call)
    → transport.output()

Called from bot.py when voice_backend flag == "gemini_live".
No Director, no Observer, no FlowManager, no separate STT/TTS.
"""

from __future__ import annotations

import asyncio
import os
import time

from loguru import logger

from pipecat.frames.frames import EndFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

try:
    from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
except ImportError as e:
    raise ImportError(
        "GeminiLiveLLMService not available. Install pipecat-ai[google]: "
        "add 'google' to the extras in pyproject.toml"
    ) from e

from processors.conversation_tracker import ConversationTrackerProcessor
from services.post_call import run_post_call


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------

def _build_system_prompt(session_state: dict) -> str:
    """Build the single-phase system prompt for the Gemini Live pipeline.

    Combines base personality, senior context (memory, news, reminders),
    and conversation instructions into one comprehensive prompt.
    No ephemeral injection — everything is in the initial system prompt.
    """
    from prompts import BASE_SYSTEM_PROMPT

    sections = [BASE_SYSTEM_PROMPT]

    # Senior profile context
    senior = session_state.get("senior") or {}
    first_name = senior.get("name", "").split()[0] if senior.get("name") else "there"

    # Memory context
    memory = session_state.get("memory_context")
    if memory:
        sections.append(f"MEMORIES ABOUT {first_name.upper()}:\n{memory}")

    # Today's call context (cross-call same-day)
    todays_ctx = session_state.get("todays_context")
    if todays_ctx:
        sections.append(f"TODAY'S CONTEXT:\n{todays_ctx}")

    # Recent turns from previous calls
    recent_turns = session_state.get("recent_turns")
    if recent_turns:
        sections.append(f"RECENT CONVERSATION HISTORY:\n{recent_turns}")

    # News context
    news = session_state.get("news_context")
    if news:
        sections.append(f"NEWS FOR THIS CALL:\n{news}")

    # Caregiver notes (pre-fetched at call start)
    notes = session_state.get("_caregiver_notes_content") or []
    if notes:
        formatted = "\n".join(
            f"- {n.get('content', '') if isinstance(n, dict) else str(n)}"
            for n in notes if (n.get("content") if isinstance(n, dict) else n)
        )
        sections.append(f"CAREGIVER NOTES (share naturally):\n{formatted}")

    # Reminders to deliver
    reminder_prompt = session_state.get("reminder_prompt")
    if reminder_prompt:
        sections.append(f"REMINDERS TO DELIVER:\n{reminder_prompt}")

    # Call phase instructions (single-phase version of MAIN_TASK)
    call_type = session_state.get("call_type", "check-in")
    is_outbound = session_state.get("is_outbound", True)

    if is_outbound:
        opening = f"START THE CALL: Greet {first_name} warmly and ask how they're doing."
    else:
        opening = f"INBOUND CALL: {first_name} is calling you. Respond warmly to their greeting."

    sections.append(f"""{opening}

CONVERSATION STYLE: Natural, warm dialogue. Weave in reminders early if present. Reference memories naturally — "I remember you mentioned..." Don't dump everything at once.

TOOLS AVAILABLE:
- search_memories: Search their memory bank when they mention something from the past
- web_search: Look up current info. Say a filler BEFORE calling ("Let me find out for you")
- save_important_detail: Save new things they share (health changes, family news, interests)
- mark_reminder_acknowledged: Mark reminders as delivered after they respond
- end_call: Call ONLY when the senior says goodbye and is done. Say your goodbye FIRST, then call this tool.

ENDING THE CALL: When the senior says goodbye or wants to go, say a warm brief farewell and IMMEDIATELY call end_call. Never let the call drift after goodbyes — the senior will hear silence.""")

    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Post-call helper (shared with bot.py)
# ---------------------------------------------------------------------------

async def _safe_post_call(session_state: dict, conversation_tracker, elapsed: int, call_sid: str):
    try:
        await run_post_call(session_state, conversation_tracker, elapsed)
    except Exception as e:
        logger.error("[{cs}] Gemini post-call failed: {err}", cs=call_sid, err=str(e))


# ---------------------------------------------------------------------------
# Main entry point (called from bot.py)
# ---------------------------------------------------------------------------

async def run_gemini_pipeline(
    session_state: dict,
    transport,
    start_time: float,
) -> None:
    """Run the Gemini Live voice pipeline.

    Args:
        session_state: Pre-populated call context (same as bot.py uses)
        transport: FastAPIWebsocketTransport already created by bot.py
        start_time: Call start time.time() for elapsed calculation
    """
    call_sid = session_state.get("call_sid", "unknown")
    logger.info("[{cs}] Starting Gemini Live pipeline", cs=call_sid)

    # Build system prompt from session context
    system_prompt = _build_system_prompt(session_state)
    logger.debug("[{cs}] Gemini system prompt: {n} chars", cs=call_sid, n=len(system_prompt))

    # task_ref: mutable container so end_call handler can queue EndFrame
    task_ref = [None]

    # -------------------------------------------------------------------------
    # LLM service (speech-to-speech — handles STT + LLM + TTS internally)
    # -------------------------------------------------------------------------
    from flows.gemini_tools import _build_gemini_tools, register_gemini_tools

    llm = GeminiLiveLLMService(
        api_key=os.getenv("GOOGLE_API_KEY", ""),
        model="models/gemini-3.1-flash-live-preview",
        system_instruction=system_prompt,
        tools=_build_gemini_tools(session_state),
        settings=GeminiLiveLLMService.Settings(
            voice="Aoede",
        ),
    )

    # Register tool handlers (must happen before pipeline starts)
    register_gemini_tools(llm, session_state, task_ref)

    # -------------------------------------------------------------------------
    # Processors
    # -------------------------------------------------------------------------
    conversation_tracker = ConversationTrackerProcessor(session_state=session_state)
    session_state["_conversation_tracker"] = conversation_tracker

    # -------------------------------------------------------------------------
    # Pipeline (minimal: transport → Gemini → tracker → transport)
    # -------------------------------------------------------------------------
    pipeline = Pipeline([
        transport.input(),
        llm,
        conversation_tracker,
        transport.output(),
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
        ),
    )

    # Wire task_ref so end_call tool can trigger EndFrame
    task_ref[0] = task

    # -------------------------------------------------------------------------
    # Event handlers
    # -------------------------------------------------------------------------
    @transport.event_handler("on_client_disconnected")
    async def on_disconnected(transport_ref, websocket_ref):
        elapsed = round(time.time() - start_time)
        logger.info("[{cs}] Gemini: client disconnected after {s}s", cs=call_sid, s=elapsed)
        session_state.setdefault("_end_reason", "user_hangup")
        conversation_tracker.flush()
        await task.queue_frame(EndFrame())
        asyncio.create_task(_safe_post_call(session_state, conversation_tracker, elapsed, call_sid))

    # -------------------------------------------------------------------------
    # Run
    # -------------------------------------------------------------------------
    runner = PipelineRunner(handle_sigint=False)
    logger.info("[{cs}] Gemini pipeline ready, running...", cs=call_sid)
    await runner.run(task)
    logger.info("[{cs}] Gemini pipeline ended", cs=call_sid)
```

**Step 2: Commit**

```bash
cd /Users/davidzuluaga/code/donna2
git add pipecat/bot_gemini.py
git commit -m "feat: Gemini 3.1 Flash Live bot pipeline (Aoede voice, single-phase, 5 tools)"
```

---

## Task 4: Route in bot.py

**Files:**
- Modify: `pipecat/bot.py:370-385` (after flags resolved, before pipeline assembly)

**Step 1: Add routing check to bot.py**

After the flag resolution block (around line 231) and BEFORE the transport creation block (around line 238), add:

```python
    # -------------------------------------------------------------------------
    # Route to Gemini Live pipeline if flag is set
    # -------------------------------------------------------------------------
    voice_backend = (session_state.get("_flags") or {}).get("voice_backend", "claude")
    if voice_backend == "gemini_live":
        logger.info("[{cs}] Routing to Gemini Live pipeline", cs=call_sid)
        # Transport is needed by both pipelines — create it first
        # (transport is created below, so we fall through to transport creation,
        # then call run_gemini_pipeline which receives the transport)
```

Actually the transport needs to be created before routing since `run_gemini_pipeline` receives it. The cleanest insertion point is **after transport creation** (around line 260) and **before the STT/LLM/TTS block** (around line 263):

```python
    # After transport creation, before STT/LLM/TTS:
    voice_backend = (session_state.get("_flags") or {}).get("voice_backend", "claude")
    if voice_backend == "gemini_live":
        logger.info("[{cs}] voice_backend=gemini_live — delegating to Gemini pipeline", cs=call_sid)
        from bot_gemini import run_gemini_pipeline
        return await run_gemini_pipeline(session_state, transport, start_time)
```

Insert this block at line ~261 (after the transport block closes at `)`).

**The exact edit** — find this pattern in bot.py:

```python
    # -------------------------------------------------------------------------
    # STT / LLM / TTS — swap for mocks in load test mode
    # -------------------------------------------------------------------------
    load_test = os.getenv("LOAD_TEST_MODE", "false").lower() == "true"
```

Insert immediately before it:

```python
    # -------------------------------------------------------------------------
    # Route to Gemini Live pipeline if flag is set
    # -------------------------------------------------------------------------
    voice_backend = (session_state.get("_flags") or {}).get("voice_backend", "claude")
    if voice_backend == "gemini_live":
        logger.info("[{cs}] voice_backend=gemini_live — delegating to Gemini pipeline", cs=call_sid)
        from bot_gemini import run_gemini_pipeline
        return await run_gemini_pipeline(session_state, transport, start_time)

```

**Step 2: Commit**

```bash
cd /Users/davidzuluaga/code/donna2
git add pipecat/bot.py
git commit -m "feat: route to Gemini Live pipeline when voice_backend flag is gemini_live"
```

---

## Task 5: Deploy and test

**Step 1: Deploy to dev**

```bash
cd /Users/davidzuluaga/code/donna2
make deploy-dev-pipecat
```

Expected: Railway build succeeds. Watch for import errors in logs:
```bash
make logs-dev
```
Look for: `GeminiLiveLLMService not available` → means `google` extra didn't install. If seen, check pyproject.toml edit.

**Step 2: Enable flag for one senior in GrowthBook**

1. Go to app.growthbook.io
2. Find or create feature flag `voice_backend` (type: string, default: `"claude"`)
3. Add a targeting rule: `id = <your_test_senior_id>` → value: `"gemini_live"`
4. Save and publish

**Step 3: Test call**

Call the dev number (+19789235477) from the test senior's registered phone.

In logs, look for:
```
[cs] voice_backend=gemini_live — delegating to Gemini pipeline
[cs] Starting Gemini Live pipeline
[cs] Gemini pipeline ready, running...
```

**Step 4: Verify tools work**

During the call:
- Ask about something from past calls → `search_memories` should fire
- Ask about today's weather → `web_search` should fire
- Say goodbye → `end_call` should fire, call should end

In logs look for:
```
Gemini tool CALL: search_memories(...)
Gemini tool RESULT: search_memories → ...
```

**Step 5: If `register_function` API is wrong**

If you see: `AttributeError: 'GeminiLiveLLMService' object has no attribute 'register_function'`

Check the actual API by running:
```bash
cd /Users/davidzuluaga/code/donna2/pipecat
python -c "from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService; print([m for m in dir(GeminiLiveLLMService) if 'function' in m.lower() or 'tool' in m.lower()])"
```

This prints all function/tool-related methods on the service. Adjust `register_gemini_tools()` in `flows/gemini_tools.py` accordingly.

---

## What's NOT in this plan (intentional scope limits)

- **No FlowManager / call phases** — single-phase for the test. Add if Gemini quality validates.
- **No Quick Observer** — no regex pattern matching. Gemini decides goodbye via `end_call` tool.
- **No Conversation Director** — no speculative prefetch, no ephemeral guidance. Intended.
- **No onboarding flow** — Gemini pipeline is subscribers-only for now (call_type != "onboarding" check is not needed since bot.py routing happens after flag check and onboarding calls use `call_type="onboarding"` which we can skip routing for).
- **No VAD config** — GeminiLiveLLMService has built-in VAD. Can tune via `Settings(vad=...)` later.
- **No GeminiLiveLLMSettings.modalities** — defaults to AUDIO which is correct.

---

## Troubleshooting Reference

| Symptom | Likely cause | Fix |
|---|---|---|
| `ImportError: GeminiLiveLLMService` | `google` extra not in pyproject.toml or not deployed | Check pyproject.toml, redeploy |
| `AttributeError: register_function` | Wrong method name on GeminiLiveLLMService | Run introspection command in Step 5 |
| No audio from Gemini | Wrong model ID | Try `"gemini-3.1-flash-live-preview"` without `models/` prefix |
| Tools not firing | Handler signature mismatch | Check Pipecat docs for exact callback signature |
| Post-call fails | `_transcript` empty | ConversationTrackerProcessor may not capture Gemini transcriptions — check if it sees `TranscriptionFrame` from Gemini |
| Call doesn't end | `end_call` not working | As fallback, Twilio disconnect still fires `on_client_disconnected` which calls `EndFrame` |
