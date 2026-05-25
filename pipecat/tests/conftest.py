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
            "profile_notes": "Prefers gentle reminders and concise check-ins",
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
        "REMINDER: Margaret needs to water the porch plants after dinner. "
        "Deliver this naturally during conversation."
    )
    session_state["reminder_delivery"] = {
        "id": "delivery-001",
        "reminder_id": "rem-001",
        "title": "Water the porch plants",
        "description": "After dinner",
    }
    session_state["_pending_reminders"] = [
        {
            "id": "rem-001",
            "title": "Water the porch plants",
            "description": "After dinner",
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
# Pipeline test runner -- encapsulates the boilerplate for frame-level tests
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
    with patch("services.news.get_news_for_senior", new_callable=AsyncMock) as mock_news:
        mock_news.return_value = "The local garden show is this weekend with new rose varieties."
        yield mock_news


@pytest.fixture
def mock_scheduler_service():
    """Patch services.scheduler for tool handler tests."""
    with patch("services.reminder_delivery.mark_reminder_acknowledged", new_callable=AsyncMock) as mock_ack, \
         patch("services.reminder_delivery.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack, \
         patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock) as mock_clear:
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
            "caregiver_sms": "Donna just chatted with Margaret. She was in great spirits — talked about gardening and family.",
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
