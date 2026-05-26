"""Tests for services/director_llm.py - Director LLM analysis (Groq + Gemini)."""

import json
import time
import pytest
from unittest.mock import patch, AsyncMock, MagicMock


class TestRepairJson:
    def test_removes_trailing_commas(self):
        from services.director_llm import _repair_json
        assert json.loads(_repair_json('{"a": 1,}')) == {"a": 1}

    def test_closes_unclosed_braces(self):
        from services.director_llm import _repair_json
        result = _repair_json('{"a": {"b": 1}')
        assert json.loads(result) == {"a": {"b": 1}}

    def test_closes_unclosed_brackets(self):
        from services.director_llm import _repair_json
        result = _repair_json('[1, 2, 3')
        assert json.loads(result) == [1, 2, 3]

    def test_valid_json_passthrough(self):
        from services.director_llm import _repair_json
        valid = '{"key": "value"}'
        assert _repair_json(valid) == valid


class TestExtractAndParseJson:
    def test_plain_json(self):
        from services.director_llm import _extract_and_parse_json
        result = _extract_and_parse_json('{"key": "value"}')
        assert result == {"key": "value"}

    def test_markdown_wrapped(self):
        from services.director_llm import _extract_and_parse_json
        result = _extract_and_parse_json('```json\n{"key": "value"}\n```')
        assert result == {"key": "value"}

    def test_empty_returns_none(self):
        from services.director_llm import _extract_and_parse_json
        assert _extract_and_parse_json("") is None
        assert _extract_and_parse_json("   ") is None

    def test_repairs_truncated(self):
        from services.director_llm import _extract_and_parse_json
        result = _extract_and_parse_json('{"a": 1,}')
        assert result == {"a": 1}


class TestFormatHistory:
    def test_empty_returns_call_just_started(self):
        from services.director_llm import _format_history
        assert _format_history([]) == "Call just started"

    def test_role_mapping(self):
        from services.director_llm import _format_history
        history = [
            {"role": "assistant", "content": "Hello!"},
            {"role": "user", "content": "Hi there"},
        ]
        result = _format_history(history)
        assert "DONNA: Hello!" in result
        assert "SENIOR: Hi there" in result

    def test_limits_to_6_messages(self):
        from services.director_llm import _format_history
        history = [{"role": "user", "content": f"msg {i}"} for i in range(15)]
        result = _format_history(history)
        lines = result.strip().split("\n")
        assert len(lines) == 6


class TestFormatReminders:
    def test_filters_delivered_by_title(self):
        from services.director_llm import _format_reminders
        reminders = [{"title": "Take pills", "description": "morning"}, {"title": "Dr visit", "description": "3pm"}]
        result = _format_reminders(reminders, {"Take pills"})
        assert "Take pills" not in result
        assert "Dr visit" in result

    def test_filters_delivered_by_id(self):
        from services.director_llm import _format_reminders
        reminders = [{"id": "r1", "title": "Take pills", "description": "morning"}]
        result = _format_reminders(reminders, {"r1"})
        assert result == "None"

    def test_none_when_all_delivered(self):
        from services.director_llm import _format_reminders
        reminders = [{"title": "Take pills", "description": "d"}]
        assert _format_reminders(reminders, {"Take pills"}) == "None"

    def test_shows_remaining(self):
        from services.director_llm import _format_reminders
        reminders = [{"title": "Walk", "description": "evening"}]
        result = _format_reminders(reminders, set())
        assert "Walk" in result


class TestBuildTurnContent:
    def test_returns_formatted_string(self):
        from services.director_llm import _build_turn_content
        session = {"senior": {"name": "Margaret"}, "_call_start_time": time.time()}
        result = _build_turn_content("Hello", session)
        assert "Margaret" in result
        assert "Hello" in result

    def test_uses_friend_when_no_name(self):
        from services.director_llm import _build_turn_content
        session = {"senior": {}, "_call_start_time": time.time()}
        result = _build_turn_content("Hello", session)
        assert "Friend" in result

    def test_includes_call_type(self):
        from services.director_llm import _build_turn_content
        session = {"senior": {"name": "Test"}, "_call_start_time": time.time(), "call_type": "new_customer"}
        result = _build_turn_content("Hello", session)
        assert "new_customer" in result

    def test_includes_location_city_and_state(self):
        from services.director_llm import _build_turn_content
        session = {
            "senior": {"name": "Margaret", "city": "Austin", "state": "Texas"},
            "_call_start_time": time.time(),
        }
        result = _build_turn_content("Hello", session)
        assert "Austin, Texas" in result

    def test_includes_location_unknown_when_missing(self):
        from services.director_llm import _build_turn_content
        session = {
            "senior": {"name": "Margaret"},
            "_call_start_time": time.time(),
        }
        result = _build_turn_content("Hello", session)
        assert "unknown location" in result

    def test_includes_today_date(self):
        from services.director_llm import _build_turn_content
        from datetime import datetime
        from services.time_context import get_timezone

        session = {
            "senior": {"name": "Margaret"},
            "_call_start_time": time.time(),
        }
        result = _build_turn_content("Hello", session)
        expected = datetime.now(get_timezone(None)).strftime("%B %d, %Y")
        assert expected in result


