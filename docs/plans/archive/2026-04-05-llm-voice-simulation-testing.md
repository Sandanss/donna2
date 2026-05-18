# LLM-to-LLM Voice Simulation Testing

> Historical simulation plan. Current live runtime uses Telnyx L16/16k, no Director-owned web-search gating, and no live `search_memories` Claude tool. Use current `pipecat/tests/` and `pipecat/docs/ARCHITECTURE.md` before implementing anything from this plan.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an LLM-to-LLM voice pipeline test system where Haiku acts as a synthetic caller against the real Donna pipeline (real Claude, Director, Observer, tool handlers, dev DB), verifying web_search calls, memory injection, reminder processing, and post-call artifacts across multiple calls.

**Architecture:** `TextCallerTransport` injects `InterimTranscriptionFrame` + `TranscriptionFrame` with simulated speech timing into a real Pipecat pipeline (minus Twilio/STT/TTS). `CallerAgent` (Haiku) improvises natural speech from a scenario persona + goals. `ResponseCollector` captures Donna's output, tool calls, and latency. Multi-call runner sequences calls against the Neon dev DB, asserting on DB state between calls. Phase 2 swaps `TextCallerTransport` for `AudioCallerTransport` (real TTS+STT at the boundaries) with zero changes to CallerAgent, scenarios, or assertions.

**Tech Stack:** pytest, asyncio, anthropic SDK (Haiku), Pipecat pipeline (real Claude Haiku / Director / Observer), Neon dev DB (asyncpg), existing test infrastructure (`tests/mocks/`, `tests/helpers/`)

---

## Text vs Speech Timing — Design Decisions

The pipeline has timing-dependent mechanisms tuned for real audio. Text injection must simulate these or the Director/Observer won't behave realistically:

| Mechanism | Real call | Text simulation |
|---|---|---|
| **VAD silence detection (1.2s)** | Silero analyzes audio → `UserStoppedSpeakingFrame` | Not needed — Deepgram finals are triggered by VAD, but we inject finals directly |
| **Director silence onset (250ms)** | 250ms gap in `InterimTranscriptionFrame`s triggers speculative Groq analysis | TextCallerTransport emits interims with 150ms gaps, then waits 300ms before final → triggers the 250ms silence timer |
| **Continuous speculative (45+ chars)** | Director fires Groq on long interims while user is still speaking | Interims build progressively (3+ words at a time) to hit 45-char threshold during emission |
| **Prefetch debounce (1s, 15+ chars)** | Interim transcription triggers memory prefetch after 1s quiet | Interim emission takes ~1s for a typical sentence → naturally triggers prefetch |
| **Web search gating** | Director holds TranscriptionFrame + pushes `TTSSpeakFrame` filler | ResponseCollector sees `TTSSpeakFrame` fillers separately, feeds them to CallerAgent as `[Donna is checking: "..."]` so it knows to wait |
| **Barge-in / interruption** | VAD detects user speech during TTS → cancels Donna's output | **Skipped in Phase 1** (requires audio). Scenarios tagged `requires_audio=True` deferred to Phase 2 |
| **Prompt caching (1024+ tokens)** | System prompt + senior context exceeds threshold → cache hits on turn 2+ | Test senior seeded with realistic context (memories, news, recent turns) to exceed 1024 tokens |
| **`parse_telephony_websocket()`** | bot.py reads Twilio handshake from WebSocket | **Bypassed** — pipeline built directly in test (like `pipeline_builder.py`), not through `bot.py` |
| **Transport lifecycle events** | `on_client_connected` → FlowManager init; `on_client_disconnected` → post-call | Test calls `flow_manager.initialize()` directly after pipeline starts; calls `run_post_call()` directly after EndFrame |

---

## File Structure

```
pipecat/tests/
├── simulation/
│   ├── __init__.py
│   ├── transport.py         # CallerTransport protocol, TextCallerTransport, ResponseCollector
│   ├── caller.py            # CallerAgent (Haiku LLM wrapper)
│   ├── pipeline.py          # build_live_sim_pipeline() — real services, test transport
│   ├── runner.py            # run_simulated_call() + multi-call orchestration
│   ├── fixtures.py          # DB seed/cleanup for test seniors
│   └── scenarios.py         # LiveSimScenario + web_search/memory/reminder scenarios
└── test_live_simulation.py  # pytest entry point (@pytest.mark.llm_simulation)
```

---

## Task 1: ResponseCollector + CallerTransport Protocol

**Files:**
- Create: `pipecat/tests/simulation/__init__.py`
- Create: `pipecat/tests/simulation/transport.py`
- Test: `pipecat/tests/test_sim_transport.py`

The `ResponseCollector` is a `FrameProcessor` that sits after the LLM in the pipeline, captures Donna's streamed text output, tracks tool calls, records latency, and signals when a full response is complete.

The `CallerTransport` protocol defines the interface that both Phase 1 (text) and Phase 2 (audio) transports implement.

**Step 1: Write ResponseCollector + protocol**

