"""Quick Observer — Layer 1 (0ms) regex-based analysis as a Pipecat FrameProcessor.

Runs synchronously on each TranscriptionFrame before the LLM processes it.
Stores guidance for Conversation Director to inject into the current response.

Pattern data lives in processors/patterns.py. This file imports only the
companion-call categories used for guidance and the FrameProcessor wrapper.
"""

import asyncio
from dataclasses import dataclass, field
from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    Frame,
    TranscriptionFrame,
)
from pipecat.processors.frame_processor import FrameProcessor

from processors.patterns import (
    FAMILY_PATTERNS, EMOTION_PATTERNS,
    SOCIAL_PATTERNS, ACTIVITY_PATTERNS, TIME_PATTERNS, ENVIRONMENT_PATTERNS,
    HELP_REQUEST_PATTERNS, END_OF_LIFE_PATTERNS,
    NEWS_PATTERNS, GOODBYE_PATTERNS,
    QUESTION_PATTERNS, ENGAGEMENT_PATTERNS, REMINDER_ACK_PATTERNS,
    EOL_GUIDANCE, EMOTION_GUIDANCE,
)


_GOODBYE_CONTINUATION_MARKERS = (
    "oh wait",
    "wait,",
    "wait ",
    "i forgot",
    "forgot to tell",
    "one more thing",
    "before i go",
    "real quick",
    "actually",
)


def _has_goodbye_continuation(text: str) -> bool:
    normalized = f" {text.lower()} "
    return any(marker in normalized for marker in _GOODBYE_CONTINUATION_MARKERS)


# =============================================================================
# Analysis result
# =============================================================================

@dataclass
class AnalysisResult:
    family_signals: list = field(default_factory=list)
    emotion_signals: list = field(default_factory=list)
    social_signals: list = field(default_factory=list)
    activity_signals: list = field(default_factory=list)
    time_signals: list = field(default_factory=list)
    environment_signals: list = field(default_factory=list)
    help_request_signals: list = field(default_factory=list)
    end_of_life_signals: list = field(default_factory=list)
    news_signals: list = field(default_factory=list)
    goodbye_signals: list = field(default_factory=list)
    is_question: bool = False
    question_type: str | None = None
    engagement_level: str = "normal"
    guidance: str | None = None
    token_recommendation: dict | None = None
    reminder_response: dict | None = None
    needs_web_search: bool = False


# =============================================================================
# Core analysis function
# =============================================================================

def quick_analyze(user_message: str, recent_history: list[dict] | None = None) -> AnalysisResult:
    """Analyze user message with companion-call regex patterns."""
    result = AnalysisResult()
    if not user_message:
        return result

    text = user_message.strip()

    def _scan(patterns, target, *, keyed=False, sev=False, emo=False, strength_key=False):
        for p in patterns:
            if p.pattern.search(text):
                if emo:
                    target.append({"signal": p.signal, "valence": p.valence, "intensity": p.intensity})
                elif sev:
                    target.append({"signal": p.signal, "severity": p.severity})
                elif strength_key:
                    target.append({"signal": p.signal, "strength": p.strength})
                else:
                    target.append(p.signal)

    _scan(FAMILY_PATTERNS, result.family_signals)
    _scan(EMOTION_PATTERNS, result.emotion_signals, emo=True)
    _scan(SOCIAL_PATTERNS, result.social_signals)
    _scan(ACTIVITY_PATTERNS, result.activity_signals)
    _scan(TIME_PATTERNS, result.time_signals)
    _scan(ENVIRONMENT_PATTERNS, result.environment_signals)
    _scan(HELP_REQUEST_PATTERNS, result.help_request_signals)
    _scan(END_OF_LIFE_PATTERNS, result.end_of_life_signals, sev=True)

    # News — also sets needs_web_search
    for p in NEWS_PATTERNS:
        if p.pattern.search(text):
            result.news_signals.append(p.signal)
            result.needs_web_search = True

    _scan(GOODBYE_PATTERNS, result.goodbye_signals, strength_key=True)
    if result.goodbye_signals and _has_goodbye_continuation(text):
        for signal in result.goodbye_signals:
            if signal.get("strength") == "strong":
                signal["strength"] = "weak"

    # Questions
    for p in QUESTION_PATTERNS:
        if p.pattern.search(text):
            result.is_question = True
            result.question_type = p.signal
            break

    # Engagement
    for p in ENGAGEMENT_PATTERNS:
        if p.pattern.search(text):
            if p.signal in ("minimal_response", "very_short", "uncertain_response"):
                result.engagement_level = "low"
            elif p.signal == "short" and result.engagement_level != "low":
                result.engagement_level = "medium"
            elif p.signal == "long_response":
                result.engagement_level = "high"

    # Consecutive short responses → low engagement
    if recent_history and len(recent_history) >= 2:
        user_msgs = [m["content"] for m in recent_history if m.get("role") == "user"][-3:]
        if sum(1 for m in user_msgs if m and len(m) < 20) >= 2:
            result.engagement_level = "low"

    # Reminder acknowledgment
    best = None
    for p in REMINDER_ACK_PATTERNS:
        if p.pattern.search(text):
            if best is None or p.confidence > best["confidence"]:
                best = {"type": p.type, "confidence": p.confidence}
    result.reminder_response = best

    result.guidance = _build_guidance(result)
    result.token_recommendation = _build_token_recommendation(result)
    return result