class TestGetDefaultDirection:
    def test_has_all_required_keys(self):
        from services.director_llm import get_default_direction
        d = get_default_direction()
        assert "analysis" in d
        assert "direction" in d
        assert "reminder" in d
        assert "guidance" in d

    def test_analysis_has_required_fields(self):
        from services.director_llm import get_default_direction
        a = get_default_direction()["analysis"]
        for key in ["call_phase", "engagement_level", "current_topic", "emotional_tone", "turns_on_current_topic"]:
            assert key in a


class TestFormatDirectorGuidance:
    def test_returns_none_for_empty(self):
        from services.director_llm import format_director_guidance
        assert format_director_guidance(None) is None
        assert format_director_guidance({}) is None

    def test_closing_phase(self):
        from services.director_llm import format_director_guidance
        d = {"analysis": {"call_phase": "closing", "engagement_level": "medium", "emotional_tone": "neutral"}, "guidance": {"tone": "warm"}}
        result = format_director_guidance(d)
        assert "CLOSING" in result

    def test_winding_down_phase(self):
        from services.director_llm import format_director_guidance
        d = {"analysis": {"call_phase": "winding_down", "engagement_level": "medium", "emotional_tone": "neutral"}, "guidance": {"tone": "warm"}}
        result = format_director_guidance(d)
        assert "WINDING DOWN" in result

    def test_reminder_delivery(self):
        from services.director_llm import format_director_guidance
        d = {
            "analysis": {"call_phase": "main", "engagement_level": "high", "emotional_tone": "positive"},
            "guidance": {"tone": "warm"},
            "reminder": {"should_deliver": True, "which_reminder": "Take medication", "delivery_approach": "after positive moment"},
        }
        result = format_director_guidance(d)
        assert "REMIND" in result
        assert "Take medication" in result

    def test_low_engagement(self):
        from services.director_llm import format_director_guidance
        d = {"analysis": {"call_phase": "main", "engagement_level": "low", "emotional_tone": "neutral"}, "guidance": {"tone": "warm"}, "reminder": {"should_deliver": False}}
        result = format_director_guidance(d)
        assert "RE-ENGAGE" in result

    def test_topic_shift(self):
        from services.director_llm import format_director_guidance
        d = {
            "analysis": {"call_phase": "main", "engagement_level": "medium", "emotional_tone": "neutral"},
            "guidance": {"tone": "warm", "specific_instruction": ""},
            "reminder": {"should_deliver": False},
            "direction": {"stay_or_shift": "transition", "next_topic": "grandchildren"},
        }
        result = format_director_guidance(d)
        assert "SHIFT to grandchildren" in result

    def test_emotional_tone_markers(self):
        from services.director_llm import format_director_guidance
        d = {"analysis": {"call_phase": "main", "engagement_level": "medium", "emotional_tone": "sad"}, "guidance": {"tone": "empathetic"}, "reminder": {"should_deliver": False}}
        result = format_director_guidance(d)
        assert "(sad)" in result

    def test_instruction_truncation(self):
        from services.director_llm import format_director_guidance
        long_instr = "A" * 100
        d = {
            "analysis": {"call_phase": "main", "engagement_level": "medium", "emotional_tone": "neutral"},
            "guidance": {"tone": "warm", "specific_instruction": long_instr},
            "reminder": {"should_deliver": False},
            "direction": {"stay_or_shift": "stay"},
        }
        result = format_director_guidance(d)
        parts = result.split(" | ")
        assert len(parts[-1]) <= 60

    def test_filters_stage_directions(self):
        from services.director_llm import format_director_guidance
        d = {
            "analysis": {"call_phase": "main", "engagement_level": "medium", "emotional_tone": "neutral"},
            "guidance": {"tone": "warm", "specific_instruction": "Laugh warmly and show empathy"},
            "reminder": {"should_deliver": False},
            "direction": {"stay_or_shift": "stay"},
        }
        result = format_director_guidance(d)
        assert "Laugh" not in (result or "")


class TestGroqAvailable:
    def test_returns_false_without_key(self):
        from services.director_llm import groq_available
        with patch.dict("os.environ", {}, clear=True):
            assert groq_available() is False

    def test_returns_true_with_key(self):
        from services.director_llm import groq_available
        with patch.dict("os.environ", {"GROQ_API_KEY": "test-key"}):
            assert groq_available() is True


