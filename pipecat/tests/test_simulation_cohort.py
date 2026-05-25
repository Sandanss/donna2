"""Unit tests for the cohort SLO comparator."""

from __future__ import annotations

import json

import pytest

from tests.simulation.cohort import (
    CohortSloThresholds,
    DEFAULT_THRESHOLDS,
    build_cohort_report,
    compare_cohorts,
    _percentile,
)
from tests.simulation.concurrent import ConcurrentCallOutcome
from tests.simulation.transport import CallResult


def _outcome(
    *,
    label: str,
    scenario_name: str = "web_search",
    senior_id: str = "senior-x",
    turns: int = 3,
    first_latency_ms: float = 500.0,
    duration_ms: float = 4_500.0,
    post_call_completed: bool = True,
    tool_calls: list[str] | None = None,
    end_reason: str = "goodbye",
    error: str | None = None,
) -> ConcurrentCallOutcome:
    """Build a ConcurrentCallOutcome with controllable per-call shape."""
    if error is not None:
        return ConcurrentCallOutcome(
            label=label,
            senior_id=senior_id,
            scenario_name=scenario_name,
            error=error,
        )

    result = CallResult()
    result.total_duration_ms = duration_ms
    result.end_reason = end_reason
    result.post_call_completed = post_call_completed
    result.tool_calls_made = list(tool_calls or [])
    for i in range(turns):
        result.turns.append({
            "turn": i + 1,
            "caller": f"caller-{i}",
            "donna": f"donna-{i}",
            "latency_ms": first_latency_ms if i == 0 else first_latency_ms + i * 50,
        })

    return ConcurrentCallOutcome(
        label=label,
        senior_id=senior_id,
        scenario_name=scenario_name,
        result=result,
    )


# ---------------------------------------------------------------------------
# Percentile helper
# ---------------------------------------------------------------------------


def test_percentile_returns_none_on_empty_input():
    assert _percentile([], 50) is None
    assert _percentile([], 95) is None


def test_percentile_single_value_returns_that_value():
    assert _percentile([42.0], 50) == 42.0
    assert _percentile([42.0], 95) == 42.0


def test_percentile_interpolates_linearly():
    values = [100.0, 200.0, 300.0, 400.0, 500.0]
    assert _percentile(values, 50) == 300.0
    # p95 of 5 elements: index = 0.95 * 4 = 3.8 → between 400 and 500 → 480
    assert pytest.approx(_percentile(values, 95), abs=0.01) == 480.0


def test_percentile_rejects_out_of_range_pct():
    with pytest.raises(ValueError):
        _percentile([1.0, 2.0], -1)
    with pytest.raises(ValueError):
        _percentile([1.0, 2.0], 101)


# ---------------------------------------------------------------------------
# CohortSloReport
# ---------------------------------------------------------------------------


def test_empty_cohort_yields_zero_counts():
    report = build_cohort_report("control", outcomes=[])
    assert report.cohort_size == 0
    assert report.completed == 0
    assert report.failed == 0
    assert report.setup_success_rate == 0.0
    assert report.first_response_p50_ms is None
    assert report.first_response_p95_ms is None
    assert report.avg_turns == 0.0
    assert report.tool_call_distribution == {}


def test_all_completed_cohort_full_metrics():
    outcomes = [
        _outcome(label="control", first_latency_ms=400.0, duration_ms=4_000.0, tool_calls=["web_search"]),
        _outcome(label="control", first_latency_ms=600.0, duration_ms=5_000.0, tool_calls=["web_search", "mark_reminder_acknowledged"]),
        _outcome(label="control", first_latency_ms=800.0, duration_ms=6_000.0, tool_calls=[]),
    ]
    report = build_cohort_report("control", outcomes)

    assert report.cohort_size == 3
    assert report.completed == 3
    assert report.failed == 0
    assert report.setup_success_rate == 1.0
    assert report.post_call_completion_rate == 1.0
    assert report.first_response_p50_ms == pytest.approx(600.0)
    assert report.first_response_p95_ms == pytest.approx(780.0, abs=0.5)
    assert report.avg_turns == 3.0
    assert report.tool_call_distribution == {"web_search": 2, "mark_reminder_acknowledged": 1}
    assert report.end_reason_distribution == {"goodbye": 3}


