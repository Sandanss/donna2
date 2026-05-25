# Voice Testing Pipeline - Architecture Design

> Design document for Donna's voice pipeline integration and scenario testing infrastructure.
> Historical note: active live calls now use Telnyx L16/16k. Twilio transport references below describe old mocks/design examples unless the current test code explicitly says otherwise.
> Current harness note: the active behavior/stress mock-call suite lives in `pipecat/tests/simulation/` and uses LLM-vs-LLM text-mode calls by default. New reminder scenarios should use non-medical everyday/social reminders; medication examples below are legacy fixtures only.

---

## Table of Contents

1. [Testing Architecture Overview](#1-testing-architecture-overview)
2. [Test Infrastructure Components](#2-test-infrastructure-components)
3. [Level 1: Processor Frame Tests](#3-level-1-processor-frame-tests)
4. [Level 2: Pipeline Integration Tests](#4-level-2-pipeline-integration-tests)
5. [Level 3: Call Simulation Tests](#5-level-3-call-simulation-tests)
6. [Call Scenario Format](#6-call-scenario-format)
7. [Mock Service Strategy](#7-mock-service-strategy)
8. [Future Extensibility](#8-future-extensibility)

---

## 1. Testing Architecture Overview

### Three Testing Levels

```
Level 3: Call Simulation Tests        ← Full call scenarios end-to-end
  |
  |  Uses: TestTransport, MockLLM, MockSTT, MockTTS, pipeline_builder
  |  Tests: Complete call lifecycle, phase transitions, goodbye flow, post-call
  |
Level 2: Pipeline Integration Tests   ← Multi-processor frame flow
  |
  |  Uses: Pipeline(), PipelineRunner, mock services
  |  Tests: Frame flow through 2+ processors, context injection, tool calls
  |
Level 1: Processor Frame Tests        ← Single processor as FrameProcessor
  |
  |  Uses: Custom run_processor_test() helper (our own — no built-in test utils)
  |  Tests: Each custom processor's process_frame() with real Frame objects
  |
Existing: Pure Function Tests (163+)  ← Already covered
```

### File Structure

```
pipecat/tests/
├── conftest.py                           ← Shared fixtures, session_state factory
├── TESTING_DESIGN.md                     ← This document
│
├── mocks/
│   ├── __init__.py
│   ├── mock_llm.py                       ← MockLLMService (scripted responses)
│   ├── mock_stt.py                       ← MockSTTProcessor (text → TranscriptionFrames)
│   ├── mock_tts.py                       ← MockTTSProcessor (TextFrame passthrough/capture)
│   ├── mock_transport.py                 ← TestInputTransport, TestOutputTransport
│   └── mock_services.py                  ← Mock memory, news, scheduler, director_llm
│
├── helpers/
│   ├── __init__.py
│   ├── pipeline_builder.py               ← Build test pipelines with configurable mocks
│   └── assertions.py                     ← Frame verification, phase transition assertions
│
├── scenarios/
│   ├── __init__.py
│   ├── base.py                           ← CallScenario dataclass, ScenarioRunner
│   ├── happy_path.py                     ← Normal check-in call
│   ├── goodbye_detection.py              ← Goodbye variations, false goodbye
│   ├── reminder_delivery.py              ← Legacy reminder call example
│   └── emotional_support.py              ← Emotional support response
│
├── simulation/                           ← Current LLM-vs-LLM mock-call harness
│   ├── pipeline.py                       ← Real Donna pipeline with direct TranscriptionFrame injection + mock TTS
│   ├── transport.py                      ← Text/Audio caller transports + CallResult
│   ├── scenarios.py                      ← Current scenario catalog
│   ├── stress.py                         ← Stress/stampede scenario builders
│   └── runner.py                         ← run_simulated_call()
│
├── test_frame_quick_observer.py          ← Level 1: QuickObserverProcessor frames
├── test_frame_conversation_director.py   ← Level 1: ConversationDirectorProcessor frames
├── test_frame_conversation_tracker.py    ← Level 1: ConversationTrackerProcessor frames
├── test_frame_guidance_stripper.py       ← Level 1: GuidanceStripperProcessor frames
├── test_frame_goodbye_gate.py            ← Level 1: GoodbyeGateProcessor frames
├── test_pipeline_observer_chain.py       ← Level 2: QuickObserver → Director → LLM context
├── test_pipeline_output_chain.py         ← Level 2: LLM → Tracker → Stripper → TTS
├── test_pipeline_tool_calls.py           ← Level 2: Tool handler integration
├── test_pipeline_phase_transitions.py    ← Level 2: Flow phase transitions
├── test_call_simulation.py              ← Level 3: Full call scenario tests
├── test_post_call.py                     ← Level 2/3: Post-call processing
│
├── (existing tests - unchanged)
├── test_quick_observer.py
├── test_guidance_stripper.py
├── test_conversation_tracker.py
├── test_tools.py
├── test_nodes.py
├── test_call_analysis.py
├── test_daily_context.py
├── test_db.py
├── test_goodbye_gate.py
├── test_greetings.py
├── test_sanitize.py
├── test_validators.py
└── test_api_routes.py
```

### Naming Convention

- `test_frame_*.py` -- Level 1 processor frame tests
- `test_pipeline_*.py` -- Level 2 pipeline integration tests
- `test_call_*.py` -- Level 3 call simulation tests
- Existing `test_*.py` files remain untouched

---

## 2. Test Infrastructure Components

### CRITICAL: No Built-in Test Utils in Pipecat v0.0.101+

The installed pipecat-ai v0.0.101+ package does **NOT** include any built-in test
utilities. There is no `pipecat.tests.utils.run_test()`, no `QueuedFrameProcessor`,
no test helpers. We must build our own.

**Required pipeline setup for tests:**

```python
from pipecat.clocks.system_clock import SystemClock
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.processors.frame_processor import FrameProcessor, FrameProcessorSetup
from pipecat.utils.asyncio.task_manager import TaskManager, TaskManagerParams
```

**Pipeline lifecycle in tests:**

1. Create processors and `Pipeline([proc_a, proc_b, ...])`
2. Create `PipelineTask(pipeline, params=PipelineParams(...))`
3. Create `PipelineRunner(handle_sigint=False)` -- disable signal handling for tests
4. From a separate coroutine: inject frames via `task.queue_frame(frame)`
5. Terminate with `task.queue_frame(EndFrame())` or `task.cancel()`
6. `runner.run(task)` blocks until EndFrame/CancelFrame

**Key constraint:** `PipelineTask.run()` blocks the current coroutine, so frame
injection must happen from an `asyncio.create_task()` coroutine or by using
`asyncio.wait_for()` with a timeout as a safety net.

All test code in this document follows this pattern. The `run_processor_test()`
helper in conftest.py encapsulates the boilerplate.

### 2.1 `conftest.py` -- Shared Fixtures

```python
"""Shared test fixtures for Donna voice pipeline tests."""

import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    LLMMessagesAppendFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameProcessor


# ---------------------------------------------------------------------------
# Session state factory
# ---------------------------------------------------------------------------

@pytest.fixture
def session_state():
    """Minimal valid session_state for pipeline tests."""
    return {
        "senior_id": "senior-test-001",
        "senior": {
            "id": "senior-test-001",
            "name": "Margaret Johnson",
            "interests": ["gardening", "cooking", "grandchildren"],
            "medical_notes": "Type 2 diabetes, mild arthritis",
            "timezone": "America/New_York",
        },
        "memory_context": "Margaret loves her rose garden. Grandson Jake plays baseball.",
        "greeting": "Good morning, Margaret! How are you doing today?",
        "reminder_prompt": None,
        "reminder_delivery": None,
        "reminders_delivered": set(),
        "conversation_id": "conv-test-001",
        "call_sid": "CA-test-001",
        "call_type": "check-in",
        "previous_calls_summary": None,
        "todays_context": None,
        "_call_start_time": None,  # Set by tests that need timing
        "_transcript": [],
    }


@pytest.fixture
def reminder_session_state(session_state):
    """Session state pre-configured for a reminder call."""
    session_state["call_type"] = "reminder"
    session_state["reminder_prompt"] = (
        "MEDICATION REMINDER: Margaret needs to take her metformin (500mg) with dinner. "
        "Deliver this naturally during conversation."
    )
    session_state["reminder_delivery"] = {
        "id": "delivery-001",
        "reminder_id": "rem-001",
        "title": "Take metformin",
        "description": "500mg with dinner",
    }
    session_state["_pending_reminders"] = [
        {
            "id": "rem-001",
            "title": "Take metformin",
            "description": "500mg with dinner",
        }
    ]
    return session_state


# ---------------------------------------------------------------------------
# Frame capture helper
# ---------------------------------------------------------------------------

class FrameCapture(FrameProcessor):
    """Captures all frames that pass through it. Place at the end of a test pipeline."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)
        self.frames.append(frame)
        await self.push_frame(frame, direction)

    def get_frames_of_type(self, frame_type: type) -> list[Frame]:
        return [f for f in self.frames if isinstance(f, frame_type)]

    def get_text_content(self) -> list[str]:
        return [f.text for f in self.frames if isinstance(f, TextFrame)]

    def get_transcriptions(self) -> list[str]:
        return [f.text for f in self.frames if isinstance(f, TranscriptionFrame)]

    def get_llm_messages(self) -> list[list[dict]]:
        return [
            f.messages
            for f in self.frames
            if isinstance(f, LLMMessagesAppendFrame)
        ]

    @property
    def has_end_frame(self) -> bool:
        return any(isinstance(f, EndFrame) for f in self.frames)

    def reset(self):
        self.frames.clear()


@pytest.fixture
def frame_capture():
    """Fresh FrameCapture instance."""
    return FrameCapture()


# ---------------------------------------------------------------------------
# Transcription frame factory
# ---------------------------------------------------------------------------

def make_transcription(text: str, user_id: str = "senior-test-001") -> TranscriptionFrame:
    """Create a TranscriptionFrame with sensible defaults."""
    return TranscriptionFrame(
        text=text,
        user_id=user_id,
        timestamp="",
        language="en",
    )


@pytest.fixture
def make_transcription_frame():
    """Factory fixture for creating TranscriptionFrame instances."""
    return make_transcription


# ---------------------------------------------------------------------------
# Pipeline test runner — encapsulates the boilerplate for frame-level tests
# ---------------------------------------------------------------------------

async def run_processor_test(
    processors: list[FrameProcessor],
    frames_to_inject: list[Frame],
    timeout: float = 5.0,
    inject_delay: float = 0.1,
    pre_end_delay: float = 0.1,
) -> FrameCapture:
    """Run a test pipeline with the given processors and injected frames.

    This is the primary test helper for Level 1 and Level 2 tests. It:
    1. Appends a FrameCapture to the processor chain
    2. Creates Pipeline + PipelineTask + PipelineRunner
    3. Injects the given frames from a background coroutine
    4. Appends an EndFrame to terminate the pipeline
    5. Returns the FrameCapture with all captured output frames

    Args:
        processors: List of FrameProcessor instances to test.
        frames_to_inject: Frames to feed into the pipeline sequentially.
        timeout: Maximum time (seconds) before the test is killed.
        inject_delay: Delay between each injected frame.
        pre_end_delay: Delay before sending the final EndFrame.

    Returns:
        FrameCapture with all frames that flowed through the pipeline.

    Example:
        capture = await run_processor_test(
            processors=[QuickObserverProcessor(session_state=state)],
            frames_to_inject=[make_transcription("I fell down")],
        )
        assert len(capture.get_frames_of_type(LLMMessagesAppendFrame)) >= 1
    """
    capture = FrameCapture()
    all_processors = list(processors) + [capture]

    pipeline = Pipeline(all_processors)
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
    runner = PipelineRunner(handle_sigint=False)

    # Give processors that need it a reference to the task
    for proc in processors:
        if hasattr(proc, "set_pipeline_task"):
            proc.set_pipeline_task(task)

    async def inject():
        for frame in frames_to_inject:
            await task.queue_frame(frame)
            await asyncio.sleep(inject_delay)
        await asyncio.sleep(pre_end_delay)
        await task.queue_frame(EndFrame())

    asyncio.create_task(inject())
    await asyncio.wait_for(runner.run(task), timeout=timeout)

    return capture


# ---------------------------------------------------------------------------
# Mock service patches (applied at module level for service imports)
# ---------------------------------------------------------------------------

@pytest.fixture
def mock_memory_service():
    """Patch services.memory for tool handler tests."""
    with patch("services.memory.search", new_callable=AsyncMock) as mock_search, \
         patch("services.memory.store", new_callable=AsyncMock) as mock_store, \
         patch("services.memory.extract_from_conversation", new_callable=AsyncMock) as mock_extract:
        mock_search.return_value = [
            {"content": "Margaret planted new roses last spring", "similarity": 0.85},
            {"content": "Her grandson Jake had a baseball game", "similarity": 0.72},
        ]
        mock_store.return_value = None
        mock_extract.return_value = None
        yield {
            "search": mock_search,
            "store": mock_store,
            "extract": mock_extract,
        }


@pytest.fixture
def mock_news_service():
    """Patch services.news for tool handler tests."""
    with patch("services.news.get_news_for_topic", new_callable=AsyncMock) as mock_news:
        mock_news.return_value = "The local garden show is this weekend with new rose varieties."
        yield mock_news


@pytest.fixture
def mock_scheduler_service():
    """Patch services.scheduler for tool handler tests."""
    with patch("services.scheduler.mark_reminder_acknowledged", new_callable=AsyncMock) as mock_ack, \
         patch("services.scheduler.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack, \
         patch("services.scheduler.clear_reminder_context", new_callable=AsyncMock) as mock_clear:
        mock_ack.return_value = None
        mock_no_ack.return_value = None
        mock_clear.return_value = None
        yield {
            "mark_acknowledged": mock_ack,
            "mark_no_ack": mock_no_ack,
            "clear_context": mock_clear,
        }


@pytest.fixture
def mock_director_llm():
    """Patch services.director_llm for ConversationDirector tests."""
    from services.director_llm import get_default_direction
    default = get_default_direction()

    with patch("services.director_llm.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
         patch("services.director_llm.format_director_guidance") as mock_format, \
         patch("services.director_llm.get_default_direction") as mock_default:
        mock_analyze.return_value = default
        mock_format.return_value = "main/medium/warm | Continue naturally"
        mock_default.return_value = default
        yield {
            "analyze_turn": mock_analyze,
            "format_guidance": mock_format,
            "get_default": mock_default,
        }


@pytest.fixture
def mock_conversations_service():
    """Patch services.conversations for post-call tests."""
    with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete:
        mock_complete.return_value = None
        yield mock_complete


@pytest.fixture
def mock_call_analysis_service():
    """Patch services.call_analysis for post-call tests."""
    with patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
         patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock) as mock_save:
        mock_analyze.return_value = {
            "mood": "positive",
            "key_topics": ["gardening", "family"],
            "concerns": [],
            "summary": "Margaret is doing well.",
        }
        mock_save.return_value = None
        yield {"analyze": mock_analyze, "save": mock_save}


@pytest.fixture
def mock_daily_context_service():
    """Patch services.daily_context for post-call tests."""
    with patch("services.daily_context.save_call_context", new_callable=AsyncMock) as mock_save:
        mock_save.return_value = None
        yield mock_save


@pytest.fixture
def mock_context_cache_service():
    """Patch services.context_cache for post-call tests."""
    with patch("services.context_cache.clear_cache") as mock_clear:
        yield mock_clear
```

### 2.2 `mocks/mock_llm.py` -- Mock LLM Service

```python
"""Mock LLM service that returns scripted responses.

Replaces AnthropicLLMService in test pipelines. Emits TextFrame sequences
based on pattern matching against accumulated user context, or returns a
default response.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    TextFrame,
)
from pipecat.processors.frame_processor import FrameProcessor


@dataclass
class ScriptedResponse:
    """A pattern-matched response for the MockLLMProcessor."""
    trigger: re.Pattern                    # Regex matched against user message
    response: str                          # Full text response to emit
    tool_calls: list[dict] | None = None   # Optional tool calls to simulate
    once: bool = False                     # If True, only fire once


@dataclass
class MockLLMProcessor(FrameProcessor):
    """Mock LLM that emits scripted TextFrame responses.

    Accumulates context from LLMMessagesAppendFrame and responds to
    TranscriptionFrames that pass through via the context aggregator.

    Usage:
        llm = MockLLMProcessor(responses=[
            ScriptedResponse(
                trigger=re.compile(r"how are you", re.I),
                response="I'm doing well, Margaret! How are you feeling today?",
            ),
            ScriptedResponse(
                trigger=re.compile(r"goodbye|bye", re.I),
                response="It was lovely talking with you! Take care, Margaret.",
            ),
        ])

    The default_response is used when no pattern matches.
    """

    responses: list[ScriptedResponse] = field(default_factory=list)
    default_response: str = "That's wonderful to hear! Tell me more about that."
    _context_messages: list[dict] = field(default_factory=list, repr=False)
    _used_once: set = field(default_factory=set, repr=False)
    _response_log: list[dict] = field(default_factory=list, repr=False)

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMMessagesAppendFrame):
            # Accumulate context (guidance, user messages, etc.)
            self._context_messages.extend(frame.messages)

            if frame.run_llm:
                # Context aggregator is asking us to generate
                await self._generate_response()
            else:
                # Just context injection (guidance), pass through
                await self.push_frame(frame, direction)
            return

        # Pass everything else through
        await self.push_frame(frame, direction)

    async def _generate_response(self):
        """Generate a scripted response based on accumulated context."""
        # Find the last user message in context
        last_user_msg = ""
        for msg in reversed(self._context_messages):
            if msg.get("role") == "user" and "guidance" not in msg.get("content", "").lower():
                last_user_msg = msg.get("content", "")
                break

        # Match against scripted responses
        response_text = self.default_response
        for i, scripted in enumerate(self.responses):
            if i in self._used_once:
                continue
            if scripted.trigger.search(last_user_msg):
                response_text = scripted.response
                if scripted.once:
                    self._used_once.add(i)
                break

        # Log for assertions
        self._response_log.append({
            "trigger": last_user_msg,
            "response": response_text,
        })

        # Emit framing similar to real LLM output
        await self.push_frame(LLMFullResponseStartFrame())

        # Emit response as a sequence of TextFrames (simulating streaming)
        # Split into word-level chunks for realism
        words = response_text.split()
        for i, word in enumerate(words):
            chunk = word if i == 0 else " " + word
            await self.push_frame(TextFrame(text=chunk))

        await self.push_frame(LLMFullResponseEndFrame())

    def get_response_log(self) -> list[dict]:
        """Return log of all trigger→response pairs for assertions."""
        return self._response_log
```

### 2.3 `mocks/mock_stt.py` -- Mock STT Processor

```python
"""Mock STT processor that converts scripted utterances to TranscriptionFrames.

Replaces DeepgramSTTService in test pipelines. Instead of processing audio,
it reads from a queue of pre-scripted utterances and emits them as finalized
TranscriptionFrames.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from pipecat.frames.frames import Frame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameProcessor


@dataclass
class Utterance:
    """A scripted user utterance with optional delay."""
    text: str
    delay_seconds: float = 0.5   # Delay before emitting (simulates speaking time)
    user_id: str = "senior-test-001"


class MockSTTProcessor(FrameProcessor):
    """Emits scripted TranscriptionFrames on demand.

    Does NOT auto-emit; call `emit_next()` or `emit_all()` to feed
    utterances into the pipeline. This gives tests precise control
    over timing.

    Usage:
        stt = MockSTTProcessor(utterances=[
            Utterance("Hello Donna", delay_seconds=0.0),
            Utterance("I'm doing well, thanks for asking"),
            Utterance("Goodbye, talk to you later"),
        ])

        # In test:
        await stt.emit_next()     # Emits "Hello Donna"
        await asyncio.sleep(1)    # Wait for pipeline to process
        await stt.emit_next()     # Emits "I'm doing well..."
    """

    def __init__(self, utterances: list[Utterance] | None = None, **kwargs):
        super().__init__(**kwargs)
        self._utterances = list(utterances or [])
        self._index = 0
        self._emitted: list[TranscriptionFrame] = []

    async def process_frame(self, frame: Frame, direction):
        """Pass all non-audio frames through unchanged."""
        await super().process_frame(frame, direction)
        # In a real pipeline, audio frames would be consumed here.
        # In tests, we ignore them and emit scripted transcriptions instead.
        await self.push_frame(frame, direction)

    async def emit_next(self) -> TranscriptionFrame | None:
        """Emit the next scripted utterance as a TranscriptionFrame.

        Returns the emitted frame, or None if all utterances consumed.
        """
        if self._index >= len(self._utterances):
            return None

        utterance = self._utterances[self._index]
        self._index += 1

        if utterance.delay_seconds > 0:
            await asyncio.sleep(utterance.delay_seconds)

        frame = TranscriptionFrame(
            text=utterance.text,
            user_id=utterance.user_id,
            timestamp="",
            language="en",
        )
        self._emitted.append(frame)
        await self.push_frame(frame)
        return frame

    async def emit_all(self) -> list[TranscriptionFrame]:
        """Emit all remaining utterances sequentially."""
        emitted = []
        while self._index < len(self._utterances):
            frame = await self.emit_next()
            if frame:
                emitted.append(frame)
        return emitted

    @property
    def remaining(self) -> int:
        return len(self._utterances) - self._index

    @property
    def emitted_count(self) -> int:
        return self._index
```

### 2.4 `mocks/mock_tts.py` -- Mock TTS Processor

```python
"""Mock TTS processor that captures TextFrames without producing audio.

Replaces ElevenLabsTTSService in test pipelines. Captures all text that
would be spoken, making it available for assertions.
"""

from __future__ import annotations

from pipecat.frames.frames import Frame, TextFrame
from pipecat.processors.frame_processor import FrameProcessor


class MockTTSProcessor(FrameProcessor):
    """Captures TextFrames (what would be spoken) and passes them through.

    Does NOT produce audio frames — just records the text content for
    assertion purposes.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.spoken_chunks: list[str] = []

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, TextFrame):
            self.spoken_chunks.append(frame.text)

        await self.push_frame(frame, direction)

    @property
    def full_text(self) -> str:
        """All spoken text concatenated."""
        return "".join(self.spoken_chunks)

    @property
    def utterances(self) -> list[str]:
        """Spoken text split into approximate utterances (by sentence)."""
        full = self.full_text
        if not full:
            return []
        # Split on sentence boundaries
        import re
        return [s.strip() for s in re.split(r'(?<=[.!?])\s+', full) if s.strip()]

    def reset(self):
        self.spoken_chunks.clear()
```

### 2.5 `mocks/mock_transport.py` -- Test Transport

```python
"""Mock transport for test pipelines.

Provides TestInputTransport and TestOutputTransport that replace
FastAPIWebsocketTransport. These do not require a WebSocket connection.
"""

from __future__ import annotations

from pipecat.frames.frames import EndFrame, Frame
from pipecat.processors.frame_processor import FrameProcessor


class TestInputTransport(FrameProcessor):
    """Replaces transport.input() in test pipelines.

    Passes frames through. The test injects frames by calling
    pipeline_task.queue_frame() directly.
    """

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)


class TestOutputTransport(FrameProcessor):
    """Replaces transport.output() in test pipelines.

    Captures all output frames. Detects EndFrame to signal pipeline shutdown.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.output_frames: list[Frame] = []
        self._ended = False

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)
        self.output_frames.append(frame)

        if isinstance(frame, EndFrame):
            self._ended = True

        await self.push_frame(frame, direction)

    @property
    def ended(self) -> bool:
        return self._ended
```

### 2.6 `mocks/mock_services.py` -- Mock External Services

```python
"""Mock implementations for external services used by tool handlers.

These mocks are designed to be used as module-level patches so that the
lazy imports in flows/tools.py resolve to controlled implementations.
"""

from __future__ import annotations
from unittest.mock import AsyncMock


class MockMemoryService:
    """Mock for services.memory — configurable search results."""

    def __init__(self, memories: list[dict] | None = None):
        self.memories = memories or [
            {"content": "Loves rose gardening", "similarity": 0.9},
            {"content": "Grandson Jake plays baseball", "similarity": 0.8},
        ]
        self.search = AsyncMock(side_effect=self._search)
        self.store = AsyncMock(return_value=None)
        self.extract_from_conversation = AsyncMock(return_value=None)
        self.search_calls: list[dict] = []
        self.store_calls: list[dict] = []

    async def _search(self, senior_id: str, query: str, limit: int = 3) -> list[dict]:
        self.search_calls.append({"senior_id": senior_id, "query": query, "limit": limit})
        # Simple keyword matching for test scenarios
        matched = [
            m for m in self.memories
            if any(word.lower() in m["content"].lower() for word in query.split())
        ]
        return matched[:limit] if matched else self.memories[:limit]


class MockNewsService:
    """Mock for services.news — returns canned news."""

    def __init__(self, news_text: str = "The local garden show is this weekend."):
        self.news_text = news_text
        self.get_news_for_topic = AsyncMock(side_effect=self._get_news)
        self.calls: list[str] = []

    async def _get_news(self, topic: str, limit: int = 2) -> str:
        self.calls.append(topic)
        return self.news_text


class MockSchedulerService:
    """Mock for services.scheduler — tracks reminder acknowledgments."""

    def __init__(self):
        self.acknowledged: list[dict] = []
        self.mark_reminder_acknowledged = AsyncMock(side_effect=self._mark_ack)
        self.mark_call_ended_without_acknowledgment = AsyncMock(return_value=None)
        self.clear_reminder_context = AsyncMock(return_value=None)

    async def _mark_ack(self, delivery_id: str, status: str, response: str = ""):
        self.acknowledged.append({
            "delivery_id": delivery_id,
            "status": status,
            "response": response,
        })


class MockDirectorLLM:
    """Mock for services.director_llm.analyze_turn — returns configurable directions."""

    def __init__(self, direction: dict | None = None):
        from services.director_llm import get_default_direction
        self.direction = direction or get_default_direction()
        self.call_count = 0

    async def analyze_turn(self, user_message: str, session_state: dict, **kwargs) -> dict:
        self.call_count += 1
        return self.direction

    def set_direction(self, direction: dict):
        """Update the direction returned by subsequent calls."""
        self.direction = direction
```

### 2.7 `helpers/pipeline_builder.py` -- Test Pipeline Builder

```python
"""Build test pipelines with configurable mock/real services.

Provides a factory function that assembles a pipeline matching the
production layout in bot.py, but with mock services for external deps.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext

from processors.quick_observer import QuickObserverProcessor
from processors.conversation_director import ConversationDirectorProcessor
from processors.conversation_tracker import ConversationTrackerProcessor
from processors.guidance_stripper import GuidanceStripperProcessor

from tests.mocks.mock_llm import MockLLMProcessor, ScriptedResponse
from tests.mocks.mock_tts import MockTTSProcessor
from tests.mocks.mock_transport import TestInputTransport, TestOutputTransport
from tests.conftest import FrameCapture


@dataclass
class TestPipelineComponents:
    """References to all components in a test pipeline for assertions."""
    pipeline: Pipeline
    task: PipelineTask
    runner: PipelineRunner
    input_transport: TestInputTransport
    output_transport: TestOutputTransport
    quick_observer: QuickObserverProcessor
    conversation_director: ConversationDirectorProcessor
    conversation_tracker: ConversationTrackerProcessor
    guidance_stripper: GuidanceStripperProcessor
    llm: MockLLMProcessor
    tts: MockTTSProcessor
    frame_capture: FrameCapture
    session_state: dict


def build_test_pipeline(
    session_state: dict,
    llm_responses: list[ScriptedResponse] | None = None,
    default_llm_response: str = "That's nice! Tell me more.",
    include_director: bool = True,
    include_quick_observer: bool = True,
) -> TestPipelineComponents:
    """Build a full test pipeline matching production layout.

    Pipeline layout (matches bot.py):
        input_transport → quick_observer → conversation_director →
        context_aggregator.user() → llm → conversation_tracker →
        guidance_stripper → tts → output_transport →
        context_aggregator.assistant() → frame_capture

    Returns TestPipelineComponents with references to all components.
    """
    # Set call start time
    session_state.setdefault("_call_start_time", time.time())
    session_state.setdefault("_transcript", [])

    # Create components
    input_transport = TestInputTransport()
    output_transport = TestOutputTransport()

    quick_observer = QuickObserverProcessor(session_state=session_state)
    conversation_director = ConversationDirectorProcessor(session_state=session_state)
    conversation_tracker = ConversationTrackerProcessor(session_state=session_state)
    guidance_stripper = GuidanceStripperProcessor()

    llm = MockLLMProcessor(
        responses=llm_responses or [],
        default_response=default_llm_response,
    )

    tts = MockTTSProcessor()
    frame_capture = FrameCapture()

    # Build pipeline processor list
    processors = [input_transport]

    if include_quick_observer:
        processors.append(quick_observer)

    if include_director:
        processors.append(conversation_director)

    # Note: In a real pipeline, context_aggregator sits here.
    # For tests, the MockLLMProcessor handles context accumulation directly.
    processors.extend([
        llm,
        conversation_tracker,
        guidance_stripper,
        tts,
        output_transport,
        frame_capture,
    ])

    pipeline = Pipeline(processors)

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=False,
        ),
    )

    # Wire up pipeline task references
    quick_observer.set_pipeline_task(task)
    conversation_director.set_pipeline_task(task)
    session_state["_conversation_tracker"] = conversation_tracker

    runner = PipelineRunner(handle_sigint=False)

    return TestPipelineComponents(
        pipeline=pipeline,
        task=task,
        runner=runner,
        input_transport=input_transport,
        output_transport=output_transport,
        quick_observer=quick_observer,
        conversation_director=conversation_director,
        conversation_tracker=conversation_tracker,
        guidance_stripper=guidance_stripper,
        llm=llm,
        tts=tts,
        frame_capture=frame_capture,
        session_state=session_state,
    )
```

### 2.8 `helpers/assertions.py` -- Custom Assertions

```python
"""Custom assertion helpers for voice pipeline tests."""

from __future__ import annotations

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    LLMMessagesAppendFrame,
    TextFrame,
    TranscriptionFrame,
)


def assert_frame_order(frames: list[Frame], expected_types: list[type]) -> None:
    """Assert that frames appear in the given type order (allowing extras between).

    Example:
        assert_frame_order(frames, [TranscriptionFrame, LLMMessagesAppendFrame, TextFrame])
    """
    type_iter = iter(expected_types)
    current = next(type_iter, None)

    for frame in frames:
        if current is None:
            break
        if isinstance(frame, current):
            current = next(type_iter, None)

    remaining = [current] + list(type_iter) if current else []
    assert not remaining, (
        f"Expected frame types not found in order. Missing: {[t.__name__ for t in remaining]}"
    )


def assert_guidance_injected(frames: list[Frame], keyword: str) -> None:
    """Assert that an LLMMessagesAppendFrame containing `keyword` exists."""
    for frame in frames:
        if isinstance(frame, LLMMessagesAppendFrame):
            for msg in frame.messages:
                if keyword.lower() in msg.get("content", "").lower():
                    return
    raise AssertionError(f"No guidance frame containing '{keyword}' found")


def assert_no_guidance_spoken(tts_text: str) -> None:
    """Assert that no guidance tags or bracketed directives appear in spoken text."""
    assert "<guidance>" not in tts_text.lower(), "Guidance tags leaked to TTS"
    assert "</guidance>" not in tts_text.lower(), "Guidance close tags leaked to TTS"
    import re
    bracketed = re.findall(r"\[[A-Z][A-Z _]+\]", tts_text)
    assert not bracketed, f"Bracketed directives leaked to TTS: {bracketed}"


def assert_transcription_passthrough(frames: list[Frame], text: str) -> None:
    """Assert that a TranscriptionFrame with the given text passed through."""
    for frame in frames:
        if isinstance(frame, TranscriptionFrame) and frame.text == text:
            return
    raise AssertionError(f"TranscriptionFrame with text '{text}' not found in frames")


def assert_end_frame_present(frames: list[Frame]) -> None:
    """Assert that an EndFrame was emitted."""
    assert any(isinstance(f, EndFrame) for f in frames), "No EndFrame found in frames"


def assert_topics_tracked(tracker, expected_topics: list[str]) -> None:
    """Assert that the ConversationTracker recorded the expected topics."""
    tracked = tracker.state.topics_discussed
    for topic in expected_topics:
        assert topic in tracked, (
            f"Topic '{topic}' not tracked. Tracked: {tracked}"
        )


def assert_transcript_contains(session_state: dict, role: str, keyword: str) -> None:
    """Assert that the shared _transcript contains a message matching role+keyword."""
    transcript = session_state.get("_transcript", [])
    for entry in transcript:
        if entry.get("role") == role and keyword.lower() in entry.get("content", "").lower():
            return
    raise AssertionError(
        f"No {role} message containing '{keyword}' in transcript. "
        f"Transcript has {len(transcript)} entries."
    )
```

---

## 3. Level 1: Processor Frame Tests

Level 1 tests verify each custom FrameProcessor by injecting Frame objects and asserting output frames. These test the `process_frame()` method -- the Pipecat integration layer -- not just the pure functions (which are already tested).

Since pipecat v0.0.101+ has **no built-in test utilities**, all Level 1 tests use our custom `run_processor_test()` helper from conftest.py, which handles Pipeline/PipelineTask/PipelineRunner boilerplate. For tests that need explicit control over timing (e.g., goodbye delays), the manual pattern with `asyncio.create_task(inject())` is used instead.

### 3.1 `test_frame_quick_observer.py`

```python
"""Level 1: QuickObserverProcessor frame-level tests.

Tests the FrameProcessor wrapper (process_frame, guidance injection,
goodbye EndFrame scheduling) -- NOT the pure quick_analyze function
(already tested in test_quick_observer.py).
"""

import asyncio
import pytest

from pipecat.frames.frames import (
    EndFrame,
    LLMMessagesAppendFrame,
    TextFrame,
    TranscriptionFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from processors.quick_observer import QuickObserverProcessor
from tests.conftest import FrameCapture, make_transcription, run_processor_test


class TestQuickObserverFramePassthrough:
    """Verify that frames pass through the processor unchanged."""

    @pytest.mark.asyncio
    async def test_transcription_passes_through(self, session_state):
        """TranscriptionFrame should appear downstream after processing."""
        processor = QuickObserverProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("Hello there")],
        )
        assert "Hello there" in capture.get_transcriptions()

    @pytest.mark.asyncio
    async def test_non_transcription_passes_through(self, session_state):
        """Non-TranscriptionFrames should pass through unchanged."""
        processor = QuickObserverProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[TextFrame(text="some text")],
        )
        assert "some text" in capture.get_text_content()


class TestQuickObserverGuidanceInjection:
    """Verify that guidance is injected as LLMMessagesAppendFrame."""

    @pytest.mark.asyncio
    async def test_health_signal_injects_guidance(self, session_state):
        """Health-related input should produce an LLMMessagesAppendFrame."""
        processor = QuickObserverProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("I fell in the bathroom")],
        )
        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) >= 1
        content = guidance_frames[0].messages[0]["content"]
        assert "guidance" in content.lower()

    @pytest.mark.asyncio
    async def test_neutral_input_no_guidance(self, session_state):
        """Neutral input should NOT produce guidance frames."""
        processor = QuickObserverProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("Hello")],
        )
        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 0


class TestQuickObserverGoodbyeEndFrame:
    """Verify programmatic call ending on strong goodbye detection."""

    @pytest.mark.asyncio
    async def test_strong_goodbye_schedules_end_frame(self, session_state, frame_capture):
        """Strong goodbye should schedule an EndFrame after GOODBYE_DELAY_SECONDS."""
        processor = QuickObserverProcessor(session_state=session_state)
        # Use a shorter delay for faster tests
        processor.GOODBYE_DELAY_SECONDS = 0.3
        capture = frame_capture

        pipeline = Pipeline([processor, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        processor.set_pipeline_task(task)
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            await task.queue_frame(make_transcription("Goodbye, talk to you later"))
            # Wait for the goodbye delay + buffer
            await asyncio.sleep(0.5)

        asyncio.create_task(inject())
        await runner.run(task)

        assert capture.has_end_frame

    @pytest.mark.asyncio
    async def test_session_state_goodbye_flag(self, session_state):
        """Strong goodbye should set _goodbye_in_progress in session_state."""
        processor = QuickObserverProcessor(session_state=session_state)
        processor.GOODBYE_DELAY_SECONDS = 10  # Long delay, we just check the flag

        pipeline = Pipeline([processor])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        processor.set_pipeline_task(task)
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            await task.queue_frame(make_transcription("Bye bye"))
            await asyncio.sleep(0.1)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await runner.run(task)

        assert session_state.get("_goodbye_in_progress") is True
```

### 3.2 `test_frame_conversation_director.py`

```python
"""Level 1: ConversationDirectorProcessor frame-level tests.

Tests non-blocking analysis dispatch, cached guidance injection,
and time-based fallback actions.
"""

import asyncio
import time
import pytest
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import EndFrame, LLMMessagesAppendFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from processors.conversation_director import ConversationDirectorProcessor
from services.director_llm import get_default_direction
from tests.conftest import FrameCapture, make_transcription


class TestDirectorFramePassthrough:
    """Verify frames always pass through (non-blocking)."""

    @pytest.mark.asyncio
    async def test_transcription_passes_through_immediately(
        self, session_state, frame_capture
    ):
        processor = ConversationDirectorProcessor(session_state=session_state)
        capture = frame_capture

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock:
            mock.return_value = get_default_direction()

            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            processor.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                await task.queue_frame(make_transcription("Hello"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await runner.run(task)

        transcriptions = capture.get_transcriptions()
        assert "Hello" in transcriptions


class TestDirectorCachedGuidance:
    """Verify that guidance from PREVIOUS turn is injected on the NEXT turn."""

    @pytest.mark.asyncio
    async def test_second_turn_gets_cached_guidance(self, session_state, frame_capture):
        processor = ConversationDirectorProcessor(session_state=session_state)
        capture = frame_capture

        direction = get_default_direction()

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = direction
            mock_format.return_value = "main/medium/warm | Continue naturally"

            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            processor.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                # Turn 1: no cached guidance yet
                await task.queue_frame(make_transcription("Hello"))
                await asyncio.sleep(0.3)  # Wait for background analysis to complete

                # Turn 2: should inject Turn 1's cached guidance
                await task.queue_frame(make_transcription("I'm doing well"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await runner.run(task)

        # Turn 2 should have produced an LLMMessagesAppendFrame
        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) >= 1


class TestDirectorGoodbyeSuppression:
    """Verify Director suppresses guidance when goodbye is in progress."""

    @pytest.mark.asyncio
    async def test_no_guidance_during_goodbye(self, session_state, frame_capture):
        session_state["_goodbye_in_progress"] = True
        processor = ConversationDirectorProcessor(session_state=session_state)
        # Pre-set cached result
        processor._last_result = get_default_direction()
        capture = frame_capture

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "closing/medium/warm"

            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            processor.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                await task.queue_frame(make_transcription("Talk to you later"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await runner.run(task)

        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 0


class TestDirectorTimeLimits:
    """Verify time-based fallback actions."""

    @pytest.mark.asyncio
    async def test_force_end_after_hard_limit(self, session_state, frame_capture):
        # Set call start 13 minutes ago
        session_state["_call_start_time"] = time.time() - (13 * 60)
        processor = ConversationDirectorProcessor(session_state=session_state)
        # Pre-cache a result so _take_actions runs
        processor._last_result = get_default_direction()
        capture = frame_capture

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            processor.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                await task.queue_frame(make_transcription("Tell me more"))
                # Wait for the delayed end (3s in _delayed_end)
                await asyncio.sleep(4)

            asyncio.create_task(inject())
            await runner.run(task)

        assert capture.has_end_frame
```

### 3.3 `test_frame_conversation_tracker.py`

```python
"""Level 1: ConversationTrackerProcessor frame-level tests.

Tests topic extraction from TranscriptionFrames, question/advice extraction
from TextFrames, transcript building, and frame passthrough.
"""

import pytest

from pipecat.frames.frames import TextFrame

from processors.conversation_tracker import ConversationTrackerProcessor
from tests.conftest import make_transcription, run_processor_test


class TestTrackerUserMessage:
    """Verify topic extraction from user TranscriptionFrames."""

    @pytest.mark.asyncio
    async def test_extracts_gardening_topic(self, session_state):
        tracker = ConversationTrackerProcessor(session_state=session_state)
        await run_processor_test(
            processors=[tracker],
            frames_to_inject=[make_transcription("I was out gardening this morning")],
        )
        assert "gardening" in tracker.state.topics_discussed

    @pytest.mark.asyncio
    async def test_updates_shared_transcript(self, session_state):
        tracker = ConversationTrackerProcessor(session_state=session_state)
        await run_processor_test(
            processors=[tracker],
            frames_to_inject=[make_transcription("Hello Donna")],
        )
        transcript = session_state.get("_transcript", [])
        assert len(transcript) >= 1
        assert transcript[0]["role"] == "user"
        assert "Hello Donna" in transcript[0]["content"]


class TestTrackerAssistantMessage:
    """Verify question/advice extraction from LLM TextFrames."""

    @pytest.mark.asyncio
    async def test_extracts_question(self, session_state):
        tracker = ConversationTrackerProcessor(session_state=session_state)
        await run_processor_test(
            processors=[tracker],
            frames_to_inject=[TextFrame(text="How has your garden been doing lately?")],
        )
        assert len(tracker.state.questions_asked) >= 1

    @pytest.mark.asyncio
    async def test_extracts_advice(self, session_state):
        tracker = ConversationTrackerProcessor(session_state=session_state)
        await run_processor_test(
            processors=[tracker],
            frames_to_inject=[TextFrame(text="You should try to drink more water today.")],
        )
        assert len(tracker.state.advice_given) >= 1


class TestTrackerPassthrough:
    """Verify all frames pass through unchanged."""

    @pytest.mark.asyncio
    async def test_transcription_passes_through(self, session_state):
        tracker = ConversationTrackerProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[tracker],
            frames_to_inject=[make_transcription("Test message")],
        )
        assert "Test message" in capture.get_transcriptions()
```

### 3.4 `test_frame_guidance_stripper.py`

```python
"""Level 1: GuidanceStripperProcessor frame-level tests.

Tests streaming guidance tag stripping, buffering of unclosed tags,
and frame passthrough for non-TextFrame types.
"""

import asyncio
import pytest

from pipecat.frames.frames import EndFrame, TextFrame, TranscriptionFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from processors.guidance_stripper import GuidanceStripperProcessor
from tests.conftest import FrameCapture, make_transcription, run_processor_test


class TestStripperBasic:
    @pytest.mark.asyncio
    async def test_strips_complete_guidance_tag(self):
        stripper = GuidanceStripperProcessor()
        capture = await run_processor_test(
            processors=[stripper],
            frames_to_inject=[
                TextFrame(text="Hello! <guidance>Be warm</guidance> How are you?")
            ],
        )
        full = "".join(capture.get_text_content())
        assert "guidance" not in full.lower()
        assert "Hello!" in full
        assert "How are you?" in full

    @pytest.mark.asyncio
    async def test_strips_bracketed_directives(self):
        stripper = GuidanceStripperProcessor()
        capture = await run_processor_test(
            processors=[stripper],
            frames_to_inject=[TextFrame(text="[HEALTH] Ask about their pain.")],
        )
        full = "".join(capture.get_text_content())
        assert "[HEALTH]" not in full


class TestStripperStreaming:
    @pytest.mark.asyncio
    async def test_buffers_unclosed_tag(self):
        """An unclosed guidance tag should be buffered until the close tag arrives."""
        stripper = GuidanceStripperProcessor()
        # Streaming requires multiple frames with short delays — use manual pattern
        capture = await run_processor_test(
            processors=[stripper],
            frames_to_inject=[
                TextFrame(text="Hello <guidance>internal"),
                TextFrame(text=" note</guidance> friend!"),
            ],
            inject_delay=0.05,
        )
        full = "".join(capture.get_text_content())
        assert "guidance" not in full.lower()
        assert "internal" not in full
        assert "Hello" in full
        assert "friend!" in full


class TestStripperPassthrough:
    @pytest.mark.asyncio
    async def test_non_text_frames_pass_through(self):
        stripper = GuidanceStripperProcessor()
        capture = await run_processor_test(
            processors=[stripper],
            frames_to_inject=[make_transcription("User speech")],
        )
        assert "User speech" in capture.get_transcriptions()
```

### 3.5 `test_frame_goodbye_gate.py`

```python
"""Level 1: GoodbyeGateProcessor frame-level tests.

Tests frame-driven goodbye detection, timer lifecycle, and false-goodbye
cancellation via TranscriptionFrame. Complements test_goodbye_gate.py
which tests the state machine directly.
"""

import asyncio
import pytest

from pipecat.frames.frames import EndFrame, TextFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from processors.goodbye_gate import GoodbyeGateProcessor, GOODBYE_SILENCE_SECONDS
from tests.conftest import FrameCapture, make_transcription


class TestGoodbyeGateFrameFlow:
    @pytest.mark.asyncio
    async def test_senior_goodbye_then_donna_goodbye_triggers_timer(self, frame_capture):
        """When both sides say goodbye, the timer should start."""
        callback_called = asyncio.Event()

        async def on_goodbye():
            callback_called.set()

        gate = GoodbyeGateProcessor(on_goodbye=on_goodbye)
        capture = frame_capture

        pipeline = Pipeline([gate, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            # Senior says goodbye (notify externally, as Quick Observer would)
            gate.notify_goodbye_detected(is_strong=True)
            # Donna says goodbye (via TextFrame)
            await task.queue_frame(TextFrame(text="Goodbye Margaret, take care!"))
            await asyncio.sleep(GOODBYE_SILENCE_SECONDS + 0.5)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await runner.run(task)

        assert callback_called.is_set()

    @pytest.mark.asyncio
    async def test_senior_speaks_cancels_goodbye(self, frame_capture):
        """If senior speaks during goodbye timer, timer should cancel."""
        callback_called = asyncio.Event()

        async def on_goodbye():
            callback_called.set()

        gate = GoodbyeGateProcessor(on_goodbye=on_goodbye)
        capture = frame_capture

        pipeline = Pipeline([gate, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            gate.notify_goodbye_detected(is_strong=True)
            await task.queue_frame(TextFrame(text="Bye bye!"))
            await asyncio.sleep(0.5)
            # Senior continues talking — should cancel
            await task.queue_frame(make_transcription("Oh wait, I forgot to tell you something"))
            await asyncio.sleep(GOODBYE_SILENCE_SECONDS + 0.5)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await runner.run(task)

        assert not callback_called.is_set()
```

---

## 4. Level 2: Pipeline Integration Tests

Level 2 tests assemble partial or full pipelines with 2+ processors and mock services, verifying that frames flow correctly through the chain and that processors interact as expected.

### 4.1 `test_pipeline_observer_chain.py`

```python
"""Level 2: Observer chain integration.

Tests frame flow through: QuickObserver → ConversationDirector → (LLM context)
Verifies guidance injection ordering and non-blocking behavior.
"""

import asyncio
import pytest
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import EndFrame, LLMMessagesAppendFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask

from processors.quick_observer import QuickObserverProcessor
from processors.conversation_director import ConversationDirectorProcessor
from services.director_llm import get_default_direction
from tests.conftest import FrameCapture, make_transcription


class TestObserverChain:
    @pytest.mark.asyncio
    async def test_quick_observer_guidance_before_director(self, session_state, frame_capture):
        """Quick Observer guidance should appear before Director guidance in frame order."""
        quick = QuickObserverProcessor(session_state=session_state)
        director = ConversationDirectorProcessor(session_state=session_state)
        capture = frame_capture

        # Pre-cache a Director result so it injects on turn 2
        director._last_result = get_default_direction()

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            pipeline = Pipeline([quick, director, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            quick.set_pipeline_task(task)
            director.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                # Turn with health signal (Quick Observer will inject guidance)
                await task.queue_frame(make_transcription("I fell down yesterday"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await runner.run(task)

        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        # Quick Observer should have injected health guidance
        assert len(guidance_frames) >= 1
        first_guidance = guidance_frames[0].messages[0]["content"]
        assert "guidance" in first_guidance.lower()


class TestObserverChainGoodbye:
    @pytest.mark.asyncio
    async def test_goodbye_suppresses_director_guidance(self, session_state, frame_capture):
        """After goodbye detection, Director should NOT inject guidance."""
        quick = QuickObserverProcessor(session_state=session_state)
        quick.GOODBYE_DELAY_SECONDS = 0.3
        director = ConversationDirectorProcessor(session_state=session_state)
        director._last_result = get_default_direction()
        capture = frame_capture

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            pipeline = Pipeline([quick, director, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            quick.set_pipeline_task(task)
            director.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                await task.queue_frame(make_transcription("Goodbye, talk to you later"))
                await asyncio.sleep(0.5)

            asyncio.create_task(inject())
            await runner.run(task)

        # Director should have been suppressed (goodbye_in_progress flag)
        director_guidance = [
            f for f in capture.get_frames_of_type(LLMMessagesAppendFrame)
            if any("Director" in m.get("content", "") for m in f.messages)
        ]
        assert len(director_guidance) == 0
```

### 4.2 `test_pipeline_output_chain.py`

```python
"""Level 2: Output chain integration.

Tests frame flow through: (LLM output) → ConversationTracker → GuidanceStripper → (TTS)
Verifies that guidance tags are stripped before TTS and topics are tracked.
"""

import pytest

from pipecat.frames.frames import TextFrame

from processors.conversation_tracker import ConversationTrackerProcessor
from processors.guidance_stripper import GuidanceStripperProcessor
from tests.mocks.mock_tts import MockTTSProcessor
from tests.conftest import make_transcription, run_processor_test


class TestOutputChain:
    @pytest.mark.asyncio
    async def test_guidance_stripped_before_tts(self, session_state):
        """Guidance tags in LLM output should be removed before reaching TTS."""
        tracker = ConversationTrackerProcessor(session_state=session_state)
        stripper = GuidanceStripperProcessor()
        tts = MockTTSProcessor()

        await run_processor_test(
            processors=[tracker, stripper, tts],
            frames_to_inject=[
                TextFrame(text="<guidance>Be empathetic</guidance>I understand how you feel.")
            ],
        )

        spoken = tts.full_text
        assert "guidance" not in spoken.lower()
        assert "I understand" in spoken

    @pytest.mark.asyncio
    async def test_tracker_records_and_stripper_cleans(self, session_state):
        """Tracker should record topics, stripper should clean bracketed directives."""
        tracker = ConversationTrackerProcessor(session_state=session_state)
        stripper = GuidanceStripperProcessor()
        tts = MockTTSProcessor()

        await run_processor_test(
            processors=[tracker, stripper, tts],
            frames_to_inject=[
                make_transcription("I planted new roses"),
                TextFrame(text="[ACTIVITY] How are your roses growing?"),
            ],
            inject_delay=0.05,
        )

        # Tracker should have recorded topic + question
        assert "gardening" in tracker.state.topics_discussed
        assert len(tracker.state.questions_asked) >= 1

        # TTS should not see bracketed directive
        spoken = tts.full_text
        assert "[ACTIVITY]" not in spoken
```

### 4.3 `test_pipeline_tool_calls.py`

```python
"""Level 2: Tool handler integration tests.

Tests that tool handlers correctly interact with mocked external services
(memory, news, scheduler) via session_state closures.
"""

import pytest
from unittest.mock import AsyncMock, patch

from flows.tools import make_tool_handlers


class TestToolHandlerIntegration:
    @pytest.mark.asyncio
    async def test_search_memories_calls_service(self, session_state):
        """search_memories should call services.memory.search with correct params."""
        handlers = make_tool_handlers(session_state)

        with patch("services.memory.search", new_callable=AsyncMock) as mock_search:
            mock_search.return_value = [
                {"content": "Margaret loves her roses"},
            ]
            result = await handlers["search_memories"]({"query": "roses"})

        assert result["status"] == "success"
        assert "roses" in result["result"]
        mock_search.assert_awaited_once_with("senior-test-001", "roses", limit=3)

    @pytest.mark.asyncio
    async def test_get_news_calls_service(self, session_state):
        handlers = make_tool_handlers(session_state)

        with patch("services.news.get_news_for_topic", new_callable=AsyncMock) as mock_news:
            mock_news.return_value = "Garden show this weekend"
            result = await handlers["get_news"]({"topic": "gardening"})

        assert result["status"] == "success"
        assert "Garden show" in result["result"]

    @pytest.mark.asyncio
    async def test_mark_reminder_updates_session(self, reminder_session_state):
        handlers = make_tool_handlers(reminder_session_state)

        with patch("services.scheduler.mark_reminder_acknowledged", new_callable=AsyncMock) as mock_ack:
            result = await handlers["mark_reminder_acknowledged"]({
                "reminder_id": "rem-001",
                "status": "acknowledged",
                "user_response": "I'll take it now",
            })

        assert result["status"] == "success"
        assert "rem-001" in reminder_session_state.get("reminders_delivered", set())
        mock_ack.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_save_detail_stores_memory(self, session_state):
        handlers = make_tool_handlers(session_state)

        with patch("services.memory.store", new_callable=AsyncMock) as mock_store:
            result = await handlers["save_important_detail"]({
                "detail": "Grandson Jake graduated college",
                "category": "family",
            })

        assert result["status"] == "success"
        mock_store.assert_awaited_once_with(
            senior_id="senior-test-001",
            type_="family",
            content="Grandson Jake graduated college",
            source="conversation",
            importance=70,
        )

    @pytest.mark.asyncio
    async def test_search_memories_handles_service_error(self, session_state):
        """Tool handlers should degrade gracefully on service errors."""
        handlers = make_tool_handlers(session_state)

        with patch("services.memory.search", new_callable=AsyncMock) as mock_search:
            mock_search.side_effect = Exception("DB connection failed")
            result = await handlers["search_memories"]({"query": "roses"})

        assert result["status"] == "success"  # Degrades gracefully
        assert "unavailable" in result["result"].lower()
```

### 4.4 `test_pipeline_phase_transitions.py`

```python
"""Level 2: Flow phase transition tests.

Tests that node builders produce correct NodeConfig structures for each phase,
and that transition functions return valid next-phase configs.
"""

import pytest

from flows.nodes import (
    build_initial_node,
    build_opening_node,
    build_main_node,
    build_winding_down_node,
    build_closing_node,
    _make_transition_to_main,
    _make_transition_to_winding_down,
    _make_transition_to_closing,
)
from flows.tools import make_flows_tools


class TestPhaseNodeConfigs:
    def test_opening_node_has_correct_tools(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_opening_node(session_state, flows_tools)

        assert node.name == "opening"
        func_names = [f.name for f in node.functions]
        assert "search_memories" in func_names
        assert "save_important_detail" in func_names
        assert "transition_to_main" in func_names
        assert node.respond_immediately is True

    def test_main_node_has_all_tools(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_main_node(session_state, flows_tools)

        assert node.name == "main"
        func_names = [f.name for f in node.functions]
        assert "search_memories" in func_names
        assert "get_news" in func_names
        assert "save_important_detail" in func_names
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_winding_down" in func_names

    def test_winding_down_node_limited_tools(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_winding_down_node(session_state, flows_tools)

        assert node.name == "winding_down"
        func_names = [f.name for f in node.functions]
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_closing" in func_names
        assert "get_news" not in func_names

    def test_closing_node_no_tools(self, session_state):
        node = build_closing_node(session_state)

        assert node.name == "closing"
        assert len(node.functions) == 0
        assert any(a.get("type") == "end_conversation" for a in node.post_actions)


class TestPhaseTransitions:
    @pytest.mark.asyncio
    async def test_transition_opening_to_main(self, session_state):
        flows_tools = make_flows_tools(session_state)
        transition = _make_transition_to_main(session_state, flows_tools)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node.name == "main"

    @pytest.mark.asyncio
    async def test_transition_main_to_winding_down(self, session_state):
        flows_tools = make_flows_tools(session_state)
        transition = _make_transition_to_winding_down(session_state, flows_tools)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node.name == "winding_down"

    @pytest.mark.asyncio
    async def test_transition_to_closing(self, session_state):
        transition = _make_transition_to_closing(session_state)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node.name == "closing"

    def test_initial_node_is_opening(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_initial_node(session_state, flows_tools)
        assert node.name == "opening"
```

### 4.5 `test_post_call.py`

```python
"""Level 2/3: Post-call processing tests.

Tests _run_post_call() with mocked services to verify the complete
post-call sequence: conversation completion, analysis, memory extraction,
daily context save, reminder cleanup, cache clearing.
"""

import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from processors.conversation_tracker import ConversationTrackerProcessor


class TestPostCallProcessing:
    @pytest.mark.asyncio
    async def test_full_post_call_sequence(self, session_state):
        """Verify all 6 post-call steps execute in order."""
        session_state["_transcript"] = [
            {"role": "user", "content": "Hello Donna"},
            {"role": "assistant", "content": "Hello Margaret! How are you?"},
            {"role": "user", "content": "I'm doing well"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)
        tracker.state.topics_discussed = ["greeting"]
        tracker.state.advice_given = []

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock) as mock_save_analysis, \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock) as mock_extract, \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock) as mock_daily, \
             patch("services.context_cache.clear_cache") as mock_cache_clear, \
             patch("services.scheduler.clear_reminder_context") as mock_sched_clear:

            mock_analyze.return_value = {"mood": "positive", "summary": "Good call"}

            from bot import _run_post_call
            await _run_post_call(session_state, tracker, duration_seconds=120)

            # 1. Conversation completed
            mock_complete.assert_awaited_once()
            # 2. Call analysis run
            mock_analyze.assert_awaited_once()
            # 3. Analysis saved
            mock_save_analysis.assert_awaited_once()
            # 4. Memories extracted
            mock_extract.assert_awaited_once()
            # 5. Daily context saved
            mock_daily.assert_awaited_once()
            # 6. Caches cleared
            mock_cache_clear.assert_called_once_with("senior-test-001")

    @pytest.mark.asyncio
    async def test_post_call_with_unacknowledged_reminder(self, reminder_session_state):
        """Undelivered reminders should trigger mark_call_ended_without_acknowledgment."""
        reminder_session_state["_transcript"] = [
            {"role": "user", "content": "Goodbye"},
        ]
        reminder_session_state["reminders_delivered"] = set()  # None delivered

        tracker = ConversationTrackerProcessor(session_state=reminder_session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context"), \
             patch("services.scheduler.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack:

            mock_analyze.return_value = {"mood": "neutral", "summary": "Short call"}

            from bot import _run_post_call
            await _run_post_call(reminder_session_state, tracker, duration_seconds=30)

            mock_no_ack.assert_awaited_once_with("delivery-001")

    @pytest.mark.asyncio
    async def test_post_call_handles_errors_gracefully(self, session_state):
        """Post-call should not crash if a service fails."""
        session_state["_transcript"] = [
            {"role": "user", "content": "Hello"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete:
            mock_complete.side_effect = Exception("DB error")

            from bot import _run_post_call
            # Should not raise
            await _run_post_call(session_state, tracker, duration_seconds=10)
```

---

## 5. Level 3: Call Simulation Tests

Level 3 tests simulate entire phone calls by feeding scripted utterances through the full pipeline and verifying end-to-end behavior.

### 5.1 `scenarios/base.py` -- Scenario Definition

```python
"""Call scenario definitions and runner for Level 3 tests."""

from __future__ import annotations

import re
from dataclasses import dataclass, field


@dataclass
class ScenarioUtterance:
    """A single utterance in a call scenario."""
    speaker: str                          # "senior" or "donna"
    text: str
    delay_seconds: float = 0.5           # Pause before this utterance
    expect_phase: str | None = None       # Expected call phase after this utterance
    expect_tool_call: str | None = None   # Expected tool call name
    expect_goodbye: bool = False          # Should trigger goodbye detection
    expect_guidance_keyword: str | None = None  # Keyword in Quick Observer guidance


@dataclass
class ScenarioSeniorProfile:
    """Senior profile for a test scenario."""
    id: str = "senior-test-001"
    name: str = "Margaret Johnson"
    interests: list[str] = field(default_factory=lambda: ["gardening", "cooking"])
    medical_notes: str = "Type 2 diabetes"
    timezone: str = "America/New_York"


@dataclass
class ScenarioReminder:
    """A medication reminder for a test scenario."""
    id: str = "rem-001"
    title: str = "Take metformin"
    description: str = "500mg with dinner"


@dataclass
class CallScenario:
    """Complete definition of a call test scenario."""
    name: str
    description: str
    senior: ScenarioSeniorProfile = field(default_factory=ScenarioSeniorProfile)
    call_type: str = "check-in"
    greeting: str = "Good morning, Margaret! How are you today?"
    reminders: list[ScenarioReminder] = field(default_factory=list)
    utterances: list[ScenarioUtterance] = field(default_factory=list)
    expect_end_frame: bool = True
    expect_topics: list[str] = field(default_factory=list)
    max_duration_seconds: float = 10.0

    def to_session_state(self) -> dict:
        """Convert scenario into a session_state dict."""
        state = {
            "senior_id": self.senior.id,
            "senior": {
                "id": self.senior.id,
                "name": self.senior.name,
                "interests": self.senior.interests,
                "medical_notes": self.senior.medical_notes,
                "timezone": self.senior.timezone,
            },
            "memory_context": None,
            "greeting": self.greeting,
            "reminder_prompt": None,
            "reminder_delivery": None,
            "reminders_delivered": set(),
            "conversation_id": "conv-test-001",
            "call_sid": "CA-test-001",
            "call_type": self.call_type,
            "previous_calls_summary": None,
            "todays_context": None,
            "_transcript": [],
        }

        if self.reminders:
            r = self.reminders[0]
            state["call_type"] = "reminder"
            state["reminder_prompt"] = (
                f"MEDICATION REMINDER: {self.senior.name} needs to {r.title}. "
                f"{r.description}. Deliver naturally."
            )
            state["reminder_delivery"] = {
                "id": f"delivery-{r.id}",
                "reminder_id": r.id,
                "title": r.title,
                "description": r.description,
            }
            state["_pending_reminders"] = [
                {"id": r.id, "title": r.title, "description": r.description}
                for r in self.reminders
            ]

        return state
```

### 5.2 `scenarios/happy_path.py`

```python
"""Happy path check-in call scenario."""

import re
from tests.scenarios.base import (
    CallScenario,
    ScenarioUtterance,
    ScenarioSeniorProfile,
)
from tests.mocks.mock_llm import ScriptedResponse


HAPPY_PATH_SCENARIO = CallScenario(
    name="happy_path_checkin",
    description="Normal check-in call. Margaret is in good spirits, talks about gardening.",
    senior=ScenarioSeniorProfile(
        name="Margaret Johnson",
        interests=["gardening", "cooking", "grandchildren"],
    ),
    utterances=[
        ScenarioUtterance(
            speaker="senior",
            text="Oh hello Donna! I'm doing just fine today.",
            delay_seconds=0.3,
        ),
        ScenarioUtterance(
            speaker="senior",
            text="I was out in the garden this morning, the roses are blooming beautifully.",
            delay_seconds=0.5,
            expect_guidance_keyword="ACTIVITY",
        ),
        ScenarioUtterance(
            speaker="senior",
            text="Jake is coming to visit this weekend, I'm so excited!",
            delay_seconds=0.5,
        ),
        ScenarioUtterance(
            speaker="senior",
            text="Well it was lovely talking to you Donna. Goodbye!",
            delay_seconds=0.5,
            expect_goodbye=True,
        ),
    ],
    expect_topics=["gardening", "family"],
    expect_end_frame=True,
)


HAPPY_PATH_LLM_RESPONSES = [
    ScriptedResponse(
        trigger=re.compile(r"doing.*(fine|well|good|great)", re.I),
        response="That's wonderful to hear, Margaret! What have you been up to today?",
    ),
    ScriptedResponse(
        trigger=re.compile(r"garden|roses|bloom", re.I),
        response="Oh how lovely! Your roses must be gorgeous this time of year. What colors are they?",
    ),
    ScriptedResponse(
        trigger=re.compile(r"jake|visit|weekend|excited", re.I),
        response="How exciting! It will be so nice to have Jake visit. What are you planning to do together?",
    ),
    ScriptedResponse(
        trigger=re.compile(r"goodbye|bye|lovely talking", re.I),
        response="It was wonderful talking with you too, Margaret! Enjoy the rest of your day. Goodbye!",
    ),
]
```

### 5.3 `scenarios/goodbye_detection.py`

```python
"""Goodbye detection scenarios — strong, false, and delayed goodbye."""

import re
from tests.scenarios.base import CallScenario, ScenarioUtterance, ScenarioSeniorProfile
from tests.mocks.mock_llm import ScriptedResponse


FALSE_GOODBYE_SCENARIO = CallScenario(
    name="false_goodbye",
    description="Senior says goodbye but then continues talking (false goodbye).",
    utterances=[
        ScenarioUtterance(
            speaker="senior",
            text="Hello Donna!",
            delay_seconds=0.3,
        ),
        ScenarioUtterance(
            speaker="senior",
            text="Alright, goodbye... Oh wait, I forgot to tell you something!",
            delay_seconds=0.3,
            expect_goodbye=True,  # Goodbye detected, but senior continues
        ),
        ScenarioUtterance(
            speaker="senior",
            text="My doctor's appointment went well yesterday.",
            delay_seconds=0.3,
            expect_guidance_keyword="HEALTH",
        ),
        ScenarioUtterance(
            speaker="senior",
            text="Okay now I really have to go. Bye bye, take care!",
            delay_seconds=0.5,
            expect_goodbye=True,
        ),
    ],
    expect_end_frame=True,
)


STRONG_GOODBYE_SCENARIO = CallScenario(
    name="strong_goodbye",
    description="Senior says a clear strong goodbye — call should end quickly.",
    utterances=[
        ScenarioUtterance(
            speaker="senior",
            text="Hello!",
            delay_seconds=0.3,
        ),
        ScenarioUtterance(
            speaker="senior",
            text="Goodbye Donna, talk to you tomorrow!",
            delay_seconds=0.3,
            expect_goodbye=True,
        ),
    ],
    expect_end_frame=True,
)
```

### 5.4 `test_call_simulation.py`

```python
"""Level 3: Full call simulation tests.

Assembles the complete pipeline with mock services and runs scripted call
scenarios end-to-end. Verifies conversation flow, phase transitions,
goodbye detection, and topic tracking.
"""

import asyncio
import re
import pytest
from unittest.mock import AsyncMock, patch

from pipecat.frames.frames import EndFrame

from tests.scenarios.happy_path import HAPPY_PATH_SCENARIO, HAPPY_PATH_LLM_RESPONSES
from tests.scenarios.goodbye_detection import STRONG_GOODBYE_SCENARIO
from tests.helpers.pipeline_builder import build_test_pipeline
from tests.helpers.assertions import (
    assert_no_guidance_spoken,
    assert_topics_tracked,
)
from tests.conftest import make_transcription


class TestHappyPathCall:
    """Full happy-path check-in call simulation."""

    @pytest.mark.asyncio
    async def test_happy_path_completes(self):
        """Normal check-in call should complete with EndFrame and tracked topics."""
        session_state = HAPPY_PATH_SCENARIO.to_session_state()

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            from services.director_llm import get_default_direction
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            components = build_test_pipeline(
                session_state=session_state,
                llm_responses=HAPPY_PATH_LLM_RESPONSES,
                default_llm_response="That sounds lovely!",
            )
            # Shorten goodbye delay for fast test
            components.quick_observer.GOODBYE_DELAY_SECONDS = 0.3

            async def run_scenario():
                for utterance in HAPPY_PATH_SCENARIO.utterances:
                    if utterance.speaker == "senior":
                        await asyncio.sleep(utterance.delay_seconds)
                        await components.task.queue_frame(
                            make_transcription(utterance.text)
                        )
                        # Allow pipeline to process
                        await asyncio.sleep(0.2)

                # Wait for goodbye EndFrame
                await asyncio.sleep(1.0)

            asyncio.create_task(run_scenario())
            await components.runner.run(components.task)

        # Verify call ended
        assert components.frame_capture.has_end_frame

        # Verify topics tracked
        assert_topics_tracked(
            components.conversation_tracker,
            HAPPY_PATH_SCENARIO.expect_topics,
        )

        # Verify no guidance leaked to TTS
        assert_no_guidance_spoken(components.tts.full_text)


class TestGoodbyeScenarios:
    """Goodbye detection simulation tests."""

    @pytest.mark.asyncio
    async def test_strong_goodbye_ends_call(self):
        """A strong goodbye should end the call via EndFrame."""
        session_state = STRONG_GOODBYE_SCENARIO.to_session_state()

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            from services.director_llm import get_default_direction
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            components = build_test_pipeline(
                session_state=session_state,
                llm_responses=[
                    re.compile(r"goodbye|bye", re.I),
                ],
                default_llm_response="Goodbye Margaret!",
            )
            components.quick_observer.GOODBYE_DELAY_SECONDS = 0.3

            async def run_scenario():
                for utterance in STRONG_GOODBYE_SCENARIO.utterances:
                    if utterance.speaker == "senior":
                        await asyncio.sleep(utterance.delay_seconds)
                        await components.task.queue_frame(
                            make_transcription(utterance.text)
                        )
                        await asyncio.sleep(0.2)

                await asyncio.sleep(1.0)

            asyncio.create_task(run_scenario())
            await components.runner.run(components.task)

        assert components.frame_capture.has_end_frame
```

---

## 6. Call Scenario Format

### Format: Python Dataclasses

We use Python dataclasses (not YAML) because:
- Type safety and IDE support
- Inline LLM response patterns (regex)
- Composable with inheritance
- No extra parser dependency
- Direct use in pytest parametrize

### Scenario Structure

```python
@dataclass
class CallScenario:
    name: str                         # Unique scenario identifier
    description: str                  # What this scenario tests
    senior: ScenarioSeniorProfile     # Senior profile (name, interests, medical)
    call_type: str                    # "check-in" | "reminder"
    greeting: str                     # Opening greeting
    reminders: list[ScenarioReminder] # Medication reminders to deliver
    utterances: list[ScenarioUtterance]  # Scripted conversation
    expect_end_frame: bool            # Should call end naturally
    expect_topics: list[str]          # Topics tracker should detect
    max_duration_seconds: float       # Test timeout
```

### Utterance Annotations

Each `ScenarioUtterance` carries optional assertion annotations:

| Field | Purpose |
|-------|---------|
| `expect_phase` | Assert call phase after this utterance |
| `expect_tool_call` | Assert a specific tool was called |
| `expect_goodbye` | Assert goodbye detection triggered |
| `expect_guidance_keyword` | Assert Quick Observer injected guidance containing keyword |

### Extensibility

New scenarios are added by creating a new file in `scenarios/` with a `CallScenario` instance and optional `ScriptedResponse` list. The `test_call_simulation.py` file uses these directly or via `pytest.mark.parametrize`.

---

## 7. Mock Service Strategy

### Mock Matrix

| External Dependency | Mock Mechanism | Verification |
|---|---|---|
| **Deepgram STT** | `MockSTTProcessor` -- emits scripted `TranscriptionFrame`s | Not called in tests; replaced entirely |
| **Anthropic Claude LLM** | `MockLLMProcessor` -- pattern-matched scripted responses | `get_response_log()` for trigger/response pairs |
| **ElevenLabs TTS** | `MockTTSProcessor` -- captures `TextFrame`s | `full_text`, `utterances` properties |
| **Gemini Flash (Director)** | `patch("services.director_llm.analyze_turn")` | Mock return value + `assert_awaited` |
| **Database (asyncpg)** | `patch()` per-service (`memory.search`, `conversations.complete`, etc.) | `assert_awaited_once_with()` on each mock |
| **Twilio Transport** | `TestInputTransport`/`TestOutputTransport` | `output_frames`, `ended` property |
| **Twilio REST API** | Not used in pipeline tests | N/A |
| **OpenAI (embeddings/news)** | `patch("services.news.get_news_for_topic")` | Mock return value + `assert_awaited` |

### Configurability

All mocks are configurable per-test:

```python
# MockLLMProcessor: different responses per scenario
llm = MockLLMProcessor(responses=[
    ScriptedResponse(trigger=re.compile(r"pain"), response="Oh no, are you hurt?"),
])

# MockMemoryService: different memory bank per scenario
memory = MockMemoryService(memories=[
    {"content": "Had hip surgery in 2024", "similarity": 0.95},
])

# Director: different directions per test
mock_analyze.return_value = {
    "analysis": {"call_phase": "winding_down", ...},
    ...
}
```

### Service Interaction Verification

```python
# Verify memory search was called with correct params
mock_search.assert_awaited_once_with("senior-001", "roses", limit=3)

# Verify reminder was acknowledged
assert "rem-001" in session_state["reminders_delivered"]

# Verify no guidance leaked to TTS
assert_no_guidance_spoken(tts.full_text)
```

---

## 8. Future Extensibility

### 8.1 Real Service Integration Tests (Optional/Expensive)

Add a `@pytest.mark.integration` marker for tests that hit real services:

```python
@pytest.mark.integration
@pytest.mark.asyncio
async def test_real_memory_search():
    """Requires DATABASE_URL. Tests actual pgvector similarity search."""
    from services.memory import search
    results = await search("test-senior", "gardening", limit=3)
    assert isinstance(results, list)
```

Run selectively: `pytest -m integration --timeout=30`

### 8.2 Prompt Regression Tests

Test that LLM system prompts haven't changed unexpectedly:

```python
def test_opening_prompt_contains_critical_instructions(session_state):
    """Guard against accidental prompt regression."""
    flows_tools = make_flows_tools(session_state)
    node = build_opening_node(session_state, flows_tools)
    system_msg = node.role_messages[0]["content"]

    assert "CRITICAL" in system_msg
    assert "spoken aloud" in system_msg.lower()
    assert "1-2 sentences" in system_msg
```

### 8.3 Real LLM Response Tests (Expensive)

```python
@pytest.mark.llm
@pytest.mark.asyncio
async def test_claude_responds_to_health_crisis():
    """Requires ANTHROPIC_API_KEY. Tests Claude's response to health crisis."""
    # Uses real AnthropicLLMService with minimal pipeline
    # Verifies response tone and content
```

Run selectively: `pytest -m llm --timeout=60`

### 8.4 Audio Quality Testing

For future TTS verification:

```python
@pytest.mark.audio
async def test_tts_output_is_valid_audio():
    """Requires ELEVENLABS_API_KEY. Verifies TTS produces valid audio bytes."""
    # Feed TextFrame to real ElevenLabsTTSService
    # Verify AudioRawFrame output has valid sample rate and content
```

### 8.5 Performance Benchmarks

```python
@pytest.mark.benchmark
async def test_quick_observer_latency():
    """QuickObserver should add < 5ms latency per frame."""
    import time
    processor = QuickObserverProcessor(session_state={})

    times = []
    for text in BENCHMARK_UTTERANCES:
        start = time.perf_counter()
        # Simulate process_frame timing (without pipeline overhead)
        quick_analyze(text)
        times.append(time.perf_counter() - start)

    avg_ms = (sum(times) / len(times)) * 1000
    assert avg_ms < 5, f"Average latency {avg_ms:.1f}ms exceeds 5ms limit"
```

---

## Appendix: Running Tests

```bash
# Run all tests (existing + new)
cd pipecat && python -m pytest tests/ -v

# Run only Level 1 frame tests
python -m pytest tests/test_frame_*.py -v

# Run only Level 2 pipeline tests
python -m pytest tests/test_pipeline_*.py -v

# Run only Level 3 simulation tests
python -m pytest tests/test_call_*.py -v

# Run with coverage
python -m pytest tests/ --cov=. --cov-report=term-missing

# Run fast (skip slow integration tests)
python -m pytest tests/ -v -m "not integration and not llm and not audio"
```

### Performance Target

All Level 1 + Level 2 + Level 3 tests should complete in **< 30 seconds** total. This is achievable because:
- No external service calls (everything mocked)
- `GOODBYE_DELAY_SECONDS` overridden to 0.3s in tests
- Director analysis mocked (no Gemini calls)
- No audio processing (MockTTS, MockSTT)
- Pipeline tasks use `handle_sigint=False` for clean test lifecycle

### Verified Pipecat v0.0.101+ Imports

These are the **confirmed available** imports from the installed package. The package
does NOT include `pipecat.tests.*` or any built-in test utilities.

```python
# Frames
from pipecat.frames.frames import (
    Frame, StartFrame, EndFrame, CancelFrame,
    TextFrame, TranscriptionFrame,
    LLMMessagesAppendFrame,
    LLMFullResponseStartFrame, LLMFullResponseEndFrame,
    FunctionCallResultFrame, FunctionCallInProgressFrame,
    TTSStartedFrame, TTSStoppedFrame,
    UserStartedSpeakingFrame, UserStoppedSpeakingFrame,
)

# Processor base
from pipecat.processors.frame_processor import (
    FrameProcessor,
    FrameDirection,
    FrameProcessorSetup,
)

# Pipeline
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask, PipelineParams
from pipecat.pipeline.runner import PipelineRunner

# Clock and task manager (needed for manual pipeline setup if required)
from pipecat.clocks.system_clock import SystemClock
from pipecat.utils.asyncio.task_manager import TaskManager, TaskManagerParams

# Context
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext

# Services (production only — replaced by mocks in tests)
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
```
