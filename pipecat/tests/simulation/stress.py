"""Stress-pack helpers for mock-call simulations.

These helpers build scenario/spec lists for expensive runs without making
ordinary unit tests run live LLM calls. They keep the source of truth for
stress coverage in code, so docs and tests can point at the same catalog.
"""

from __future__ import annotations

from collections.abc import Callable

from tests.simulation.concurrent import ConcurrentCallSpec
from tests.simulation.scenarios import (
    LiveSimScenario,
    ambiguous_reminder_ack_scenario,
    async_search_overlap_scenario,
    cognitive_confusion_reminder_scenario,
    consent_boundary_reminder_attempt_scenario,
    discovery_boundary_reminder_attempt_scenario,
    embedding_outage_scenario,
    empty_search_result_scenario,
    false_goodbye_reminder_ack_scenario,
    low_engagement_reminder_scenario,
    multiple_reminders_scenario,
    out_of_order_reminder_ack_scenario,
    reminder_interruption_scenario,
    reminder_overload_scenario,
    search_phi_guard_scenario,
    similar_reminders_scenario,
    slow_search_overlap_scenario,
    unacknowledged_reminder_scenario,
)

ScenarioFactory = Callable[[], LiveSimScenario]


STRESS_SCENARIO_FACTORIES: tuple[ScenarioFactory, ...] = (
    reminder_overload_scenario,
    ambiguous_reminder_ack_scenario,
    reminder_interruption_scenario,
    similar_reminders_scenario,
    out_of_order_reminder_ack_scenario,
    unacknowledged_reminder_scenario,
    embedding_outage_scenario,
    slow_search_overlap_scenario,
    empty_search_result_scenario,
    search_phi_guard_scenario,
    false_goodbye_reminder_ack_scenario,
    cognitive_confusion_reminder_scenario,
    low_engagement_reminder_scenario,
    consent_boundary_reminder_attempt_scenario,
    discovery_boundary_reminder_attempt_scenario,
)


def build_stress_pack_specs(*, repetitions: int = 1) -> list[ConcurrentCallSpec]:
    """Build one concurrent spec per documented stress scenario."""
    if repetitions < 1:
        raise ValueError("repetitions must be >= 1")

    specs: list[ConcurrentCallSpec] = []
    for rep in range(repetitions):
        for factory in STRESS_SCENARIO_FACTORIES:
            scenario = factory()
            specs.append(
                ConcurrentCallSpec(
                    scenario=scenario,
                    label=f"stress-{rep + 1:02d}-{scenario.name}",
                )
            )
    return specs


def build_reminder_stampede_specs(count: int) -> list[ConcurrentCallSpec]:
    """Build a high-concurrency reminder-delivery mix."""
    if count < 1:
        raise ValueError("count must be >= 1")

    factories: tuple[ScenarioFactory, ...] = (
        multiple_reminders_scenario,
        reminder_overload_scenario,
        similar_reminders_scenario,
        out_of_order_reminder_ack_scenario,
        unacknowledged_reminder_scenario,
    )
    specs: list[ConcurrentCallSpec] = []
    for index in range(count):
        scenario = factories[index % len(factories)]()
        specs.append(
            ConcurrentCallSpec(
                scenario=scenario,
                label=f"reminder-stampede-{index + 1:04d}",
            )
        )
    return specs


def build_post_call_stampede_specs(count: int) -> list[ConcurrentCallSpec]:
    """Build a mixed batch intended to end around the same time with post-call on."""
    if count < 1:
        raise ValueError("count must be >= 1")

    factories: tuple[ScenarioFactory, ...] = (
        embedding_outage_scenario,
        async_search_overlap_scenario,
        empty_search_result_scenario,
        low_engagement_reminder_scenario,
    )
    specs: list[ConcurrentCallSpec] = []
    for index in range(count):
        scenario = factories[index % len(factories)]()
        specs.append(
            ConcurrentCallSpec(
                scenario=scenario,
                label=f"post-call-stampede-{index + 1:04d}",
            )
        )
    return specs


def build_parallel_flake_specs(
    factory: ScenarioFactory,
    *,
    repetitions: int,
) -> list[ConcurrentCallSpec]:
    """Repeat one scenario to expose state leaks and nondeterminism."""
    if repetitions < 1:
        raise ValueError("repetitions must be >= 1")

    specs: list[ConcurrentCallSpec] = []
    for index in range(repetitions):
        scenario = factory()
        specs.append(
            ConcurrentCallSpec(
                scenario=scenario,
                label=f"flake-{scenario.name}-{index + 1:04d}",
            )
        )
    return specs


def scale_2000_load_test_plan() -> dict:
    """PHI-free plan metadata for the 2,000-user infra test track."""
    return {
        "primary_track": "locust_websocket_load",
        "target_concurrent_users": 2000,
        "requires_load_test_mode": True,
        "mock_call_sample_size": 50,
        "mock_call_purpose": (
            "Behavior sample only; 2,000 full LLM-vs-LLM calls mostly tests "
            "vendor quota and spend, not load balancing."
        ),
    }
