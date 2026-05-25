"""Conversation tracking processor.

Tracks topics discussed, questions asked, and advice given during a call
to prevent repetition. Port of extractConversationElements(),
trackTopicsFromSignals(), and getConversationTrackingSummary() from
pipelines/v1-advanced.js.

Sits in the pipeline after guidance stripping and reads both:
- TranscriptionFrame (user messages) → extract topic keywords
- TextFrame (LLM output) → extract questions and advice phrases
"""

import asyncio
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from loguru import logger
from pipecat.frames.frames import EndFrame, LLMFullResponseEndFrame, TextFrame, TranscriptionFrame
from pipecat.processors.frame_processor import FrameProcessor


# ---------------------------------------------------------------------------
# Topic extraction patterns (16 categories from user messages)
# ---------------------------------------------------------------------------

_TOPIC_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(garden(?:ing)?|plant(?:ing|s)?|flower(?:s)?)\b", re.I), "gardening"),
    (re.compile(r"\b(cook(?:ing)?|bak(?:ing)?|recipe(?:s)?|dinner|lunch|breakfast)\b", re.I), "cooking"),
    (re.compile(r"\b(walk(?:ing)?|exercise|yoga|swimming)\b", re.I), "exercise"),
    (re.compile(r"\b(read(?:ing)?|book(?:s)?|newspaper)\b", re.I), "reading"),
    (re.compile(r"\b(church|prayer|service|bible)\b", re.I), "faith"),
    (re.compile(r"\b(tv|television|show(?:s)?|movie(?:s)?|watch(?:ing)?)\b", re.I), "tv/movies"),
    (re.compile(r"\b(grandkid(?:s)?|grandchild(?:ren)?|grandson|granddaughter)\b", re.I), "grandchildren"),
    (re.compile(r"\b(son|daughter|brother|sister|husband|wife|family)\b", re.I), "family"),
    (re.compile(r"\b(weather|rain(?:ing)?|snow(?:ing)?|sunny|cold|hot)\b", re.I), "weather"),
    (re.compile(r"\b(sleep(?:ing)?|nap|rest(?:ing)?|tired)\b", re.I), "sleep"),
    (re.compile(r"\b(friend(?:s)?|neighbor(?:s)?|visitor(?:s)?|company)\b", re.I), "social"),
    (re.compile(r"\b(bird(?:s)?|cat(?:s)?|dog(?:s)?|pet(?:s)?)\b", re.I), "pets"),
    (re.compile(r"\b(music|sing(?:ing)?|radio|song(?:s)?)\b", re.I), "music"),
    (re.compile(r"\b(craft(?:s)?|knit(?:ting)?|sew(?:ing)?|puzzle(?:s)?)\b", re.I), "crafts"),
]

# Advice phrases in Donna's responses
_ADVICE_PATTERN = re.compile(
    r"(?:you should|try to|don't forget to|make sure to|remember to|how about)[^.!?]*",
    re.IGNORECASE,
)

# Max list sizes
_MAX_TOPICS = 10
_MAX_QUESTIONS = 8
_MAX_ADVICE = 8
_MAX_DIRECTOR_TRANSCRIPT_TURNS = 40


# ---------------------------------------------------------------------------
# Extraction helpers (pure functions, usable standalone)
# ---------------------------------------------------------------------------

def extract_topics(user_message: str) -> list[str]:
    """Extract topic keywords from a user message."""
    topics = []
    lower = user_message.lower()
    for pattern, label in _TOPIC_PATTERNS:
        if pattern.search(lower):
            topics.append(label)
    return topics


def extract_questions(response_text: str) -> list[str]:
    """Extract questions from Donna's response (sentences ending in ?)."""
    questions = []
    matches = re.findall(r"[^.!?]*\?", response_text)
    for q in matches:
        words = q.strip().split()[:5]
        if words:
            questions.append(" ".join(words))
    return questions


def extract_advice(response_text: str) -> list[str]:
    """Extract advice phrases from Donna's response."""
    advice = []
    for match in _ADVICE_PATTERN.finditer(response_text):
        words = match.group(0).strip().split()[:5]
        if words:
            advice.append(" ".join(words))
    return advice