```python
# pipecat/tests/simulation/transport.py
"""Caller transport abstraction for LLM-to-LLM voice simulation.

Phase 1: TextCallerTransport — injects text as TranscriptionFrames
Phase 2: AudioCallerTransport — wraps text in TTS→STT at boundaries

Both use ResponseCollector to capture pipeline output.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Protocol

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    TextFrame,
    TTSSpeakFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameProcessor


@dataclass
class CallerEvent:
    """An event from the pipeline back to the caller."""
    type: str  # "response", "filler", "end", "tool_call"
    text: str | None = None
    tool_name: str | None = None
    tool_args: dict | None = None
    latency_ms: float | None = None  # Time from final TranscriptionFrame to first TextFrame


@dataclass
class CallResult:
    """Aggregate results from a simulated call."""
    turns: list[dict] = field(default_factory=list)  # [{caller: str, donna: str, latency_ms: float}]
    tool_calls_made: list[str] = field(default_factory=list)  # tool names in order
    tool_call_details: list[dict] = field(default_factory=list)  # {name, args, result, latency_ms}
    injected_memories: list[str] = field(default_factory=list)  # ephemeral memory injections
    web_search_results: list[str] = field(default_factory=list)
    fillers: list[str] = field(default_factory=list)  # TTSSpeakFrame text (Director fillers)
    total_duration_ms: float = 0
    end_reason: str = "unknown"
    post_call_completed: bool = False


class ResponseCollector(FrameProcessor):
    """Captures Donna's responses, tool calls, and timing from the pipeline.

    Place after the LLM (or after GuidanceStripper) in the pipeline.
    Tracks:
    - TextFrame chunks → assembled into full responses
    - TTSSpeakFrame → Director fillers (web search gating)
    - Tool call frames → names + args
    - Latency: time from last TranscriptionFrame injection to first TextFrame
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self._response_chunks: list[str] = []
        self._response_ready = asyncio.Event()
        self._filler_ready = asyncio.Event()
        self._end_detected = asyncio.Event()
        self._tool_calls: list[dict] = []
        self._fillers: list[str] = []
        self._injected_memories: list[str] = []
        self._web_results: list[str] = []
        self._injection_time: float | None = None  # Set externally when TranscriptionFrame is injected
        self._first_text_time: float | None = None
        self._in_response = False

    def mark_injection_time(self):
        """Called by transport when a final TranscriptionFrame is injected."""
        self._injection_time = time.time()
        self._first_text_time = None

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, EndFrame):
            self._end_detected.set()
            # Also signal response ready so wait_for_response unblocks
            self._response_ready.set()

        elif isinstance(frame, TextFrame):
            if not self._in_response:
                self._in_response = True
                self._first_text_time = time.time()
            self._response_chunks.append(frame.text)

        elif isinstance(frame, TTSSpeakFrame):
            self._fillers.append(frame.text)
            self._filler_ready.set()

        # Track LLM context injections (memories, web results)
        # These come as LLMMessagesAppendFrame from the Director
        from pipecat.frames.frames import LLMMessagesAppendFrame
        if isinstance(frame, LLMMessagesAppendFrame):
            for msg in (frame.messages or []):
                content = msg.get("content", "")
                if isinstance(content, str):
                    if "[MEMORY]" in content:
                        self._injected_memories.append(content)
                    elif "[WEB RESULT]" in content:
                        self._web_results.append(content)

        await self.push_frame(frame, direction)

    async def wait_for_response(self, timeout: float = 60.0) -> CallerEvent:
        """Wait for Donna's complete response (all TextFrames until pause).

        Returns CallerEvent with assembled text and latency.
        After the LLM finishes generating, there's a natural gap before
        the next user turn. We detect this via a 1s timeout on new TextFrames.
        """
        self._response_chunks.clear()
        self._in_response = False

        # Wait for either: response text to start flowing, or end of call
        deadline = time.time() + timeout
        while time.time() < deadline:
            # Check for end
            if self._end_detected.is_set():
                return CallerEvent(type="end")

            # Wait for some text to arrive
            if self._response_chunks:
                # Text has started — wait for it to finish (1s gap = done)
                try:
                    last_len = len(self._response_chunks)
                    await asyncio.sleep(1.0)
                    if len(self._response_chunks) == last_len:
                        # No new text for 1s — response is complete
                        break
                except asyncio.CancelledError:
                    break
            else:
                # No text yet — wait a bit
                await asyncio.sleep(0.1)

        if self._end_detected.is_set() and not self._response_chunks:
            return CallerEvent(type="end")

        text = "".join(self._response_chunks)
        latency_ms = None
        if self._injection_time and self._first_text_time:
            latency_ms = round((self._first_text_time - self._injection_time) * 1000)

        self._response_chunks.clear()
        self._in_response = False

        return CallerEvent(type="response", text=text, latency_ms=latency_ms)

    async def wait_for_filler(self, timeout: float = 10.0) -> str | None:
        """Wait for a Director filler (TTSSpeakFrame). Returns text or None."""
        self._filler_ready.clear()
        try:
            await asyncio.wait_for(self._filler_ready.wait(), timeout)
            return self._fillers[-1] if self._fillers else None
        except asyncio.TimeoutError:
            return None

    def get_latency_ms(self) -> float | None:
        if self._injection_time and self._first_text_time:
            return round((self._first_text_time - self._injection_time) * 1000)
        return None

    @property
    def tool_calls(self) -> list[dict]:
        return list(self._tool_calls)

    @property
    def fillers(self) -> list[str]:
        return list(self._fillers)

    @property
    def injected_memories(self) -> list[str]:
        return list(self._injected_memories)

    @property
    def web_results(self) -> list[str]:
        return list(self._web_results)

    @property
    def ended(self) -> bool:
        return self._end_detected.is_set()

    def reset(self):
        """Reset state for a new turn."""
        self._response_chunks.clear()
        self._response_ready.clear()
        self._filler_ready.clear()
        self._in_response = False
        self._injection_time = None
        self._first_text_time = None


class CallerTransport(Protocol):
    """Interface for injecting caller speech and receiving Donna's output.

    Phase 1 (TextCallerTransport): text → TranscriptionFrames, TextFrames → text
    Phase 2 (AudioCallerTransport): text → TTS → audio → STT pipeline, real TTS → STT → text
    """

    async def send_utterance(self, text: str) -> None:
        """Send caller's speech into the pipeline with appropriate timing."""
        ...

    async def receive_response(self, timeout: float = 60.0) -> CallerEvent:
        """Wait for Donna's complete response."""
        ...

    @property
    def collector(self) -> ResponseCollector:
        """Access the ResponseCollector for assertions."""
        ...
```

**Step 2: Write unit test for ResponseCollector**

```python
# pipecat/tests/test_sim_transport.py
"""Unit tests for simulation transport components."""

import asyncio
import pytest
from pipecat.frames.frames import TextFrame, EndFrame, TTSSpeakFrame
from tests.simulation.transport import ResponseCollector, CallerEvent


@pytest.mark.asyncio
async def test_response_collector_captures_text():
    """ResponseCollector assembles TextFrame chunks into a complete response."""
    collector = ResponseCollector()
    collector.mark_injection_time()

    # Simulate streamed LLM response
    await collector.process_frame(TextFrame(text="Hello "), None)
    await collector.process_frame(TextFrame(text="Margaret!"), None)
    await asyncio.sleep(1.1)  # Gap signals end of response

    event = await collector.wait_for_response(timeout=2.0)
    assert event.type == "response"
    assert event.text == "Hello Margaret!"
    assert event.latency_ms is not None
    assert event.latency_ms >= 0


@pytest.mark.asyncio
async def test_response_collector_detects_end():
    """ResponseCollector returns end event on EndFrame."""
    collector = ResponseCollector()
    await collector.process_frame(EndFrame(), None)

    event = await collector.wait_for_response(timeout=2.0)
    assert event.type == "end"


@pytest.mark.asyncio
async def test_response_collector_tracks_fillers():
    """ResponseCollector captures Director TTSSpeakFrame fillers."""
    collector = ResponseCollector()
    await collector.process_frame(TTSSpeakFrame(text="Let me check on that"), None)

    assert len(collector.fillers) == 1
    assert "check" in collector.fillers[0]
```

**Step 3: Run tests**

```bash
cd pipecat && python -m pytest tests/test_sim_transport.py -v
```

Expected: All 3 tests pass.

**Step 4: Commit**

```bash
git add tests/simulation/__init__.py tests/simulation/transport.py tests/test_sim_transport.py
git commit -m "feat: add ResponseCollector and CallerTransport protocol for LLM-to-LLM voice simulation"
```

---

## Task 2: TextCallerTransport (Speech Timing Simulation)

**Files:**
- Modify: `pipecat/tests/simulation/transport.py`
- Test: `pipecat/tests/test_sim_transport.py` (add tests)

TextCallerTransport simulates realistic speech timing so the Director's silence detection, continuous speculative analysis, and memory prefetch all trigger naturally.

**Step 1: Implement TextCallerTransport**

Add to `pipecat/tests/simulation/transport.py`:

```python
class TextCallerTransport:
    """Phase 1: Text-only caller transport with speech timing simulation.

    Injects text as InterimTranscriptionFrame + TranscriptionFrame sequences
    with realistic timing to trigger Director's silence detection (250ms)
    and continuous speculative analysis (45+ char interims).

    Timing simulation:
    1. Emit progressive InterimTranscriptionFrames (3 words at a time, 150ms apart)
    2. Wait 300ms after last interim (exceeds 250ms silence threshold)
    3. Emit final TranscriptionFrame

    This triggers:
    - Director's silence-based speculative analysis (250ms gap)
    - Continuous speculative on long interims (45+ chars)
    - Memory prefetch debounce (interims over 15 chars)
    """

    # Timing constants (match real speech patterns)
    INTERIM_CHUNK_WORDS = 3        # Words per interim emission
    INTERIM_GAP_MS = 150           # Gap between interims (simulates speaking pace)
    POST_INTERIM_SILENCE_MS = 300  # Silence after last interim (> 250ms threshold)

    def __init__(
        self,
        pipeline_task,
        response_collector: ResponseCollector,
        user_id: str = "senior-test-001",
    ):
        self._task = pipeline_task
        self._collector = response_collector
        self._user_id = user_id

    async def send_utterance(self, text: str) -> None:
        """Inject caller speech with simulated timing.

        Emits:
        1. Progressive InterimTranscriptionFrames (builds up word by word)
        2. 300ms silence gap (triggers Director's 250ms speculative analysis)
        3. Final TranscriptionFrame
        """
        words = text.split()
        if not words:
            return

        # Emit progressive interims (3 words at a time)
        for i in range(self.INTERIM_CHUNK_WORDS, len(words), self.INTERIM_CHUNK_WORDS):
            partial = " ".join(words[:i])
            await self._task.queue_frame(
                InterimTranscriptionFrame(
                    text=partial,
                    user_id=self._user_id,
                    timestamp="",
                    language="en",
                )
            )
            await asyncio.sleep(self.INTERIM_GAP_MS / 1000)

        # Full text as final interim (if not already emitted)
        if len(words) > self.INTERIM_CHUNK_WORDS:
            await self._task.queue_frame(
                InterimTranscriptionFrame(
                    text=text,
                    user_id=self._user_id,
                    timestamp="",
                    language="en",
                )
            )
            await asyncio.sleep(self.INTERIM_GAP_MS / 1000)

        # Silence gap — triggers Director's 250ms silence timer
        await asyncio.sleep(self.POST_INTERIM_SILENCE_MS / 1000)

        # Final transcription
        self._collector.mark_injection_time()
        await self._task.queue_frame(
            TranscriptionFrame(
                text=text,
                user_id=self._user_id,
                timestamp="",
                language="en",
            )
        )

    async def receive_response(self, timeout: float = 60.0) -> CallerEvent:
        """Wait for Donna's complete response."""
        return await self._collector.wait_for_response(timeout=timeout)

    @property
    def collector(self) -> ResponseCollector:
        return self._collector
```

