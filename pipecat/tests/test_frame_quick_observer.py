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
    """Verify that guidance is stashed in session_state for the Director.

    Quick Observer used to ALSO push an ``LLMMessagesAppendFrame`` itself,
    but that produced duplicate guidance messages — surfaced by the
    mock-call harness on 2026-05-24: the Director's ephemeral-strip ran
    before the in-flight LLMMessagesAppendFrame had been applied to the
    LLM context, so the strip missed it, the Director's re-inject added a
    fresh copy, and then the original push landed too. The contract is
    now single-writer: Quick Observer stashes via
    ``session_state["_pending_observer_guidance"]``; the Director is the
    sole place that pushes ``LLMMessagesAppendFrame`` for Observer
    guidance.
    """

    @pytest.mark.asyncio
    async def test_health_signal_stashes_guidance_in_session_state(self, session_state):
        """Health-related input should stash guidance in session_state for the Director."""
        processor = QuickObserverProcessor(session_state=session_state)
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("I fell in the bathroom")],
        )

        # The processor must NOT push the guidance frame itself — that's
        # the Director's job. If this regresses we go back to the duplicate
        # injection that broke the mock-call demo.
        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 0, (
            "Quick Observer must not push LLMMessagesAppendFrame directly; "
            "stash via session_state and let the Director inject."
        )

        # And the stash must be populated for the Director to pick up.
        stashed = session_state.get("_pending_observer_guidance")
        assert stashed, "Expected health signal to populate _pending_observer_guidance"
        # Stashed value is the raw guidance text (no [EPHEMERAL: ...] header —
        # the Director adds that when it injects).
        assert isinstance(stashed, str)

    @pytest.mark.asyncio
    async def test_neutral_input_no_guidance(self, session_state):
        """Neutral input should produce neither a guidance frame nor a stash entry."""
        processor = QuickObserverProcessor(session_state=session_state)
        # Long enough to skip engagement triggers, neutral enough to skip everything else.
        capture = await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("I thought about that for a while and it was interesting to consider")],
        )
        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 0
        assert "_pending_observer_guidance" not in session_state

    @pytest.mark.asyncio
    async def test_token_recommendation_clears_on_neutral_turn(self, session_state):
        processor = QuickObserverProcessor(session_state=session_state)
        await run_processor_test(
            processors=[processor],
            frames_to_inject=[
                make_transcription("I fell and hurt my knee badly"),
                make_transcription("I thought about that for a while and it was interesting to consider"),
            ],
        )

        assert "_token_recommendation" not in session_state


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
        await asyncio.wait_for(runner.run(task), timeout=5.0)

        assert capture.has_end_frame

    @pytest.mark.asyncio
    async def test_session_state_goodbye_flag(self, session_state):
        """Strong goodbye should set _goodbye_in_progress in session_state."""
        processor = QuickObserverProcessor(session_state=session_state)
        processor.GOODBYE_DELAY_SECONDS = 10  # Long delay, we just check the flag

        capture = FrameCapture()
        pipeline = Pipeline([processor, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        processor.set_pipeline_task(task)
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            await task.queue_frame(make_transcription("Bye bye"))
            await asyncio.sleep(0.1)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await asyncio.wait_for(runner.run(task), timeout=5.0)

        assert session_state.get("_goodbye_in_progress") is True

    @pytest.mark.asyncio
    async def test_consent_call_goodbye_does_not_force_end(self, session_state):
        """Consent calls should let the consent flow end the call after recording."""
        session_state["call_type"] = "consent"
        processor = QuickObserverProcessor(session_state=session_state)
        processor.GOODBYE_DELAY_SECONDS = 0.1

        await run_processor_test(
            processors=[processor],
            frames_to_inject=[make_transcription("Yes, I agree. Bye now")],
            pre_end_delay=0.3,
        )

        assert processor._goodbye_task is None
        assert session_state.get("_goodbye_in_progress") is not True

    @pytest.mark.asyncio
    async def test_early_strong_goodbye_forces_end(self, session_state, frame_capture):
        """A clear goodbye should not be blocked by an arbitrary minimum call age."""
        import time

        session_state["_call_start_time"] = time.time()
        processor = QuickObserverProcessor(session_state=session_state)
        processor.GOODBYE_DELAY_SECONDS = 0.1
        capture = frame_capture

        pipeline = Pipeline([processor, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        processor.set_pipeline_task(task)
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            await task.queue_frame(make_transcription("Goodbye, talk to you later"))
            await asyncio.sleep(0.3)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await asyncio.wait_for(runner.run(task), timeout=5.0)

        assert session_state.get("_goodbye_in_progress") is True
        assert capture.has_end_frame

    @pytest.mark.asyncio
    async def test_goodbye_continuation_does_not_force_end(self, session_state, frame_capture):
        """A same-utterance continuation should not hang up an otherwise mature call."""
        import time

        session_state["_call_start_time"] = time.time() - (
            QuickObserverProcessor.PROGRAMMATIC_GOODBYE_MIN_ELAPSED_SECONDS + 5
        )
        processor = QuickObserverProcessor(session_state=session_state)
        processor.GOODBYE_DELAY_SECONDS = 0.1
        capture = frame_capture

        pipeline = Pipeline([processor, capture])
        task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
        processor.set_pipeline_task(task)
        runner = PipelineRunner(handle_sigint=False)

        async def inject():
            await task.queue_frame(
                make_transcription("Alright, goodbye... Oh wait, I forgot to tell you something!")
            )
            await asyncio.sleep(0.3)
            await task.queue_frame(EndFrame())

        asyncio.create_task(inject())
        await asyncio.wait_for(runner.run(task), timeout=5.0)

        assert session_state.get("_goodbye_in_progress") is not True