def track_topics_from_signals(analysis_result, topics: list[str]) -> list[str]:
    """Add topic entries from Quick Observer signals.

    Args:
        analysis_result: AnalysisResult from quick_observer.quick_analyze()
        topics: Existing topics list (mutated in place and returned)
    """
    if getattr(analysis_result, "family_signals", None):
        if "family" not in topics:
            topics.append("family")

    for signal in getattr(analysis_result, "activity_signals", []):
        label = str(signal).lower().split()[:2]
        label = " ".join(label)
        if label and label not in topics:
            topics.append(label)

    if getattr(analysis_result, "emotion_signals", None):
        negatives = [e for e in analysis_result.emotion_signals if e.get("valence") == "negative"]
        if negatives and "emotions" not in topics:
            topics.append("emotions")

    return topics


def format_tracking_summary(
    topics: list[str],
    questions: list[str],
    advice: list[str],
) -> str | None:
    """Format conversation tracking as a system prompt section.

    Returns None if nothing has been tracked yet.
    """
    sections = []
    if topics:
        sections.append(f"- Topics discussed: {', '.join(topics)}")
    if questions:
        sections.append(f"- Questions you've asked: {'; '.join(questions)}")
    if advice:
        sections.append(f"- Advice you've given: {'; '.join(advice)}")

    if not sections:
        return None

    return (
        "CONVERSATION SO FAR THIS CALL (avoid repeating):\n"
        + "\n".join(sections)
        + "\nBuild on these topics rather than reintroducing them. Ask NEW questions."
    )


# ---------------------------------------------------------------------------
# Processor (sits in pipeline, reads frames passthrough)
# ---------------------------------------------------------------------------

@dataclass
class ConversationState:
    """Mutable state for a single call's conversation tracking."""
    topics_discussed: list[str] = field(default_factory=list)
    questions_asked: list[str] = field(default_factory=list)
    advice_given: list[str] = field(default_factory=list)


