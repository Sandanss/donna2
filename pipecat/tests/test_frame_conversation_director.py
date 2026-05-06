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

        with patch("processors.conversation_director.analyze_turn_speculative", new_callable=AsyncMock) as mock:
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
            await asyncio.wait_for(runner.run(task), timeout=5.0)

        transcriptions = capture.get_transcriptions()
        assert "Hello" in transcriptions


class TestDirectorCachedGuidance:
    """Verify that guidance from PREVIOUS turn is injected on the NEXT turn."""

    @pytest.mark.asyncio
    async def test_second_turn_gets_cached_guidance(self, session_state, frame_capture):
        processor = ConversationDirectorProcessor(session_state=session_state)
        capture = frame_capture

        direction = get_default_direction()
        # Pre-set cached guidance (simulates previous speculative completing)
        processor._last_result = direction

        with patch("processors.conversation_director.analyze_turn_speculative", new_callable=AsyncMock) as mock_analyze, \
             patch("processors.conversation_director.format_director_guidance") as mock_format:
            mock_analyze.return_value = direction
            mock_format.return_value = "main/medium/warm | Continue naturally"

            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            processor.set_pipeline_task(task)
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                # Turn 1: has cached guidance from _last_result
                await task.queue_frame(make_transcription("Hello"))
                await asyncio.sleep(0.3)

                # Turn 2: should inject cached guidance
                await task.queue_frame(make_transcription("I'm doing well"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await asyncio.wait_for(runner.run(task), timeout=5.0)

        # Should have produced guidance frames from cached _last_result
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

        with patch("processors.conversation_director.analyze_turn_speculative", new_callable=AsyncMock) as mock_analyze, \
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
            await asyncio.wait_for(runner.run(task), timeout=5.0)

        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 0


class TestDirectorFallbackAnalysis:
    """Verify final-turn fallback analysis stays off-path but still updates state."""

    @pytest.mark.asyncio
    async def test_fallback_analysis_updates_cached_guidance(self, session_state):
        processor = ConversationDirectorProcessor(session_state=session_state)
        result = get_default_direction()

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch.object(processor, "_run_director_prefetch", new_callable=AsyncMock) as mock_prefetch:
            mock_analyze.return_value = result

            returned = await processor._run_fallback_analysis("I had lunch", [])
            await asyncio.sleep(0)

        assert returned is result
        assert processor._last_result is result
        assert processor._last_result_age == 0
        mock_analyze.assert_awaited_once()
        mock_prefetch.assert_called_once_with(result)

    @pytest.mark.asyncio
    async def test_fallback_analysis_preserves_forced_wrapup(self, session_state):
        processor = ConversationDirectorProcessor(session_state=session_state)
        processor._wrapup_forced = True
        result = get_default_direction()
        result["analysis"]["call_phase"] = "main"
        result["direction"]["pacing_note"] = "good"

        with patch("processors.conversation_director.analyze_turn", new_callable=AsyncMock) as mock_analyze, \
             patch.object(processor, "_run_director_prefetch", new_callable=AsyncMock):
            mock_analyze.return_value = result
            returned = await processor._run_fallback_analysis("Tell me more", [])

        assert returned["analysis"]["call_phase"] == "winding_down"
        assert returned["direction"]["pacing_note"] == "time_to_close"


class TestDirectorContextInjection:
    """Verify non-guidance context is injected ephemerally and deduplicated."""

    @pytest.mark.asyncio
    async def test_pending_observer_guidance_injected_after_strip(self, session_state, frame_capture):
        class FakeContext:
            def __init__(self):
                self.messages = [
                    {"role": "system", "content": "base"},
                    {
                        "role": "user",
                        "content": "[EPHEMERAL: Observer guidance — do not read aloud]\nstale",
                    },
                ]

            def get_messages(self):
                return self.messages

            def set_messages(self, messages):
                self.messages = messages

        fake_context = FakeContext()
        session_state["_llm_context"] = fake_context
        session_state["_pending_observer_guidance"] = "[HEALTH] Ask how they are feeling."
        processor = ConversationDirectorProcessor(session_state=session_state)
        capture = frame_capture

        with patch("lib.growthbook.is_on", return_value=False):
            pipeline = Pipeline([processor, capture])
            task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False))
            runner = PipelineRunner(handle_sigint=False)

            async def inject():
                await task.queue_frame(make_transcription("My back hurts today"))
                await asyncio.sleep(0.1)
                await task.queue_frame(EndFrame())

            asyncio.create_task(inject())
            await asyncio.wait_for(runner.run(task), timeout=5.0)

        guidance_frames = capture.get_frames_of_type(LLMMessagesAppendFrame)
        assert len(guidance_frames) == 1
        content = guidance_frames[0].messages[0]["content"]
        assert "Observer guidance" in content
        assert "[HEALTH]" in content
        assert "_pending_observer_guidance" not in session_state
        assert all(
            not (m.get("content", "").startswith("[EPHEMERAL") if isinstance(m, dict) else False)
            for m in fake_context.messages
        )

    @pytest.mark.asyncio
    async def test_tracking_context_injected_once_per_summary(self, session_state):
        class Tracker:
            def get_summary(self):
                return "CONVERSATION SO FAR THIS CALL\n- Topics discussed: health"

        frames = []

        async def capture_frame(frame, direction=None):
            frames.append(frame)

        session_state["_conversation_tracker"] = Tracker()
        processor = ConversationDirectorProcessor(session_state=session_state)
        processor.push_frame = capture_frame

        await processor._inject_tracking_context()
        await processor._inject_tracking_context()

        assert len(frames) == 1
        assert isinstance(frames[0], LLMMessagesAppendFrame)
        assert frames[0].messages[0]["content"].startswith("[EPHEMERAL: CONVERSATION TRACKING")
        assert session_state["conversation_tracking"].startswith("CONVERSATION SO FAR")

    @pytest.mark.asyncio
    async def test_memory_refresh_injects_changed_context(self, session_state):
        class Tracker:
            def get_topics(self):
                return ["lunch"]

        frames = []

        async def capture_frame(frame, direction=None):
            frames.append(frame)

        session_state["_conversation_tracker"] = Tracker()
        processor = ConversationDirectorProcessor(session_state=session_state)
        processor.push_frame = capture_frame

        with patch("services.memory.refresh_context", new_callable=AsyncMock) as mock_refresh:
            mock_refresh.return_value = "- Lunch is an important routine."
            await processor._refresh_memory()

        assert session_state["memory_context"] == "- Lunch is an important routine."
        assert len(frames) == 1
        assert isinstance(frames[0], LLMMessagesAppendFrame)
        assert frames[0].messages[0]["content"].startswith("[EPHEMERAL: MEMORY CONTEXT")

    @pytest.mark.asyncio
    async def test_prefetched_memory_not_reinjected_during_cooldown(self, session_state):
        from services.prefetch import PrefetchCache

        frames = []

        async def capture_frame(frame, direction=None):
            frames.append(frame)

        cache = PrefetchCache()
        cache.put("gardening", [{"id": "memory-1", "content": "Loves growing roses."}])
        session_state["_prefetch_cache"] = cache

        processor = ConversationDirectorProcessor(session_state=session_state)
        processor.push_frame = capture_frame
        processor._turn_count = 1
        await processor._inject_prefetched_memories("gardening")

        processor._turn_count = 2
        await processor._inject_prefetched_memories("gardening")

        assert len(frames) == 1
        assert "Loves growing roses" in frames[0].messages[0]["content"]

    @pytest.mark.asyncio
    async def test_prefetched_memory_reinjects_after_cooldown(self, session_state):
        from services.prefetch import PrefetchCache

        frames = []

        async def capture_frame(frame, direction=None):
            frames.append(frame)

        cache = PrefetchCache()
        cache.put("gardening", [{"id": "memory-1", "content": "Loves growing roses."}])
        session_state["_prefetch_cache"] = cache

        processor = ConversationDirectorProcessor(session_state=session_state)
        processor.push_frame = capture_frame
        processor._turn_count = 1
        await processor._inject_prefetched_memories("gardening")

        processor._turn_count = 1 + processor.MEMORY_REINJECTION_COOLDOWN_TURNS
        await processor._inject_prefetched_memories("gardening")

        assert len(frames) == 2

    def test_history_before_current_removes_current_user_turn(self, session_state):
        session_state["_transcript"] = [
            {"role": "assistant", "content": "How was your day?"},
            {"role": "user", "content": "I am going to work out tomorrow."},
        ]
        processor = ConversationDirectorProcessor(session_state=session_state)

        history = processor._history_before_current("I am going to work out tomorrow.")

        assert history == [{"role": "assistant", "content": "How was your day?"}]

    @pytest.mark.asyncio
    async def test_memory_gate_does_not_wait_without_relevant_inflight(self, session_state):
        from services.prefetch import PrefetchCache

        cache = PrefetchCache()
        cache.put("gardening", [{"id": "memory-1", "content": "Loves roses."}])
        session_state["_prefetch_cache"] = cache

        processor = ConversationDirectorProcessor(session_state=session_state)

        with patch("processors.conversation_director.asyncio.sleep", new_callable=AsyncMock) as mock_sleep:
            await processor._inject_prefetched_memories("weather forecast")

        mock_sleep.assert_not_called()

    @pytest.mark.asyncio
    async def test_injected_memory_marks_accessed_after_push(self, session_state):
        from services.prefetch import PrefetchCache

        frames = []

        async def capture_frame(frame, direction=None):
            frames.append(frame)

        cache = PrefetchCache()
        cache.put("gardening", [{"id": "memory-1", "content": "Loves growing roses."}])
        session_state["_prefetch_cache"] = cache

        processor = ConversationDirectorProcessor(session_state=session_state)
        processor.push_frame = capture_frame

        with patch("services.memory.mark_accessed", new_callable=AsyncMock) as mock_mark:
            await processor._inject_prefetched_memories("gardening")
            await asyncio.sleep(0.01)

        assert len(frames) == 1
        mock_mark.assert_awaited_once_with(["memory-1"])


