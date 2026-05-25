"""Unit tests for the concurrent simulation runner.

These tests use ``monkeypatch`` to stub out ``run_simulated_call`` and the
DB seed/cleanup helpers so the orchestrator logic can be exercised without
touching Postgres, Anthropic, or the live pipeline. The real LLM-vs-LLM
integration is covered by ``test_live_simulation.py`` (marked
``llm_simulation``).
"""

from __future__ import annotations

import asyncio

import pytest

from tests.simulation import concurrent as concurrent_module
from tests.simulation.concurrent import (
    ConcurrentCallSpec,
    ConcurrentRunSummary,
    run_simulated_calls_concurrent,
)
from tests.simulation.scenarios import memory_recall_scenario, web_search_scenario
from tests.simulation.transport import CallResult


def _fake_result(turns: int = 3, latency_ms: float = 600.0, completed: bool = True) -> CallResult:
    """Build a CallResult with deterministic shape for orchestration tests."""
    result = CallResult()
    for i in range(turns):
        result.turns.append({
            "turn": i + 1,
            "caller": f"caller-turn-{i}",
            "donna": f"donna-turn-{i}",
            "latency_ms": latency_ms,
        })
    result.tool_calls_made = ["web_search"] if turns > 1 else []
    result.total_duration_ms = turns * 1000.0
    result.end_reason = "goodbye" if completed else "timeout"
    result.post_call_completed = completed
    return result


@pytest.fixture
def stubbed_runner(monkeypatch):
    """Patch run_simulated_call, seed_test_senior, cleanup_test_senior to be
    in-memory no-ops so the orchestrator can be exercised without a DB."""
    calls: list[dict] = []

    async def fake_run_simulated_call(scenario, senior=None, **kwargs):
        calls.append({
            "scenario": scenario.name,
            "senior_id": senior.id if senior else None,
        })
        return _fake_result()

    async def fake_seed(senior):
        return senior

    async def fake_cleanup(_senior_id):
        return None

    monkeypatch.setattr(concurrent_module, "run_simulated_call", fake_run_simulated_call)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", fake_seed)
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", fake_cleanup)
    return calls


@pytest.mark.asyncio
async def test_empty_spec_list_returns_empty_summary():
    summary = await run_simulated_calls_concurrent([])
    assert isinstance(summary, ConcurrentRunSummary)
    assert summary.started == 0
    assert summary.completed == 0
    assert summary.failed == 0
    assert summary.outcomes == []


@pytest.mark.asyncio
async def test_runs_all_specs_in_parallel(stubbed_runner):
    specs = [
        ConcurrentCallSpec(scenario=web_search_scenario(), label="control"),
        ConcurrentCallSpec(scenario=web_search_scenario(), label="control"),
        ConcurrentCallSpec(scenario=memory_recall_scenario(), label="treatment"),
    ]

    summary = await run_simulated_calls_concurrent(specs, max_concurrent=5)

    assert summary.started == 3
    assert summary.completed == 3
    assert summary.failed == 0
    assert len(summary.outcomes) == 3
    assert len(stubbed_runner) == 3

    # Outcomes are tagged with their label and scenario so a downstream
    # cohort comparator can filter without inspecting the result.
    labels = {o.label for o in summary.outcomes}
    assert labels == {"control", "treatment"}


@pytest.mark.asyncio
async def test_auto_senior_assigns_unique_ids(stubbed_runner):
    """Two slots in the same scenario must NOT share a senior_id, otherwise
    concurrent DB writes would collide on the primary key."""
    specs = [
        ConcurrentCallSpec(scenario=web_search_scenario()),
        ConcurrentCallSpec(scenario=web_search_scenario()),
        ConcurrentCallSpec(scenario=web_search_scenario()),
    ]

    summary = await run_simulated_calls_concurrent(specs, max_concurrent=3)

    senior_ids = [o.senior_id for o in summary.outcomes]
    assert len(set(senior_ids)) == 3  # all distinct


@pytest.mark.asyncio
async def test_explicit_senior_is_passed_through(stubbed_runner):
    """When a spec provides a senior explicitly the orchestrator must use it
    (no auto-generation)."""
    from tests.simulation.fixtures import TestSenior

    senior = TestSenior(id="11111111-1111-1111-1111-111111111111", name="ExplicitSenior")
    specs = [ConcurrentCallSpec(scenario=web_search_scenario(), senior=senior)]

    summary = await run_simulated_calls_concurrent(specs)

    assert summary.outcomes[0].senior_id == senior.id


@pytest.mark.asyncio
async def test_max_concurrent_bounds_in_flight_calls(monkeypatch):
    """Confirm the semaphore actually bounds concurrent calls."""
    in_flight = 0
    peak = 0
    in_flight_lock = asyncio.Lock()

    async def slow_call(scenario, senior=None, **_kwargs):
        nonlocal in_flight, peak
        async with in_flight_lock:
            in_flight += 1
            peak = max(peak, in_flight)
        await asyncio.sleep(0.05)
        async with in_flight_lock:
            in_flight -= 1
        return _fake_result()

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(concurrent_module, "run_simulated_call", slow_call)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", lambda s: noop(s))
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", noop)

    specs = [ConcurrentCallSpec(scenario=web_search_scenario()) for _ in range(10)]
    await run_simulated_calls_concurrent(specs, max_concurrent=3)

    assert peak <= 3, f"peak in-flight {peak} exceeded max_concurrent=3"


