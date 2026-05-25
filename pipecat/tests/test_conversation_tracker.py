"""Tests for conversation tracking — topic, question, and advice extraction."""

import pytest

from processors.conversation_tracker import (
    extract_topics,
    extract_questions,
    extract_advice,
    format_tracking_summary,
    ConversationState,
)


# medical/health_concerns topics were removed when Donna stopped classifying
# medical content per docs/plans/2026-05-17-senior-consent-verification-flow.md.
_DEPRECATED_MEDICAL_TOPIC = pytest.mark.skip(
    reason="Deprecated: extract_topics no longer emits medical/health_concerns categories."
)


class TestTopicExtraction:
    def test_gardening_topic(self):
        topics = extract_topics("I was out gardening this morning")
        assert "gardening" in topics

    @_DEPRECATED_MEDICAL_TOPIC
    def test_medical_topic(self):
        topics = extract_topics("I have a doctor appointment tomorrow")
        assert "medical" in topics

    def test_family_topic(self):
        topics = extract_topics("My daughter visited last weekend")
        assert "family" in topics

    def test_weather_topic(self):
        topics = extract_topics("The weather has been really cold")
        assert "weather" in topics

    def test_multiple_topics(self):
        topics = extract_topics("My grandson helped me in the garden and we watched a movie")
        assert "grandchildren" in topics
        assert "gardening" in topics
        assert "tv/movies" in topics

    def test_no_topics(self):
        topics = extract_topics("I'm doing fine thank you")
        assert len(topics) == 0

    @_DEPRECATED_MEDICAL_TOPIC
    def test_health_concerns(self):
        topics = extract_topics("I've been having some pain in my knee")
        assert "health concerns" in topics

    def test_social_topic(self):
        topics = extract_topics("My neighbor came over for tea")
        assert "social" in topics

    def test_case_insensitive(self):
        topics = extract_topics("GARDENING is my favorite hobby")
        assert "gardening" in topics


class TestQuestionExtraction:
    def test_single_question(self):
        questions = extract_questions("How was your day today?")
        assert len(questions) == 1

    def test_multiple_questions(self):
        questions = extract_questions("How are you? Did you eat lunch? What about dinner?")
        assert len(questions) == 3

    def test_no_questions(self):
        questions = extract_questions("That sounds wonderful, tell me more.")
        assert len(questions) == 0

    def test_question_truncated(self):
        questions = extract_questions("What did you think about the new medication your doctor prescribed last week?")
        assert len(questions) == 1
        # Should be truncated to first 5 words
        assert len(questions[0].split()) <= 5


class TestAdviceExtraction:
    def test_should_advice(self):
        advice = extract_advice("You should try to get some rest")
        assert len(advice) == 1

    def test_remember_advice(self):
        advice = extract_advice("Remember to take your medication at noon")
        assert len(advice) == 1

    def test_no_advice(self):
        advice = extract_advice("That sounds lovely")
        assert len(advice) == 0

    def test_multiple_advice(self):
        advice = extract_advice("You should rest. Try to eat well. Don't forget to call your daughter.")
        assert len(advice) >= 2


class TestTrackingSummary:
    def test_full_summary(self):
        summary = format_tracking_summary(
            topics=["gardening", "family"],
            questions=["How are you"],
            advice=["You should rest"],
        )
        assert summary is not None
        assert "gardening" in summary
        assert "CONVERSATION SO FAR" in summary

    def test_empty_returns_none(self):
        summary = format_tracking_summary([], [], [])
        assert summary is None

    def test_topics_only(self):
        summary = format_tracking_summary(
            topics=["weather"],
            questions=[],
            advice=[],
        )
        assert summary is not None
        assert "weather" in summary


class TestConversationState:
    def test_initial_state_empty(self):
        state = ConversationState()
        assert len(state.topics_discussed) == 0
        assert len(state.questions_asked) == 0
        assert len(state.advice_given) == 0

    def test_state_mutation(self):
        state = ConversationState()
        state.topics_discussed.append("gardening")
        state.questions_asked.append("How are you")
        assert len(state.topics_discussed) == 1
        assert len(state.questions_asked) == 1