# =============================================================================
# Guidance builder
# =============================================================================

def _build_guidance(r: AnalysisResult) -> str | None:
    lines: list[str] = []

    if r.end_of_life_signals:
        sig = r.end_of_life_signals[0]["signal"]
        lines.append(f"[END OF LIFE] {EOL_GUIDANCE.get(sig, 'Sensitive topic. Be very gentle and listen.')}")

    if r.help_request_signals:
        lines.append("[HELP REQUEST] They're asking for help. Address their request directly and clearly.")

    neg = [e for e in r.emotion_signals if e["valence"] == "negative"]
    pos = [e for e in r.emotion_signals if e["valence"] == "positive"]
    if neg:
        sig = neg[0]["signal"]
        lines.append(f"[EMOTION] {EMOTION_GUIDANCE.get(sig, 'They seem upset. Acknowledge their feelings.')}")
    elif pos:
        if pos[0]["intensity"] == "high":
            lines.append("[EMOTION] They're in great spirits! Match their positive energy.")
        else:
            lines.append("[EMOTION] They seem positive. Keep the warm tone.")

    if "social_isolation" in r.social_signals:
        lines.append("[SOCIAL] They haven't seen anyone lately. Be extra warm and engaging.")
    elif r.social_signals:
        lines.append("[SOCIAL] Social connection mentioned. Ask warm follow-up questions.")

    if r.family_signals:
        if "deceased_spouse" in r.family_signals:
            lines.append("[FAMILY] They mentioned late spouse. Be gentle and let them share if they want.")
        else:
            lines.append("[FAMILY] Family mentioned. Ask a warm follow-up about this person.")

    if r.activity_signals:
        lines.append("[ACTIVITY] They mentioned an activity. Ask more about it with genuine interest.")

    if any(s in r.time_signals for s in ("reminiscing", "childhood_memory", "nostalgia")):
        lines.append("[MEMORY] They're sharing memories. Listen warmly and ask follow-up questions.")

    if r.is_question:
        lines.append("[QUESTION] Answer their question directly first, then continue naturally.")

    if r.engagement_level == "low":
        lines.append("[ENGAGEMENT] Short responses detected. Ask an open question about something they enjoy.")

    if r.goodbye_signals:
        has_strong = any(g["strength"] == "strong" for g in r.goodbye_signals)
        if has_strong:
            lines.append("[GOODBYE] They said goodbye. Say a brief warm goodbye and then CALL transition_to_winding_down immediately. You MUST use the tool — do not just say bye in text.")
        else:
            lines.append("[GOODBYE] They may be wrapping up. Start winding down and prepare to call transition_to_winding_down.")

    return "\n".join(lines) if lines else None


# =============================================================================
# Token recommendation — 16 priority-ordered response-length rules
# =============================================================================

def _build_token_recommendation(r: AnalysisResult) -> dict | None:
    # End of life critical
    crit_eol = [s for s in r.end_of_life_signals if s["signal"] in ("death_wish", "hopelessness", "burden_concern")]
    if crit_eol:
        return {"max_tokens": 350, "reason": "crisis_support"}

    if r.end_of_life_signals:
        return {"max_tokens": 250, "reason": "end_of_life_topic"}

    if r.help_request_signals:
        return {"max_tokens": 200, "reason": "help_request"}

    high_neg = [e for e in r.emotion_signals if e["valence"] == "negative" and e["intensity"] == "high"]
    if high_neg:
        return {"max_tokens": 250, "reason": "emotional_support"}

    med_neg = [e for e in r.emotion_signals if e["valence"] == "negative" and e["intensity"] == "medium"]
    if med_neg:
        return {"max_tokens": 200, "reason": "emotional_support"}

    if r.engagement_level == "low":
        return {"max_tokens": 180, "reason": "low_engagement"}

    if any(s in r.time_signals for s in ("reminiscing", "childhood_memory")):
        return {"max_tokens": 170, "reason": "memory_sharing"}

    if r.engagement_level == "high":
        return {"max_tokens": 150, "reason": "high_engagement"}

    if r.is_question and not high_neg:
        return {"max_tokens": 100, "reason": "simple_question"}

    if r.family_signals:
        return {"max_tokens": 150, "reason": "family_warmth"}

    return None


