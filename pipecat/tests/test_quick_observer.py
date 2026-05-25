"""Tests for Quick Observer — regex-based analysis engine."""

import pytest

from processors.quick_observer import quick_analyze


# Donna no longer classifies medical/health/safety concerns (see
# docs/plans/2026-05-17-senior-consent-verification-flow.md and migration
# 014_deprecate_medical_notes_and_concern_alerts). The AnalysisResult dropped
# its health_signals attribute and quick_analyze stopped emitting
# health/medical guidance. The tests below assert that removed behavior.
# Keeping the source for historical reference; @pytest.mark.skip lets them
# coexist with the suite without blocking CI.
_DEPRECATED_MEDICAL = pytest.mark.skip(
    reason=(
        "Deprecated: medical/health/concern features removed per "
        "docs/plans/2026-05-17-senior-consent-verification-flow.md. "
        "AnalysisResult no longer carries health_signals; quick_analyze "
        "no longer emits health-keyed guidance."
    )
)


@_DEPRECATED_MEDICAL
class TestHealthPatterns:
    def test_pain_detection(self):
        result = quick_analyze("My back is really hurting today")
        assert any("pain" in s["signal"] or "back" in s["signal"] for s in result.health_signals)

    def test_fall_detection_high_severity(self):
        result = quick_analyze("I fell in the bathroom yesterday")
        assert any("fall" in s["signal"] for s in result.health_signals)

    def test_dizziness_detection(self):
        result = quick_analyze("I've been feeling dizzy all morning")
        assert any("dizz" in s["signal"] for s in result.health_signals)

    def test_cardiovascular(self):
        result = quick_analyze("I had some chest pain last night")
        assert any("cardio" in s["signal"] or "chest" in s["signal"] or "pain" in s["signal"]
                    for s in result.health_signals)

    def test_eating_detection(self):
        result = quick_analyze("I had a nice breakfast this morning")
        assert any("eating" in s["signal"] for s in result.health_signals)

    def test_no_health_signals(self):
        result = quick_analyze("The weather is lovely today")
        assert len(result.health_signals) == 0


class TestGoodbyeDetection:
    def test_strong_goodbye(self):
        result = quick_analyze("Bye bye, talk to you later!")
        assert len(result.goodbye_signals) > 0
        assert any(s["strength"] == "strong" for s in result.goodbye_signals)

    def test_take_care_goodbye(self):
        result = quick_analyze("Alright, take care now")
        assert len(result.goodbye_signals) > 0
        assert all(s["strength"] == "weak" for s in result.goodbye_signals)

    def test_single_bye_is_weak(self):
        result = quick_analyze("Bye")
        assert len(result.goodbye_signals) > 0
        assert all(s["strength"] == "weak" for s in result.goodbye_signals)

    def test_goodbye_with_continuation_is_weak(self):
        result = quick_analyze("Alright, goodbye... Oh wait, I forgot to tell you something!")
        assert len(result.goodbye_signals) > 0
        assert all(s["strength"] == "weak" for s in result.goodbye_signals)

    def test_no_goodbye(self):
        result = quick_analyze("Tell me more about that")
        assert len(result.goodbye_signals) == 0


class TestEmotionPatterns:
    def test_loneliness_detected(self):
        result = quick_analyze("Nobody has visited me in weeks")
        assert len(result.emotion_signals) > 0

    def test_positive_emotion(self):
        result = quick_analyze("I'm feeling wonderful today")
        assert len(result.emotion_signals) > 0

    def test_neutral_no_emotion(self):
        result = quick_analyze("I had lunch at noon")
        assert len(result.emotion_signals) == 0


class TestCognitivePatterns:
    @_DEPRECATED_MEDICAL
    def test_memory_mention(self):
        result = quick_analyze("I can't remember what day it is")
        # Memory patterns were categorized as health signals (memory_mention)
        assert any("memory" in s["signal"] for s in result.health_signals)


class TestActivityPatterns:
    def test_gardening(self):
        result = quick_analyze("I was out gardening this morning")
        assert len(result.activity_signals) > 0

    @_DEPRECATED_MEDICAL
    def test_cooking_is_eating(self):
        result = quick_analyze("I made some soup for dinner")
        # Cooking/eating was categorized as health signals (eating)
        assert any("eating" in s["signal"] for s in result.health_signals)


class TestTokenRecommendation:
    @_DEPRECATED_MEDICAL
    def test_health_boosts_tokens(self):
        result = quick_analyze("I fell and hurt my knee badly")
        assert result.token_recommendation is not None
        assert result.token_recommendation["max_tokens"] >= 150

    def test_normal_baseline(self):
        result = quick_analyze("The weather is nice")
        # Normal text should have no token_recommendation or a default
        if result.token_recommendation:
            assert result.token_recommendation["max_tokens"] <= 150
        else:
            assert result.token_recommendation is None

    def test_emotional_support_tokens(self):
        result = quick_analyze("I'm so lonely, nobody ever calls me")
        assert result.token_recommendation is not None
        assert result.token_recommendation["max_tokens"] >= 200


class TestGuidanceBuild:
    @_DEPRECATED_MEDICAL
    def test_health_generates_guidance(self):
        result = quick_analyze("My head has been aching")
        assert result.guidance is not None
        assert len(result.guidance) > 0

    def test_no_signals_no_guidance(self):
        result = quick_analyze("Hello there")
        # May or may not have guidance depending on default behavior
        # Just verify no crash


class TestEdgeCases:
    def test_empty_string(self):
        result = quick_analyze("")
        assert result is not None

    def test_very_long_input(self):
        result = quick_analyze("word " * 1000)
        assert result is not None

    def test_special_characters(self):
        result = quick_analyze("He said 'don't worry' and that's fine!")
        assert result is not None

    @_DEPRECATED_MEDICAL
    def test_multiple_signals(self):
        result = quick_analyze("I fell and I'm lonely and my medication is wrong")
        assert len(result.health_signals) > 0
        assert len(result.emotion_signals) > 0
