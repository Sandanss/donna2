"""Legacy goodbye gate processor — false-goodbye grace period.

Prevents premature call termination when the senior says goodbye but then
continues talking. Implements a 4-second silence timer:

1. Quick Observer detects goodbye signal → timer starts
2. If senior speaks during the timer → cancel timer, continue call
3. If 4 seconds of silence pass → trigger closing transition

Port of initiateCallEnding() / cancelCallEnding() from v1-advanced.js. This
processor is not assembled in the active `bot.py` pipeline; Quick Observer now
owns programmatic goodbye transitions and TTS-aware EndFrame fallback.

In the Pipecat Flows architecture, the closing transition happens via
the Flow's transition tools, not via provider REST APIs.
The closing node's `post_actions: [{type: "end_conversation"}]` triggers
pipeline shutdown, and the active telephony serializer terminates the call.
"""

from __future__ import annotations

import asyncio

from loguru import logger
from pipecat.frames.frames import TranscriptionFrame, TextFrame, EndFrame
from pipecat.processors.frame_processor import FrameProcessor


GOODBYE_SILENCE_SECONDS = 4.0


class GoodbyeGateProcessor(FrameProcessor):
    """Gate goodbye transitions behind a silence timer.

    Place after Quick Observer in the pipeline. Observes:
    - TranscriptionFrame: if the senior speaks, cancel any pending timer
    - TextFrame: track when Donna responds (for mutual goodbye detection)

    When both senior and Donna have said goodbye and silence holds for
    4 seconds, calls the provided `on_goodbye` callback.

    Usage:
        async def handle_goodbye():
            # Trigger flow transition to closing node
            ...

        gate = GoodbyeGateProcessor(on_goodbye=handle_goodbye)
    """

    def __init__(self, on_goodbye=None, **kwargs):
        super().__init__(**kwargs)
        self._on_goodbye = on_goodbye
        self._senior_said_goodbye = False
        self._donna_said_goodbye = False
        self._ending_initiated = False
        self._timer_task: asyncio.Task | None = None

    @property
    def is_ending(self) -> bool:
        """Whether a goodbye timer is currently active."""
        return self._ending_initiated

    def notify_goodbye_detected(self, is_strong: bool = False) -> None:
        """Called by the Quick Observer when goodbye signals are detected.

        Args:
            is_strong: Whether this was a strong goodbye signal (e.g., "bye bye")
                       vs. a weak one (e.g., "I should let you go").
        """
        self._senior_said_goodbye = True
        if is_strong:
            logger.info("Strong goodbye detected from senior")

    def notify_donna_goodbye(self) -> None:
        """Called when Donna's response contains a goodbye.

        Check for goodbye in TextFrames (LLM output) before TTS.
        """
        self._donna_said_goodbye = True

    def _initiate_ending(self) -> None:
        """Start the 4-second silence timer."""
        if self._ending_initiated:
            return

        self._ending_initiated = True
        logger.info("Goodbye gate: timer started ({s}s)", s=GOODBYE_SILENCE_SECONDS)

        async def _timer():
            try:
                await asyncio.sleep(GOODBYE_SILENCE_SECONDS)
                if self._ending_initiated and self._on_goodbye:
                    logger.info("Goodbye gate: silence held, triggering closing")
                    await self._on_goodbye()
            except asyncio.CancelledError:
                pass

        self._timer_task = asyncio.create_task(_timer())

    def _cancel_ending(self) -> None:
        """Cancel the pending goodbye timer."""
        if self._timer_task and not self._timer_task.done():
            self._timer_task.cancel()
            self._timer_task = None

        if self._ending_initiated:
            logger.info("Goodbye gate: timer cancelled (senior spoke)")

        self._ending_initiated = False
        self._senior_said_goodbye = False
        self._donna_said_goodbye = False

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)

        if isinstance(frame, TranscriptionFrame):
            # Senior spoke — cancel any pending goodbye timer
            if self._ending_initiated:
                self._cancel_ending()

        elif isinstance(frame, TextFrame):
            # Check if Donna is saying goodbye
            text_lower = frame.text.lower()
            goodbye_words = ("goodbye", "bye bye", "bye", "take care", "talk to you")
            if any(w in text_lower for w in goodbye_words):
                self.notify_donna_goodbye()

            # If both sides have said goodbye, start the timer
            if self._senior_said_goodbye and self._donna_said_goodbye:
                self._initiate_ending()

        await self.push_frame(frame, direction)

    async def cleanup(self):
        """Cancel timer on cleanup."""
        self._cancel_ending()
        await super().cleanup()