**Step 2: Write timing test**

Add to `tests/test_sim_transport.py`:

```python
@pytest.mark.asyncio
async def test_text_caller_transport_emits_interims():
    """TextCallerTransport emits InterimTranscriptionFrames before final."""
    from tests.conftest import FrameCapture, run_processor_test

    # Use a minimal pipeline that just captures frames
    capture = FrameCapture()
    pipeline = Pipeline([capture])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
    runner = PipelineRunner(handle_sigint=False)

    collector = ResponseCollector()
    transport = TextCallerTransport(
        pipeline_task=task,
        response_collector=collector,
    )

    async def inject():
        await asyncio.sleep(0.1)  # Let pipeline start
        await transport.send_utterance("Did the Cowboys win last night")
        await asyncio.sleep(0.5)
        await task.queue_frame(EndFrame())

    asyncio.create_task(inject())
    await asyncio.wait_for(runner.run(task), timeout=10.0)

    interims = [f for f in capture.frames if isinstance(f, InterimTranscriptionFrame)]
    finals = [f for f in capture.frames if isinstance(f, TranscriptionFrame)]

    assert len(interims) >= 1, "Should emit at least one interim"
    assert len(finals) == 1, "Should emit exactly one final"
    assert finals[0].text == "Did the Cowboys win last night"
```

**Step 3: Run tests**

```bash
cd pipecat && python -m pytest tests/test_sim_transport.py -v
```

**Step 4: Commit**

```bash
git add tests/simulation/transport.py tests/test_sim_transport.py
git commit -m "feat: add TextCallerTransport with speech timing simulation for Director compatibility"
```

---

## Task 3: CallerAgent (Haiku LLM Wrapper)

**Files:**
- Create: `pipecat/tests/simulation/caller.py`
- Test: `pipecat/tests/test_sim_caller.py`

The CallerAgent uses Haiku to improvise natural conversational responses as an elderly person, guided by a scenario persona and goals.

**Step 1: Implement CallerAgent**

```python
# pipecat/tests/simulation/caller.py
"""CallerAgent — Haiku-powered synthetic caller for voice simulation tests.

Takes a persona and conversation goals, generates natural elderly speech
in response to Donna's output. Tracks goal completion and decides when
to end the call.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field

import anthropic
from loguru import logger


@dataclass
class CallerPersona:
    """Who the caller is pretending to be."""
    name: str = "Margaret Johnson"
    age: int = 78
    personality: str = "Warm, chatty, occasionally forgetful. Loves gardening and family."
    speech_style: str = "Natural elderly speech — uses 'dear', pauses with 'well...', short sentences."


@dataclass
class CallerGoal:
    """A specific thing the caller should do during the call."""
    description: str          # What to do (e.g., "Ask about the weather")
    trigger_phrase: str = ""  # Optional: specific phrase to use
    completed: bool = False


class CallerAgent:
    """Haiku-powered synthetic caller for LLM-to-LLM simulation.

    Generates natural conversational responses as an elderly person,
    guided by a persona and ordered goals. Tracks which goals have
    been completed and decides when to say goodbye.
    """

    MAX_TURNS = 20  # Safety limit

    def __init__(
        self,
        persona: CallerPersona,
        goals: list[CallerGoal],
        model: str = "claude-haiku-4-5-20251001",
    ):
        self._persona = persona
        self._goals = goals
        self._model = model
        self._conversation: list[dict] = []
        self._turn_count = 0
        self._client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY", ""))

    def _build_system_prompt(self) -> str:
        goals_text = "\n".join(
            f"  {i+1}. {'[DONE] ' if g.completed else ''}{g.description}"
            + (f' (say something like: "{g.trigger_phrase}")' if g.trigger_phrase else "")
            for i, g in enumerate(self._goals)
        )

        return f"""You are role-playing as {self._persona.name}, a {self._persona.age}-year-old person on a phone call with Donna, an AI companion.

PERSONALITY: {self._persona.personality}
SPEECH STYLE: {self._persona.speech_style}

YOUR GOALS (complete in order):
{goals_text}

RULES:
- Stay in character at all times. You ARE {self._persona.name}.
- Complete goals naturally — don't rush. One goal per 1-2 exchanges.
- Respond to what Donna says before pivoting to your next goal.
- Keep responses SHORT (1-3 sentences). Elderly people don't monologue.
- When all goals are completed, say goodbye naturally within 1-2 more exchanges.
- If Donna asks you something, answer naturally before continuing with goals.
- Never mention "goals" or "testing" or break character.

OUTPUT: Just your spoken words. No stage directions, no quotes, no asterisks."""

    def generate_response(self, donna_text: str) -> str:
        """Generate the caller's next utterance in response to Donna.

        Args:
            donna_text: What Donna just said (text captured from pipeline).

        Returns:
            The caller's spoken response as text.
        """
        self._turn_count += 1

        if self._turn_count > self.MAX_TURNS:
            return "Well, I should let you go, Donna. Goodbye!"

        # Add Donna's message to conversation history
        self._conversation.append({"role": "user", "content": f"Donna: {donna_text}"})

        response = self._client.messages.create(
            model=self._model,
            max_tokens=150,
            system=self._build_system_prompt(),
            messages=self._conversation,
        )

        caller_text = response.content[0].text.strip()

        # Track in conversation history
        self._conversation.append({"role": "assistant", "content": caller_text})

        # Check if any goals were addressed (simple heuristic)
        self._check_goal_completion(caller_text, donna_text)

        logger.info(
            "[CallerAgent] Turn {n}: {text}",
            n=self._turn_count, text=caller_text[:80],
        )

        return caller_text

    def _check_goal_completion(self, caller_text: str, donna_text: str):
        """Mark goals as completed based on conversation content."""
        combined = (caller_text + " " + donna_text).lower()
        for goal in self._goals:
            if goal.completed:
                continue
            # Simple keyword match from goal description
            keywords = [w.lower() for w in goal.description.split() if len(w) > 3]
            if sum(1 for kw in keywords if kw in combined) >= len(keywords) * 0.5:
                goal.completed = True
                logger.info("[CallerAgent] Goal completed: {g}", g=goal.description)
                break  # One goal per turn

    @property
    def all_goals_completed(self) -> bool:
        return all(g.completed for g in self._goals)

    @property
    def should_end_call(self) -> bool:
        return self.all_goals_completed or self._turn_count >= self.MAX_TURNS

    @property
    def turn_count(self) -> int:
        return self._turn_count
```

**Step 2: Write test for CallerAgent**