def test_failed_outcomes_increment_error_class_distribution():
    outcomes = [
        _outcome(label="treatment", first_latency_ms=500.0),
        _outcome(label="treatment", error="TimeoutError"),
        _outcome(label="treatment", error="TimeoutError"),
        _outcome(label="treatment", error="ConnectionError"),
    ]
    report = build_cohort_report("treatment", outcomes)

    assert report.cohort_size == 4
    assert report.completed == 1
    assert report.failed == 3
    assert report.setup_success_rate == pytest.approx(0.25)
    assert report.error_class_distribution == {"TimeoutError": 2, "ConnectionError": 1}


def test_post_call_completion_rate_excludes_failed_calls():
    """post_call_completion_rate is the rate among COMPLETED calls, not all
    calls — otherwise a flaky setup would falsely lower the rate."""
    outcomes = [
        _outcome(label="treatment", post_call_completed=True),
        _outcome(label="treatment", post_call_completed=True),
        _outcome(label="treatment", post_call_completed=False),
        _outcome(label="treatment", error="TimeoutError"),  # excluded
    ]
    report = build_cohort_report("treatment", outcomes)

    assert report.completed == 3
    assert report.post_call_completion_rate == pytest.approx(2 / 3)


def test_report_is_json_serializable_and_phi_free():
    """Build a report from outcomes whose CallResult contains realistic
    PHI-shaped values, then verify NONE of those values appear in the
    serialized report. The cohort label itself ('control') is allowed
    because it's an operational identifier, not PHI."""
    phi_marker_name = "MargaretGardenerXYZ"
    phi_marker_phone = "5559876543"
    phi_marker_transcript = "Donna I have been feeling chest pain since Tuesday"

    # Hand-build outcomes that DO contain PHI in the underlying CallResult.
    result = CallResult()
    result.total_duration_ms = 5000.0
    result.end_reason = "goodbye"
    result.post_call_completed = True
    result.tool_calls_made = ["web_search"]
    result.turns.append({
        "turn": 1,
        "caller": phi_marker_transcript,
        "donna": f"Hello {phi_marker_name}, how are you feeling today?",
        "latency_ms": 500.0,
    })
    phi_outcome = ConcurrentCallOutcome(
        label="control",
        senior_id="senior-xyz",
        scenario_name="web_search",
        result=result,
    )
    fail_outcome = ConcurrentCallOutcome(
        label="control",
        senior_id=phi_marker_phone,  # if senior_id ever leaks, this would too
        scenario_name="web_search",
        error="TimeoutError",
    )

    report = build_cohort_report("control", [phi_outcome, fail_outcome])
    serialized = json.dumps(report.to_dict())

    # Operational fields land correctly.
    parsed = json.loads(serialized)
    assert parsed["name"] == "control"
    assert parsed["completed"] == 1
    assert parsed["failed"] == 1
    assert parsed["error_class_distribution"] == {"TimeoutError": 1}

    # Critical: no PHI-shaped values from the underlying call data may
    # leak into the cohort-level report.
    for phi_value in (phi_marker_name, phi_marker_phone, phi_marker_transcript):
        assert phi_value not in serialized, (
            f"Cohort report leaked PHI-shaped value: {phi_value!r}"
        )
    # Field-level PHI guards: transcripts, per-turn arrays, and caller-side
    # text must never appear under any key. `avg_turns` (aggregate) is fine.
    assert "transcript" not in serialized.lower()
    assert "turn_transcript" not in serialized.lower()
    assert "caller_text" not in serialized.lower()
    assert "\"turns\":" not in serialized  # no nested per-turn array


# ---------------------------------------------------------------------------
# CohortComparison
# ---------------------------------------------------------------------------


def test_compare_cohorts_clean_run_has_no_breaches():
    control_outcomes = [
        _outcome(label="control", first_latency_ms=400.0),
        _outcome(label="control", first_latency_ms=500.0),
        _outcome(label="control", first_latency_ms=600.0),
    ]
    treatment_outcomes = [
        _outcome(label="treatment", first_latency_ms=400.0),
        _outcome(label="treatment", first_latency_ms=500.0),
        _outcome(label="treatment", first_latency_ms=700.0),
    ]
    control = build_cohort_report("control", control_outcomes)
    treatment = build_cohort_report("treatment", treatment_outcomes)

    comparison = compare_cohorts(control, treatment)

    assert comparison.passed is True
    assert comparison.breaches == []


