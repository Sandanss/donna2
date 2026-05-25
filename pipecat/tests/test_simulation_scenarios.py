from scripts.run_simulated_demo import SCENARIOS
from tests import simulation as sim
from tests.simulation.scenarios import (
    ambiguous_reminder_ack_scenario,
    async_search_overlap_scenario,
    cognitive_confusion_reminder_scenario,
    consent_boundary_reminder_attempt_scenario,
    consent_decline_scenario,
    consent_grant_scenario,
    cognitive_confusion_scenario,
    discovery_scenario,
    discovery_boundary_reminder_attempt_scenario,
    embedding_outage_scenario,
    empty_search_result_scenario,
    false_goodbye_scenario,
    false_goodbye_reminder_ack_scenario,
    health_concern_scenario,
    low_engagement_scenario,
    low_engagement_reminder_scenario,
    memory_recall_scenario,
    memory_seed_scenario,
    multiple_reminders_scenario,
    out_of_order_reminder_ack_scenario,
    reminder_creation_scenario,
    reminder_interruption_scenario,
    reminder_overload_scenario,
    reminder_scenario,
    search_phi_guard_scenario,
    similar_reminders_scenario,
    slow_search_overlap_scenario,
    unacknowledged_reminder_scenario,
    web_search_scenario,
)
from tests.simulation.stress import STRESS_SCENARIO_FACTORIES


SCENARIO_FACTORIES = [
    web_search_scenario,
    memory_seed_scenario,
    memory_recall_scenario,
    reminder_scenario,
    multiple_reminders_scenario,
    reminder_overload_scenario,
    ambiguous_reminder_ack_scenario,
    reminder_interruption_scenario,
    similar_reminders_scenario,
    out_of_order_reminder_ack_scenario,
    unacknowledged_reminder_scenario,
    false_goodbye_reminder_ack_scenario,
    cognitive_confusion_reminder_scenario,
    low_engagement_reminder_scenario,
    consent_grant_scenario,
    consent_decline_scenario,
    consent_boundary_reminder_attempt_scenario,
    discovery_scenario,
    discovery_boundary_reminder_attempt_scenario,
    embedding_outage_scenario,
    false_goodbye_scenario,
    low_engagement_scenario,
    health_concern_scenario,
    cognitive_confusion_scenario,
    reminder_creation_scenario,
    async_search_overlap_scenario,
    slow_search_overlap_scenario,
    empty_search_result_scenario,
    search_phi_guard_scenario,
]

EXPECTED_SCENARIO_NAMES = {
    "web_search",
    "memory_seed",
    "memory_recall",
    "reminder",
    "multiple_reminders",
    "reminder_overload",
    "ambiguous_reminder_ack",
    "reminder_interruption",
    "similar_reminders",
    "out_of_order_reminder_ack",
    "unacknowledged_reminder",
    "false_goodbye_reminder_ack",
    "cognitive_confusion_reminder",
    "low_engagement_reminder",
    "consent_grant",
    "consent_decline",
    "consent_boundary_reminder_attempt",
    "discovery",
    "discovery_boundary_reminder_attempt",
    "embedding_outage",
    "false_goodbye",
    "low_engagement",
    "health_concern",
    "cognitive_confusion",
    "reminder_creation",
    "async_search_overlap",
    "slow_search_overlap",
    "empty_search_result",
    "search_phi_guard",
}


def test_active_scenario_names_are_unique_and_complete():
    scenarios = [factory() for factory in SCENARIO_FACTORIES]

    assert {scenario.name for scenario in scenarios} == EXPECTED_SCENARIO_NAMES
    assert len({scenario.name for scenario in scenarios}) == len(scenarios)


def test_new_scenarios_are_exported_from_public_api():
    for name in EXPECTED_SCENARIO_NAMES:
        export_name = f"{name}_scenario"
        if name == "reminder":
            export_name = "reminder_scenario"
        assert hasattr(sim, export_name)


def test_demo_cli_registry_includes_all_active_scenarios():
    assert set(SCENARIOS) == EXPECTED_SCENARIO_NAMES


def test_embedding_outage_scenario_forces_memory_degradation():
    scenario = embedding_outage_scenario()

    assert scenario.force_embedding_outage is True
    assert scenario.expect_memories_injected is False
    assert "remember" in scenario.goals[0].trigger_phrase.lower()


def test_false_goodbye_scenario_has_midcall_and_final_goodbyes():
    scenario = false_goodbye_scenario()

    midcall = scenario.goals[0].trigger_phrase.lower()
    final = scenario.goals[-1].trigger_phrase.lower()
    assert "bye helen" in midcall
    assert "still here" in midcall
    assert "bye donna" in final


def test_reminder_creation_and_async_search_expect_tools():
    reminder_creation = reminder_creation_scenario()
    overlap = async_search_overlap_scenario()
    slow_overlap = slow_search_overlap_scenario()
    empty_search = empty_search_result_scenario()
    phi_guard = search_phi_guard_scenario()

    assert reminder_creation.expect_tool_calls == ["create_reminder"]
    assert "recuérdame" in reminder_creation.goals[0].trigger_phrase.lower()
    assert overlap.expect_tool_calls == ["web_search"]
    assert slow_overlap.force_slow_web_search_seconds > 0
    assert empty_search.force_empty_web_search is True
    assert phi_guard.expect_tool_calls == ["web_search"]