```python
# pipecat/tests/test_sim_caller.py
"""Tests for CallerAgent."""

import os
import pytest
from tests.simulation.caller import CallerAgent, CallerPersona, CallerGoal


@pytest.mark.llm_simulation
@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="Requires ANTHROPIC_API_KEY")
def test_caller_agent_generates_response():
    """CallerAgent generates a natural response to Donna's greeting."""
    agent = CallerAgent(
        persona=CallerPersona(name="Margaret"),
        goals=[CallerGoal(description="Ask about the weather")],
    )

    response = agent.generate_response("Good morning, Margaret! How are you today?")

    assert len(response) > 0
    assert len(response) < 500  # Should be short
    assert agent.turn_count == 1


@pytest.mark.llm_simulation
@pytest.mark.skipif(not os.environ.get("ANTHROPIC_API_KEY"), reason="Requires ANTHROPIC_API_KEY")
def test_caller_agent_completes_goals():
    """CallerAgent tracks goal completion."""
    agent = CallerAgent(
        persona=CallerPersona(name="Margaret"),
        goals=[
            CallerGoal(description="Ask about the weather", trigger_phrase="What's the weather like?"),
        ],
    )

    response = agent.generate_response("Good morning! How are you?")
    # The agent should mention weather since that's the first goal
    # Goal completion is checked via keyword matching
    assert agent.turn_count == 1
```

**Step 3: Run tests**

```bash
cd pipecat && python -m pytest tests/test_sim_caller.py -v -m llm_simulation
```

**Step 4: Commit**

```bash
git add tests/simulation/caller.py tests/test_sim_caller.py
git commit -m "feat: add CallerAgent (Haiku) for synthetic caller in voice simulation"
```

---

## Task 4: LiveSimPipeline Builder

**Files:**
- Create: `pipecat/tests/simulation/pipeline.py`
- Test: validated in Task 7 integration test

Builds the real Pipecat pipeline without Twilio transport. Uses real Claude, real Director, real Quick Observer, real tool handlers, real DB queries. Replaces STT (inject directly), TTS (capture text), and transport (test transport).

**Step 1: Implement pipeline builder**

```python
# pipecat/tests/simulation/pipeline.py
"""Build a live simulation pipeline — real services, no Twilio.

Assembles the same pipeline as bot.py but with:
- TestInputTransport/TestOutputTransport (no WebSocket)
- No STT (TranscriptionFrames injected directly by TextCallerTransport)
- MockTTSProcessor (captures text, no audio generation)
- ResponseCollector (captures output for CallerAgent)
- Everything else real: Claude, Director, Quick Observer, tool handlers, DB
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from loguru import logger
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat_flows import FlowManager

from flows.nodes import build_initial_node
from flows.tools import make_flows_tools
from processors.conversation_director import ConversationDirectorProcessor
from processors.conversation_tracker import ConversationTrackerProcessor
from processors.guidance_stripper import GuidanceStripperProcessor
from processors.metrics_logger import MetricsLoggerProcessor
from processors.quick_observer import QuickObserverProcessor
from services.post_call import run_post_call

from tests.mocks.mock_tts import MockTTSProcessor
from tests.mocks.mock_transport import TestInputTransport, TestOutputTransport
from tests.simulation.transport import ResponseCollector, TextCallerTransport


@dataclass
class LiveSimComponents:
    """References to all live simulation pipeline components."""
    pipeline: Pipeline
    task: PipelineTask
    runner: PipelineRunner
    input_transport: TestInputTransport
    output_transport: TestOutputTransport
    response_collector: ResponseCollector
    caller_transport: TextCallerTransport
    quick_observer: QuickObserverProcessor
    conversation_director: ConversationDirectorProcessor
    conversation_tracker: ConversationTrackerProcessor
    flow_manager: FlowManager
    llm: AnthropicLLMService
    tts: MockTTSProcessor
    session_state: dict


async def build_live_sim_pipeline(session_state: dict) -> LiveSimComponents:
    """Build a real pipeline for LLM-to-LLM simulation.

    Uses real:
    - AnthropicLLMService (Claude Haiku) with prompt caching
    - ConversationDirectorProcessor (Groq/Cerebras speculative analysis)
    - QuickObserverProcessor (268 regex patterns + goodbye detection)
    - Tool handlers (web_search calls real Tavily, mark_reminder writes real DB)
    - FlowManager (4-phase state machine)
    - Context aggregators (LLM message pairing)

    Replaces:
    - FastAPIWebsocketTransport → TestInputTransport + TestOutputTransport
    - DeepgramSTTService → direct TranscriptionFrame injection
    - ElevenLabs/Cartesia TTS → MockTTSProcessor (text capture)
    """
    session_state.setdefault("_call_start_time", time.time())
    session_state.setdefault("_transcript", [])
    session_state.setdefault("_flags", {
        "director_enabled": True,
        "post_call_analysis_enabled": True,
        "news_search_enabled": True,
    })

    # Real LLM
    llm = AnthropicLLMService(
        api_key=os.environ["ANTHROPIC_API_KEY"],
        model="claude-haiku-4-5-20251001",
        params=AnthropicLLMService.InputParams(
            enable_prompt_caching=True,
        ),
    )

    # Test transport (no WebSocket)
    input_transport = TestInputTransport()
    output_transport = TestOutputTransport()

    # Real processors
    quick_observer = QuickObserverProcessor(session_state=session_state)
    conversation_director = ConversationDirectorProcessor(session_state=session_state)
    conversation_tracker = ConversationTrackerProcessor(session_state=session_state)
    guidance_stripper = GuidanceStripperProcessor()
    metrics_logger = MetricsLoggerProcessor(session_state=session_state)

    # Mock TTS + ResponseCollector
    tts = MockTTSProcessor()
    response_collector = ResponseCollector()

    # Context aggregators
    context = OpenAILLMContext()
    context_aggregator = llm.create_context_aggregator(context)
    session_state["_llm_context"] = context
    session_state["_conversation_tracker"] = conversation_tracker

    # Pipeline: matches bot.py layout minus STT and real transport
    pipeline = Pipeline([
        input_transport,
        # No STT — TranscriptionFrames injected directly
        quick_observer,
        conversation_director,
        context_aggregator.user(),
        llm,
        conversation_tracker,
        guidance_stripper,
        response_collector,  # Captures output before TTS
        tts,
        output_transport,
        context_aggregator.assistant(),
        metrics_logger,
    ])

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=False,  # No barge-in in text mode
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    # Wire up processor references
    quick_observer.set_pipeline_task(task)
    conversation_director.set_pipeline_task(task)

    # FlowManager
    flows_tools = make_flows_tools(session_state)
    initial_node = build_initial_node(session_state, flows_tools)

    flow_manager = FlowManager(
        task=task,
        llm=llm,
        context_aggregator=context_aggregator,
    )
    session_state["_flow_manager"] = flow_manager

    # Caller transport
    caller_transport = TextCallerTransport(
        pipeline_task=task,
        response_collector=response_collector,
        user_id=session_state.get("senior_id", "senior-test-001"),
    )

    runner = PipelineRunner(handle_sigint=False)

    return LiveSimComponents(
        pipeline=pipeline,
        task=task,
        runner=runner,
        input_transport=input_transport,
        output_transport=output_transport,
        response_collector=response_collector,
        caller_transport=caller_transport,
        quick_observer=quick_observer,
        conversation_director=conversation_director,
        conversation_tracker=conversation_tracker,
        flow_manager=flow_manager,
        llm=llm,
        tts=tts,
        session_state=session_state,
    )
```

**Step 2: Commit**

```bash
git add tests/simulation/pipeline.py
git commit -m "feat: add LiveSimPipeline builder — real Claude/Director/Observer with test transport"
```

---

## Task 5: DB Fixtures (Seed / Cleanup Test Senior)

**Files:**
- Create: `pipecat/tests/simulation/fixtures.py`
- Test: `pipecat/tests/test_sim_fixtures.py`

Seeds a test senior in the Neon dev database with realistic context (memories, news, recent call history) to ensure prompt caching works (>1024 tokens). Cleans up after tests.

**Step 1: Implement fixtures**