class ConversationTrackerProcessor(FrameProcessor):
    """Track conversation elements from both user and LLM frames.

    Place after the guidance stripper:
        ... → llm → guidance_stripper → conversation_tracker → tts → ...

    All frames pass through unchanged — this processor only observes.
    The tracked state is available via .state and .get_summary().

    If *session_state* is provided, also maintains a shared ``_transcript``
    list that the Conversation Director reads for bounded recent context.
    Full call history is kept separately in ``_full_transcript`` and, for
    production calls, persisted asynchronously as draft transcript data.
    """

    def __init__(
        self,
        session_state: dict | None = None,
        state: ConversationState | None = None,
        track_user: bool = True,
        track_assistant: bool = True,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.state = state or ConversationState()
        self._session_state = session_state
        self._track_user = track_user
        self._track_assistant = track_assistant
        self._assistant_buffer = ""
        if self._session_state is not None:
            self._session_state.setdefault(
                "_full_transcript",
                list(self._session_state.get("_transcript") or []),
            )

    def get_summary(self) -> str | None:
        """Get formatted tracking summary for system prompt injection."""
        return format_tracking_summary(
            self.state.topics_discussed,
            self.state.questions_asked,
            self.state.advice_given,
        )

    def get_topics(self) -> list[str]:
        """Get list of topics discussed so far (for mid-call memory refresh)."""
        return list(self.state.topics_discussed)

    def record_quick_observer_signals(self, analysis_result) -> None:
        """Record topics from Quick Observer analysis result."""
        track_topics_from_signals(analysis_result, self.state.topics_discussed)
        if len(self.state.topics_discussed) > _MAX_TOPICS:
            self.state.topics_discussed = self.state.topics_discussed[-_MAX_TOPICS:]

    def flush(self):
        """Flush any remaining buffered assistant text. Call before post-call."""
        if not self._track_assistant:
            return
        self._flush_assistant_buffer()

    async def flush_pending_persistence(self, timeout: float = 5.0) -> None:
        """Wait briefly for in-flight transcript draft writes to finish."""
        if self._session_state is None:
            return

        tasks = set(self._session_state.get("_transcript_persist_tasks") or ())
        if not tasks:
            return

        done, pending = await asyncio.wait(tasks, timeout=timeout)
        for task in done:
            try:
                task.result()
            except Exception:
                # The persistence task already logs sanitized failure details.
                pass

        if pending:
            logger.warning(
                "[{cs}] Transcript draft persistence still pending (count={n})",
                cs=self._session_state.get("call_sid", "unknown"),
                n=len(pending),
            )

    def _flush_assistant_buffer(self):
        """Flush buffered assistant text into shared transcript."""
        text = self._assistant_buffer.strip()
        if text and self._session_state is not None:
            self._record_turn("assistant", text)
        self._assistant_buffer = ""

    def _record_turn(self, role: str, content: str) -> None:
        """Record one completed turn in full and bounded transcript state."""
        if self._session_state is None:
            return

        seq = int(self._session_state.get("_transcript_turn_seq") or 0)
        self._session_state["_transcript_turn_seq"] = seq + 1

        call_start = self._session_state.get("_call_start_time")
        offset_ms = None
        if isinstance(call_start, (int, float)):
            offset_ms = max(0, int((time.time() - call_start) * 1000))

        turn = {
            "role": role,
            "content": content,
            "sequence": seq,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        if offset_ms is not None:
            turn["timestamp_offset_ms"] = offset_ms

        full_transcript = self._session_state.setdefault("_full_transcript", [])
        full_transcript.append(turn)

        director_transcript = self._session_state.setdefault("_transcript", [])
        director_transcript.append(turn)
        if len(director_transcript) > _MAX_DIRECTOR_TRANSCRIPT_TURNS:
            self._session_state["_transcript"] = director_transcript[-_MAX_DIRECTOR_TRANSCRIPT_TURNS:]

        self._schedule_transcript_persistence()

    def _schedule_transcript_persistence(self) -> None:
        """Persist a full transcript snapshot without blocking the audio path."""
        if self._session_state is None:
            return
        if not self._session_state.get("_transcript_persistence_enabled"):
            return

        call_sid = self._session_state.get("call_sid")
        if not call_sid or call_sid == "unknown":
            return

        snapshot = list(self._session_state.get("_full_transcript") or [])
        if not snapshot:
            return

        seq = int(self._session_state.get("_transcript_persist_seq") or 0) + 1
        self._session_state["_transcript_persist_seq"] = seq

        task = asyncio.create_task(self._persist_transcript_snapshot(call_sid, snapshot, seq))
        tasks = self._session_state.setdefault("_transcript_persist_tasks", set())
        tasks.add(task)
        task.add_done_callback(tasks.discard)

    async def _persist_transcript_snapshot(
        self,
        call_sid: str,
        snapshot: list[dict],
        seq: int,
    ) -> None:
        """Write the latest transcript snapshot if it has not been superseded."""
        assert self._session_state is not None
        lock = self._session_state.setdefault("_transcript_persist_lock", asyncio.Lock())

        async with lock:
            if seq != self._session_state.get("_transcript_persist_seq"):
                return

            try:
                from services.conversations import update_transcript
                await update_transcript(call_sid, snapshot)
            except Exception as e:
                logger.warning(
                    "[{cs}] Transcript draft persistence failed: {err}",
                    cs=call_sid,
                    err=str(e),
                )

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)

        # Flush remaining assistant buffer on call end so the last
        # bot utterance is included in the transcript for post-call analysis.
        if isinstance(frame, EndFrame):
            self._flush_assistant_buffer()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            self._flush_assistant_buffer()
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, TranscriptionFrame):
            # Flush any buffered assistant text from previous turn
            if self._track_assistant:
                self._flush_assistant_buffer()

            # Track user message in shared transcript
            if self._track_user and self._session_state is not None:
                self._record_turn("user", frame.text)

            # User message → extract topics
            if self._track_user:
                topics = extract_topics(frame.text)
                for t in topics:
                    if t not in self.state.topics_discussed:
                        self.state.topics_discussed.append(t)
                if len(self.state.topics_discussed) > _MAX_TOPICS:
                    self.state.topics_discussed = self.state.topics_discussed[-_MAX_TOPICS:]

        elif self._track_assistant and isinstance(frame, TextFrame):
            # Buffer assistant text (flushed when next TranscriptionFrame arrives)
            self._assistant_buffer += frame.text

            # LLM output → extract questions and advice
            text = frame.text
            questions = extract_questions(text)
            self.state.questions_asked.extend(questions)
            if len(self.state.questions_asked) > _MAX_QUESTIONS:
                self.state.questions_asked = self.state.questions_asked[-_MAX_QUESTIONS:]

            advice = extract_advice(text)
            self.state.advice_given.extend(advice)
            if len(self.state.advice_given) > _MAX_ADVICE:
                self.state.advice_given = self.state.advice_given[-_MAX_ADVICE:]

        await self.push_frame(frame, direction)