@pytest.mark.asyncio
async def test_timeout_yields_phi_free_error_class(monkeypatch):
    async def hangs(scenario, senior=None, **_kwargs):
        await asyncio.sleep(2.0)
        return _fake_result()

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(concurrent_module, "run_simulated_call", hangs)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", lambda s: noop(s))
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", noop)

    summary = await run_simulated_calls_concurrent(
        [ConcurrentCallSpec(scenario=web_search_scenario())],
        timeout_per_call=0.05,
    )

    assert summary.completed == 0
    assert summary.failed == 1
    assert summary.outcomes[0].error == "TimeoutError"
    assert summary.outcomes[0].result is None


@pytest.mark.asyncio
async def test_exception_in_call_is_class_name_only(monkeypatch):
    class FakeCredentialError(RuntimeError):
        pass

    async def raises(scenario, senior=None, **_kwargs):
        raise FakeCredentialError("anthropic key sk-ant-xxxxx invalid for senior 12345")

    async def noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(concurrent_module, "run_simulated_call", raises)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", lambda s: noop(s))
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", noop)

    summary = await run_simulated_calls_concurrent(
        [ConcurrentCallSpec(scenario=web_search_scenario())],
    )

    assert summary.failed == 1
    outcome = summary.outcomes[0]
    assert outcome.error == "FakeCredentialError"
    # Critical: exception body must NOT have leaked into outcome.error.
    assert "sk-ant" not in (outcome.error or "")
    assert "senior" not in (outcome.error or "")


@pytest.mark.asyncio
async def test_summary_by_label_filters_outcomes(stubbed_runner):
    specs = [
        ConcurrentCallSpec(scenario=web_search_scenario(), label="control"),
        ConcurrentCallSpec(scenario=web_search_scenario(), label="control"),
        ConcurrentCallSpec(scenario=web_search_scenario(), label="treatment"),
        ConcurrentCallSpec(scenario=web_search_scenario(), label="treatment"),
        ConcurrentCallSpec(scenario=web_search_scenario(), label="treatment"),
    ]

    summary = await run_simulated_calls_concurrent(specs, max_concurrent=10)

    assert len(summary.by_label("control")) == 2
    assert len(summary.by_label("treatment")) == 3
    assert len(summary.by_label("nonexistent")) == 0


@pytest.mark.asyncio
async def test_on_progress_callback_is_invoked_per_outcome(stubbed_runner):
    seen = []

    def progress(outcome):
        seen.append(outcome.scenario_name)

    specs = [
        ConcurrentCallSpec(scenario=web_search_scenario()),
        ConcurrentCallSpec(scenario=memory_recall_scenario()),
    ]
    await run_simulated_calls_concurrent(specs, on_progress=progress)

    assert len(seen) == 2
    assert set(seen) == {"web_search", "memory_recall"}


@pytest.mark.asyncio
async def test_bare_scenario_is_auto_wrapped(stubbed_runner):
    """Calling with a bare LiveSimScenario should work without wrapping it
    in a ConcurrentCallSpec — the orchestrator wraps it for the caller."""
    summary = await run_simulated_calls_concurrent(
        [web_search_scenario(), web_search_scenario()],
    )
    assert summary.started == 2
    assert summary.completed == 2


@pytest.mark.asyncio
async def test_invalid_spec_type_raises():
    with pytest.raises(TypeError):
        await run_simulated_calls_concurrent(["not a spec"])  # type: ignore[list-item]


@pytest.mark.asyncio
async def test_max_concurrent_zero_raises():
    with pytest.raises(ValueError):
        await run_simulated_calls_concurrent(
            [ConcurrentCallSpec(scenario=web_search_scenario())],
            max_concurrent=0,
        )


@pytest.mark.asyncio
async def test_seed_db_false_skips_seed_and_cleanup(monkeypatch):
    seed_calls = 0
    cleanup_calls = 0

    async def fake_seed(senior):
        nonlocal seed_calls
        seed_calls += 1
        return senior

    async def fake_cleanup(_senior_id):
        nonlocal cleanup_calls
        cleanup_calls += 1

    async def fake_run(scenario, senior=None, **_kwargs):
        return _fake_result()

    monkeypatch.setattr(concurrent_module, "run_simulated_call", fake_run)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", fake_seed)
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", fake_cleanup)

    specs = [
        ConcurrentCallSpec(scenario=web_search_scenario(), seed_db=False),
        ConcurrentCallSpec(scenario=web_search_scenario(), seed_db=False),
    ]
    await run_simulated_calls_concurrent(specs)

    assert seed_calls == 0
    assert cleanup_calls == 0


@pytest.mark.asyncio
async def test_cleanup_after_false_skips_cleanup_only(monkeypatch):
    seed_calls = 0
    cleanup_calls = 0

    async def fake_seed(senior):
        nonlocal seed_calls
        seed_calls += 1
        return senior

    async def fake_cleanup(_senior_id):
        nonlocal cleanup_calls
        cleanup_calls += 1

    async def fake_run(scenario, senior=None, **_kwargs):
        return _fake_result()

    monkeypatch.setattr(concurrent_module, "run_simulated_call", fake_run)
    monkeypatch.setattr(concurrent_module, "seed_test_senior", fake_seed)
    monkeypatch.setattr(concurrent_module, "cleanup_test_senior", fake_cleanup)

    specs = [ConcurrentCallSpec(scenario=web_search_scenario(), cleanup_after=False)]
    await run_simulated_calls_concurrent(specs)

    assert seed_calls == 1
    assert cleanup_calls == 0