class TestGroqAnalyze:
    @pytest.mark.asyncio
    async def test_returns_none_without_client(self):
        from services.director_llm import _groq_analyze, _groq_breaker
        with patch("services.director_llm._get_groq_client", return_value=None):
            result = await _groq_analyze("test content", _groq_breaker)
            assert result is None

    @pytest.mark.asyncio
    async def test_parses_valid_json_response(self):
        from services.director_llm import _groq_analyze, _groq_breaker
        direction = {
            "analysis": {"call_phase": "main", "engagement_level": "high"},
            "direction": {},
            "reminder": {},
            "guidance": {},
        }

        mock_choice = MagicMock()
        mock_choice.message.content = json.dumps(direction)
        mock_response = MagicMock()
        mock_response.choices = [mock_choice]

        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)

        with patch("services.director_llm._get_groq_client", return_value=mock_client):
            result = await _groq_analyze("test", _groq_breaker)
            assert result["analysis"]["call_phase"] == "main"


class TestAnalyzeTurn:
    @pytest.mark.asyncio
    async def test_returns_default_without_any_provider(self):
        from services.director_llm import analyze_turn, get_default_direction
        with patch("services.director_llm.groq_available", return_value=False), \
             patch("services.director_llm._gemini_analyze", new_callable=AsyncMock, return_value=None):
            result = await analyze_turn("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result == get_default_direction()

    @pytest.mark.asyncio
    async def test_groq_primary_gemini_fallback(self):
        from services.director_llm import analyze_turn
        gemini_direction = {
            "analysis": {"call_phase": "main", "engagement_level": "medium", "emotional_tone": "neutral"},
            "direction": {},
            "reminder": {},
            "guidance": {},
        }
        with patch("services.director_llm.groq_available", return_value=True), \
             patch("services.director_llm._groq_analyze", new_callable=AsyncMock, return_value=None), \
             patch("services.director_llm._gemini_analyze", new_callable=AsyncMock, return_value=gemini_direction):
            result = await analyze_turn("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result["analysis"]["engagement_level"] == "medium"

    @pytest.mark.asyncio
    async def test_groq_used_when_available(self):
        from services.director_llm import analyze_turn
        groq_direction = {
            "analysis": {"call_phase": "main", "engagement_level": "high", "emotional_tone": "positive"},
            "direction": {},
            "reminder": {},
            "guidance": {},
        }
        with patch("services.director_llm.groq_available", return_value=True), \
             patch("services.director_llm._groq_analyze", new_callable=AsyncMock, return_value=groq_direction), \
             patch("services.director_llm._gemini_analyze", new_callable=AsyncMock) as mock_gemini:
            result = await analyze_turn("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result["analysis"]["engagement_level"] == "high"
            mock_gemini.assert_not_called()

    @pytest.mark.asyncio
    async def test_gemini_only_without_groq(self):
        from services.director_llm import analyze_turn
        gemini_direction = {
            "analysis": {"call_phase": "opening", "engagement_level": "medium", "emotional_tone": "neutral"},
            "direction": {},
            "reminder": {},
            "guidance": {},
        }
        with patch("services.director_llm.groq_available", return_value=False), \
             patch("services.director_llm._gemini_analyze", new_callable=AsyncMock, return_value=gemini_direction):
            result = await analyze_turn("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result["analysis"]["call_phase"] == "opening"


class TestAnalyzeTurnSpeculative:
    @pytest.mark.asyncio
    async def test_returns_none_without_groq(self):
        from services.director_llm import analyze_turn_speculative
        with patch("services.director_llm.groq_available", return_value=False):
            result = await analyze_turn_speculative("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result is None

    @pytest.mark.asyncio
    async def test_returns_result_with_groq(self):
        from services.director_llm import analyze_turn_speculative
        direction = {
            "analysis": {"call_phase": "main", "engagement_level": "high"},
            "direction": {},
            "reminder": {},
            "guidance": {},
        }
        with patch("services.director_llm.groq_available", return_value=True), \
             patch("services.director_llm._groq_analyze", new_callable=AsyncMock, return_value=direction):
            result = await analyze_turn_speculative("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result["analysis"]["engagement_level"] == "high"

    @pytest.mark.asyncio
    async def test_returns_none_on_failure(self):
        from services.director_llm import analyze_turn_speculative
        with patch("services.director_llm.groq_available", return_value=True), \
             patch("services.director_llm._groq_analyze", new_callable=AsyncMock, side_effect=Exception("fail")):
            result = await analyze_turn_speculative("hello", {"senior": {"name": "Test"}, "_call_start_time": time.time()})
            assert result is None