def test_compare_cohorts_flags_setup_latency_breach():
    bad_treatment_outcomes = [
        _outcome(label="treatment", first_latency_ms=l) for l in (1_400, 1_800, 2_500)
    ]
    treatment = build_cohort_report("treatment", bad_treatment_outcomes)
    control = build_cohort_report("control", [_outcome(label="control")])

    comparison = compare_cohorts(control, treatment)

    assert comparison.passed is False
    latency_breaches = [b for b in comparison.breaches if b.metric == "first_response_p95_ms"]
    assert len(latency_breaches) == 1
    assert latency_breaches[0].cohort == "treatment"
    assert latency_breaches[0].observed and latency_breaches[0].observed > 1500.0
    assert latency_breaches[0].threshold == 1500.0
    assert latency_breaches[0].direction == "above"


def test_compare_cohorts_flags_setup_success_floor_breach():
    # 10 outcomes, 5 failed → 0.5 success rate, below the 0.95 floor.
    outcomes = [_outcome(label="treatment") for _ in range(5)] + [
        _outcome(label="treatment", error="TimeoutError") for _ in range(5)
    ]
    treatment = build_cohort_report("treatment", outcomes)
    control = build_cohort_report("control", [_outcome(label="control")])

    comparison = compare_cohorts(control, treatment)

    success_breaches = [b for b in comparison.breaches if b.metric == "setup_success_rate"]
    assert len(success_breaches) == 1
    assert success_breaches[0].cohort == "treatment"
    assert success_breaches[0].observed == pytest.approx(0.5)
    assert success_breaches[0].direction == "below"


def test_compare_cohorts_flags_post_call_completion_breach():
    # 5 completed calls, 3 with failing post-call → 0.4, below 0.95 floor.
    outcomes = [
        _outcome(label="treatment", post_call_completed=True),
        _outcome(label="treatment", post_call_completed=True),
        _outcome(label="treatment", post_call_completed=False),
        _outcome(label="treatment", post_call_completed=False),
        _outcome(label="treatment", post_call_completed=False),
    ]
    treatment = build_cohort_report("treatment", outcomes)
    control = build_cohort_report("control", [_outcome(label="control")])

    comparison = compare_cohorts(control, treatment)

    post_call_breaches = [
        b for b in comparison.breaches if b.metric == "post_call_completion_rate"
    ]
    assert len(post_call_breaches) == 1
    assert post_call_breaches[0].cohort == "treatment"
    assert post_call_breaches[0].observed == pytest.approx(0.4)


def test_compare_cohorts_thresholds_are_overridable():
    """A canary with a relaxed policy can pass thresholds that the default
    config would have flagged."""
    outcomes = [_outcome(label="treatment", first_latency_ms=l) for l in (1_400, 1_800, 2_500)]
    treatment = build_cohort_report("treatment", outcomes)
    control = build_cohort_report("control", [_outcome(label="control")])

    relaxed = CohortSloThresholds(outbound_call_setup_p95_ms=5_000.0)
    comparison = compare_cohorts(control, treatment, thresholds=relaxed)

    latency_breaches = [b for b in comparison.breaches if b.metric == "first_response_p95_ms"]
    assert latency_breaches == []


def test_compare_cohorts_to_dict_serializable_and_phi_free():
    outcomes = [_outcome(label="treatment", first_latency_ms=2_500.0)]
    treatment = build_cohort_report("treatment", outcomes)
    control = build_cohort_report("control", [_outcome(label="control")])

    comparison = compare_cohorts(control, treatment)
    serialized = json.dumps(comparison.to_dict())

    assert "passed" in serialized
    assert "breaches" in serialized
    # PHI-shape guards: no transcript content or per-turn data should ever
    # appear in a cohort-level comparison report (avg_turns aggregate is OK).
    assert "transcript" not in serialized.lower()
    assert "turn_transcript" not in serialized.lower()
    assert "\"turns\":" not in serialized


def test_compare_cohorts_empty_control_doesnt_crash():
    """A control cohort with 0 calls (e.g. ramp not started) must not raise."""
    control = build_cohort_report("control", [])
    treatment = build_cohort_report("treatment", [_outcome(label="treatment")])

    comparison = compare_cohorts(control, treatment)

    # Empty control isn't flagged as a setup_success failure (cohort_size 0
    # is "no data yet", not a breach).
    control_setup_breaches = [
        b for b in comparison.breaches
        if b.cohort == "control" and b.metric == "setup_success_rate"
    ]
    assert control_setup_breaches == []