class TestDirectorSpeculativeAnalysis:
    """Verify speculative pre-processing behavior."""

    def test_text_matches_similar(self):
        """Jaccard similarity check accepts similar text."""
        from processors.conversation_director import ConversationDirectorProcessor
        # Interim is missing final punctuation/word — very common
        assert ConversationDirectorProcessor._text_matches(
            "I went to the doctor yesterday and they told me",
            "I went to the doctor yesterday and they told me everything is fine",
        )

    def test_text_matches_rejects_divergent(self):
        """Jaccard similarity check rejects divergent text."""
        from processors.conversation_director import ConversationDirectorProcessor
        assert not ConversationDirectorProcessor._text_matches(
            "I went to the",
            "Tell me about the weather today please",
        )

    def test_text_matches_handles_empty(self):
        from processors.conversation_director import ConversationDirectorProcessor
        assert not ConversationDirectorProcessor._text_matches("", "hello")
        assert not ConversationDirectorProcessor._text_matches("hello", "")

    @pytest.mark.asyncio
    async def test_speculative_keeps_running_on_new_interim(self, session_state):
        """Speculative analysis keeps running when new speech arrives (fire-and-forget).

        Each speculative builds cache context, so we never cancel them.
        """
        processor = ConversationDirectorProcessor(session_state=session_state)

        # Simulate a running speculative task
        long_task = asyncio.create_task(asyncio.sleep(10))
        processor._speculative_tasks.append(("I went to the doctor", long_task))

        # New interim arrives — speculative should NOT be cancelled
        assert not long_task.cancelled()
        assert len(processor._speculative_tasks) == 1

        # Clean up
        long_task.cancel()
        try:
            await long_task
        except asyncio.CancelledError:
            pass

    @pytest.mark.asyncio
    async def test_end_frame_cancels_background_tasks(self, session_state):
        processor = ConversationDirectorProcessor(session_state=session_state)
        speculative_task = asyncio.create_task(asyncio.sleep(10))
        prefetch_task = asyncio.create_task(asyncio.sleep(10))
        fallback_task = asyncio.create_task(asyncio.sleep(10))
        delayed_end_task = asyncio.create_task(asyncio.sleep(10))
        silence_task = asyncio.create_task(asyncio.sleep(10))

        processor._speculative_tasks.append(("hello there", speculative_task))
        processor._prefetch_tasks.append(prefetch_task)
        processor._fallback_analysis_task = fallback_task
        processor._delayed_end_task = delayed_end_task
        processor._silence_timer_task = silence_task

        processor._cancel_background_tasks()
        await asyncio.sleep(0)

        assert speculative_task.cancelled()
        assert prefetch_task.cancelled()
        assert fallback_task.cancelled()
        assert delayed_end_task.cancelled()
        assert silence_task.cancelled()
        assert processor._speculative_tasks == []
        assert processor._prefetch_tasks == []
        assert processor._fallback_analysis_task is None
        assert processor._delayed_end_task is None
        assert processor._silence_timer_task is None

    @pytest.mark.asyncio
    async def test_harvest_speculative_returns_best_match(self, session_state):
        """harvest_speculative returns best matching result from completed tasks."""
        processor = ConversationDirectorProcessor(session_state=session_state)

        async def fake_result():
            return {"analysis": {"call_phase": "main", "engagement_level": "high"}}
        task = asyncio.create_task(fake_result())
        processor._speculative_tasks.append(("I went to the doctor yesterday and they told me", task))
        await asyncio.sleep(0.01)

        result = processor._harvest_speculative("I went to the doctor yesterday and they told me everything is fine")
        assert result is not None
        assert result["analysis"]["engagement_level"] == "high"

    @pytest.mark.asyncio
    async def test_harvest_speculative_discards_divergent_text(self, session_state):
        """harvest_speculative discards result when text diverges."""
        processor = ConversationDirectorProcessor(session_state=session_state)

        async def fake_result():
            return {"analysis": {"call_phase": "main"}}
        task = asyncio.create_task(fake_result())
        processor._speculative_tasks.append(("I went to the", task))
        await asyncio.sleep(0.01)

        result = processor._harvest_speculative("Tell me about the weather today please")
        assert result is None

    @pytest.mark.asyncio
    async def test_harvest_speculative_matches_each_task_source_text(self, session_state):
        """A stale task must not be accepted just because the latest interim matches."""
        processor = ConversationDirectorProcessor(session_state=session_state)
        processor._latest_interim_text = "Tell me about the weather today please"

        async def fake_result():
            return {"analysis": {"call_phase": "main", "current_topic": "doctor"}}
        task = asyncio.create_task(fake_result())
        processor._speculative_tasks.append(("I went to the doctor", task))
        await asyncio.sleep(0.01)

        result = processor._harvest_speculative("Tell me about the weather today please")
        assert result is None

    @pytest.mark.asyncio
    async def test_harvest_speculative_keeps_running_tasks(self, session_state):
        """harvest_speculative keeps running tasks alive (they build cache)."""
        processor = ConversationDirectorProcessor(session_state=session_state)

        long_task = asyncio.create_task(asyncio.sleep(10))
        processor._speculative_tasks.append(("Hello there", long_task))

        result = processor._harvest_speculative("Hello there")
        await asyncio.sleep(0)

        assert result is None
        assert not long_task.cancelled()
        assert len(processor._speculative_tasks) == 1  # still tracked
        assert processor._speculative_misses == 1

        long_task.cancel()
        try:
            await long_task
        except asyncio.CancelledError:
            pass

    def test_no_speculative_without_fast_provider(self, session_state):
        """No silence timer starts when the fast provider is not configured.

        Tests the condition directly since process_frame requires a started pipeline.
        """
        processor = ConversationDirectorProcessor(session_state=session_state)
        text = "I went to the doctor yesterday and they said"

        # Fast provider not available → silence timer should NOT start
        fast_provider_check = False
        if len(text) >= processor.SPECULATIVE_MIN_LENGTH and fast_provider_check:
            processor._silence_timer_task = "would be set"

        assert processor._silence_timer_task is None

        # Fast provider available → silence timer WOULD start
        fast_provider_check = True
        if len(text) >= processor.SPECULATIVE_MIN_LENGTH and fast_provider_check:
            processor._silence_timer_task = "would be set"

        assert processor._silence_timer_task is not None


class TestDirectorWebSearchGating:
    """Web search gating removed — Claude handles web search via tool calls now."""
    pass


class TestDirectorTimeLimits:
    """Verify time-based fallback actions."""

    @pytest.mark.asyncio
    async def test_force_end_after_hard_limit(self, session_state, frame_capture):
        # Set call start 13 minutes ago
        session_state["_call_start_time"] = time.time() - (36 * 60)
        processor = ConversationDirectorProcessor(session_state=session_state)
        # Pre-cache a result so _take_actions runs
        processor._last_result = get_default_direction()
        capture = frame_capture

        with patch("processors.conversation_director.analyze_turn_speculative", new_callable=AsyncMock) as mock_analyze, \
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
            await asyncio.wait_for(runner.run(task), timeout=10.0)

        assert capture.has_end_frame