def test_reminder_delivery_scenario_uses_everyday_prompt_context():
    scenario = reminder_scenario()

    assert scenario.call_type == "reminder"
    assert scenario.reminder_title == "Water the porch plants"
    assert scenario.reminder_description == "This evening after dinner"
    assert scenario.reminder_type == "generic"
    assert scenario.expect_tool_calls == ["mark_reminder_acknowledged"]


def test_multiple_reminders_scenario_covers_every_pending_item():
    scenario = multiple_reminders_scenario()

    assert scenario.call_type == "reminder"
    assert scenario.reminder_title is None
    assert len(scenario.reminders) == 2
    assert [reminder["type"] for reminder in scenario.reminders] == [
        "generic",
        "generic",
    ]
    assert "porch plants" in scenario.reminders[0]["title"].lower()
    assert "bridge club" in scenario.reminders[1]["title"].lower()
    assert scenario.expect_tool_calls == ["mark_reminder_acknowledged"]


def test_reminder_stress_scenarios_cover_corner_cases():
    overload = reminder_overload_scenario()
    ambiguous = ambiguous_reminder_ack_scenario()
    interrupted = reminder_interruption_scenario()
    similar = similar_reminders_scenario()
    out_of_order = out_of_order_reminder_ack_scenario()
    unacknowledged = unacknowledged_reminder_scenario()

    assert len(overload.reminders) == 5
    assert "second one" in ambiguous.goals[0].trigger_phrase.lower()
    assert interrupted.expect_tool_calls == [
        "mark_reminder_acknowledged",
        "create_reminder",
    ]
    assert [r["title"] for r in similar.reminders] == [
        "Call Eleanor",
        "Call Eleanor about bridge club",
    ]
    assert "bridge club" in out_of_order.goals[0].trigger_phrase.lower()
    assert unacknowledged.expect_tool_calls == []


def test_reminder_stress_scenarios_are_non_medical():
    banned = (
        "medication",
        "medicine",
        "metformin",
        "blood pressure",
        "pill",
    )
    for factory in (
        reminder_scenario,
        multiple_reminders_scenario,
        reminder_overload_scenario,
        ambiguous_reminder_ack_scenario,
        reminder_interruption_scenario,
        similar_reminders_scenario,
        out_of_order_reminder_ack_scenario,
        unacknowledged_reminder_scenario,
        false_goodbye_reminder_ack_scenario,
        cognitive_confusion_reminder_scenario,
        low_engagement_reminder_scenario,
    ):
        scenario = factory()
        text = " ".join([
            scenario.name,
            scenario.description,
            scenario.reminder_title or "",
            scenario.reminder_description or "",
            *[goal.description for goal in scenario.goals],
            *[goal.trigger_phrase or "" for goal in scenario.goals],
            *[
                " ".join(str(value) for value in reminder.values())
                for reminder in scenario.reminders
            ],
        ]).lower()
        assert not any(term in text for term in banned), scenario.name


def test_boundary_stress_scenarios_do_not_advertise_reminder_creation():
    consent = consent_boundary_reminder_attempt_scenario()
    discovery_boundary = discovery_boundary_reminder_attempt_scenario()

    assert consent.call_type == "consent"
    assert consent.expect_tool_calls == ["record_consent_response"]
    assert "create_reminder" not in consent.expect_tool_calls
    assert discovery_boundary.call_type == "discovery"
    assert discovery_boundary.expect_tool_calls == ["record_discovery_fact"]
    assert "create_reminder" not in discovery_boundary.expect_tool_calls


def test_stress_pack_catalog_matches_documented_factories():
    names = {factory().name for factory in STRESS_SCENARIO_FACTORIES}

    assert {
        "reminder_overload",
        "ambiguous_reminder_ack",
        "reminder_interruption",
        "similar_reminders",
        "out_of_order_reminder_ack",
        "unacknowledged_reminder",
        "embedding_outage",
        "slow_search_overlap",
        "empty_search_result",
        "search_phi_guard",
        "false_goodbye_reminder_ack",
        "cognitive_confusion_reminder",
        "low_engagement_reminder",
        "consent_boundary_reminder_attempt",
        "discovery_boundary_reminder_attempt",
    } <= names


def test_persona_specific_scenarios_use_distinct_seniors():
    low_engagement = low_engagement_scenario()
    reminder_creation = reminder_creation_scenario()

    assert low_engagement.senior.name.startswith("Harold")
    assert "woodworking" in low_engagement.senior.interests
    assert reminder_creation.senior.name.startswith("Carmen")
    assert "San Antonio" == reminder_creation.senior.city


def test_safety_scenarios_are_catalogued_without_tools():
    health = health_concern_scenario()
    cognitive = cognitive_confusion_scenario()

    assert health.expect_tool_calls == []
    assert cognitive.expect_tool_calls == []
    assert "lightheaded" in health.goals[0].trigger_phrase.lower()
    assert "who is this" in cognitive.goals[0].trigger_phrase.lower()
