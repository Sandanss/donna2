"""Validation tests for simulation scenario definitions.

Pure-data tests — no database, no LLM, no network.  Verifies that each
scenario factory returns a well-formed ``LiveSimScenario`` with the
expected goals, tool expectations, and sensible defaults.
"""

from __future__ import annotations

from tests.simulation.caller import CallerGoal, CallerPersona
from tests.simulation.fixtures import TestSenior
from tests.simulation.scenarios import (
    LiveSimScenario,
    consent_decline_scenario,
    consent_grant_scenario,
    consent_mock_call_scenarios,
    discovery_mock_call_scenarios,
    discovery_scenario,
    memory_recall_scenario,
    memory_seed_scenario,
    reminder_scenario,
    web_search_scenario,
)


# ---------------------------------------------------------------------------
# Web search scenario
# ---------------------------------------------------------------------------


class TestWebSearchScenario:
    def test_has_goals(self):
        s = web_search_scenario()
        assert len(s.goals) >= 2, "Should have at least weather + sports goals"

    def test_expects_web_search_tool(self):
        s = web_search_scenario()
        assert "web_search" in s.expect_tool_calls

    def test_max_turns(self):
        s = web_search_scenario()
        assert s.max_turns == 10

    def test_call_type_is_checkin(self):
        s = web_search_scenario()
        assert s.call_type == "check-in"

    def test_has_name_and_description(self):
        s = web_search_scenario()
        assert s.name == "web_search"
        assert len(s.description) > 0


# ---------------------------------------------------------------------------
# Memory scenarios (seed + recall)
# ---------------------------------------------------------------------------


class TestMemoryScenarios:
    def test_seed_has_goals(self):
        s = memory_seed_scenario()
        assert len(s.goals) >= 2, "Should have family update goals"

    def test_seed_expects_post_call_analysis(self):
        s = memory_seed_scenario()
        assert s.expect_post_call_analysis is True

    def test_seed_max_turns(self):
        s = memory_seed_scenario()
        assert s.max_turns == 8

    def test_recall_has_goals(self):
        s = memory_recall_scenario()
        assert len(s.goals) >= 2, "Should have recall + mention goals"

    def test_recall_expects_memories_injected(self):
        s = memory_recall_scenario()
        assert s.expect_memories_injected is True

    def test_recall_max_turns(self):
        s = memory_recall_scenario()
        assert s.max_turns == 8

    def test_both_use_same_senior_name(self):
        seed = memory_seed_scenario()
        recall = memory_recall_scenario()
        assert seed.senior.name == recall.senior.name

    def test_seed_goals_mention_jake_and_florida(self):
        s = memory_seed_scenario()
        goal_text = " ".join(g.description for g in s.goals)
        assert "Jake" in goal_text or "jake" in goal_text.lower()
        assert "Florida" in goal_text or "florida" in goal_text.lower()

    def test_recall_goals_reference_previous_info(self):
        s = memory_recall_scenario()
        goal_text = " ".join(g.description for g in s.goals)
        assert "Jake" in goal_text or "jake" in goal_text.lower()
        assert "Florida" in goal_text or "florida" in goal_text.lower()


# ---------------------------------------------------------------------------
# Reminder scenario
# ---------------------------------------------------------------------------


class TestReminderScenario:
    def test_has_reminder_title(self):
        s = reminder_scenario()
        assert s.reminder_title is not None
        assert "porch plants" in s.reminder_title.lower()

    def test_has_reminder_description(self):
        s = reminder_scenario()
        assert s.reminder_description is not None
        assert "dinner" in s.reminder_description.lower()

    def test_expects_mark_reminder_acknowledged(self):
        s = reminder_scenario()
        assert "mark_reminder_acknowledged" in s.expect_tool_calls

    def test_call_type_is_reminder(self):
        s = reminder_scenario()
        assert s.call_type == "reminder"

    def test_max_turns(self):
        s = reminder_scenario()
        assert s.max_turns == 8

    def test_has_goals(self):
        s = reminder_scenario()
        assert len(s.goals) >= 2


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------