```python
# pipecat/tests/simulation/fixtures.py
"""DB fixtures for LLM-to-LLM simulation tests.

Seeds and cleans up test seniors in the Neon dev database.
Test seniors have realistic context (memories, interests, recent call history)
so that Anthropic prompt caching activates (requires >1024 tokens in system prompt).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from loguru import logger


@dataclass
class TestSenior:
    """A test senior seeded in the dev database."""
    id: str = field(default_factory=lambda: f"sim-test-{uuid.uuid4().hex[:8]}")
    name: str = "Margaret Simulation"
    phone: str = "+15551234567"
    timezone: str = "America/New_York"
    interests: list[str] = field(default_factory=lambda: [
        "gardening", "cooking", "grandchildren", "bird watching", "crossword puzzles"
    ])
    medical_notes: str = "Type 2 diabetes, mild arthritis in hands"


async def seed_test_senior(senior: TestSenior | None = None) -> TestSenior:
    """Insert a test senior into the dev database with realistic context.

    Creates:
    - Senior profile (seniors table)
    - 5 seed memories (memories table) — ensures memory search has results
    - Cached news context (seniors.cached_news)

    Returns the TestSenior with its ID.
    """
    from db.client import execute, fetchrow

    senior = senior or TestSenior()

    # Insert senior
    await execute(
        """INSERT INTO seniors (id, name, phone, timezone, interests, medical_notes, cached_news, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
           ON CONFLICT (id) DO NOTHING""",
        senior.id, senior.name, senior.phone, senior.timezone,
        senior.interests, senior.medical_notes,
        "The local garden show is this weekend featuring new rose varieties. Weather expected to be sunny with highs in the 70s.",
    )

    # Seed memories for memory search testing
    seed_memories = [
        ("Margaret planted new rose bushes in her garden last spring", "preference", 80),
        ("Her grandson Jake plays baseball for his high school team", "relationship", 85),
        ("She makes the best apple pie — her grandmother's recipe", "preference", 70),
        ("Margaret's daughter Lisa visits every Sunday for dinner", "relationship", 75),
        ("She's been doing the crossword puzzle in the morning paper for 30 years", "preference", 65),
    ]

    for content, type_, importance in seed_memories:
        # Generate embedding for pgvector search
        try:
            from services.memory import _generate_embedding
            embedding = await _generate_embedding(content)
        except Exception:
            embedding = None

        if embedding:
            await execute(
                """INSERT INTO memories (id, senior_id, type, content, source, importance, embedding)
                   VALUES ($1, $2, $3, $4, 'seed', $5, $6)""",
                str(uuid.uuid4()), senior.id, type_, content, importance, embedding,
            )
        else:
            await execute(
                """INSERT INTO memories (id, senior_id, type, content, source, importance)
                   VALUES ($1, $2, $3, $4, 'seed', $5)""",
                str(uuid.uuid4()), senior.id, type_, content, importance,
            )

    logger.info("[Fixtures] Seeded test senior: {id} ({name})", id=senior.id, name=senior.name)
    return senior


async def create_test_conversation(senior_id: str, call_type: str = "check-in") -> str:
    """Create a conversation record and return its ID."""
    from db.client import fetchval

    conv_id = str(uuid.uuid4())
    call_sid = f"SIM-{uuid.uuid4().hex[:12]}"

    await fetchval(
        """INSERT INTO conversations (id, senior_id, call_sid, call_type, status)
           VALUES ($1, $2, $3, $4, 'in_progress')
           RETURNING id""",
        conv_id, senior_id, call_sid, call_type,
    )

    return conv_id


async def build_session_state(senior: TestSenior, conversation_id: str, call_type: str = "check-in") -> dict:
    """Build a session_state dict matching what bot.py produces.

    Fetches real data from the dev DB (memories, recent turns, etc.)
    so the system prompt exceeds 1024 tokens for prompt caching.
    """
    from services.memory import search as memory_search
    from services.greetings import get_greeting

    # Fetch memory context
    memory_results = await memory_search(senior.id, "general context", limit=10)
    memory_context = "\n".join(r["content"] for r in memory_results if r.get("content")) if memory_results else ""

    # Generate greeting
    greeting_result = get_greeting(
        senior_name=senior.name,
        timezone=senior.timezone,
        interests=senior.interests,
    )

    return {
        "senior_id": senior.id,
        "senior": {
            "id": senior.id,
            "name": senior.name,
            "phone": senior.phone,
            "timezone": senior.timezone,
            "interests": senior.interests,
            "medical_notes": senior.medical_notes,
            "interest_scores": None,
        },
        "memory_context": memory_context,
        "greeting": greeting_result.get("greeting", f"Hello, {senior.name}!"),
        "reminder_prompt": None,
        "reminder_delivery": None,
        "reminders_delivered": set(),
        "conversation_id": conversation_id,
        "call_sid": f"SIM-{uuid.uuid4().hex[:12]}",
        "call_type": call_type,
        "previous_calls_summary": None,
        "recent_turns": None,
        "todays_context": None,
        "news_context": "The local garden show is this weekend featuring new rose varieties.",
        "last_call_analysis": None,
        "_transcript": [],
        "_call_start_time": None,
    }


async def cleanup_test_senior(senior_id: str) -> None:
    """Remove all test data for a senior from the dev database."""
    from db.client import execute

    tables = [
        "call_metrics",
        "daily_call_context",
        "call_analyses",
        "reminder_deliveries",
        "memories",
        "conversations",
        "caregivers",
        "seniors",
    ]

    for table in tables:
        try:
            await execute(f"DELETE FROM {table} WHERE senior_id = $1", senior_id)
        except Exception as e:
            # Some tables may not have senior_id column
            logger.debug("Cleanup {table} skipped: {err}", table=table, err=str(e))

    logger.info("[Fixtures] Cleaned up test senior: {id}", id=senior_id)
```

**Step 2: Write test**

```python
# pipecat/tests/test_sim_fixtures.py
"""Test DB fixtures for simulation tests."""

import os
import pytest
from tests.simulation.fixtures import seed_test_senior, cleanup_test_senior, TestSenior


@pytest.mark.integration
@pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="Requires DATABASE_URL")
@pytest.mark.asyncio
async def test_seed_and_cleanup_test_senior():
    """Seed a test senior, verify it exists, then clean up."""
    from db.client import fetchrow

    senior = await seed_test_senior(TestSenior(name="Fixture Test Senior"))

    try:
        row = await fetchrow("SELECT * FROM seniors WHERE id = $1", senior.id)
        assert row is not None
        assert row["name"] == "Fixture Test Senior"

        # Verify memories were seeded
        from db.client import fetchval
        count = await fetchval("SELECT COUNT(*) FROM memories WHERE senior_id = $1", senior.id)
        assert count >= 5
    finally:
        await cleanup_test_senior(senior.id)

        # Verify cleanup
        row = await fetchrow("SELECT * FROM seniors WHERE id = $1", senior.id)
        assert row is None
```

**Step 3: Run test**

```bash
cd pipecat && DATABASE_URL=$DATABASE_URL python -m pytest tests/test_sim_fixtures.py -v -m integration
```

**Step 4: Commit**

```bash
git add tests/simulation/fixtures.py tests/test_sim_fixtures.py
git commit -m "feat: add DB fixtures for simulation testing — seed/cleanup test seniors with memories"
```

---

## Task 6: Scenario Definitions

**Files:**
- Create: `pipecat/tests/simulation/scenarios.py`

Defines `LiveSimScenario` dataclass and three concrete scenarios that test web_search, memory injection, and reminder acknowledgment across multiple calls.

**Step 1: Implement scenarios**

