"""ResponseCollector + CallerTransport protocol for simulation testing.

ResponseCollector is a FrameProcessor that sits in the Donna pipeline and
captures output frames: streamed text chunks (TextFrame), Director fillers
(TTSSpeakFrame), ephemeral injections (LLMMessagesAppendFrame with
[EPHEMERAL: MEMORY ...] or [WEB RESULT] content), tool calls (FunctionCallFromLLM), and pipeline
termination (EndFrame).

CallerTransport is a Protocol that abstracts how caller utterances are
injected into the pipeline and how responses are received. Text mode is the
default path; AudioCallerTransport exists for frame-push mechanics, while
end-to-end STT/TTS audio simulation still needs CLI wiring.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, runtime_checkable

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    FunctionCallFromLLM,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMMessagesAppendFrame,
    TextFrame,
    TranscriptionFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameProcessor


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class CallerEvent:
    """A single event observed from the pipeline back to the caller.

    Attributes:
        type: One of ``"response"``, ``"filler"``, ``"end"``, ``"tool_call"``.
        text: The assembled text for ``"response"`` and ``"filler"`` events.
        tool_name: Tool/function name for ``"tool_call"`` events.
        tool_args: Tool arguments dict for ``"tool_call"`` events.
        latency_ms: Milliseconds from the last ``mark_injection_time()`` call
            to the first ``TextFrame`` of a ``"response"`` event.
    """

    type: str
    text: str | None = None
    tool_name: str | None = None
    tool_args: dict | None = None
    latency_ms: float | None = None


@dataclass
class CallResult:
    """Aggregate results from a complete simulated call.

    Attributes:
        turns: Chronological list of ``{caller, donna, latency_ms}`` dicts.
        tool_calls_made: Tool names in the order they were invoked.
        tool_call_details: Full ``{name, args}`` dicts for each invocation.
        injected_memories: Content strings of ``[EPHEMERAL: MEMORY ...]``
            messages injected via ``LLMMessagesAppendFrame``.
        web_search_results: Content strings of ``[WEB RESULT]`` messages.
        fillers: Text of ``TTSSpeakFrame`` Director fillers.
        total_duration_ms: Wall-clock duration of the entire call.
        end_reason: Human-readable reason the call ended (e.g. ``"goodbye"``,
            ``"max_turns"``, ``"timeout"``).
        post_call_completed: Whether post-call processing ran to completion.
        post_call_metrics_logged: Whether post-call call_metrics persisted.
        post_call_logged_tools: Tool names written into post-call metrics.
        post_call_context_event_count: Number of encrypted context trace events
            present when post-call metrics persisted.
        post_call_context_trace_encrypted: Whether the metrics write included
            encrypted context trace payload.
        post_call_error_count: Number of post-call error events recorded in
            PHI-safe metrics.
        conversation_id: DB conversation row created for the simulated call.
        initial_donna_text: Donna's opening response before the first caller turn.
    """

    turns: list[dict] = field(default_factory=list)
    tool_calls_made: list[str] = field(default_factory=list)
    tool_call_details: list[dict] = field(default_factory=list)
    injected_memories: list[str] = field(default_factory=list)
    web_search_results: list[str] = field(default_factory=list)
    fillers: list[str] = field(default_factory=list)
    total_duration_ms: float = 0.0
    end_reason: str = "unknown"
    post_call_completed: bool = False
    post_call_metrics_logged: bool = False
    post_call_logged_tools: list[str] = field(default_factory=list)
    post_call_context_event_count: int = 0
    post_call_context_trace_encrypted: bool = False
    post_call_error_count: int = 0
    conversation_id: str | None = None
    initial_donna_text: str | None = None


# ---------------------------------------------------------------------------
# ResponseCollector — FrameProcessor that captures pipeline output
# ---------------------------------------------------------------------------


# Marker substrings used by the Director when injecting ephemeral context.
_MEMORY_MARKER = "MEMORY"
_WEB_RESULT_MARKER = "[WEB RESULT"


class ResponseCollector(FrameProcessor):
    """Captures Donna's pipeline output for simulation test assertions.

    Place this processor *after* the LLM (and after GuidanceStripper) so that
    it sees the cleaned text that would normally go to TTS.

    Tracking:
    - **Text responses**: ``TextFrame`` chunks between
      ``LLMFullResponseStartFrame`` / ``LLMFullResponseEndFrame`` are
      assembled into complete response strings.
    - **Fillers**: ``TTSSpeakFrame`` text (Director-generated fillers like
      "Let me look that up for you").
    - **Memory injections**: ``LLMMessagesAppendFrame`` messages whose
      content contains ``[EPHEMERAL: MEMORY``.
    - **Web search results**: ``LLMMessagesAppendFrame`` messages whose
      content contains ``[WEB RESULT``.
    - **Tool calls**: ``FunctionCallFromLLM`` frames.
    - **Pipeline end**: ``EndFrame``.
    - **Response latency**: Time from ``mark_injection_time()`` to the first
      ``TextFrame`` of the subsequent response.

    Concurrency: all public state is guarded by ``asyncio.Event`` objects so
    that callers can ``await wait_for_response(timeout)`` without polling.
    """

    def __init__(self, **kwargs):
        super().__init__(**kwargs)

        # -- Text assembly --
        self._collecting: bool = False
        self._current_chunks: list[str] = []
        self._latest_response: str = ""
        self._response_ready = asyncio.Event()

        # -- Latency tracking --
        self._injection_time: float | None = None
        self._first_text_seen: bool = False
        self._latest_latency_ms: float | None = None

        # -- Filler tracking --
        self._fillers: list[str] = []
        self._filler_ready = asyncio.Event()

        # -- Memory / web result tracking --
        self._injected_memories: list[str] = []
        self._web_results: list[str] = []

        # -- Tool call tracking --
        self._tool_calls: list[dict] = []

        # -- End tracking --
        self._ended: bool = False
        self._end_event = asyncio.Event()

    # ------------------------------------------------------------------
    # FrameProcessor interface
    # ------------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._collecting = True
            self._current_chunks = []
            self._first_text_seen = False

        elif isinstance(frame, TextFrame):
            if self._collecting:
                self._current_chunks.append(frame.text)
                # Record latency on the first text chunk of a response.
                if not self._first_text_seen and self._injection_time is not None:
                    self._latest_latency_ms = (
                        (time.monotonic() - self._injection_time) * 1000
                    )
                    self._first_text_seen = True

        elif isinstance(frame, LLMFullResponseEndFrame):
            if self._collecting:
                self._latest_response = "".join(self._current_chunks).strip()
                self._collecting = False
                if self._latest_response:
                    self._response_ready.set()

        elif isinstance(frame, TTSSpeakFrame):
            self._fillers.append(frame.text)
            self._filler_ready.set()

        elif isinstance(frame, LLMMessagesAppendFrame):
            self._classify_injected_messages(frame.messages)

        elif isinstance(frame, FunctionCallFromLLM):
            self._tool_calls.append(
                {"name": frame.function_name, "args": dict(frame.arguments)}
            )

        elif isinstance(frame, EndFrame):
            self._ended = True
            self._end_event.set()
            # Unblock anyone waiting for a response — they'll see ended=True.
            self._response_ready.set()

        await self.push_frame(frame, direction)

    # ------------------------------------------------------------------
    # Injection helpers
    # ------------------------------------------------------------------

    def _classify_injected_messages(self, messages: list[dict]) -> None:
        """Sort LLMMessagesAppendFrame messages into memories vs web results."""
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, list):
                # Multi-block content (Anthropic format)
                for block in content:
                    if isinstance(block, dict):
                        self._classify_text(block.get("text", ""))
            elif isinstance(content, str):
                self._classify_text(content)

    def _classify_text(self, text: str) -> None:
        if _MEMORY_MARKER in text and "[EPHEMERAL" in text:
            self._injected_memories.append(text)
        elif _WEB_RESULT_MARKER in text:
            self._web_results.append(text)

    # ------------------------------------------------------------------
    # Public API — called by CallerTransport / test code
    # ------------------------------------------------------------------

    def mark_injection_time(self) -> None:
        """Record the moment a ``TranscriptionFrame`` is injected.

        Call this from the transport right before pushing the user's speech
        into the pipeline.  The next response's ``latency_ms`` will be
        computed relative to this timestamp.
        """
        self._injection_time = time.monotonic()
        self._first_text_seen = False
        self._latest_latency_ms = None

    async def wait_for_response(self, timeout: float = 30.0) -> CallerEvent:
        """Block until a full LLM response is assembled or the pipeline ends.

        A response is considered complete when ``LLMFullResponseEndFrame``
        arrives (Pipecat guarantees a matched start/end pair per LLM call).

        If a response (or end) is already pending from a prior frame push,
        it is returned immediately without blocking.

        Returns:
            A ``CallerEvent`` with ``type="response"`` or ``type="end"``.

        Raises:
            asyncio.TimeoutError: if no response within *timeout* seconds.
        """
        if not self._response_ready.is_set():
            await asyncio.wait_for(self._response_ready.wait(), timeout=timeout)

        # Consume the signal so the next call blocks until a new response.
        self._response_ready.clear()

        if self._ended:
            return CallerEvent(type="end")

        return CallerEvent(
            type="response",
            text=self._latest_response,
            latency_ms=self._latest_latency_ms,
        )

    async def wait_for_filler(self, timeout: float = 5.0) -> str | None:
        """Wait for the next ``TTSSpeakFrame`` filler.

        If a filler is already pending from a prior frame push, it is
        returned immediately without blocking.

        Returns:
            The filler text, or ``None`` if *timeout* elapses first.
        """
        if not self._filler_ready.is_set():
            try:
                await asyncio.wait_for(self._filler_ready.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                return None

        # Consume the signal so the next call blocks until a new filler.
        self._filler_ready.clear()
        return self._fillers[-1] if self._fillers else None

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def tool_calls(self) -> list[dict]:
        """All tool calls observed so far: ``[{name, args}, ...]``."""
        return list(self._tool_calls)

    @property
    def fillers(self) -> list[str]:
        """All filler texts from ``TTSSpeakFrame`` observed so far."""
        return list(self._fillers)

    @property
    def injected_memories(self) -> list[str]:
        """All ``[EPHEMERAL: MEMORY ...]`` messages observed so far."""
        return list(self._injected_memories)

    @property
    def web_results(self) -> list[str]:
        """All ``[WEB RESULT ...]`` messages observed so far."""
        return list(self._web_results)

    @property
    def ended(self) -> bool:
        """Whether an ``EndFrame`` has been observed."""
        return self._ended

    @property
    def latest_response(self) -> str:
        """The most recently assembled full text response."""
        return self._latest_response

    @property
    def latest_latency_ms(self) -> float | None:
        """Latency of the most recent response, or ``None``."""
        return self._latest_latency_ms

    # ------------------------------------------------------------------
    # Reset
    # ------------------------------------------------------------------

    def reset(self) -> None:
        """Clear all accumulated state for a new turn.

        Call between turns if you want per-turn isolation in the
        ``CallResult.turns`` list.
        """
        self._collecting = False
        self._current_chunks = []
        self._latest_response = ""
        self._response_ready.clear()
        self._injection_time = None
        self._first_text_seen = False
        self._latest_latency_ms = None
        self._fillers.clear()
        self._filler_ready.clear()
        self._injected_memories.clear()
        self._web_results.clear()
        self._tool_calls.clear()
        self._ended = False
        self._end_event.clear()


# ---------------------------------------------------------------------------
# TextCallerTransport — text-only caller with realistic speech timing
# ---------------------------------------------------------------------------


class TextCallerTransport:
    """Simulates a caller by injecting transcription frames with realistic timing.

    Produces progressive ``InterimTranscriptionFrame`` chunks (3 words at a
    time with 150ms gaps), then a silence gap (300ms — above the Director's
    250ms threshold to trigger speculative analysis), marks injection time on
    the ``ResponseCollector``, and finally emits the full
    ``TranscriptionFrame``.

    This timing pattern causes the Director's continuous speculative analysis,
    silence detection, and memory prefetch to fire naturally — exactly as they
    would during a real phone call with Deepgram STT.
    """

    INTERIM_CHUNK_WORDS: int = 3
    INTERIM_GAP_MS: int = 150
    POST_INTERIM_SILENCE_MS: int = 300

    def __init__(
        self,
        pipeline_task: PipelineTask,
        response_collector: ResponseCollector,
        user_id: str = "senior-test-001",
    ):
        self._task = pipeline_task
        self._collector = response_collector
        self._user_id = user_id

    @property
    def collector(self) -> ResponseCollector:
        """The ``ResponseCollector`` wired into the pipeline."""
        return self._collector

    async def send_utterance(self, text: str) -> None:
        """Inject a caller utterance with progressive interims and silence gap.

        1. Emit progressive ``InterimTranscriptionFrame`` chunks (3 words at a
           time, 150ms gap between each).
        2. If the text was long enough for multiple interims, emit a final
           interim with the full text.
        3. Wait 300ms (silence gap — exceeds Director's 250ms threshold).
        4. Call ``collector.mark_injection_time()``.
        5. Emit the final ``TranscriptionFrame``.
        """
        words = text.split()

        # Step 1: Emit progressive interims (3 words at a time)
        if len(words) > self.INTERIM_CHUNK_WORDS:
            num_chunks = (len(words) + self.INTERIM_CHUNK_WORDS - 1) // self.INTERIM_CHUNK_WORDS
            last_partial = ""
            for i in range(num_chunks):
                start = 0
                end = min((i + 1) * self.INTERIM_CHUNK_WORDS, len(words))
                last_partial = " ".join(words[start:end])
                frame = InterimTranscriptionFrame(
                    text=last_partial,
                    user_id=self._user_id,
                    timestamp="",
                    language="en",
                )
                await self._task.queue_frame(frame)
                await asyncio.sleep(self.INTERIM_GAP_MS / 1000.0)

            # Step 2: Emit full text as final interim if last chunk was a subset
            if last_partial != text:
                full_interim = InterimTranscriptionFrame(
                    text=text,
                    user_id=self._user_id,
                    timestamp="",
                    language="en",
                )
                await self._task.queue_frame(full_interim)
                await asyncio.sleep(self.INTERIM_GAP_MS / 1000.0)

        # Step 3: Silence gap (exceeds Director's 250ms threshold)
        await asyncio.sleep(self.POST_INTERIM_SILENCE_MS / 1000.0)

        # Step 4: Mark injection time for latency measurement
        self._collector.mark_injection_time()

        # Step 5: Emit final TranscriptionFrame
        final = TranscriptionFrame(
            text=text,
            user_id=self._user_id,
            timestamp="",
            language="en",
        )
        await self._task.queue_frame(final)

    async def receive_response(self, timeout: float = 60.0) -> CallerEvent:
        """Wait for and return the next pipeline response event.

        Delegates to the ``ResponseCollector.wait_for_response()`` method.
        """
        return await self._collector.wait_for_response(timeout)


# ---------------------------------------------------------------------------
# CallerTransport — protocol for Phase 1 (text) and Phase 2 (audio)
# ---------------------------------------------------------------------------


@runtime_checkable
class CallerTransport(Protocol):
    """Interface for injecting caller speech and receiving pipeline output.

    Phase 1 (``TextCallerTransport``) injects ``TranscriptionFrame`` text
    directly.  Phase 2 (``AudioCallerTransport``) will synthesise audio
    and inject audio frames, exercising the full STT path.

    Implementations must hold a reference to a ``ResponseCollector`` so
    that higher-level orchestration (``CallSimRunner``) can inspect
    accumulated tool calls, fillers, memories, etc.
    """

    @property
    def collector(self) -> ResponseCollector:
        """The ``ResponseCollector`` wired into the pipeline."""
        ...

    async def send_utterance(self, text: str) -> None:
        """Inject a caller utterance into the pipeline.

        For text transports this pushes a ``TranscriptionFrame``.  For
        audio transports this will synthesise speech and push audio frames.
        """
        ...

    async def receive_response(self, timeout: float = 30.0) -> CallerEvent:
        """Wait for and return the next pipeline response event."""
        ...


# ---------------------------------------------------------------------------
# AudioCallerTransport — audio-loop caller transport
# ---------------------------------------------------------------------------


# A TTS provider is an async callable that turns text into raw PCM bytes
# at a known sample rate (16-bit signed little-endian, mono). Built-in
# providers are below; callers can also pass a custom provider for tests.
TtsProvider = Callable[[str], Awaitable[bytes]]


def silence_tts_provider(
    *,
    duration_seconds: float = 1.0,
    sample_rate: int = 16000,
) -> TtsProvider:
    """Return a TTS provider that produces silence regardless of input.

    Useful for unit-testing the audio-frame-push mechanics of
    AudioCallerTransport without making real TTS API calls. The downstream
    STT will not transcribe silence into anything meaningful, so this stub
    is only suitable for asserting that the transport produces the right
    *frame shapes*, not that the pipeline transcribes the right *text*.
    """
    # 16-bit signed PCM = 2 bytes per sample.
    silence = b"\x00\x00" * int(sample_rate * duration_seconds)

    async def _provider(_text: str) -> bytes:
        return silence

    return _provider


def elevenlabs_tts_provider(
    *,
    api_key: str,
    voice_id: str,
    model: str = "eleven_flash_v2_5",
    sample_rate: int = 16000,
    timeout_seconds: float = 30.0,
) -> TtsProvider:
    """Return a TTS provider backed by ElevenLabs streaming TTS.

    Requires a valid API key with quota; each call costs real money. Gate
    callers behind a pytest mark such as ``audio_simulation`` so unit tests
    don't burn quota.

    Output is PCM at ``sample_rate`` Hz, 16-bit signed mono.
    """
    import aiohttp

    output_format = f"pcm_{sample_rate}"
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"

    async def _provider(text: str) -> bytes:
        headers = {
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/pcm",
        }
        payload = {"text": text, "model_id": model, "output_format": output_format}
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=timeout_seconds),
            ) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"elevenlabs_http_{resp.status}")
                return await resp.read()

    return _provider


def cartesia_tts_provider(
    *,
    api_key: str,
    voice_id: str,
    model: str = "sonic-3",
    sample_rate: int = 16000,
    timeout_seconds: float = 30.0,
) -> TtsProvider:
    """Return a TTS provider backed by Cartesia ``/tts/bytes``."""
    import aiohttp

    url = "https://api.cartesia.ai/tts/bytes"

    async def _provider(text: str) -> bytes:
        headers = {
            "Cartesia-Version": "2024-06-10",
            "X-API-Key": api_key,
            "Content-Type": "application/json",
        }
        payload = {
            "model_id": model,
            "voice": {"mode": "id", "id": voice_id},
            "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": sample_rate},
            "transcript": text,
        }
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=timeout_seconds),
            ) as resp:
                if resp.status >= 400:
                    raise RuntimeError(f"cartesia_http_{resp.status}")
                return await resp.read()

    return _provider


class AudioCallerTransport:
    """Audio-loop caller transport — text → real TTS → audio frames → real STT.

    Replaces ``TextCallerTransport`` for tests that need to exercise the full
    audio path (STT misrecognition, codec drift, sample-rate mismatches).
    Use the same ``ResponseCollector``-based ``receive_response`` API as the
    text transport so existing scenario assertions work unchanged.

    Pipeline requirements:
    - The pipeline must include a *real* STT service (e.g. ``DeepgramSTTService``)
      between the input transport and the rest of the pipeline. The default
      ``build_live_sim_pipeline`` SKIPS real STT — callers using this transport
      need an alternate pipeline build that wires real STT in.
    - The pipeline's input transport must accept ``InputAudioRawFrame``.
      ``TestInputTransport`` from ``tests/mocks/mock_transport.py`` does.

    Lifecycle of one ``send_utterance(text)``:
      1. Emit ``UserStartedSpeakingFrame`` so VAD-aware processors see speech
         onset.
      2. Call ``tts_provider(text)`` to get PCM bytes at the configured
         sample rate.
      3. Slice the bytes into ``chunk_duration_ms`` chunks and push each as
         an ``InputAudioRawFrame``, sleeping the chunk duration between
         frames to mimic real-time audio.
      4. Append ``trailing_silence_ms`` of zero PCM so VAD detects end of
         speech (Pipecat Silero VAD ``stop_secs=1.2`` by default — the
         caller can tune ``trailing_silence_ms`` per pipeline).
      5. Emit ``UserStoppedSpeakingFrame``.
      6. Mark the injection time on the ``ResponseCollector`` so latency
         measurement starts from the end of caller speech, matching what
         a real phone call would measure.

    Cost: ~$0.005 per turn for ElevenLabs at the cheapest tier. A 10-turn
    simulated call ≈ $0.05. Compare with ~$0.001/turn for ``TextCallerTransport``.
    Use TextCallerTransport for breadth, AudioCallerTransport for audio-bug
    regression tests.
    """

    DEFAULT_CHUNK_DURATION_MS: int = 100
    DEFAULT_TRAILING_SILENCE_MS: int = 1500
    DEFAULT_SAMPLE_RATE: int = 16000

    def __init__(
        self,
        pipeline_task: PipelineTask,
        response_collector: ResponseCollector,
        *,
        tts_provider: TtsProvider,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        chunk_duration_ms: int = DEFAULT_CHUNK_DURATION_MS,
        trailing_silence_ms: int = DEFAULT_TRAILING_SILENCE_MS,
        emit_speaking_frames: bool = True,
        realtime: bool = True,
        user_id: str = "senior-test-001",
    ):
        if chunk_duration_ms <= 0:
            raise ValueError("chunk_duration_ms must be > 0")
        if sample_rate <= 0:
            raise ValueError("sample_rate must be > 0")
        self._task = pipeline_task
        self._collector = response_collector
        self._tts_provider = tts_provider
        self._sample_rate = sample_rate
        self._chunk_duration_ms = chunk_duration_ms
        self._trailing_silence_ms = trailing_silence_ms
        self._emit_speaking_frames = emit_speaking_frames
        self._realtime = realtime
        self._user_id = user_id
        # 16-bit signed PCM = 2 bytes per sample, mono.
        self._bytes_per_chunk = int(self._sample_rate * (self._chunk_duration_ms / 1000.0)) * 2
        # Track frames pushed since the last reset for unit-test assertions.
        self.audio_frames_pushed: int = 0
        self.bytes_pushed: int = 0

    @property
    def collector(self) -> ResponseCollector:
        return self._collector

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

    @property
    def chunk_duration_ms(self) -> int:
        return self._chunk_duration_ms

    def _build_audio_frame(self, audio: bytes) -> InputAudioRawFrame:
        return InputAudioRawFrame(
            audio=audio,
            sample_rate=self._sample_rate,
            num_channels=1,
        )

    async def send_utterance(self, text: str) -> None:
        """Synthesize ``text`` and push it through the pipeline as audio.

        See class docstring for the full lifecycle.
        """
        if self._emit_speaking_frames:
            await self._task.queue_frame(UserStartedSpeakingFrame())

        audio_bytes = await self._tts_provider(text)
        chunk_size = self._bytes_per_chunk
        if chunk_size <= 0:
            chunk_size = max(1, len(audio_bytes))

        for offset in range(0, len(audio_bytes), chunk_size):
            chunk = audio_bytes[offset:offset + chunk_size]
            if not chunk:
                continue
            await self._task.queue_frame(self._build_audio_frame(chunk))
            self.audio_frames_pushed += 1
            self.bytes_pushed += len(chunk)
            if self._realtime:
                await asyncio.sleep(self._chunk_duration_ms / 1000.0)

        # Trailing silence so VAD detects end-of-speech.
        if self._trailing_silence_ms > 0:
            silence_bytes = b"\x00\x00" * int(
                self._sample_rate * (self._trailing_silence_ms / 1000.0)
            )
            for offset in range(0, len(silence_bytes), chunk_size):
                chunk = silence_bytes[offset:offset + chunk_size]
                if not chunk:
                    continue
                await self._task.queue_frame(self._build_audio_frame(chunk))
                self.audio_frames_pushed += 1
                self.bytes_pushed += len(chunk)
                if self._realtime:
                    await asyncio.sleep(self._chunk_duration_ms / 1000.0)

        # Mark injection time AFTER the audio + silence finish so latency is
        # measured from end-of-speech (matches what a real call observes).
        self._collector.mark_injection_time()

        if self._emit_speaking_frames:
            await self._task.queue_frame(UserStoppedSpeakingFrame())

    async def receive_response(self, timeout: float = 60.0) -> CallerEvent:
        return await self._collector.wait_for_response(timeout)