class TestScenarioDefaults:
    def test_default_senior(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert isinstance(s.senior, TestSenior)
        assert s.senior.name == "Margaret Simulation"

    def test_default_persona(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert isinstance(s.persona, CallerPersona)
        assert s.persona.name == "Margaret Johnson"

    def test_default_call_type(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.call_type == "check-in"

    def test_default_max_turns(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.max_turns == 12

    def test_default_goals_empty(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.goals == []

    def test_default_no_reminder(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.reminder_title is None
        assert s.reminder_description is None

    def test_default_expect_tool_calls_empty(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.expect_tool_calls == []

    def test_default_no_audio_required(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.requires_audio is False

    def test_default_expect_post_call_analysis(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.expect_post_call_analysis is True

    def test_default_no_memories_expected(self):
        s = LiveSimScenario(name="test", description="test scenario")
        assert s.expect_memories_injected is False

    def test_mutable_defaults_are_independent(self):
        """Verify that list defaults are not shared across instances."""
        a = LiveSimScenario(name="a", description="a")
        b = LiveSimScenario(name="b", description="b")
        a.goals.append(CallerGoal(description="test"))
        assert len(b.goals) == 0, "Mutable default should not be shared"


# ---------------------------------------------------------------------------
# Consent + Discovery scenarios
# ---------------------------------------------------------------------------


def _assert_scenario_is_well_formed(s: LiveSimScenario):
    assert s.name
    assert s.description
    assert s.call_type
    assert s.max_turns >= 2
    assert s.goals, f"{s.name} should define caller goals"
    for goal in s.goals:
        assert goal.description
        assert goal.trigger_phrase, f"{s.name} goal missing trigger_phrase"


def _scenario_names(scenarios: list[LiveSimScenario]) -> set[str]:
    return {s.name for s in scenarios}


class TestConsentGrantScenario:
    def test_call_type_is_consent(self):
        s = consent_grant_scenario()
        assert s.call_type == "consent"

    def test_expects_record_consent_response(self):
        s = consent_grant_scenario()
        assert "record_consent_response" in s.expect_tool_calls

    def test_has_combined_grant_goal(self):
        """Single-decision: one combined consent answer covering call + recording."""
        s = consent_grant_scenario()
        text = " ".join(g.trigger_phrase or "" for g in s.goals).lower()
        # The combined "yes" should mention both calling AND recording in one breath
        assert "record" in text, "Combined-grant goal should reference recording"
        # Goodbye is the last goal
        assert "bye" in (s.goals[-1].trigger_phrase or "").lower()


class TestConsentDeclineScenario:
    def test_call_type_is_consent(self):
        s = consent_decline_scenario()
        assert s.call_type == "consent"

    def test_includes_combined_decline_goal(self):
        """Single-decision: one combined 'no' covering the whole ask."""
        s = consent_decline_scenario()
        text = " ".join(g.trigger_phrase or "" for g in s.goals).lower()
        # The combined "no" must be a clear decline
        assert "rather not" in text or "no" in text
        # And it should mention recording as the reason it's a full no
        assert "record" in text

    def test_skips_post_call_analysis(self):
        # Consent calls don't run analysis (no transcript-worth-summarizing).
        s = consent_decline_scenario()
        assert s.expect_post_call_analysis is False


class TestDiscoveryScenario:
    def test_call_type_is_discovery(self):
        s = discovery_scenario()
        assert s.call_type == "discovery"

    def test_expects_record_discovery_fact(self):
        s = discovery_scenario()
        assert "record_discovery_fact" in s.expect_tool_calls

    def test_goals_cover_multiple_categories(self):
        s = discovery_scenario()
        text = " ".join(g.description.lower() for g in s.goals)
        # At least friend, hobby/routine (garden), and family (son) appear
        assert "eleanor" in text or "bridge" in text
        assert "garden" in text
        assert "son" in text or "tom" in text

    def test_max_turns_is_generous(self):
        # Discovery is a conversational call — needs more turns than a reminder.
        s = discovery_scenario()
        assert s.max_turns >= 12


class TestConsentComplexScenarioSet:
    def test_has_at_least_five_distinct_examples(self):
        scenarios = consent_mock_call_scenarios()
        names = [s.name for s in scenarios]
        assert len(scenarios) >= 5
        assert len(names) == len(set(names))
        assert all(name.startswith("consent_") for name in names)

    def test_examples_cover_required_branches(self):
        names = _scenario_names(consent_mock_call_scenarios())
        assert "consent_grant" in names
        assert "consent_decline" in names
        assert "consent_ambiguous_then_grant" in names
        assert "consent_ai_question_then_grant" in names
        assert "consent_off_topic_redirect_decline" in names

    def test_all_examples_are_consent_calls_with_only_consent_tool(self):
        for s in consent_mock_call_scenarios():
            _assert_scenario_is_well_formed(s)
            assert s.call_type == "consent"
            assert s.expect_tool_calls == ["record_consent_response"]
            assert s.expect_post_call_analysis is False
            assert s.expect_memories_injected is False
            assert "web_search" not in s.expect_tool_calls

    def test_fuzzy_example_requires_confirmation_before_clear_yes(self):
        fuzzy = next(
            s for s in consent_mock_call_scenarios()
            if s.name == "consent_ambiguous_then_grant"
        )
        text = " ".join(g.trigger_phrase.lower() for g in fuzzy.goals)
        assert "not completely sure" in text
        assert "yes" in text
        assert "recording is alright" in text

    def test_off_topic_example_does_not_expect_web_search(self):
        off_topic = next(
            s for s in consent_mock_call_scenarios()
            if s.name == "consent_off_topic_redirect_decline"
        )
        text = " ".join(g.trigger_phrase.lower() for g in off_topic.goals)
        assert "rain" in text or "weather" in text
        assert "web_search" not in off_topic.expect_tool_calls


class TestDiscoveryComplexScenarioSet:
    def test_has_at_least_five_distinct_examples(self):
        scenarios = discovery_mock_call_scenarios()
        names = [s.name for s in scenarios]
        assert len(scenarios) >= 5
        assert len(names) == len(set(names))
        assert all(name.startswith("discovery") for name in names)

    def test_examples_cover_required_branches(self):
        names = _scenario_names(discovery_mock_call_scenarios())
        assert "discovery" in names
        assert "discovery_quiet_routine" in names
        assert "discovery_off_topic_weather" in names
        assert "discovery_boundary_redirect" in names
        assert "discovery_early_goodbye" in names
        assert "discovery_correction" in names

    def test_all_examples_are_discovery_calls(self):
        for s in discovery_mock_call_scenarios():
            _assert_scenario_is_well_formed(s)
            assert s.call_type == "discovery"
            assert "record_discovery_fact" in s.expect_tool_calls
            assert s.expect_post_call_analysis is True

    def test_weather_example_expects_search_and_fact_capture(self):
        weather = next(
            s for s in discovery_mock_call_scenarios()
            if s.name == "discovery_off_topic_weather"
        )
        assert set(weather.expect_tool_calls) == {"record_discovery_fact", "web_search"}
        text = " ".join(g.trigger_phrase.lower() for g in weather.goals)
        assert "weather" in text or "rain" in text
        assert "tomato" in text or "garden" in text

    def test_boundary_example_avoids_clinical_fixture_details(self):
        boundary = next(
            s for s in discovery_mock_call_scenarios()
            if s.name == "discovery_boundary_redirect"
        )
        text = " ".join(g.trigger_phrase.lower() for g in boundary.goals)
        assert "private" in text
        assert "medication" not in text
        assert "lisinopril" not in text
        assert "metformin" not in text

    def test_early_goodbye_example_has_short_turn_budget(self):
        early = next(
            s for s in discovery_mock_call_scenarios()
            if s.name == "discovery_early_goodbye"
        )
        assert early.max_turns <= 7
        assert "bye" in " ".join(g.trigger_phrase.lower() for g in early.goals)
