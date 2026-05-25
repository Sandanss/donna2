"""Unit tests for the simulation transport layer.

Tests ResponseCollector (FrameProcessor that captures pipeline output),
TextCallerTransport (speech timing simulation), and the CallerEvent /
CallResult data classes.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    FunctionCallFromLLM,
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    TextFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from tests.simulation.transport import (
    AudioCallerTransport,
    CallerEvent,
    CallerTransport,
    CallResult,
    ResponseCollector,
    TextCallerTransport,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _push_frames(collector: ResponseCollector, frames: list[Frame]) -> None:
    """Push a sequence of frames through the collector."""
    for frame in frames:
        await collector.process_frame(frame, FrameDirection.DOWNSTREAM)


# ---------------------------------------------------------------------------
# CallerEvent dataclass tests
# ---------------------------------------------------------------------------


class TestCallerEvent:
    def test_response_event(self):
        evt = CallerEvent(type="response", text="Hello Margaret!", latency_ms=42.5)
        assert evt.type == "response"
        assert evt.text == "Hello Margaret!"
        assert evt.latency_ms == 42.5
        assert evt.tool_name is None
        assert evt.tool_args is None

    def test_tool_call_event(self):
        evt = CallerEvent(
            type="tool_call",
            tool_name="web_search",
            tool_args={"query": "weather today"},
        )
        assert evt.type == "tool_call"
        assert evt.tool_name == "web_search"
        assert evt.tool_args == {"query": "weather today"}
        assert evt.text is None

    def test_end_event(self):
        evt = CallerEvent(type="end")
        assert evt.type == "end"
        assert evt.text is None

    def test_filler_event(self):
        evt = CallerEvent(type="filler", text="Let me check on that for you")
        assert evt.type == "filler"
        assert evt.text == "Let me check on that for you"


# ---------------------------------------------------------------------------
# CallResult dataclass tests
# ---------------------------------------------------------------------------


class TestCallResult:
    def test_default_values(self):
        result = CallResult()
        assert result.turns == []
        assert result.tool_calls_made == []
        assert result.tool_call_details == []
        assert result.injected_memories == []
        assert result.web_search_results == []
        assert result.fillers == []
        assert result.total_duration_ms == 0.0
        assert result.end_reason == "unknown"
        assert result.post_call_completed is False

    def test_populated_result(self):
        result = CallResult(
            turns=[{"caller": "Hello", "donna": "Hi!", "latency_ms": 100}],
            tool_calls_made=["web_search"],
            tool_call_details=[{"name": "web_search", "args": {"query": "news"}}],
            fillers=["Let me look that up"],
            total_duration_ms=45000,
            end_reason="goodbye",
            post_call_completed=True,
        )
        assert len(result.turns) == 1
        assert result.tool_calls_made == ["web_search"]
        assert result.end_reason == "goodbye"
        assert result.post_call_completed is True


# ---------------------------------------------------------------------------
# ResponseCollector — text assembly
# ---------------------------------------------------------------------------


class TestResponseCollectorText:
    """Tests that ResponseCollector assembles TextFrame chunks correctly."""

    @pytest.mark.asyncio
    async def test_assembles_text_chunks(self):
        """Streamed TextFrame chunks between start/end markers are joined."""
        collector = ResponseCollector()

        # Simulate a streamed LLM response: start -> chunks -> end
        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            TextFrame(text="Good "),
            TextFrame(text="morning, "),
            TextFrame(text="Margaret!"),
            LLMFullResponseEndFrame(),
        ])

        # The event should be ready immediately after EndFrame
        event = await collector.wait_for_response(timeout=1.0)
        assert event.type == "response"
        assert event.text == "Good morning, Margaret!"

    @pytest.mark.asyncio
    async def test_empty_response_does_not_fire(self):
        """A start/end pair with no text chunks does not produce an event."""
        collector = ResponseCollector()

        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            LLMFullResponseEndFrame(),
        ])

        # The response_ready event should NOT have been set
        with pytest.raises(asyncio.TimeoutError):
            await collector.wait_for_response(timeout=0.1)

    @pytest.mark.asyncio
    async def test_multiple_responses(self):
        """Multiple response sequences are each captured independently."""
        collector = ResponseCollector()

        # First response
        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            TextFrame(text="First response"),
            LLMFullResponseEndFrame(),
        ])
        event1 = await collector.wait_for_response(timeout=1.0)
        assert event1.text == "First response"

        # Second response
        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            TextFrame(text="Second response"),
            LLMFullResponseEndFrame(),
        ])
        event2 = await collector.wait_for_response(timeout=1.0)
        assert event2.text == "Second response"

    @pytest.mark.asyncio
    async def test_text_outside_response_pair_is_ignored(self):
        """TextFrames not bracketed by start/end are not collected."""
        collector = ResponseCollector()

        # Stray TextFrame before any response sequence
        await _push_frames(collector, [
            TextFrame(text="stray text"),
            LLMFullResponseStartFrame(),
            TextFrame(text="real response"),
            LLMFullResponseEndFrame(),
        ])

        event = await collector.wait_for_response(timeout=1.0)
        assert event.text == "real response"


# ---------------------------------------------------------------------------
# ResponseCollector — end detection
# ---------------------------------------------------------------------------


class TestResponseCollectorEnd:
    """Tests that ResponseCollector detects EndFrame correctly."""

    @pytest.mark.asyncio
    async def test_end_frame_sets_ended(self):
        """EndFrame sets the ended property to True."""
        collector = ResponseCollector()
        assert collector.ended is False

        await _push_frames(collector, [EndFrame()])
        assert collector.ended is True

    @pytest.mark.asyncio
    async def test_wait_for_response_returns_end_event(self):
        """wait_for_response returns type='end' when EndFrame arrives."""
        collector = ResponseCollector()

        await _push_frames(collector, [EndFrame()])

        event = await collector.wait_for_response(timeout=1.0)
        assert event.type == "end"
        assert event.text is None


# ---------------------------------------------------------------------------
# ResponseCollector — filler tracking
# ---------------------------------------------------------------------------


class TestResponseCollectorFillers:
    """Tests that ResponseCollector captures TTSSpeakFrame fillers."""

    @pytest.mark.asyncio
    async def test_tracks_single_filler(self):
        """A single TTSSpeakFrame is captured in the fillers list."""
        collector = ResponseCollector()

        await _push_frames(collector, [
            TTSSpeakFrame(text="Let me check on that for you"),
        ])

        assert collector.fillers == ["Let me check on that for you"]

    @pytest.mark.asyncio
    async def test_tracks_multiple_fillers(self):
        """Multiple TTSSpeakFrame instances are captured in order."""
        collector = ResponseCollector()

        await _push_frames(collector, [
            TTSSpeakFrame(text="Let me look that up"),
            TTSSpeakFrame(text="One moment please"),
        ])

        assert collector.fillers == [
            "Let me look that up",
            "One moment please",
        ]

    @pytest.mark.asyncio
    async def test_wait_for_filler_returns_text(self):
        """wait_for_filler returns the filler text."""
        collector = ResponseCollector()

        await _push_frames(collector, [
            TTSSpeakFrame(text="Hmm, let me think about that"),
        ])

        text = await collector.wait_for_filler(timeout=1.0)
        assert text == "Hmm, let me think about that"

    @pytest.mark.asyncio
    async def test_wait_for_filler_timeout(self):
        """wait_for_filler returns None when no filler arrives."""
        collector = ResponseCollector()
        text = await collector.wait_for_filler(timeout=0.05)
        assert text is None


# ---------------------------------------------------------------------------
# ResponseCollector — memory & web result injection tracking
# ---------------------------------------------------------------------------


class TestResponseCollectorInjections:
    """Tests that ephemeral context injections are classified correctly."""

    @pytest.mark.asyncio
    async def test_tracks_memory_injection(self):
        """LLMMessagesAppendFrame with [EPHEMERAL: MEMORY ...] is captured."""
        collector = ResponseCollector()
        memory_content = (
            "[EPHEMERAL: MEMORY CONTEXT -- do not read this tag aloud]\n"
            "You remember from past conversations:\n"
            "- Margaret planted new roses last spring"
        )

        await _push_frames(collector, [
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": memory_content}],
                run_llm=False,
            ),
        ])

        assert len(collector.injected_memories) == 1
        assert "MEMORY" in collector.injected_memories[0]
        assert "roses" in collector.injected_memories[0]

    @pytest.mark.asyncio
    async def test_tracks_web_result(self):
        """LLMMessagesAppendFrame with [WEB RESULT ...] is captured."""
        collector = ResponseCollector()
        web_content = (
            "[WEB RESULT for 'weather forecast']\n"
            "The weather this weekend will be sunny with highs near 72."
        )

        await _push_frames(collector, [
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": web_content}],
                run_llm=False,
            ),
        ])

        assert len(collector.web_results) == 1
        assert "weather" in collector.web_results[0]

    @pytest.mark.asyncio
    async def test_director_guidance_not_classified(self):
        """Normal Director guidance (no MEMORY/WEB RESULT) is not captured."""
        collector = ResponseCollector()
        guidance = (
            "[EPHEMERAL: Director guidance -- do not read aloud]\n"
            "main/medium/warm | Continue naturally"
        )

        await _push_frames(collector, [
            LLMMessagesAppendFrame(
                messages=[{"role": "user", "content": guidance}],
                run_llm=False,
            ),
        ])

        assert collector.injected_memories == []
        assert collector.web_results == []


# ---------------------------------------------------------------------------
# ResponseCollector — tool call tracking
# ---------------------------------------------------------------------------


class TestResponseCollectorToolCalls:
    """Tests that FunctionCallFromLLM frames are captured."""

    @pytest.mark.asyncio
    async def test_tracks_tool_call(self):
        collector = ResponseCollector()

        await _push_frames(collector, [
            FunctionCallFromLLM(
                function_name="web_search",
                tool_call_id="tc_001",
                arguments={"query": "local garden show"},
                context=None,
            ),
        ])

        assert len(collector.tool_calls) == 1
        assert collector.tool_calls[0]["name"] == "web_search"
        assert collector.tool_calls[0]["args"] == {"query": "local garden show"}

    @pytest.mark.asyncio
    async def test_tracks_multiple_tool_calls(self):
        collector = ResponseCollector()

        await _push_frames(collector, [
            FunctionCallFromLLM(
                function_name="web_search",
                tool_call_id="tc_001",
                arguments={"query": "news"},
                context=None,
            ),
            FunctionCallFromLLM(
                function_name="mark_reminder_acknowledged",
                tool_call_id="tc_002",
                arguments={"reminder_id": "rem-001"},
                context=None,
            ),
        ])

        assert len(collector.tool_calls) == 2
        assert collector.tool_calls[0]["name"] == "web_search"
        assert collector.tool_calls[1]["name"] == "mark_reminder_acknowledged"


# ---------------------------------------------------------------------------
# ResponseCollector — latency tracking
# ---------------------------------------------------------------------------


class TestResponseCollectorLatency:
    """Tests that injection-to-first-text latency is recorded."""

    @pytest.mark.asyncio
    async def test_latency_recorded(self):
        collector = ResponseCollector()

        collector.mark_injection_time()
        # Small delay to ensure measurable latency
        await asyncio.sleep(0.01)

        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            TextFrame(text="Hello!"),
            LLMFullResponseEndFrame(),
        ])

        event = await collector.wait_for_response(timeout=1.0)
        assert event.latency_ms is not None
        assert event.latency_ms >= 10  # at least 10ms from the sleep

    @pytest.mark.asyncio
    async def test_no_latency_without_injection_mark(self):
        """Without mark_injection_time, latency_ms is None."""
        collector = ResponseCollector()

        await _push_frames(collector, [
            LLMFullResponseStartFrame(),
            TextFrame(text="Hello!"),
            LLMFullResponseEndFrame(),
        ])

        event = await collector.wait_for_response(timeout=1.0)
        assert event.latency_ms is None


# ---------------------------------------------------------------------------
# ResponseCollector — reset
# ---------------------------------------------------------------------------


class TestResponseCollectorReset:
    """Tests that reset() clears all state."""

    @pytest.mark.asyncio
    async def test_reset_clears_state(self):
        collector = ResponseCollector()

        # Populate some state
        await _push_frames(collector, [
            TTSSpeakFrame(text="filler"),
            FunctionCallFromLLM(
                function_name="web_search",
                tool_call_id="tc_001",
                arguments={"query": "test"},
                context=None,
            ),
            LLMFullResponseStartFrame(),
            TextFrame(text="response"),
            LLMFullResponseEndFrame(),
        ])

        # Verify state exists
        assert collector.fillers != []
        assert collector.tool_calls != []

        # Reset
        collector.reset()

        # All state should be cleared
        assert collector.fillers == []
        assert collector.tool_calls == []
        assert collector.injected_memories == []
        assert collector.web_results == []
        assert collector.ended is False
        assert collector.latest_response == ""
        assert collector.latest_latency_ms is None


# ---------------------------------------------------------------------------
# ResponseCollector — frame passthrough
# ---------------------------------------------------------------------------


class TestResponseCollectorPassthrough:
    """Verify that all frames are pushed downstream unchanged."""

    @pytest.mark.asyncio
    async def test_frames_are_forwarded(self):
        """ResponseCollector must push every frame it receives."""
        collector = ResponseCollector()
        forwarded: list[Frame] = []

        # Monkey-patch push_frame to capture what gets forwarded
        async def capture_push(frame, direction):
            forwarded.append(frame)

        collector.push_frame = capture_push

        frames = [
            LLMFullResponseStartFrame(),
            TextFrame(text="Hi"),
            LLMFullResponseEndFrame(),
            TTSSpeakFrame(text="filler"),
            EndFrame(),
        ]
        await _push_frames(collector, frames)

        assert len(forwarded) == len(frames)


# ---------------------------------------------------------------------------
# CallerTransport protocol compliance
# ---------------------------------------------------------------------------


class TestCallerTransportProtocol:
    """Tests that the CallerTransport Protocol is structurally valid."""

    def test_protocol_has_required_methods(self):
        """CallerTransport defines send_utterance, receive_response, collector."""
        assert hasattr(CallerTransport, "send_utterance")
        assert hasattr(CallerTransport, "receive_response")
        assert hasattr(CallerTransport, "collector")

    def test_class_can_implement_protocol(self):
        """A concrete class satisfying the protocol is recognized at runtime."""

        class FakeTransport:
            def __init__(self):
                self._collector = ResponseCollector()

            @property
            def collector(self) -> ResponseCollector:
                return self._collector

            async def send_utterance(self, text: str) -> None:
                pass

            async def receive_response(self, timeout: float = 30.0) -> CallerEvent:
                return CallerEvent(type="end")

        transport = FakeTransport()
        assert isinstance(transport, CallerTransport)


# ---------------------------------------------------------------------------
# TextCallerTransport — speech timing simulation
# ---------------------------------------------------------------------------


def _make_mock_task() -> MagicMock:
    """Create a mock PipelineTask with a recording queue_frame.

    Pipecat 0.0.101's PipelineTask.queue_frame is async, so the mock uses
    AsyncMock to match. Tests that drove the old sync signature continue
    to work because they only inspect task._queued_frames.
    """
    task = MagicMock()
    task._queued_frames: list[Frame] = []

    async def _queue(frame):
        task._queued_frames.append(frame)

    task.queue_frame = AsyncMock(side_effect=_queue)
    return task


class TestTextCallerTransport:
    """Tests for TextCallerTransport speech timing simulation."""

    @pytest.mark.asyncio
    async def test_emits_interims_before_final(self):
        """Multi-word sentence produces InterimTranscriptionFrames before the final."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )

        # 7 words → should produce at least 2 interim chunks + full interim + final
        await transport.send_utterance("I went to the garden this morning")

        frames = task._queued_frames
        assert len(frames) >= 3, f"Expected at least 3 frames, got {len(frames)}"

        # All frames before the last should be InterimTranscriptionFrame
        for f in frames[:-1]:
            assert isinstance(f, InterimTranscriptionFrame), (
                f"Expected InterimTranscriptionFrame, got {type(f).__name__}"
            )

        # Last frame should be the final TranscriptionFrame
        assert isinstance(frames[-1], TranscriptionFrame)
        assert frames[-1].text == "I went to the garden this morning"

    @pytest.mark.asyncio
    async def test_short_utterance_emits_final_only(self):
        """A 1-2 word utterance emits only a final TranscriptionFrame."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )

        await transport.send_utterance("Hello")

        frames = task._queued_frames
        assert len(frames) == 1
        assert isinstance(frames[0], TranscriptionFrame)
        assert frames[0].text == "Hello"

    @pytest.mark.asyncio
    async def test_marks_injection_time(self):
        """send_utterance calls collector.mark_injection_time() before the final frame."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )

        # _injection_time is None before any utterance
        assert collector._injection_time is None

        await transport.send_utterance("How are you doing today")

        # After send_utterance, injection time should be set
        assert collector._injection_time is not None

    @pytest.mark.asyncio
    async def test_implements_caller_transport_protocol(self):
        """TextCallerTransport satisfies the CallerTransport protocol."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )
        assert isinstance(transport, CallerTransport)

    @pytest.mark.asyncio
    async def test_three_word_utterance_no_interims(self):
        """Exactly 3 words (INTERIM_CHUNK_WORDS) should NOT produce interims."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )

        await transport.send_utterance("Good morning dear")

        frames = task._queued_frames
        # 3 words = INTERIM_CHUNK_WORDS, so len(words) is NOT > INTERIM_CHUNK_WORDS
        assert len(frames) == 1
        assert isinstance(frames[0], TranscriptionFrame)

    @pytest.mark.asyncio
    async def test_interim_chunks_build_progressively(self):
        """Interim chunks should build up progressively from the start."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
        )

        # 6 words → 2 interim chunks + 1 full interim + 1 final
        await transport.send_utterance("I really love my rose garden")

        frames = task._queued_frames
        interims = [f for f in frames if isinstance(f, InterimTranscriptionFrame)]
        finals = [f for f in frames if isinstance(f, TranscriptionFrame)]

        assert len(interims) >= 2, f"Expected at least 2 interims, got {len(interims)}"
        assert len(finals) == 1

        # First interim should be the first 3 words
        assert interims[0].text == "I really love"
        # Second interim should be the first 6 words
        assert interims[1].text == "I really love my rose garden"

    @pytest.mark.asyncio
    async def test_user_id_propagated(self):
        """Custom user_id is set on all emitted frames."""
        task = _make_mock_task()
        collector = ResponseCollector()
        transport = TextCallerTransport(
            pipeline_task=task,
            response_collector=collector,
            user_id="senior-margaret-001",
        )

        await transport.send_utterance("Tell me about the weather today please")

        for f in task._queued_frames:
            assert f.user_id == "senior-margaret-001"


# ---------------------------------------------------------------------------
# AudioCallerTransport — constructor sanity checks
# ---------------------------------------------------------------------------
#
# Frame-push mechanics, silence appending, and the realtime-vs-non-realtime
# behaviors are covered by tests/test_simulation_audio_transport.py.


class TestAudioCallerTransport:
    """Construction sanity for the implemented AudioCallerTransport."""

    def test_audio_caller_transport_constructs_with_required_args(self):
        """AudioCallerTransport requires a TTS provider; pure construction
        does not raise once one is supplied."""
        from tests.simulation.transport import silence_tts_provider

        task = _make_mock_task()
        collector = ResponseCollector()

        transport = AudioCallerTransport(
            pipeline_task=task,
            response_collector=collector,
            tts_provider=silence_tts_provider(),
        )
        assert transport.collector is collector
        assert transport.sample_rate == 16000

    def test_audio_caller_transport_requires_tts_provider(self):
        """Omitting tts_provider must raise TypeError (the previous stub
        accepted any kwargs and raised NotImplementedError instead)."""
        from tests.simulation.transport import silence_tts_provider  # noqa: F401

        task = _make_mock_task()
        collector = ResponseCollector()

        with pytest.raises(TypeError):
            AudioCallerTransport(
                pipeline_task=task,
                response_collector=collector,
            )
