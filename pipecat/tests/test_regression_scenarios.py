"""Regression tests: full pipeline simulation for all call scenarios.

Each test class runs a scripted scenario through the complete test pipeline
(Quick Observer → Director → MockLLM → Tracker → Stripper → MockTTS)
and validates conversation flow, pattern detection, topic tracking, and
call termination.

Marked with @pytest.mark.regression for selective test runs.
"""

import asyncio
import re
import time
import pytest
from unittest.mock import AsyncMock, patch

from tests.scenarios.happy_path import HAPPY_PATH_SCENARIO, HAPPY_PATH_LLM_RESPONSES
from tests.scenarios.goodbye_detection import (
    FALSE_GOODBYE_SCENARIO,
    STRONG_GOODBYE_SCENARIO,
)
from tests.scenarios.medication_reminder import (
    MEDICATION_REMINDER_SCENARIO,
    MEDICATION_REMINDER_LLM_RESPONSES,
)
from tests.scenarios.news_discussion import (
    NEWS_DISCUSSION_SCENARIO,
    NEWS_DISCUSSION_LLM_RESPONSES,
)
from tests.scenarios.emotional_support import (
    EMOTIONAL_SUPPORT_SCENARIO,
    EMOTIONAL_SUPPORT_LLM_RESPONSES,
)
from tests.scenarios.memory_recall import (
    MEMORY_RECALL_SCENARIO,
    MEMORY_RECALL_LLM_RESPONSES,
)
from tests.scenarios.long_call_timeout import (
    LONG_CALL_TIMEOUT_SCENARIO,
    LONG_CALL_TIMEOUT_LLM_RESPONSES,
)
from tests.helpers.pipeline_builder import build_test_pipeline
from tests.helpers.assertions import (
    assert_no_guidance_spoken,
    assert_topics_tracked,
)
from tests.conftest import make_transcription
from tests.mocks.mock_llm import ScriptedResponse


# ---------------------------------------------------------------------------
# Shared helper
# ---------------------------------------------------------------------------

async def _run_scenario(components, scenario):
    """Feed a scenario's utterances through the pipeline and wait for completion."""
    async def _inject():
        for utterance in scenario.utterances:
            if utterance.speaker == "senior":
                await asyncio.sleep(utterance.delay_seconds)
                await components.task.queue_frame(
                    make_transcription(utterance.text)
                )
                await asyncio.sleep(0.2)
        # Wait for goodbye EndFrame / timeout
        await asyncio.sleep(1.0)

    asyncio.create_task(_inject())
    await components.runner.run(components.task)


def _build_with_mocked_director(scenario, llm_responses, default_response="That sounds nice!"):
    """Build test pipeline with Director's analyze_turn mocked out."""
    session_state = scenario.to_session_state()
    session_state["_call_start_time"] = time.time() - 65

    mock_analyze_patcher = patch(
        "processors.conversation_director.analyze_turn_speculative",
        new_callable=AsyncMock,
    )
    mock_format_patcher = patch(
        "processors.conversation_director.format_director_guidance",
    )
    mock_analyze = mock_analyze_patcher.start()
    mock_format = mock_format_patcher.start()

    from services.director_llm import get_default_direction
    mock_analyze.return_value = get_default_direction()
    mock_format.return_value = "main/medium/warm"

    components = build_test_pipeline(
        session_state=session_state,
        llm_responses=llm_responses,
        default_llm_response=default_response,
    )
    # Speed up goodbye delay for tests
    components.quick_observer.GOODBYE_DELAY_SECONDS = 0.3

    return components, mock_analyze_patcher, mock_format_patcher


# ---------------------------------------------------------------------------
# Regression test classes
# ---------------------------------------------------------------------------