# =============================================================================
# Pipecat FrameProcessor wrapper
# =============================================================================

class QuickObserverProcessor(FrameProcessor):
    """Pipecat FrameProcessor that runs quick_analyze on each TranscriptionFrame
    and stashes guidance for Conversation Director to inject in one canonical place.

    When a strong goodbye is detected, first tries a programmatic transition to
    winding_down. If that cannot happen, it schedules a TTS-aware EndFrame
    fallback so the call actually terminates.
    """

    # Seconds to wait before the EndFrame fallback after goodbye detection.
    # Gives the LLM time to generate and TTS to speak the goodbye audio.
    GOODBYE_DELAY_SECONDS = 5.0
    PROGRAMMATIC_GOODBYE_MIN_ELAPSED_SECONDS = 0.0
    # After the initial delay, keep checking every TTS_IDLE_POLL_SECONDS to
    # see if Donna's audio output has gone idle. Caps total wait so the call
    # can't hang forever if TTS keeps generating (model run-on).
    TTS_IDLE_POLL_SECONDS = 0.5
    MAX_END_WAIT_SECONDS = 30.0
    # Buffer between BotStoppedSpeaking and the EndFrame fire, so the final
    # frame of audio has time to flush out over the network.
    POST_TTS_BUFFER_SECONDS = 0.6

    def __init__(self, session_state: dict | None = None, **kwargs):
        super().__init__(**kwargs)
        self._recent_history: list[dict] = []
        self.last_analysis: AnalysisResult | None = None
        self._session_state = session_state
        self._pipeline_task = None  # Set via set_pipeline_task() after pipeline creation
        self._goodbye_task: asyncio.Task | None = None
        # Tracks whether Donna's TTS is currently producing audio frames.
        # Updated by BotStartedSpeakingFrame / BotStoppedSpeakingFrame.
        self._bot_speaking: bool = False
        self._bot_last_stopped_at: float | None = None

    def set_pipeline_task(self, task):
        """Set the pipeline task reference for programmatic call ending."""
        self._pipeline_task = task

    async def _try_transition_to_winding_down(self) -> bool:
        """Programmatically transition the flow to winding_down.

        Bypasses the LLM tool call (which is unreliable when the senior says
        a strong goodbye). Builds the winding_down node from
        the cached flows_tools + session_state and asks flow_manager to
        switch. Returns True on success, False if any prerequisite is
        missing (in which case the caller should fall back to EndFrame).
        """
        if not self._session_state:
            return False
        flow_manager = self._session_state.get("_flow_manager")
        flows_tools = self._session_state.get("_flow_tools")
        if flow_manager is None or not flows_tools:
            logger.warning(
                "[QuickObserver] Can't programmatically transition — "
                "flow_manager={fm} flow_tools={ft}",
                fm=flow_manager is not None,
                ft=bool(flows_tools),
            )
            return False
        try:
            from flows.nodes import build_winding_down_node
            node = build_winding_down_node(self._session_state, flows_tools)
            await flow_manager.set_node_from_config(node)
            logger.info(
                "[QuickObserver] Programmatic transition: main → winding_down"
            )
            if self._session_state is not None:
                self._session_state["_end_reason"] = "goodbye_detected_qo_transition"
            return True
        except Exception as e:
            logger.error(
                "[QuickObserver] Transition to winding_down failed: {err}",
                err=str(e),
            )
            return False

    async def _wait_until_bot_silent(self, *, max_wait: float) -> bool:
        """Wait until the bot is no longer speaking. Returns True if reached
        a silent state (with the POST_TTS_BUFFER_SECONDS buffer), False if
        we hit the cap while bot was still speaking."""
        import time as _t
        start = _t.time()
        # If bot hasn't started speaking yet, give it a brief moment to begin
        # (TTS pipeline takes ~100-500ms to first audio frame). Otherwise we'd
        # bail out before Donna gets a chance to speak.
        if not self._bot_speaking and self._bot_last_stopped_at is None:
            grace_end = _t.time() + 1.0
            while _t.time() < grace_end and not self._bot_speaking:
                await asyncio.sleep(self.TTS_IDLE_POLL_SECONDS)
        # Now wait for bot to stop speaking, capped at max_wait total.
        while _t.time() - start < max_wait:
            if not self._bot_speaking:
                # Got silence — let the final audio frame flush.
                await asyncio.sleep(self.POST_TTS_BUFFER_SECONDS)
                # Re-check: if Donna started speaking again during the buffer,
                # keep waiting (another turn of response generation).
                if not self._bot_speaking:
                    return True
            await asyncio.sleep(self.TTS_IDLE_POLL_SECONDS)
        return False

    async def _force_end_call(self):
        """End the call gracefully on detected goodbye.

        Strategy (replaces the old fixed-delay EndFrame):
          1. Try a programmatic transition to winding_down. The closing flow
             will speak its piece and emit end_conversation. No cutoff.
          2. If the transition succeeds, set a long max-wait safety net to
             EndFrame if the flow gets stuck.
          3. If the transition fails (no flow_manager/flow_tools available,
             or any error), wait for Donna to stop speaking, then fire
             EndFrame — preserves the original behavior but no longer cuts
             her off mid-sentence.
        """
        try:
            settings = (self._session_state or {}).get("call_settings") or {}
            initial_delay = settings.get("goodbye_delay_seconds", self.GOODBYE_DELAY_SECONDS)
            max_wait = settings.get("goodbye_max_wait_seconds", self.MAX_END_WAIT_SECONDS)

            # Phase 1: try programmatic transition immediately.
            transitioned = await self._try_transition_to_winding_down()

            if transitioned:
                # Closing node has post_actions=end_conversation; the flow
                # will end the call naturally. Set a long safety net just
                # in case the closing flow stalls.
                await asyncio.sleep(max_wait)
                if self._pipeline_task and (self._session_state or {}).get("_end_reason") != "user_hangup":
                    logger.warning(
                        "[QuickObserver] Winding-down took longer than {s}s — "
                        "force-ending as safety net",
                        s=max_wait,
                    )
                    if self._session_state is not None:
                        self._session_state["_end_reason"] = "goodbye_detected_safety_net"
                    await self._pipeline_task.queue_frame(EndFrame())
                return

            # Phase 2: fall back to wait-for-TTS-silent then EndFrame.
            logger.info(
                "[QuickObserver] Transition not available — falling back to "
                "TTS-aware EndFrame (delay={d}s, max_wait={m}s)",
                d=initial_delay,
                m=max_wait,
            )
            await asyncio.sleep(initial_delay)
            reached_silent = await self._wait_until_bot_silent(max_wait=max_wait)
            if not reached_silent:
                logger.warning(
                    "[QuickObserver] Bot still speaking after {s}s — force-ending anyway",
                    s=max_wait,
                )
            if self._pipeline_task:
                logger.info("[QuickObserver] Goodbye reached silent state — ending call")
                if self._session_state is not None:
                    self._session_state["_end_reason"] = "goodbye_detected"
                await self._pipeline_task.queue_frame(EndFrame())
            else:
                logger.warning("[QuickObserver] No pipeline_task set — cannot force end call")
        except asyncio.CancelledError:
            logger.info("[QuickObserver] Goodbye end-call timer cancelled")
        except Exception as e:
            logger.error("[QuickObserver] Error forcing call end: {err}", err=str(e))

    def _call_elapsed_seconds(self) -> float | None:
        started = (self._session_state or {}).get("_call_start_time")
        if started is None:
            return None
        try:
            import time
            return max(0.0, time.time() - float(started))
        except (TypeError, ValueError):
            return None

    async def process_frame(self, frame: Frame, direction):
        await super().process_frame(frame, direction)

        # Track bot-speaking state so _wait_until_bot_silent can do its job.
        # These frames originate downstream of the TTS service and are
        # observed here purely for goodbye-timing logic. Always pass through.
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            import time as _t
            self._bot_last_stopped_at = _t.time()

        if isinstance(frame, TranscriptionFrame):
            text = frame.text
            logger.debug("[QuickObserver] Transcription received chars={n}", n=len(text or ""))
            analysis = quick_analyze(text, self._recent_history)
            self.last_analysis = analysis

            # Expose analysis to session_state for prefetch engine
            if self._session_state is not None:
                self._session_state["_last_quick_analysis"] = analysis
                tracker = self._session_state.get("_conversation_tracker")
                if tracker and hasattr(tracker, "record_quick_observer_signals"):
                    tracker.record_quick_observer_signals(analysis)

            # Store current-turn token recommendation for Director. Clear it
            # when this turn has no recommendation so old response-length hints
            # do not leak into later unrelated turns.
            if self._session_state is not None:
                if analysis.token_recommendation:
                    self._session_state["_token_recommendation"] = analysis.token_recommendation
                else:
                    self._session_state.pop("_token_recommendation", None)

            # Track recent history for engagement detection
            self._recent_history.append({"role": "user", "content": text})
            if len(self._recent_history) > 10:
                self._recent_history = self._recent_history[-10:]

            # Stash guidance for the Director to inject in a single,
            # canonical place. Previously Quick Observer ALSO pushed a
            # ``LLMMessagesAppendFrame`` here, which caused a duplicate
            # injection — surfaced by the mock-call harness on 2026-05-24:
            # the Director's ``_strip_ephemeral_messages()`` runs *before*
            # the Quick Observer push has been applied to the LLM context
            # (the frames travel down the pipeline; the strip operates on
            # the materialized context). So strip missed the in-flight
            # Quick Observer message, the Director's reinject added a
            # fresh copy, and then the original push finally landed —
            # giving two identical ephemerals per turn.
            #
            # The fix is single-writer: Quick Observer ONLY stashes, the
            # Director ONLY injects. If the Director is disabled (feature
            # flag) the Director's ``_inject_observer_guidance()`` still
            # fires before the early return, so guidance still reaches
            # Claude. See conversation_director.py:_inject_observer_guidance.
            if analysis.guidance and self._session_state is not None:
                self._session_state["_pending_observer_guidance"] = analysis.guidance

            # PROGRAMMATIC GOODBYE: When strong goodbye is detected, transition to
            # winding_down first. The TTS-aware EndFrame path remains a fallback,
            # so we don't rely on the LLM to call transition tools.
            #
            # Consent calls are exempt: the persona is scripted to end with a
            # warm "bye now" right after agreeing/declining, and the QO racing
            # ahead can force the call to end before Donna calls
            # record_consent_response — losing the senior's answer entirely.
            # The consent closing node handles call termination via its
            # end_conversation post_action.
            call_type = (self._session_state or {}).get("call_type")
            if call_type == "consent":
                # Skip the entire programmatic-goodbye block for consent calls.
                pass
            elif analysis.goodbye_signals and self._goodbye_task is None:
                has_strong = any(g["strength"] == "strong" for g in analysis.goodbye_signals)
                if has_strong:
                    settings = (self._session_state or {}).get("call_settings") or {}
                    min_elapsed = settings.get(
                        "programmatic_goodbye_min_elapsed_seconds",
                        self.PROGRAMMATIC_GOODBYE_MIN_ELAPSED_SECONDS,
                    )
                    elapsed = self._call_elapsed_seconds()
                    if elapsed is not None and elapsed < min_elapsed:
                        logger.info(
                            "[QuickObserver] Strong goodbye before minimum elapsed ({e:.1f}s < {m:.1f}s); not forcing end",
                            e=elapsed,
                            m=min_elapsed,
                        )
                        await self.push_frame(frame, direction)
                        return
                    delay = settings.get("goodbye_delay_seconds", self.GOODBYE_DELAY_SECONDS)
                    logger.info(
                        "[QuickObserver] Strong goodbye detected signals={n} - scheduling forced end in {d}s",
                        n=len(analysis.goodbye_signals),
                        d=delay,
                    )
                    self._goodbye_task = asyncio.create_task(self._force_end_call())
                    # Signal to Director to suppress stale guidance + stamp the
                    # detection time so post-call analytics know when QO fired.
                    if self._session_state is not None:
                        self._session_state["_goodbye_in_progress"] = True
                        if not self._session_state.get("_goodbye_detected_at"):
                            import time as _t, datetime as _dt
                            self._session_state["_goodbye_detected_at"] = (
                                _dt.datetime.now(_dt.timezone.utc)
                            )

            # Cancel goodbye timer if senior keeps speaking (false goodbye)
            elif self._goodbye_task is not None and not self._goodbye_task.done():
                if not analysis.goodbye_signals:
                    logger.info("[QuickObserver] Senior still speaking — cancelling goodbye timer")
                    self._goodbye_task.cancel()
                    self._goodbye_task = None
                    if self._session_state is not None:
                        self._session_state["_goodbye_in_progress"] = False

        # Always pass frames through
        await self.push_frame(frame, direction)
