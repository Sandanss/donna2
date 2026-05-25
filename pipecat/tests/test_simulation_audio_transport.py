"""Unit tests for AudioCallerTransport frame-push mechanics.

These tests exercise the audio-frame slicing, silence appending, and
speaking-frame emission with a STUB TTS provider so no real ElevenLabs or
Cartesia calls happen in CI. End-to-end audio simulation (text → real TTS →
real STT → assertion) is planned separately and is not registered as a pytest
marker yet.
"""

from __future__ import annotations

import asyncio

import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)

from tests.simulation.transport import (
    AudioCallerTransport,
    ResponseCollector,
    silence_tts_provider,
)


class _StubTask:
    """Stub PipelineTask that just captures every queued frame.

    Pipecat 0.0.101's PipelineTask.queue_frame is async, so this stub
    mirrors that signature; AudioCallerTransport awaits it.
    """

    def __init__(self):
        self.frames: list = []

    async def queue_frame(self, frame) -> None:
        self.frames.append(frame)


def _make_transport(
    *,
    tts_duration_seconds: float = 0.3,
    sample_rate: int = 16000,
    chunk_duration_ms: int = 100,
    trailing_silence_ms: int = 200,
    realtime: bool = False,
    emit_speaking_frames: bool = True,
):
    task = _StubTask()
    collector = ResponseCollector()
    transport = AudioCallerTransport(
        pipeline_task=task,
        response_collector=collector,
        tts_provider=silence_tts_provider(
            duration_seconds=tts_duration_seconds, sample_rate=sample_rate
        ),
        sample_rate=sample_rate,
        chunk_duration_ms=chunk_duration_ms,
        trailing_silence_ms=trailing_silence_ms,
        realtime=realtime,
        emit_speaking_frames=emit_speaking_frames,
    )
    return transport, task


@pytest.mark.asyncio
async def test_send_utterance_emits_speaking_frames_and_audio_chunks():
    transport, task = _make_transport(
        tts_duration_seconds=0.3,
        chunk_duration_ms=100,
        trailing_silence_ms=200,
    )

    await transport.send_utterance("hello donna")

    # First frame: UserStartedSpeakingFrame; last: UserStoppedSpeakingFrame.
    assert isinstance(task.frames[0], UserStartedSpeakingFrame)
    assert isinstance(task.frames[-1], UserStoppedSpeakingFrame)

    audio_frames = [f for f in task.frames if isinstance(f, InputAudioRawFrame)]
    # 300ms TTS payload + 200ms silence = 500ms total, at 100ms chunks = 5 frames.
    assert len(audio_frames) == 5
    assert transport.audio_frames_pushed == 5


@pytest.mark.asyncio
async def test_send_utterance_chunk_byte_counts_match_sample_rate():
    """Each non-tail chunk should be exactly chunk_duration_ms worth of PCM
    at the configured sample rate (mono, 16-bit). 100ms @ 16kHz, 16-bit =
    16000 * 0.1 * 2 = 3200 bytes per chunk."""
    transport, task = _make_transport(
        tts_duration_seconds=0.2,  # 2 chunks at 100ms each
        sample_rate=16000,
        chunk_duration_ms=100,
        trailing_silence_ms=0,
    )

    await transport.send_utterance("hi")

    audio_frames = [f for f in task.frames if isinstance(f, InputAudioRawFrame)]
    for frame in audio_frames:
        assert frame.sample_rate == 16000
        assert frame.num_channels == 1
        assert len(frame.audio) == 3200


@pytest.mark.asyncio
async def test_trailing_silence_is_appended_after_tts_payload():
    transport, task = _make_transport(
        tts_duration_seconds=0.1,
        chunk_duration_ms=100,
        trailing_silence_ms=300,  # 3 chunks of silence
    )

    await transport.send_utterance("ok")

    audio_frames = [f for f in task.frames if isinstance(f, InputAudioRawFrame)]
    # 100ms TTS + 300ms silence = 400ms total = 4 chunks.
    assert len(audio_frames) == 4
    # Last frame should be all-zero silence.
    assert audio_frames[-1].audio == b"\x00\x00" * (16000 // 10)


@pytest.mark.asyncio
async def test_emit_speaking_frames_can_be_disabled():
    transport, task = _make_transport(
        emit_speaking_frames=False,
        tts_duration_seconds=0.1,
        trailing_silence_ms=0,
    )

    await transport.send_utterance("hello")

    for frame in task.frames:
        assert not isinstance(frame, UserStartedSpeakingFrame)
        assert not isinstance(frame, UserStoppedSpeakingFrame)


@pytest.mark.asyncio
async def test_mark_injection_time_runs_after_audio_and_silence():
    transport, task = _make_transport(
        tts_duration_seconds=0.1,
        trailing_silence_ms=100,
    )

    # Before send: collector has no injection mark.
    before = transport.collector._injection_time  # noqa: SLF001
    assert before is None

    await transport.send_utterance("hi")

    after = transport.collector._injection_time  # noqa: SLF001
    assert after is not None


@pytest.mark.asyncio
async def test_non_realtime_mode_does_not_sleep_between_chunks():
    """``realtime=False`` makes the transport queue every frame immediately
    so unit tests run fast and so a stampede simulation can push 600 calls
    of audio in seconds rather than minutes."""
    transport, _task = _make_transport(
        tts_duration_seconds=0.5,
        trailing_silence_ms=500,
        realtime=False,
    )

    started = asyncio.get_event_loop().time()
    await transport.send_utterance("hello donna")
    elapsed = asyncio.get_event_loop().time() - started

    # 1 second of audio at 100ms chunks would take 1.0s in realtime mode;
    # non-realtime should finish in well under that.
    assert elapsed < 0.2, f"non-realtime audio push took too long: {elapsed:.3f}s"


@pytest.mark.asyncio
async def test_invalid_constructor_args_raise():
    task = _StubTask()
    collector = ResponseCollector()
    provider = silence_tts_provider()

    with pytest.raises(ValueError):
        AudioCallerTransport(
            pipeline_task=task,
            response_collector=collector,
            tts_provider=provider,
            chunk_duration_ms=0,
        )

    with pytest.raises(ValueError):
        AudioCallerTransport(
            pipeline_task=task,
            response_collector=collector,
            tts_provider=provider,
            sample_rate=0,
        )


@pytest.mark.asyncio
async def test_audio_transport_propagates_tts_errors():
    """A failure in the TTS provider should bubble up so the caller knows
    the simulated call setup failed — it must not silently swallow."""

    async def failing_provider(_text: str) -> bytes:
        raise RuntimeError("tts_provider_unreachable")

    task = _StubTask()
    transport = AudioCallerTransport(
        pipeline_task=task,
        response_collector=ResponseCollector(),
        tts_provider=failing_provider,
        realtime=False,
        trailing_silence_ms=0,
    )

    with pytest.raises(RuntimeError, match="tts_provider_unreachable"):
        await transport.send_utterance("hi")

    # UserStartedSpeakingFrame already fired before TTS failed — that's OK,
    # the test is just confirming the error propagated.
    assert isinstance(task.frames[0], UserStartedSpeakingFrame)


@pytest.mark.asyncio
async def test_audio_transport_satisfies_caller_transport_protocol():
    """The audio transport must remain swap-compatible with the text
    transport so scenario tests can pick either via a runtime flag."""
    from tests.simulation.transport import CallerTransport

    transport = AudioCallerTransport(
        pipeline_task=_StubTask(),
        response_collector=ResponseCollector(),
        tts_provider=silence_tts_provider(),
        realtime=False,
        trailing_silence_ms=0,
    )

    assert isinstance(transport, CallerTransport)