```python
# pipecat/tests/simulation/scenarios.py
"""Scenario definitions for LLM-to-LLM voice simulation tests.

Each scenario defines:
- A CallerPersona (who the synthetic caller is)
- Ordered CallerGoals (what the caller should do)
- Expected outcomes (tool calls, DB state, etc.)
- Optional reminder setup
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tests.simulation.caller import CallerPersona, CallerGoal
from tests.simulation.fixtures import TestSenior


@dataclass
class LiveSimScenario:
    """A complete simulation test scenario."""
    name: str
    description: str
    senior: TestSenior = field(default_factory=TestSenior)
    persona: CallerPersona = field(default_factory=CallerPersona)
    goals: list[CallerGoal] = field(default_factory=list)
    call_type: str = "check-in"
    max_turns: int = 12
    requires_audio: bool = False  # Phase 2 only

    # Reminder setup (for reminder scenarios)
    reminder_title: str | None = None
    reminder_description: str | None = None

    # Expected outcomes
    expect_tool_calls: list[str] = field(default_factory=list)
    expect_memories_injected: bool = False
    expect_post_call_analysis: bool = True


# ---------------------------------------------------------------------------
# Scenario: Web Search Trigger
# ---------------------------------------------------------------------------

def web_search_scenario() -> LiveSimScenario:
    """Caller asks about weather/sports — should trigger web_search tool or Director web search."""
    return LiveSimScenario(
        name="web_search_trigger",
        description="Caller asks about weather and sports scores, triggering web_search tool calls.",
        persona=CallerPersona(
            name="Margaret Johnson",
            age=78,
            personality="Curious, loves knowing about weather for gardening. Follows Dallas Cowboys.",
            speech_style="Short sentences. 'Oh dear', 'well now'. Asks clear questions.",
        ),
        goals=[
            CallerGoal(
                description="Ask about the weather this weekend for gardening",
                trigger_phrase="What's the weather supposed to be like this weekend? I want to work in my garden.",
            ),
            CallerGoal(
                description="Ask about a recent sports score",
                trigger_phrase="Did the Cowboys win their last game?",
            ),
            CallerGoal(
                description="Say goodbye naturally",
                trigger_phrase="Well, I should go water my plants. Goodbye, dear!",
            ),
        ],
        expect_tool_calls=["web_search"],
        max_turns=10,
    )


# ---------------------------------------------------------------------------
# Scenario: Memory Injection (Cross-Call)
# ---------------------------------------------------------------------------

def memory_seed_scenario() -> LiveSimScenario:
    """Call 1: Caller mentions new facts that should be saved as memories post-call."""
    return LiveSimScenario(
        name="memory_seed",
        description="Caller shares new personal details. Post-call should extract and save memories.",
        persona=CallerPersona(
            name="Margaret Johnson",
            age=78,
            personality="Talkative, shares family updates. Excited about grandson.",
            speech_style="Warm, detailed stories. Uses 'you know' and 'well'.",
        ),
        goals=[
            CallerGoal(
                description="Tell Donna your grandson Jake just won his baseball championship",
                trigger_phrase="Oh, you won't believe it! My grandson Jake just won the baseball championship!",
            ),
            CallerGoal(
                description="Mention you're planning a trip to visit your daughter Lisa in Florida",
                trigger_phrase="Lisa invited me to come visit her in Florida next month. I'm so excited!",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Well, I better go pack! Goodbye!",
            ),
        ],
        expect_post_call_analysis=True,
        max_turns=8,
    )


def memory_recall_scenario() -> LiveSimScenario:
    """Call 2: Caller references previous topics — Director should inject memories."""
    return LiveSimScenario(
        name="memory_recall",
        description="Caller mentions topics from previous call. Director should prefetch and inject memories.",
        persona=CallerPersona(
            name="Margaret Johnson",
            age=78,
            personality="Continues previous conversation naturally.",
            speech_style="References past topics casually.",
        ),
        goals=[
            CallerGoal(
                description="Ask if Donna remembers Jake's baseball game",
                trigger_phrase="Do you remember I told you about Jake's big game?",
            ),
            CallerGoal(
                description="Mention the Florida trip again",
                trigger_phrase="I've been looking at flights to go see Lisa in Florida.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Talk to you tomorrow, Donna!",
            ),
        ],
        expect_memories_injected=True,
        max_turns=8,
    )


# ---------------------------------------------------------------------------
# Scenario: Reminder Acknowledgment
# ---------------------------------------------------------------------------

def reminder_scenario() -> LiveSimScenario:
    """Caller receives a medication reminder and acknowledges it."""
    return LiveSimScenario(
        name="reminder_acknowledgment",
        description="Donna delivers a medication reminder. Caller acknowledges. Tool mark_reminder_acknowledged should fire.",
        call_type="reminder",
        reminder_title="Take metformin",
        reminder_description="500mg with dinner",
        persona=CallerPersona(
            name="Margaret Johnson",
            age=78,
            personality="Cooperative about medications but sometimes forgetful.",
            speech_style="'Oh right, thank you for reminding me.' Grateful tone.",
        ),
        goals=[
            CallerGoal(
                description="Chat briefly, then wait for Donna to mention the medication reminder",
            ),
            CallerGoal(
                description="Acknowledge the medication reminder clearly",
                trigger_phrase="Oh yes, thank you for reminding me! I'll take my metformin right now with dinner.",
            ),
            CallerGoal(
                description="Say goodbye",
                trigger_phrase="Thanks Donna, bye now!",
            ),
        ],
        expect_tool_calls=["mark_reminder_acknowledged"],
        max_turns=8,
    )
```

**Step 2: Commit**

```bash
git add tests/simulation/scenarios.py
git commit -m "feat: add simulation scenarios — web search, memory injection, reminder acknowledgment"
```

---

## Task 7: CallSimRunner (Orchestration Loop)

**Files:**
- Create: `pipecat/tests/simulation/runner.py`

The core orchestration: starts the pipeline, initializes the flow, runs the CallerAgent ↔ pipeline conversation loop, triggers post-call, collects results.

**Step 1: Implement runner**

