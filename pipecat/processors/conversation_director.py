"""Conversation Director processor — Layer 2 non-blocking analysis.

Sits in the pipeline after Quick Observer. Observes TranscriptionFrames,
fires off async analysis (non-blocking), and injects guidance into the
LLM context.

Primary LLM: Groq (OpenAI-compatible) with Gemini Flash fallback.

Speculative pre-processing: Detects silence onset via gaps in interim
transcriptions (250ms threshold). Starts fast Groq analysis during the
silence gap so guidance can be injected for the CURRENT turn instead
of being one turn behind.

Also monitors call timing and takes direct fallback actions when Claude
misses tool calls (e.g., force phase transitions, force call end).

NOT in the blocking path — process_frame() passes frames through
immediately and analysis runs in the background.
"""

from __future__ import annotations

import asyncio
import time

from loguru import logger
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    LLMMessagesAppendFrame,
)
from pipecat.processors.frame_processor import FrameProcessor

import re
from typing import Any

from services.director_llm import (
    analyze_queries,
    analyze_turn,
    analyze_turn_speculative,
    fast_provider_available,
    format_director_guidance,
    get_default_direction,
    warmup_fast_providers,
)
from services.context_trace import record_context_event, record_latency_event


# ---------------------------------------------------------------------------
# Legacy query similarity helpers retained for older cache-dedup experiments.
# ---------------------------------------------------------------------------

_NOISE_WORDS = frozenset({
    '2024', '2025', '2026', '2027', 'today', 'tomorrow', 'yesterday',
    'latest', 'recent', 'current', 'now', 'tonight', 'morning',
    'the', 'a', 'an', 'this', 'that', 'these', 'those',
    'who', 'what', 'when', 'where', 'how', 'why', 'which',
    'is', 'are', 'was', 'were', 'did', 'does', 'do', 'will',
    'has', 'have', 'had', 'be', 'been', 'being',
    'in', 'on', 'at', 'for', 'to', 'of', 'by', 'from', 'with',
})

_LEMMA_MAP = {
    'won': 'win', 'wins': 'win', 'winner': 'win', 'winning': 'win',
    'scores': 'score', 'scored': 'score', 'scoring': 'score',
    'result': 'score', 'results': 'score',
    'games': 'game', 'match': 'game', 'matches': 'game',
    'forecast': 'weather', 'forecasts': 'weather',
    'temperature': 'weather', 'temps': 'weather',
    'played': 'play', 'plays': 'play', 'playing': 'play',
    'players': 'play', 'player': 'play',
}

_SUFFIXES = ('ing', 'tion', 'ner', 'er', 'ed', 'ly', 'es', "'s")


def _normalize_query(query: str) -> tuple[list[str], set[str]]:
    """Tokenize, remove noise, lemmatize. Returns (token_list, token_set)."""
    words = query.lower().split()
    tokens = []
    for w in words:
        if w in _NOISE_WORDS:
            continue
        lemma = _LEMMA_MAP.get(w, w)
        if lemma == w:
            for suffix in _SUFFIXES:
                if w.endswith(suffix) and len(w) - len(suffix) >= 2:
                    lemma = w[:-len(suffix)]
                    break
            if lemma == w and w.endswith('s') and not w.endswith('ss') and len(w) >= 3:
                lemma = w[:-1]
        tokens.append(lemma)
    if not tokens:
        tokens = [w.lower() for w in query.split()]
    return tokens, set(tokens)


def query_similarity(q1: str, q2: str) -> float:
    """Compute similarity between two search queries (<0.1ms).

    Uses noise removal + lemmatization + containment/Jaccard hybrid
    + bigram bonus for multi-word entities like "Orlando Magic".
    """
    tokens1, set1 = _normalize_query(q1)
    tokens2, set2 = _normalize_query(q2)
    if not set1 or not set2:
        return 0.0
    if set1 == set2:
        return 1.0
    intersection = set1 & set2
    if not intersection:
        return 0.0
    containment = len(intersection) / min(len(set1), len(set2))
    jaccard = len(intersection) / len(set1 | set2)
    score = 0.6 * containment + 0.4 * jaccard
    bi1 = {f"{tokens1[i]}_{tokens1[i+1]}" for i in range(len(tokens1) - 1)}
    bi2 = {f"{tokens2[i]}_{tokens2[i+1]}" for i in range(len(tokens2) - 1)}
    if bi1 and bi2:
        bi_overlap = bi1 & bi2
        if bi_overlap:
            score += 0.15 * len(bi_overlap) / max(len(bi1), len(bi2))
    return min(1.0, score)


# ---------------------------------------------------------------------------
# Ephemeral context helpers
# ---------------------------------------------------------------------------

_EPHEMERAL_PREFIX = "[EPHEMERAL"


def _is_ephemeral(msg: Any) -> bool:
    """Check if a message was injected as ephemeral (per-turn) context."""
    content = msg.get("content", "") if isinstance(msg, dict) else ""
    if isinstance(content, str):
        return content.startswith(_EPHEMERAL_PREFIX)
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and isinstance(block.get("text", ""), str):
                if block["text"].startswith(_EPHEMERAL_PREFIX):
                    return True
    return False


