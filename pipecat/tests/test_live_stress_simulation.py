"""Opt-in live LLM stress simulations.

This file runs real Donna pipeline calls concurrently. It is skipped unless
``RUN_LIVE_STRESS_SIMULATION=true`` is set so normal test runs do not spend
LLM tokens or mutate the dev database.
"""

from __future__ import annotations

import os

import pytest

from scripts.run_simulated_demo import SCENARIOS
from tests.simulation import (
    ConcurrentCallSpec,
    build_cohort_report,
    build_reminder_stampede_specs,
    run_simulated_calls_concurrent,
)


_RUN_LIVE_STRESS = os.getenv("RUN_LIVE_STRESS_SIMULATION") == "true"
_HAS_LIVE_ENV = all(os.getenv(k) for k in ("ANTHROPIC_API_KEY", "DATABASE_URL"))

pytestmark = [
    pytest.mark.llm_simulation,
    pytest.mark.stress,
    pytest.mark.skipif(
        not _RUN_LIVE_STRESS,
        reason="Set RUN_LIVE_STRESS_SIMULATION=true to run live stress calls",
    ),
    pytest.mark.skipif(
        not _HAS_LIVE_ENV,
        reason="Requires ANTHROPIC_API_KEY and DATABASE_URL",
    ),
]


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return int(value)


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or value.strip() == "":
        return default
    return float(value)


def _selected_live_stress_specs() -> list[ConcurrentCallSpec]:
    raw = os.getenv(
        "LIVE_STRESS_SCENARIOS",
        "ambiguous_reminder_ack,similar_reminders,empty_search_result",
    )
    names = [name.strip() for name in raw.split(",") if name.strip()]
    unknown = sorted(set(names) - set(SCENARIOS))
    if unknown:
        raise ValueError(f"Unknown LIVE_STRESS_SCENARIOS entries: {unknown}")
    return [
        ConcurrentCallSpec(
            scenario=SCENARIOS[name](),
            label=f"live-stress-{index:02d}-{name}",
        )
        for index, name in enumerate(names, start=1)
    ]


@pytest.mark.asyncio(loop_scope="module")
async def test_live_advanced_stress_subset_runs_concurrently():
    specs = _selected_live_stress_specs()
    summary = await run_simulated_calls_concurrent(
        specs,
        max_concurrent=_env_int("LIVE_STRESS_MAX_CONCURRENT", 2),
        timeout_per_call=_env_float("LIVE_STRESS_TIMEOUT_PER_CALL", 300.0),
        run_post_call_processing=os.getenv("LIVE_STRESS_POST_CALL") == "true",
    )
    report = build_cohort_report("live-advanced-stress", summary.outcomes)

    assert summary.started == len(specs)
    assert summary.failed == 0, report.to_dict()
    assert report.setup_success_rate == 1.0
    for outcome in summary.outcomes:
        assert outcome.result is not None
        assert outcome.result.end_reason not in {"no_greeting", "timeout"}
        assert len(outcome.result.turns) >= 2


@pytest.mark.skipif(
    os.getenv("RUN_LIVE_REMINDER_STAMPEDE") != "true",
    reason="Set RUN_LIVE_REMINDER_STAMPEDE=true to run reminder stampede calls",
)
@pytest.mark.asyncio(loop_scope="module")
async def test_live_reminder_stampede_runs_concurrently():
    count = _env_int("LIVE_REMINDER_STAMPEDE_COUNT", 5)
    specs = build_reminder_stampede_specs(count)
    summary = await run_simulated_calls_concurrent(
        specs,
        max_concurrent=_env_int("LIVE_REMINDER_STAMPEDE_MAX_CONCURRENT", 3),
        timeout_per_call=_env_float("LIVE_STRESS_TIMEOUT_PER_CALL", 300.0),
        run_post_call_processing=False,
    )
    report = build_cohort_report("live-reminder-stampede", summary.outcomes)

    assert summary.started == count
    assert summary.failed == 0, report.to_dict()
    assert report.setup_success_rate == 1.0