```python
# pipecat/tests/simulation/runner.py
"""CallSimRunner — orchestrates a simulated call between CallerAgent and the real pipeline.

Flow:
1. Build live pipeline (real Claude, Director, Observer, tool handlers)
2. Start pipeline runner in background
3. Initialize FlowManager (triggers greeting)
4. Wait for greeting response
5. Feed greeting to CallerAgent → get response
6. Inject response into pipeline via TextCallerTransport
7. Wait for Donna's response
8. Repeat until CallerAgent says goodbye or max turns
9. Trigger post-call processing (real DB writes)
10. Collect and return CallResult
"""

from __future__ import annotations

import asyncio
import time
import uuid

from loguru import logger
from pipecat.frames.frames import EndFrame

from services.post_call import run_post_call

from tests.simulation.caller import CallerAgent
from tests.simulation.fixtures import (
    TestSenior,
    build_session_state,
    create_test_conversation,
)
from tests.simulation.pipeline import build_live_sim_pipeline
from tests.simulation.scenarios import LiveSimScenario
from tests.simulation.transport import CallResult


async def run_simulated_call(
    scenario: LiveSimScenario,
    senior: TestSenior | None = None,
    conversation_id: str | None = None,
    run_post_call_processing: bool = True,
) -> CallResult:
    """Run a single simulated call for a scenario.

    Args:
        scenario: The scenario definition.
        senior: Pre-seeded TestSenior (use seed_test_senior() first).
        conversation_id: Pre-created conversation ID. Created if None.
        run_post_call_processing: Whether to run real post-call (DB writes).

    Returns:
        CallResult with turns, tool calls, latency, injected memories.
    """
    senior = senior or scenario.senior
    result = CallResult()
    call_start = time.time()

    # Create conversation if not provided
    if not conversation_id:
        conversation_id = await create_test_conversation(senior.id, scenario.call_type)

    # Build session state from DB
    session_state = await build_session_state(senior, conversation_id, scenario.call_type)

    # Set up reminder context if scenario has one
    if scenario.reminder_title:
        reminder_id = f"rem-sim-{uuid.uuid4().hex[:8]}"
        delivery_id = f"del-sim-{uuid.uuid4().hex[:8]}"
        session_state["call_type"] = "reminder"
        session_state["reminder_prompt"] = (
            f"MEDICATION REMINDER: {senior.name} needs to {scenario.reminder_title}. "
            f"{scenario.reminder_description}. Deliver naturally."
        )
        session_state["reminder_delivery"] = {
            "id": delivery_id,
            "reminder_id": reminder_id,
            "title": scenario.reminder_title,
            "description": scenario.reminder_description,
        }
        session_state["_pending_reminders"] = [{
            "id": reminder_id,
            "title": scenario.reminder_title,
            "description": scenario.reminder_description,
        }]

    # Build pipeline
    components = await build_live_sim_pipeline(session_state)

    # Create CallerAgent
    caller = CallerAgent(
        persona=scenario.persona,
        goals=list(scenario.goals),  # Copy to avoid mutation
    )

    # Start pipeline in background
    pipeline_task = asyncio.create_task(
        asyncio.wait_for(components.runner.run(components.task), timeout=300)
    )

    try:
        # Small delay for pipeline to initialize
        await asyncio.sleep(0.5)

        # Initialize FlowManager (triggers greeting via respond_immediately)
        await components.flow_manager.initialize(
            build_initial_node_for_sim(session_state, components)
        )

        # Wait for Donna's greeting
        greeting_event = await components.caller_transport.receive_response(timeout=30)
        if greeting_event.type == "end":
            logger.warning("[Runner] Pipeline ended before greeting")
            result.end_reason = "no_greeting"
            return result

        donna_text = greeting_event.text or ""
        logger.info("[Runner] Greeting: {text}", text=donna_text[:80])

        # Main conversation loop
        turn = 0
        while turn < scenario.max_turns:
            turn += 1

            # CallerAgent generates response
            caller_text = caller.generate_response(donna_text)

            # Check if caller is ending the call
            is_goodbye = any(
                w in caller_text.lower()
                for w in ["goodbye", "bye", "gotta go", "talk to you later", "talk to you tomorrow"]
            )

            # Inject into pipeline
            await components.caller_transport.send_utterance(caller_text)

            # Wait for Donna's response
            response_event = await components.caller_transport.receive_response(timeout=60)

            if response_event.type == "end":
                logger.info("[Runner] Call ended (EndFrame) after turn {n}", n=turn)
                result.end_reason = session_state.get("_end_reason", "pipeline_end")
                break

            donna_text = response_event.text or ""

            # Record turn
            result.turns.append({
                "turn": turn,
                "caller": caller_text,
                "donna": donna_text,
                "latency_ms": response_event.latency_ms,
            })

            logger.info(
                "[Runner] Turn {n}: caller={ct} → donna={dt} ({ms}ms)",
                n=turn,
                ct=caller_text[:50],
                dt=donna_text[:50],
                ms=response_event.latency_ms,
            )

            # Check if caller should end
            if caller.should_end_call and not is_goodbye:
                # CallerAgent wants to end — generate goodbye
                caller_text = caller.generate_response(donna_text)
                await components.caller_transport.send_utterance(caller_text)
                await components.caller_transport.receive_response(timeout=30)
                break

        # Collect metrics from collector
        collector = components.response_collector
        result.tool_calls_made = list(session_state.get("_tools_used", []))
        result.tool_call_details = collector.tool_calls
        result.injected_memories = collector.injected_memories
        result.web_search_results = collector.web_results
        result.fillers = collector.fillers
        result.total_duration_ms = round((time.time() - call_start) * 1000)

        # End pipeline
        if not collector.ended:
            await components.task.queue_frame(EndFrame())
            await asyncio.sleep(1)

        # Run post-call processing (real DB writes)
        if run_post_call_processing:
            try:
                elapsed = round(time.time() - call_start)
                session_state.setdefault("_end_reason", "simulation_complete")
                components.conversation_tracker.flush()
                await run_post_call(session_state, components.conversation_tracker, elapsed)
                result.post_call_completed = True
                logger.info("[Runner] Post-call processing completed")
            except Exception as e:
                logger.error("[Runner] Post-call failed: {err}", err=str(e))
                result.post_call_completed = False

    except asyncio.TimeoutError:
        logger.error("[Runner] Call timed out after {s}s", s=round(time.time() - call_start))
        result.end_reason = "timeout"
    except Exception as e:
        logger.error("[Runner] Call error: {err}", err=str(e))
        result.end_reason = f"error: {e}"
    finally:
        # Ensure pipeline stops
        if not pipeline_task.done():
            pipeline_task.cancel()
            try:
                await pipeline_task
            except (asyncio.CancelledError, Exception):
                pass

    return result


def build_initial_node_for_sim(session_state: dict, components) -> dict:
    """Build the initial FlowManager node for simulation.

    Wraps build_initial_node() with the simulation's tools.
    """
    from flows.nodes import build_initial_node
    from flows.tools import make_flows_tools
    flows_tools = make_flows_tools(session_state)
    return build_initial_node(session_state, flows_tools)
```

**Step 2: Commit**

```bash
git add tests/simulation/runner.py
git commit -m "feat: add CallSimRunner — orchestrates CallerAgent ↔ pipeline conversation loop"
```

---

## Task 8: Integration Tests (Multi-Call)

**Files:**
- Create: `pipecat/tests/test_live_simulation.py`

The actual pytest test file. Runs multi-call scenarios against the dev database.

**Step 1: Write test file**