class ConversationDirectorProcessor(FrameProcessor):
    """Layer 2 — runs per-turn analysis, caches guidance, takes actions.

    Non-blocking: ``process_frame()`` passes frames through immediately.
    Analysis runs in the background via ``asyncio.create_task()``.

    Speculative pre-processing:
    - Detects silence onset via 250ms gap in InterimTranscriptionFrames
    - Starts Groq analysis during silence
    - If speculative completes before final TranscriptionFrame → same-turn guidance
    - Otherwise falls back to previous-turn guidance (existing behavior)

    Fallback actions:
    - Force call end when time limit exceeded
    - Force winding-down guidance when call is running long
    """

    # Default time limits (overridden by call_settings in session_state)
    FORCE_WINDING_DOWN_MINUTES = 30.0
    FORCE_END_MINUTES = 35.0

    # Interim transcription debounce settings (for prefetch)
    INTERIM_DEBOUNCE_SECONDS = 1.0

    # Speculative pre-processing settings
    SILENCE_ONSET_SECONDS = 0.250  # 250ms gap triggers speculative analysis
    SPECULATIVE_MIN_LENGTH = 15    # min chars in interim to trigger speculative

    # Continuous speculative: fire Groq while user is still speaking
    CONTINUOUS_SPECULATIVE_FIRST_FIRE = 45   # ~8-9 words, first fire threshold
    CONTINUOUS_SPECULATIVE_REFIRE_MIN = 60   # subsequent fires need 60+ total chars
    CONTINUOUS_SPECULATIVE_REFIRE_WINDOW = 25 # 25 new chars needed to re-fire
    CONTINUOUS_SPECULATIVE_INTERVAL = 0.5    # min seconds between fires
    MEMORY_REINJECTION_COOLDOWN_TURNS = 4

    def __init__(self, session_state: dict, **kwargs):
        super().__init__(**kwargs)
        self._session_state = session_state
        self._pipeline_task = None
        self._last_result: dict | None = None
        self._last_result_age: int = 0
        self._delayed_end_task: asyncio.Task | None = None
        self._turn_count = 0
        self._end_scheduled = False
        self._wrapup_forced = False
        self._memory_refreshed = False
        self._warmup_done = False

        # Prefetch state
        self._last_interim_prefetch_time = 0.0
        self._last_interim_text = ""
        self._last_tracking_summary = ""
        self._fallback_analysis_task: asyncio.Task | None = None

        # Speculative pre-processing state
        self._silence_timer_task: asyncio.Task | None = None
        self._speculative_tasks: list[tuple[str, asyncio.Task]] = []  # (source_text, task)
        self._latest_interim_text: str = ""

        # Continuous speculative state (fires while user is still speaking)
        self._last_continuous_speculative_time: float = 0.0
        self._last_continuous_speculative_text: str = ""
        self._turn_first_interim_time: float | None = None
        self._turn_last_interim_time: float | None = None

        # Query Director tasks (separate from guidance speculative tasks)
        self._prefetch_tasks: list[asyncio.Task] = []

        # Metrics
        self._speculative_attempts = 0
        self._speculative_hits = 0
        self._speculative_misses = 0

    MAX_CONCURRENT_SPECULATIVE = 3  # cap concurrent guidance analysis calls
    MAX_CONCURRENT_PREFETCH = 3     # cap concurrent query-only analysis calls

    def set_pipeline_task(self, task):
        """Set pipeline task reference for direct actions (EndFrame, etc.)."""
        self._pipeline_task = task

    async def process_frame(self, frame: Frame, direction):
        """Non-blocking: inject guidance, start analysis, pass frame."""
        await super().process_frame(frame, direction)

        # --- End of call: stop background analysis and log speculative metrics ---
        if isinstance(frame, EndFrame):
            self._cancel_background_tasks()
            if self._speculative_attempts > 0:
                logger.info(
                    "[Director] Call summary: {turns} turns, "
                    "{hits}/{attempts} speculative hits ({pct}%), "
                    "{misses} misses",
                    turns=self._turn_count,
                    hits=self._speculative_hits,
                    attempts=self._speculative_attempts,
                    pct=round(self._speculative_hits / self._speculative_attempts * 100),
                    misses=self._speculative_misses,
                )
            await self.push_frame(frame, direction)
            return

        # Consent calls intentionally skip the Director — the conversation is
        # short, script-driven, and must not be coloured by check-in framing.
        # We still let EndFrame above run cleanup; everything else is a no-op
        # passthrough. See docs/plans/2026-05-24-consent-and-discovery-call-flows.md.
        if self._session_state.get("call_type") == "consent":
            await self.push_frame(frame, direction)
            return

        # --- Final TranscriptionFrame (after VAD 1.2s silence) ---
        if isinstance(frame, TranscriptionFrame):
            self._turn_count += 1
            self._session_state["_current_turn_sequence"] = self._turn_count
            self._session_state["_last_user_speech_time"] = time.time()
            self._record_transcription_timing()

            # Strip previous turn's ephemeral context (guidance, memories, web results)
            self._strip_ephemeral_messages()
            await self._inject_observer_guidance()

            # Feature flag: skip Director analysis when disabled
            from lib.growthbook import is_on
            if not is_on("director_enabled", self._session_state):
                await self.push_frame(frame, direction)
                return

            # Groq warmup on first transcription (warms TCP/TLS)
            if not self._warmup_done:
                self._warmup_done = True
                asyncio.create_task(warmup_fast_providers())

            # Cancel silence timer and reset continuous speculative state
            self._cancel_silence_timer()
            self._last_continuous_speculative_time = 0.0
            self._last_continuous_speculative_text = ""

            # Check speculative result
            speculative_result = self._harvest_speculative(frame.text)

            # Determine which guidance to inject
            goodbye_in_progress = self._session_state.get("_goodbye_in_progress", False)
            actions_checked = False

            if speculative_result and not goodbye_in_progress:
                # SAME-TURN guidance from speculative analysis
                self._speculative_hits += 1
                self._last_result = speculative_result
                self._last_result_age = 0
                await self._inject_guidance(speculative_result)
                await self._take_actions(speculative_result)
                actions_checked = True
                asyncio.create_task(self._run_director_prefetch(speculative_result))
                logger.info("[Director] SAME-TURN guidance injected (speculative)")

            elif self._last_result and not goodbye_in_progress and self._last_result_age < 1:
                # PREVIOUS-TURN guidance — only inject once as fallback,
                # don't keep re-injecting stale guidance on every turn.
                self._last_result_age += 1
                await self._inject_guidance(self._last_result)
                await self._take_actions(self._last_result)
                actions_checked = True

            if not actions_checked:
                await self._take_actions({})

            if not speculative_result and not goodbye_in_progress:
                self._start_fallback_analysis(frame.text)

            # Inject any prefetched memories into Claude's context proactively
            # (so Claude doesn't need to call search_memories tool)
            await self._inject_prefetched_memories(frame.text)
            await self._inject_tracking_context()

            # No blocking analysis on final. Speculative/fallback Director tasks
            # provide same-turn or next-turn guidance off the critical path.

            # Start speculative memory prefetch (non-blocking, raw-utterance first wave)
            asyncio.create_task(self._run_prefetch(frame.text))

            # Clean up completed query tasks
            self._prefetch_tasks = [t for t in self._prefetch_tasks if not t.done()]

            # Trigger mid-call memory refresh at 5 minutes
            call_start = self._session_state.get("_call_start_time") or time.time()
            refresh_after = (self._session_state.get("call_settings") or {}).get(
                "memory_refresh_after_minutes", 5
            )
            minutes_elapsed = (time.time() - call_start) / 60
            if minutes_elapsed > refresh_after and not self._memory_refreshed:
                self._memory_refreshed = True
                asyncio.create_task(self._refresh_memory())

            await self.push_frame(frame, direction)
            return

        # --- Interim TranscriptionFrame (while user is still speaking) ---
        if isinstance(frame, InterimTranscriptionFrame):
            text = frame.text or ""
            now = time.time()

            # Update latest interim for speculative analysis
            self._latest_interim_text = text
            if text:
                if self._turn_first_interim_time is None:
                    self._turn_first_interim_time = now
                self._turn_last_interim_time = now

            # Cancel silence timer (user is still speaking)
            self._cancel_silence_timer()

            # DON'T cancel running speculative — let it complete (fire-and-forget).
            # Deepgram sends interim refinements even after the user stops speaking,
            # which would repeatedly cancel speculative and leave no time window.
            # Instead, we let the first speculative run and check text overlap at harvest.

            # Start silence timer — fires speculative after 250ms pause.
            if len(text) >= self.SPECULATIVE_MIN_LENGTH and fast_provider_available():
                self._silence_timer_task = asyncio.create_task(
                    self._silence_timer(text)
                )

            # Continuous speculative: fire Groq while user is still speaking.
            # Don't wait for silence — if we have enough text and enough time
            # has passed since the last fire, start analysis now.
            self._maybe_fire_continuous_speculative(text)

            # Debounced prefetch. Source-specific text thresholds live in
            # extract_prefetch_queries(), so the Director only handles timing.
            now = time.time()
            if (
                now - self._last_interim_prefetch_time >= self.INTERIM_DEBOUNCE_SECONDS
                and text != self._last_interim_text
            ):
                self._last_interim_prefetch_time = now
                self._last_interim_text = text
                asyncio.create_task(self._run_prefetch(text, source="interim"))

            await self.push_frame(frame, direction)
            return

        # All other frames — pass through immediately
        await self.push_frame(frame, direction)

    def _record_transcription_timing(self) -> None:
        now = time.time()
        turn_sequence = self._turn_count

        if self._turn_first_interim_time is not None:
            record_latency_event(
                self._session_state,
                stage="transcription.window",
                source="stt_timing",
                action="measured",
                label="First interim to final transcript",
                provider="deepgram",
                latency_ms=(now - self._turn_first_interim_time) * 1000,
                turn_sequence=turn_sequence,
                metadata={"approximation": "first_interim_to_final"},
            )

        if self._turn_last_interim_time is not None:
            record_latency_event(
                self._session_state,
                stage="transcription.finalize_gap",
                source="stt_timing",
                action="measured",
                label="Last interim to final transcript",
                provider="deepgram",
                latency_ms=(now - self._turn_last_interim_time) * 1000,
                turn_sequence=turn_sequence,
                metadata={"approximation": "last_interim_to_final"},
            )

        self._turn_first_interim_time = None
        self._turn_last_interim_time = None

    # ------------------------------------------------------------------
    # Speculative pre-processing
    # ------------------------------------------------------------------

    def _cancel_silence_timer(self):
        """Cancel the silence onset timer if running."""
        if self._silence_timer_task is not None and not self._silence_timer_task.done():
            self._silence_timer_task.cancel()
        self._silence_timer_task = None

    def _cancel_task(self, task: asyncio.Task | None) -> None:
        if task is not None and not task.done():
            task.cancel()

    def _cancel_background_tasks(self) -> None:
        """Cancel call-scoped Director work when the pipeline ends."""
        self._cancel_silence_timer()
        self._cancel_task(self._fallback_analysis_task)
        self._fallback_analysis_task = None
        self._cancel_task(self._delayed_end_task)
        self._delayed_end_task = None
        for _, task in self._speculative_tasks:
            self._cancel_task(task)
        self._speculative_tasks = []
        for task in self._prefetch_tasks:
            self._cancel_task(task)
        self._prefetch_tasks = []

    async def _silence_timer(self, interim_text: str):
        """Wait for silence threshold, then start speculative analysis."""
        try:
            await asyncio.sleep(self.SILENCE_ONSET_SECONDS)

            # Clean up completed tasks
            self._speculative_tasks = [
                (text, t) for text, t in self._speculative_tasks if not t.done()
            ]

            # Cap concurrent speculatives
            if len(self._speculative_tasks) >= self.MAX_CONCURRENT_SPECULATIVE:
                logger.debug("[Director] Speculative cap reached ({n})", n=len(self._speculative_tasks))
                return

            # Timer fired — silence confirmed
            logger.debug(
                "[Director] Silence onset ({ms}ms), starting speculative",
                ms=round(self.SILENCE_ONSET_SECONDS * 1000),
            )
            self._speculative_attempts += 1

            transcript = self._history_before_current(interim_text)
            task = asyncio.create_task(
                self._run_speculative_analysis(interim_text, transcript)
            )
            self._speculative_tasks.append((interim_text, task))
        except asyncio.CancelledError:
            pass  # Normal: new interim arrived before timer fired

    def _maybe_fire_continuous_speculative(self, text: str):
        """Fire query-only analysis on interims without waiting for silence.

        First fire at 45 chars (~8-9 words) to catch questions early.
        Subsequent fires require 60+ total chars AND 25 new chars since last fire,
        so we don't waste Groq calls on slightly extended text.
        """
        is_first = not self._last_continuous_speculative_text

        if is_first:
            if len(text) < self.CONTINUOUS_SPECULATIVE_FIRST_FIRE:
                return
        else:
            if len(text) < self.CONTINUOUS_SPECULATIVE_REFIRE_MIN:
                return
            new_chars = len(text) - len(self._last_continuous_speculative_text)
            if new_chars < self.CONTINUOUS_SPECULATIVE_REFIRE_WINDOW:
                return

        if not fast_provider_available():
            return

        now = time.time()
        if now - self._last_continuous_speculative_time < self.CONTINUOUS_SPECULATIVE_INTERVAL:
            return

        # Clean up completed tasks
        self._prefetch_tasks = [
            t for t in self._prefetch_tasks if not t.done()
        ]
        if len(self._prefetch_tasks) >= self.MAX_CONCURRENT_PREFETCH:
            return

        self._last_continuous_speculative_time = now
        self._last_continuous_speculative_text = text

        transcript = self._history_before_current(text)
        task = asyncio.create_task(
            self._run_query_analysis(text, transcript)
        )
        self._prefetch_tasks.append(task)
        logger.debug("[Director] Continuous query started")

    async def _run_query_analysis(self, user_message: str, transcript: list[dict]):
        """Run query-only analysis (memory_queries extraction).

        Fast (~200ms). Feeds memory prefetch.
        Does NOT produce guidance — cannot be harvested for same-turn injection.
        """
        start = time.time()
        turn_sequence = self._turn_count + 1
        try:
            result = await analyze_queries(
                user_message,
                self._session_state,
                conversation_history=transcript,
            )
            record_latency_event(
                self._session_state,
                stage="director.query",
                source="director_query",
                action="measured",
                label="Director query analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={
                    "result": bool(result),
                    "query_count": len((result or {}).get("memory_queries") or []),
                },
            )
            if result:
                direction_like = {"prefetch": result}
                asyncio.create_task(self._run_director_prefetch(direction_like))
            return result
        except asyncio.CancelledError:
            return None
        except Exception as e:
            record_latency_event(
                self._session_state,
                stage="director.query",
                source="director_query",
                action="failed",
                label="Director query analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"error": str(e)[:200]},
            )
            logger.debug("[Director] Query analysis error: {err}", err=str(e))
            return None

    def _start_fallback_analysis(self, user_message: str):
        """Start non-blocking full analysis so Gemini fallback can feed next turn."""
        if self._fallback_analysis_task and not self._fallback_analysis_task.done():
            return

        transcript = self._history_before_current(user_message)
        self._fallback_analysis_task = asyncio.create_task(
            self._run_fallback_analysis(user_message, transcript)
        )

    async def _run_fallback_analysis(self, user_message: str, transcript: list[dict]):
        """Run full Director analysis outside the critical path for next-turn guidance."""
        start = time.time()
        try:
            result = await analyze_turn(
                user_message,
                self._session_state,
                conversation_history=transcript,
            )
            record_latency_event(
                self._session_state,
                stage="director.fallback",
                source="director_guidance",
                action="measured",
                label="Director fallback analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=self._turn_count,
                metadata={"result": bool(result)},
            )
            if result:
                if self._wrapup_forced:
                    result.setdefault("analysis", {})["call_phase"] = "winding_down"
                    result.setdefault("direction", {})["pacing_note"] = "time_to_close"
                self._last_result = result
                self._last_result_age = 0
                asyncio.create_task(self._run_director_prefetch(result))
            return result
        except asyncio.CancelledError:
            return None
        except Exception as e:
            record_latency_event(
                self._session_state,
                stage="director.fallback",
                source="director_guidance",
                action="failed",
                label="Director fallback analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=self._turn_count,
                metadata={"error": str(e)[:200]},
            )
            logger.debug("[Director] Fallback analysis error: {err}", err=str(e))
            return None

    async def _run_speculative_analysis(self, user_message: str, transcript: list[dict]):
        """Run full guidance analysis. Result retrieved via _harvest_speculative()."""
        start = time.time()
        turn_sequence = self._turn_count + 1
        try:
            result = await analyze_turn_speculative(
                user_message,
                self._session_state,
                conversation_history=transcript,
            )
            record_latency_event(
                self._session_state,
                stage="director.speculative",
                source="director_guidance",
                action="measured",
                label="Director speculative analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"result": bool(result)},
            )
            return result
        except asyncio.CancelledError:
            return None
        except Exception as e:
            record_latency_event(
                self._session_state,
                stage="director.speculative",
                source="director_guidance",
                action="failed",
                label="Director speculative analysis",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"error": str(e)[:200]},
            )
            logger.debug("[Director] Speculative analysis error: {err}", err=str(e))
            return None

    def _harvest_speculative(self, final_text: str) -> dict | None:
        """Check all completed speculative analyses for a usable result.

        Picks the best text-matching completed result. Incomplete tasks
        keep running — their prefetch results still build the cache.
        """
        if not self._speculative_tasks:
            return None

        best_result = None
        still_running = 0

        remaining: list[tuple[str, asyncio.Task]] = []

        for source_text, task in self._speculative_tasks:
            if task.done():
                try:
                    result = task.result()
                except Exception:
                    continue
                if result and self._text_matches(source_text, final_text, threshold=0.5):
                    best_result = result
            else:
                still_running += 1
                remaining.append((source_text, task))

        # Clear completed tasks and keep still-running ones for cancellation/cleanup.
        self._speculative_tasks = remaining

        if best_result:
            return best_result

        if still_running:
            self._speculative_misses += 1
            logger.info(
                "[Director] No speculative match at final transcription "
                "({n} still running)",
                n=still_running,
            )
        return None

    @staticmethod
    def _text_matches(interim: str, final: str, threshold: float = 0.7) -> bool:
        """Check if interim and final text are similar enough (Jaccard word overlap)."""
        if not interim or not final:
            return False
        words_i = set(interim.lower().split())
        words_f = set(final.lower().split())
        if not words_i or not words_f:
            return False
        intersection = len(words_i & words_f)
        union = len(words_i | words_f)
        return (intersection / union) >= threshold

    @staticmethod
    def _message_content_text(content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                block.get("text", "")
                for block in content
                if isinstance(block, dict) and isinstance(block.get("text"), str)
            )
        return str(content)

    def _history_before_current(self, user_text: str) -> list[dict]:
        """Return transcript history without duplicating the current user turn.

        The tracker sits before the Director, so final TranscriptionFrames are
        already appended to session_state["_transcript"] when the Director asks
        Groq/Gemini to analyze "Current message from senior". Passing the raw
        transcript makes that same message appear twice.
        """
        transcript = list(self._session_state.get("_transcript") or [])
        if not transcript:
            return transcript

        last = transcript[-1]
        if not isinstance(last, dict) or last.get("role") != "user":
            return transcript

        last_text = self._message_content_text(last.get("content"))
        if self._text_matches(last_text, user_text, threshold=0.8):
            return transcript[:-1]
        return transcript

    def _strip_ephemeral_messages(self):
        """Remove previous turn's ephemeral injections from LLM context.

        Called at the start of each new turn so only fresh, relevant
        context is present. The senior's conversation stays permanent;
        Director guidance, memories, and web results are ephemeral.

        Handles merged messages (where context aggregator combines ephemeral
        guidance with user speech into multi-block messages) by stripping
        only the ephemeral blocks rather than removing the whole message.
        """
        ctx = self._session_state.get("_llm_context")
        if not ctx:
            return
        messages = ctx.get_messages()
        filtered = []
        n_stripped = 0
        for m in messages:
            if not isinstance(m, dict):
                filtered.append(m)
                continue
            content = m.get("content", "")
            # Simple string content — remove if ephemeral
            if isinstance(content, str):
                if content.startswith(_EPHEMERAL_PREFIX):
                    n_stripped += 1
                    continue
                filtered.append(m)
                continue
            # Multi-block content — strip only ephemeral blocks, keep the rest
            if isinstance(content, list):
                kept_blocks = []
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text", ""), str):
                        if block["text"].startswith(_EPHEMERAL_PREFIX):
                            n_stripped += 1
                            continue
                    kept_blocks.append(block)
                if kept_blocks:
                    filtered.append({**m, "content": kept_blocks if len(kept_blocks) > 1 else kept_blocks[0].get("text", "") if isinstance(kept_blocks[0], dict) else kept_blocks})
                else:
                    n_stripped += 1  # all blocks were ephemeral
                continue
            filtered.append(m)
        if n_stripped > 0:
            ctx.set_messages(filtered)
            logger.debug("[Director] Stripped {n} ephemeral blocks", n=n_stripped)


    # ------------------------------------------------------------------
    # Guidance injection
    # ------------------------------------------------------------------

    async def _inject_guidance(self, result: dict):
        """Inject Director guidance into Claude's context."""
        guidance_text = format_director_guidance(result)
        if not guidance_text:
            return

        # Append token budget hint from Quick Observer if available
        token_rec = self._session_state.get("_token_recommendation")
        if token_rec:
            guidance_text += (
                f"\n[RESPONSE LENGTH: Keep response under "
                f"{token_rec['max_tokens']} tokens — {token_rec['reason']}]"
            )

        # Inject news content when Director recommends mentioning it
        # (news removed from system prompt to save ~300 tokens per turn)
        dir_section = result.get("direction", {})
        if (
            dir_section.get("should_mention_news")
            and not self._session_state.get("_news_injected", False)
        ):
            news_ctx = self._session_state.get("news_context")
            if news_ctx:
                guidance_text += f"\n\n{news_ctx}"
                self._session_state["_news_injected"] = True
                record_context_event(
                    self._session_state,
                    source="news_context",
                    action="injected",
                    label="Director news context",
                    content=news_ctx,
                    provider="context_cache",
                    item_count=sum(1 for line in str(news_ctx).splitlines() if line.strip().startswith("-")) or None,
                    metadata={"trigger": "director_should_mention_news"},
                )
                logger.info("[Director] News content injected into context")

        record_context_event(
            self._session_state,
            source="director_guidance",
            action="injected",
            label="Director guidance",
            content=guidance_text,
            provider="conversation_director",
            metadata={
                "call_phase": (result.get("analysis") or {}).get("call_phase"),
                "pacing_note": (result.get("direction") or {}).get("pacing_note"),
                "has_token_recommendation": bool(token_rec),
            },
        )
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "[EPHEMERAL: Director guidance — do not read aloud]\n"
                            + guidance_text
                        ),
                    }
                ],
                run_llm=False,
            )
        )

    async def _inject_observer_guidance(self):
        """Re-inject current-turn Quick Observer guidance after stripping.

        Quick Observer runs before the Director and its guidance reaches the
        context aggregator before the final transcription. The Director strips
        stale ephemeral messages at the start of each turn, so the observer also
        leaves the current guidance in session_state for a same-turn reinjection.
        """
        guidance_text = self._session_state.pop("_pending_observer_guidance", None)
        if not guidance_text:
            return

        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "[EPHEMERAL: Observer guidance — do not read aloud]\n"
                            + guidance_text
                        ),
                    }
                ],
                run_llm=False,
            )
        )

    # ------------------------------------------------------------------
    # Proactive memory injection
    # ------------------------------------------------------------------

    async def _inject_prefetched_memories(self, user_text: str):
        """Inject cached prefetch results into Claude's context proactively.

        Checks the prefetch cache for memories relevant to the current user
        speech and injects them as context — eliminates ~4.3s tool call latency.

        500ms gate: If no cache hit yet, waits up to 500ms for in-flight
        prefetch to complete. Prefetch starts on interim transcriptions while
        the user is still speaking, so most queries are cached before the final
        arrives. The 500ms is a worst-case backstop.
        """
        cache = self._session_state.get("_prefetch_cache")
        if not cache:
            return

        cached = cache.get(user_text, threshold=0.3)

        # Brief gate: wait only when a relevant prefetch is actually in flight.
        # If the cache exists but has no relevant entry and nothing relevant is
        # running, skipping the wait preserves the non-blocking Director path.
        if not cached and cache.has_relevant_inflight(user_text, threshold=0.3):
            gate_start = time.time()
            for _ in range(10):  # 10 * 50ms = 500ms
                await asyncio.sleep(0.05)
                cached = cache.get(user_text, threshold=0.3)
                if cached:
                    logger.info("[Director] Memory gate hit after wait")
                    break
                if not cache.has_relevant_inflight(user_text, threshold=0.3):
                    break
            gate_elapsed_ms = round((time.time() - gate_start) * 1000)
            if gate_elapsed_ms > 0:
                record_latency_event(
                    self._session_state,
                    stage="memory_gate.wait",
                    source="memory_gate",
                    action="measured",
                    label="Memory gate wait",
                    provider="prefetch_cache",
                    latency_ms=gate_elapsed_ms,
                    turn_sequence=self._turn_count,
                    metadata={"cache_hit_after_wait": bool(cached)},
                )

        if not cached:
            return

        # Format memories for injection, suppressing recent repeats.
        memory_lines: list[str] = []
        injected_ids: list[str] = []
        injected_turns = self._session_state.setdefault("_injected_memory_turns", {})
        current_turn = self._turn_count
        explicit_memory_request = bool(
            re.search(r"\b(remember|last time|what did I tell you|do you know)\b", user_text, re.I)
        )

        senior = self._session_state.get("senior") or {}
        timezone_name = senior.get("timezone") or "America/New_York"
        try:
            from services.memory import format_memory_for_context
        except Exception:
            format_memory_for_context = None

        for result in cached:
            content = (
                format_memory_for_context(result, timezone_name)
                if format_memory_for_context
                else result.get("content")
            )
            if not content:
                continue
            memory_key = str(result.get("id") or content)
            last_turn = injected_turns.get(memory_key)
            if (
                last_turn is not None
                and not explicit_memory_request
                and current_turn - int(last_turn) < self.MEMORY_REINJECTION_COOLDOWN_TURNS
            ):
                continue
            memory_lines.append(content)
            if result.get("id"):
                injected_ids.append(result["id"])
            injected_turns[memory_key] = current_turn

        if not memory_lines:
            return

        memory_text = "\n".join(f"- {line}" for line in memory_lines)
        record_context_event(
            self._session_state,
            source="memory_context",
            action="injected",
            label="Prefetched memories injected",
            content=memory_text,
            provider="prefetch_cache",
            item_count=len(memory_lines),
            metadata={"cache_hit": True, "query_chars": len(user_text or "")},
        )
        logger.info(
            "[Director] Proactive memory injection: {n} memories",
            n=len(memory_lines),
        )

        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "[EPHEMERAL: MEMORY CONTEXT - do not read this tag aloud]\n"
                            "You remember from past conversations:\n"
                            f"{memory_text}\n"
                            "Use naturally: \"I remember you mentioning...\" "
                            "Don't force it if it doesn't fit."
                        ),
                    }
                ],
                run_llm=False,
            )
        )
        if injected_ids:
            asyncio.create_task(self._mark_injected_memories_accessed(injected_ids))

    async def _mark_injected_memories_accessed(self, memory_ids: list[str]) -> None:
        try:
            from services.memory import mark_accessed
            await mark_accessed(memory_ids)
        except Exception as e:
            logger.debug("[Director] Failed to mark injected memories accessed: {err}", err=str(e))

    async def _inject_tracking_context(self):
        """Inject compact tracking summary so the LLM avoids repetition mid-call."""
        tracker = self._session_state.get("_conversation_tracker")
        if not tracker or not hasattr(tracker, "get_summary"):
            return

        summary = tracker.get_summary()
        if not summary or summary == self._last_tracking_summary:
            return

        self._last_tracking_summary = summary
        self._session_state["conversation_tracking"] = summary
        record_context_event(
            self._session_state,
            source="conversation_tracking",
            action="injected",
            label="Conversation tracking summary",
            content=summary,
            provider="conversation_tracker",
        )
        await self.push_frame(
            LLMMessagesAppendFrame(
                messages=[
                    {
                        "role": "user",
                        "content": (
                            "[EPHEMERAL: CONVERSATION TRACKING - do not read aloud]\n"
                            f"{summary}"
                        ),
                    }
                ],
                run_llm=False,
            )
        )

    # ------------------------------------------------------------------
    # Regular analysis + prefetch
    # ------------------------------------------------------------------


    async def _run_prefetch(self, text: str, source: str = "final"):
        """Speculatively prefetch memories based on user speech (non-blocking)."""
        start = time.time()
        turn_sequence = self._turn_count + (1 if source == "interim" else 0)
        try:
            from services.prefetch import PrefetchCache, extract_prefetch_queries, run_prefetch

            # Lazily init cache in session_state
            if "_prefetch_cache" not in self._session_state:
                self._session_state["_prefetch_cache"] = PrefetchCache()
            cache = self._session_state["_prefetch_cache"]

            queries = extract_prefetch_queries(text, self._session_state, source=source)
            if not queries:
                logger.info("[Prefetch] No queries extracted from {src}", src=source)
                return

            senior_id = self._session_state.get("senior_id")
            if not senior_id:
                logger.info("[Prefetch] No senior_id in session_state")
                return

            count = await run_prefetch(senior_id, queries, cache)
            record_latency_event(
                self._session_state,
                stage=f"prefetch.{source}",
                source="memory_prefetch",
                action="measured",
                label=f"Memory prefetch from {source} transcript",
                provider="prefetch",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"source": source, "query_count": len(queries), "result_count": count},
                content="\n".join(queries),
            )
            if count > 0:
                record_context_event(
                    self._session_state,
                    source="memory_prefetch",
                    action="prefetched",
                    label=f"Memory prefetch from {source} transcript",
                    content="\n".join(queries),
                    provider="prefetch",
                    item_count=count,
                    metadata={"source": source, "query_count": len(queries)},
                )
            if count > 0:
                logger.info(
                    "[Prefetch] {n} queries cached from {src} transcription",
                    n=count, src=source,
                )
            else:
                logger.debug("[Prefetch] 0 results")
        except Exception as e:
            record_latency_event(
                self._session_state,
                stage=f"prefetch.{source}",
                source="memory_prefetch",
                action="failed",
                label=f"Memory prefetch from {source} transcript",
                provider="prefetch",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"source": source, "error": str(e)[:200]},
            )
            logger.warning("[Prefetch] Error: {err}", err=str(e))

    async def _run_director_prefetch(self, direction: dict):
        """Second-wave prefetch using Director's analysis output (memory only)."""
        start = time.time()
        turn_sequence = self._session_state.get("_current_turn_sequence") or (self._turn_count + 1)
        try:
            from services.prefetch import (
                PrefetchCache,
                extract_director_queries,
                run_prefetch,
            )

            if "_prefetch_cache" not in self._session_state:
                self._session_state["_prefetch_cache"] = PrefetchCache()
            cache = self._session_state["_prefetch_cache"]

            queries = extract_director_queries(direction, self._session_state)
            senior_id = self._session_state.get("senior_id")

            if not queries or not senior_id:
                return

            count = await run_prefetch(senior_id, queries, cache)
            record_latency_event(
                self._session_state,
                stage="prefetch.director",
                source="memory_prefetch",
                action="measured",
                label="Director memory prefetch",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"query_count": len(queries), "result_count": count},
                content="\n".join(queries),
            )
            if count:
                record_context_event(
                    self._session_state,
                    source="memory_prefetch",
                    action="prefetched",
                    label="Director memory prefetch",
                    content="\n".join(queries),
                    provider="director_llm",
                    item_count=count,
                    metadata={"query_count": len(queries)},
                )
                logger.info(
                    "[Prefetch] Director 2nd wave: {m} memory cached",
                    m=count,
                )

        except Exception as e:
            record_latency_event(
                self._session_state,
                stage="prefetch.director",
                source="memory_prefetch",
                action="failed",
                label="Director memory prefetch",
                provider="director_llm",
                latency_ms=(time.time() - start) * 1000,
                turn_sequence=turn_sequence,
                metadata={"error": str(e)[:200]},
            )
            logger.warning("[Prefetch] Director prefetch error: {err}", err=str(e))

    # ------------------------------------------------------------------
    # Fallback actions + call ending
    # ------------------------------------------------------------------

    async def _take_actions(self, result: dict | None):
        """Take direct fallback actions when Claude misses things."""
        result = result or {}
        analysis = result.get("analysis", {})
        phase = analysis.get("call_phase", "main")
        pacing = result.get("direction", {}).get("pacing_note", "good")

        call_start = self._session_state.get("_call_start_time") or time.time()
        minutes_elapsed = (time.time() - call_start) / 60

        # Read configurable time limits from call_settings
        settings = self._session_state.get("call_settings") or {}
        winding_down_minutes = settings.get("winding_down_minutes", self.FORCE_WINDING_DOWN_MINUTES)
        max_call_minutes = settings.get("max_call_minutes", self.FORCE_END_MINUTES)

        # Force call end if Director says closing AND call is long enough
        if phase == "closing" and minutes_elapsed > 8 and not self._end_scheduled:
            if self._pipeline_task:
                logger.info(
                    "[Director] phase=closing + {m:.1f}min - scheduling end in 5s",
                    m=minutes_elapsed,
                )
                self._end_scheduled = True
                self._delayed_end_task = asyncio.create_task(self._delayed_end(5.0))

        # Inject time-pressure guidance if call exceeds limit
        if (
            pacing == "time_to_close"
            or minutes_elapsed > winding_down_minutes
        ) and not self._wrapup_forced:
            if phase not in ("winding_down", "closing"):
                logger.info(
                    "[Director] Time limit - injecting wrap-up ({m:.1f}min)",
                    m=minutes_elapsed,
                )
                self._wrapup_forced = True
                # Override last_result to force wrap-up guidance on next turn
                if not self._last_result:
                    self._last_result = get_default_direction()
                    self._last_result_age = 0
                self._last_result.setdefault("analysis", {})[
                    "call_phase"
                ] = "winding_down"
                self._last_result.setdefault("direction", {})[
                    "pacing_note"
                ] = "time_to_close"

        # Hard limit - force end
        if minutes_elapsed > max_call_minutes and not self._end_scheduled:
            if self._pipeline_task:
                logger.info(
                    "[Director] Hard time limit ({m:.1f}min) - forcing end",
                    m=minutes_elapsed,
                )
                self._end_scheduled = True
                self._delayed_end_task = asyncio.create_task(self._delayed_end(3.0))

    async def _refresh_memory(self):
        """Refresh memory context mid-call based on current topics."""
        try:
            tracker = self._session_state.get("_conversation_tracker")
            topics = []
            if tracker and hasattr(tracker, "get_topics"):
                topics = tracker.get_topics()
            senior_id = self._session_state.get("senior_id")
            if senior_id and topics:
                from services.memory import refresh_context
                refreshed = await refresh_context(senior_id, topics)
                if refreshed:
                    existing = self._session_state.get("memory_context")
                    self._session_state["memory_context"] = refreshed
                    logger.info("[Director] Memory refreshed with {n} topics", n=len(topics))
                    if refreshed != existing:
                        await self.push_frame(
                            LLMMessagesAppendFrame(
                                messages=[
                                    {
                                        "role": "user",
                                        "content": (
                                            "[EPHEMERAL: MEMORY CONTEXT - do not read aloud]\n"
                                            f"{refreshed}"
                                        ),
                                    }
                                ],
                                run_llm=False,
                            )
                        )
        except Exception as e:
            logger.error("[Director] Memory refresh failed: {err}", err=str(e))

    async def _delayed_end(self, delay: float):
        """End the call after a delay (lets current audio play)."""
        try:
            await asyncio.sleep(delay)
            if self._pipeline_task:
                logger.info("[Director] Forcing call end via EndFrame")
                self._session_state["_end_reason"] = "director_timeout"
                await self._pipeline_task.queue_frame(EndFrame())
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error("[Director] Error forcing call end: {err}", err=str(e))