@pytest.mark.regression
class TestRegressionHappyPath:
    """Regression: normal check-in call."""

    @pytest.mark.asyncio
    async def test_happy_path_completes(self):
        components, p1, p2 = _build_with_mocked_director(
            HAPPY_PATH_SCENARIO, HAPPY_PATH_LLM_RESPONSES
        )
        try:
            await _run_scenario(components, HAPPY_PATH_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame
        assert_topics_tracked(
            components.conversation_tracker,
            HAPPY_PATH_SCENARIO.expect_topics,
        )
        assert_no_guidance_spoken(components.tts.full_text)


@pytest.mark.regression
class TestRegressionStrongGoodbye:
    """Regression: strong goodbye ends call quickly."""

    @pytest.mark.asyncio
    async def test_strong_goodbye_ends_call(self):
        components, p1, p2 = _build_with_mocked_director(
            STRONG_GOODBYE_SCENARIO,
            [
                ScriptedResponse(
                    trigger=re.compile(r"goodbye|bye", re.I),
                    response="Goodbye Margaret! Talk to you tomorrow!",
                ),
            ],
            default_response="Hello Margaret! How are you?",
        )
        try:
            await _run_scenario(components, STRONG_GOODBYE_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame


@pytest.mark.regression
class TestRegressionFalseGoodbye:
    """Regression: false goodbye does not end call prematurely."""

    @pytest.mark.asyncio
    async def test_false_goodbye_continues(self):
        components, p1, p2 = _build_with_mocked_director(
            FALSE_GOODBYE_SCENARIO,
            [
                ScriptedResponse(
                    trigger=re.compile(r"goodbye|bye|wait|forgot", re.I),
                    response="Oh of course! What did you want to tell me?",
                ),
                ScriptedResponse(
                    trigger=re.compile(r"doctor|appointment", re.I),
                    response="I'm glad your appointment went well!",
                ),
                ScriptedResponse(
                    trigger=re.compile(r"really|go|take care", re.I),
                    response="Take care, Margaret! Goodbye!",
                ),
            ],
        )
        try:
            await _run_scenario(components, FALSE_GOODBYE_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        # Call should eventually end (after the second, real goodbye)
        assert components.frame_capture.has_end_frame
        assert_no_guidance_spoken(components.tts.full_text)


@pytest.mark.regression
class TestRegressionMedicationReminder:
    """Regression: medication reminder call with acknowledgment."""

    @pytest.mark.asyncio
    async def test_medication_reminder_completes(self):
        components, p1, p2 = _build_with_mocked_director(
            MEDICATION_REMINDER_SCENARIO, MEDICATION_REMINDER_LLM_RESPONSES
        )
        try:
            # Verify reminder session state is populated
            ss = components.session_state
            assert ss["call_type"] == "reminder"
            assert ss["reminder_delivery"] is not None
            assert "metformin" in ss["reminder_delivery"]["title"].lower()

            await _run_scenario(components, MEDICATION_REMINDER_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame
        assert_topics_tracked(
            components.conversation_tracker,
            MEDICATION_REMINDER_SCENARIO.expect_topics,
        )
        assert_no_guidance_spoken(components.tts.full_text)


@pytest.mark.regression
class TestRegressionNewsDiscussion:
    """Regression: senior asks about news, triggers NEWS pattern."""

    @pytest.mark.asyncio
    async def test_news_discussion_completes(self):
        components, p1, p2 = _build_with_mocked_director(
            NEWS_DISCUSSION_SCENARIO, NEWS_DISCUSSION_LLM_RESPONSES
        )
        try:
            await _run_scenario(components, NEWS_DISCUSSION_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame
        assert_no_guidance_spoken(components.tts.full_text)

    @pytest.mark.asyncio
    async def test_news_pattern_detects_web_search(self):
        """The news utterance should trigger needs_web_search in Quick Observer."""
        from processors.quick_observer import quick_analyze

        result = quick_analyze("Have you heard what's in the news today?")
        assert result.needs_web_search, "NEWS pattern should set needs_web_search=True"
        assert len(result.news_signals) > 0, "Should detect news signals"


@pytest.mark.regression
class TestRegressionEmotionalSupport:
    """Regression: emotional support with loneliness and grief."""

    @pytest.mark.asyncio
    async def test_emotional_support_completes(self):
        components, p1, p2 = _build_with_mocked_director(
            EMOTIONAL_SUPPORT_SCENARIO, EMOTIONAL_SUPPORT_LLM_RESPONSES
        )
        try:
            await _run_scenario(components, EMOTIONAL_SUPPORT_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame
        assert_no_guidance_spoken(components.tts.full_text)

    @pytest.mark.asyncio
    async def test_emotion_patterns_detected(self):
        """Loneliness and grief utterances should trigger EMOTION patterns."""
        from processors.quick_observer import quick_analyze

        lonely = quick_analyze("I've been feeling quite lonely lately.")
        assert len(lonely.emotion_signals) > 0, "Should detect loneliness emotion"

        grief = quick_analyze("I miss him so much.")
        assert len(grief.emotion_signals) > 0, "Should detect grief emotion"


@pytest.mark.regression
class TestRegressionMemoryRecall:
    """Regression: senior references past conversations."""

    # Scenario.expect_topics references 'medical' which extract_topics no
    # longer emits per the medical-features deprecation (migration 014).
    @pytest.mark.skip(
        reason=(
            "Deprecated: scenario asserts 'medical' topic tracking which "
            "extract_topics no longer emits. See migration 014_deprecate."
        )
    )
    @pytest.mark.asyncio
    async def test_memory_recall_completes(self):
        components, p1, p2 = _build_with_mocked_director(
            MEMORY_RECALL_SCENARIO, MEMORY_RECALL_LLM_RESPONSES
        )
        try:
            await _run_scenario(components, MEMORY_RECALL_SCENARIO)
        finally:
            p1.stop()
            p2.stop()

        assert components.frame_capture.has_end_frame
        assert_topics_tracked(
            components.conversation_tracker,
            MEMORY_RECALL_SCENARIO.expect_topics,
        )
        assert_no_guidance_spoken(components.tts.full_text)

    @pytest.mark.skip(
        reason=(
            "Deprecated: AnalysisResult.health_signals removed per "
            "migration 014_deprecate. quick_analyze no longer surfaces "
            "health/medical pattern signals."
        )
    )
    @pytest.mark.asyncio
    async def test_health_pattern_detected(self):
        """Knee/arthritis mention used to trigger the HEALTH pattern."""
        from processors.quick_observer import quick_analyze

        result = quick_analyze("I've been having trouble with my knee, the doctor said it's arthritis.")
        assert len(result.health_signals) > 0, "Should detect health signals for knee/arthritis"


@pytest.mark.regression
class TestRegressionLongCallTimeout:
    """Regression: Director forces call end after time limit."""

    @pytest.mark.asyncio
    async def test_long_call_forces_end(self):
        """Simulates a long call by backdating _call_start_time.

        The Director's _take_actions() checks minutes_elapsed and
        schedules _delayed_end() when FORCE_END_MINUTES is exceeded.
        """
        session_state = LONG_CALL_TIMEOUT_SCENARIO.to_session_state()
        # Backdate call start to exceed FORCE_END_MINUTES (35 min)
        session_state["_call_start_time"] = time.time() - (36 * 60)

        with patch(
            "processors.conversation_director.analyze_turn_speculative",
            new_callable=AsyncMock,
        ) as mock_analyze, patch(
            "processors.conversation_director.format_director_guidance",
        ) as mock_format:
            from services.director_llm import get_default_direction
            mock_analyze.return_value = get_default_direction()
            mock_format.return_value = "main/medium/warm"

            components = build_test_pipeline(
                session_state=session_state,
                llm_responses=LONG_CALL_TIMEOUT_LLM_RESPONSES,
                default_llm_response="Tell me more!",
            )
            # Override the already-set _call_start_time from build_test_pipeline
            components.session_state["_call_start_time"] = time.time() - (36 * 60)
            # Pre-set guidance so _take_actions() fires on turn processing
            components.conversation_director._last_result = get_default_direction()
            components.quick_observer.GOODBYE_DELAY_SECONDS = 0.3

            # Shorten Director's delayed_end delay for faster test
            original_delayed_end = components.conversation_director._delayed_end

            async def fast_delayed_end(delay: float):
                await original_delayed_end(0.3)

            components.conversation_director._delayed_end = fast_delayed_end

            async def _inject():
                for utterance in LONG_CALL_TIMEOUT_SCENARIO.utterances:
                    if utterance.speaker == "senior":
                        await asyncio.sleep(utterance.delay_seconds)
                        await components.task.queue_frame(
                            make_transcription(utterance.text)
                        )
                        await asyncio.sleep(0.2)
                # Give Director time to force end
                await asyncio.sleep(2.0)

            asyncio.create_task(_inject())
            await components.runner.run(components.task)

        assert components.frame_capture.has_end_frame