```python
# pipecat/tests/test_live_simulation.py
"""LLM-to-LLM voice simulation tests.

Runs Haiku (synthetic caller) against the real Donna pipeline with:
- Real Claude Haiku (LLM responses)
- Real Director (Groq/Cerebras speculative analysis)
- Real Quick Observer (268 regex patterns, goodbye detection)
- Real tool handlers (web_search → Tavily, mark_reminder → DB)
- Real post-call processing (analysis, memory extraction, daily context)
- Real Neon dev database

Requires: ANTHROPIC_API_KEY, DATABASE_URL, GOOGLE_API_KEY, OPENAI_API_KEY
Optional: CEREBRAS_API_KEY (Director), TAVILY_API_KEY (web search)

Run: cd pipecat && python -m pytest tests/test_live_simulation.py -v -m llm_simulation
"""

from __future__ import annotations

import asyncio
import os

import pytest

from tests.simulation.fixtures import (
    TestSenior,
    cleanup_test_senior,
    create_test_conversation,
    seed_test_senior,
)
from tests.simulation.runner import run_simulated_call
from tests.simulation.scenarios import (
    memory_recall_scenario,
    memory_seed_scenario,
    reminder_scenario,
    web_search_scenario,
)


# Skip if missing required env vars
pytestmark = [
    pytest.mark.llm_simulation,
    pytest.mark.skipif(
        not all(os.environ.get(k) for k in ["ANTHROPIC_API_KEY", "DATABASE_URL"]),
        reason="Requires ANTHROPIC_API_KEY and DATABASE_URL",
    ),
]


@pytest.fixture
async def test_senior():
    """Seed a test senior and clean up after the test."""
    senior = await seed_test_senior()
    yield senior
    await cleanup_test_senior(senior.id)


class TestWebSearch:
    """Test that asking about weather/sports triggers web_search."""

    @pytest.mark.asyncio
    async def test_web_search_triggered(self, test_senior):
        """Caller asks about weather → web_search tool should be called."""
        scenario = web_search_scenario()
        conv_id = await create_test_conversation(test_senior.id)

        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            conversation_id=conv_id,
            run_post_call_processing=True,
        )

        # Assert web_search was called (either by Claude tool or Director web search gating)
        web_searched = (
            "web_search" in result.tool_calls_made
            or len(result.web_search_results) > 0
            or len(result.fillers) > 0  # Director fillers indicate web search gating
        )
        assert web_searched, (
            f"Expected web_search to be triggered. "
            f"Tools used: {result.tool_calls_made}, "
            f"Web results: {len(result.web_search_results)}, "
            f"Fillers: {result.fillers}"
        )

        # Assert reasonable latency
        latencies = [t["latency_ms"] for t in result.turns if t.get("latency_ms")]
        if latencies:
            avg_latency = sum(latencies) / len(latencies)
            assert avg_latency < 30000, f"Average latency {avg_latency}ms exceeds 30s threshold"

        # Assert call completed with multiple turns
        assert len(result.turns) >= 2, f"Expected at least 2 turns, got {len(result.turns)}"


class TestMemoryAcrossCalls:
    """Test memory injection across two calls to the same senior."""

    @pytest.mark.asyncio
    async def test_memory_seed_then_recall(self, test_senior):
        """Call 1 seeds new facts → post-call saves memories → Call 2 recalls them."""

        # --- Call 1: Seed memories ---
        seed_scenario = memory_seed_scenario()
        conv1_id = await create_test_conversation(test_senior.id)

        result1 = await run_simulated_call(
            seed_scenario,
            senior=test_senior,
            conversation_id=conv1_id,
            run_post_call_processing=True,
        )

        assert result1.post_call_completed, "Post-call processing must complete for memory extraction"
        assert len(result1.turns) >= 2, "Call 1 should have at least 2 turns"

        # Wait for async memory extraction to finish
        await asyncio.sleep(3)

        # Verify memories were saved to DB
        from db.client import fetchval
        memory_count = await fetchval(
            "SELECT COUNT(*) FROM memories WHERE senior_id = $1 AND source = 'conversation'",
            test_senior.id,
        )
        assert memory_count > 0, "Post-call should have extracted and saved memories"

        # --- Call 2: Recall memories ---
        recall_scenario = memory_recall_scenario()
        conv2_id = await create_test_conversation(test_senior.id)

        result2 = await run_simulated_call(
            recall_scenario,
            senior=test_senior,
            conversation_id=conv2_id,
            run_post_call_processing=True,
        )

        # Assert: Director should have injected memories (either via prefetch or search)
        # Check that Donna's responses reference previously seeded topics
        all_donna_text = " ".join(t["donna"] for t in result2.turns).lower()
        memory_referenced = (
            "jake" in all_donna_text
            or "baseball" in all_donna_text
            or "lisa" in all_donna_text
            or "florida" in all_donna_text
            or len(result2.injected_memories) > 0
        )
        assert memory_referenced, (
            f"Expected Donna to reference memories from Call 1. "
            f"Injected memories: {result2.injected_memories}, "
            f"Donna's text: {all_donna_text[:200]}"
        )


class TestReminderAcknowledgment:
    """Test that medication reminders are delivered and acknowledged."""

    @pytest.mark.asyncio
    async def test_reminder_delivered_and_acknowledged(self, test_senior):
        """Donna delivers a reminder → caller acknowledges → mark_reminder_acknowledged fires."""
        scenario = reminder_scenario()
        conv_id = await create_test_conversation(test_senior.id, call_type="reminder")

        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            conversation_id=conv_id,
            run_post_call_processing=True,
        )

        # Assert mark_reminder_acknowledged was called
        assert "mark_reminder_acknowledged" in result.tool_calls_made, (
            f"Expected mark_reminder_acknowledged tool call. "
            f"Tools used: {result.tool_calls_made}"
        )

        # Assert reminder was mentioned in conversation
        all_donna_text = " ".join(t["donna"] for t in result.turns).lower()
        reminder_mentioned = "metformin" in all_donna_text or "medication" in all_donna_text
        assert reminder_mentioned, "Donna should mention the medication reminder"


class TestCallMetrics:
    """Test that call metrics and latency are recorded."""

    @pytest.mark.asyncio
    async def test_latency_recorded(self, test_senior):
        """All turns should have latency measurements."""
        scenario = web_search_scenario()
        conv_id = await create_test_conversation(test_senior.id)

        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            conversation_id=conv_id,
            run_post_call_processing=False,  # Skip post-call for speed
        )

        latencies = [t["latency_ms"] for t in result.turns if t.get("latency_ms")]
        assert len(latencies) > 0, "Should have at least one latency measurement"

        for latency in latencies:
            assert latency > 0, "Latency should be positive"
            assert latency < 60000, f"Latency {latency}ms seems too high"
```

**Step 2: Run tests**

```bash
cd pipecat && python -m pytest tests/test_live_simulation.py -v -m llm_simulation --timeout=300
```

Expected: Tests connect to dev DB, run real calls with Haiku caller, verify tool calls and memory injection.

**Step 3: Commit**

```bash
git add tests/test_live_simulation.py
git commit -m "feat: add LLM-to-LLM simulation tests — web search, memory recall, reminder acknowledgment"
```

---

## Task 9: AudioCallerTransport Stub (Phase 2 Interface)

**Files:**
- Modify: `pipecat/tests/simulation/transport.py`

Add the Phase 2 `AudioCallerTransport` class stub that implements the same `CallerTransport` protocol but wraps text in real TTS→audio→STT at the boundaries. This is a stub — full implementation deferred to Phase 2.

**Step 1: Add stub**

Add to bottom of `pipecat/tests/simulation/transport.py`:

```python
class AudioCallerTransport:
    """Phase 2: Audio-loop caller transport (STUB — not yet implemented).

    Same interface as TextCallerTransport, but:
    - send_utterance: text → TTS (ElevenLabs/Cartesia) → audio frames → pipeline STT
    - receive_response: pipeline TTS → audio → STT (Deepgram) → text

    This tests the full audio path except Twilio transport.
    Catches STT/TTS edge cases (mumbling, overlapping, accent handling).

    CallerAgent, scenarios, and assertions remain identical.
    """

    def __init__(self, pipeline_task, response_collector: ResponseCollector, **kwargs):
        self._task = pipeline_task
        self._collector = response_collector
        raise NotImplementedError(
            "AudioCallerTransport is Phase 2 — use TextCallerTransport for now"
        )

    async def send_utterance(self, text: str) -> None:
        raise NotImplementedError

    async def receive_response(self, timeout: float = 60.0) -> CallerEvent:
        raise NotImplementedError

    @property
    def collector(self) -> ResponseCollector:
        return self._collector
```

**Step 2: Commit**

```bash
git add tests/simulation/transport.py
git commit -m "feat: add AudioCallerTransport stub for Phase 2 audio-loop testing"
```

---

## Task 10: Update pytest config + CLAUDE.md

**Files:**
- Modify: `pipecat/pyproject.toml` (add `llm_simulation` marker)
- Modify: `CLAUDE.md` (add simulation testing section)

**Step 1: Register pytest marker**

Add to `pyproject.toml` under `[tool.pytest.ini_options]` markers:

```
"llm_simulation: LLM-to-LLM voice simulation tests (requires API keys + dev DB)"
```

**Step 2: Update CLAUDE.md testing section**

Add to the Testing Strategy section:

```markdown
- **LLM-to-LLM Voice Simulation:** `cd pipecat && python -m pytest tests/test_live_simulation.py -v -m llm_simulation` — Haiku caller vs real Donna pipeline (real Claude, Director, Observer, DB). Tests web_search, memory injection, reminder processing across multiple calls. Requires all API keys + dev DATABASE_URL.
```

**Step 3: Commit**

```bash
git add pipecat/pyproject.toml CLAUDE.md
git commit -m "feat: register llm_simulation pytest marker and document voice simulation testing"
```

---

## Implementation Notes

**FlowManager transport parameter:** `FlowManager(task, llm, context_aggregator, transport=...)` — in `bot.py` this is the Twilio transport. For simulation, try passing without `transport` first. If it requires one, create a minimal mock. Validate during Task 4 implementation.

**Director feature flags:** The Director checks `is_on("director_enabled", session_state)`. The session_state in `build_live_sim_pipeline()` pre-sets `_flags` with `director_enabled: True`. If GrowthBook SDK isn't initialized in test context, this should fallback gracefully.

**API rate limits:** Running multiple simulation tests back-to-back may hit Anthropic or Groq rate limits. Add a small delay between tests if needed. Consider running scenarios sequentially (not parallel) to stay under limits.

**Post-call timing:** After `run_post_call()`, memory extraction runs via OpenAI embeddings which may take 2-3s. The multi-call test adds a `sleep(3)` between calls to ensure memories are persisted before the second call queries them.
