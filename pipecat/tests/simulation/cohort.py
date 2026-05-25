"""Cohort SLO comparator for simulated A/B runs and (later) live canary cohorts.

`run_simulated_calls_concurrent` returns a list of per-call outcomes. To make
Phase 5 (synthetic A/B), Phase 6 (post-call stampede), and Phase 7 (live
canary) actionable we need to aggregate those outcomes into a cohort-level
SLO compliance report. This module provides the shared aggregation +
comparison primitives.

PHI safety: the report intentionally contains only counts, percentiles, and
PHI-free identifiers (scenario names, tool names, end reasons, exception
class names). It MUST NOT include transcripts, senior names, phone numbers,
or any raw conversation content.

The report shape mirrors the field set the Phase 5 live-ab-report script
(`scripts/phase5-live-ab-report.js`) emits so Phase 7's daily canary review
can reuse the same downstream tooling against real cohorts later.

SLO targets are pulled from plan §1.3.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from tests.simulation.concurrent import ConcurrentCallOutcome
from tests.simulation.transport import CallResult


# ---------------------------------------------------------------------------
# Plan §1.3 SLO thresholds
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CohortSloThresholds:
    """Numeric SLO targets used by the simulated A/B report.

    Defaults match plan §1.3 row by row. Override per-call when running
    against a non-prod replica or a relaxed canary policy.
    """

    outbound_call_setup_p95_ms: float = 1500.0
    duplicate_call_rate: float = 0.0  # 0 duplicates per 10,000 dispatches
    post_call_critical_p95_seconds: float = 5 * 60.0
    post_call_normal_summary_p95_seconds: float = 15 * 60.0
    answer_rate_floor: float = 0.80  # ≥ 80% of single-call baseline
    setup_success_floor: float = 0.95  # treat <95% setup success as a SLO breach
    post_call_completion_floor: float = 0.95


DEFAULT_THRESHOLDS = CohortSloThresholds()


# ---------------------------------------------------------------------------
# Percentile helper
# ---------------------------------------------------------------------------


def _percentile(values: Sequence[float], pct: float) -> float | None:
    """Return the ``pct``-th percentile using linear interpolation.

    Returns None when the input is empty so callers can render the report
    with "—" placeholders rather than 0.0 (which would falsely look like a
    very good p95).
    """
    if not values:
        return None
    if not 0.0 <= pct <= 100.0:
        raise ValueError("pct must be in [0, 100]")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    k = (len(ordered) - 1) * (pct / 100.0)
    floor = math.floor(k)
    ceil = math.ceil(k)
    if floor == ceil:
        return float(ordered[int(k)])
    lower = ordered[floor] * (ceil - k)
    upper = ordered[ceil] * (k - floor)
    return float(lower + upper)


# ---------------------------------------------------------------------------
# Per-call metrics extraction
# ---------------------------------------------------------------------------


def _first_response_latency_ms(result: CallResult) -> float | None:
    """First measurable Donna response latency in milliseconds.

    Phase 5 SLO row "outbound call setup p95 ≤ 1.5s" measures dispatcher
    decision → media start. In simulation we don't have a real Telnyx media
    start, so the closest analogue is the latency of the *first* Donna
    response after the caller's first utterance. This is what the live
    matrix would also measure.
    """
    for turn in result.turns:
        latency = turn.get("latency_ms")
        if latency is not None:
            return float(latency)
    return None


def _avg_response_latency_ms(result: CallResult) -> float | None:
    latencies = [t["latency_ms"] for t in result.turns if t.get("latency_ms") is not None]
    if not latencies:
        return None
    return sum(latencies) / len(latencies)


# ---------------------------------------------------------------------------
# CohortSloReport
# ---------------------------------------------------------------------------


@dataclass
class CohortSloReport:
    """Aggregated per-cohort SLO compliance.

    All fields are PHI-free. ``error_class_distribution`` maps the per-slot
    exception class name (e.g. ``"TimeoutError"``) to count so operators can
    triage failure modes without needing the exception body.
    """

    name: str
    cohort_size: int
    completed: int
    failed: int

    setup_success_rate: float
    post_call_completion_rate: float

    first_response_p50_ms: float | None
    first_response_p95_ms: float | None
    avg_response_p50_ms: float | None
    avg_response_p95_ms: float | None
    total_duration_p50_ms: float | None
    total_duration_p95_ms: float | None

    avg_turns: float
    avg_tool_calls_per_call: float

    tool_call_distribution: dict[str, int] = field(default_factory=dict)
    end_reason_distribution: dict[str, int] = field(default_factory=dict)
    error_class_distribution: dict[str, int] = field(default_factory=dict)
    scenario_distribution: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Return a JSON-serializable dict. PHI-free by construction."""
        return {
            "name": self.name,
            "cohort_size": self.cohort_size,
            "completed": self.completed,
            "failed": self.failed,
            "setup_success_rate": self.setup_success_rate,
            "post_call_completion_rate": self.post_call_completion_rate,
            "first_response_p50_ms": self.first_response_p50_ms,
            "first_response_p95_ms": self.first_response_p95_ms,
            "avg_response_p50_ms": self.avg_response_p50_ms,
            "avg_response_p95_ms": self.avg_response_p95_ms,
            "total_duration_p50_ms": self.total_duration_p50_ms,
            "total_duration_p95_ms": self.total_duration_p95_ms,
            "avg_turns": self.avg_turns,
            "avg_tool_calls_per_call": self.avg_tool_calls_per_call,
            "tool_call_distribution": dict(self.tool_call_distribution),
            "end_reason_distribution": dict(self.end_reason_distribution),
            "error_class_distribution": dict(self.error_class_distribution),
            "scenario_distribution": dict(self.scenario_distribution),
        }


def build_cohort_report(
    name: str,
    outcomes: Iterable[ConcurrentCallOutcome],
) -> CohortSloReport:
    """Aggregate per-call outcomes into a cohort-level SLO report."""
    outcomes = list(outcomes)
    cohort_size = len(outcomes)
    completed_outcomes = [o for o in outcomes if o.result is not None and o.error is None]
    failed_outcomes = [o for o in outcomes if o not in completed_outcomes]

    completed = len(completed_outcomes)
    failed = len(failed_outcomes)

    setup_success_rate = completed / cohort_size if cohort_size else 0.0
    post_call_completion = sum(
        1 for o in completed_outcomes if o.result and o.result.post_call_completed
    )
    post_call_completion_rate = (
        post_call_completion / completed if completed else 0.0
    )

    first_response_latencies: list[float] = []
    avg_response_latencies: list[float] = []
    durations: list[float] = []
    turn_counts: list[int] = []
    tool_call_counts: list[int] = []
    tool_call_dist: Counter[str] = Counter()
    end_reason_dist: Counter[str] = Counter()
    scenario_dist: Counter[str] = Counter()

    for outcome in completed_outcomes:
        assert outcome.result is not None  # narrowed above
        result = outcome.result

        first = _first_response_latency_ms(result)
        if first is not None:
            first_response_latencies.append(first)

        avg = _avg_response_latency_ms(result)
        if avg is not None:
            avg_response_latencies.append(avg)

        if result.total_duration_ms:
            durations.append(result.total_duration_ms)

        turn_counts.append(len(result.turns))
        tool_call_counts.append(len(result.tool_calls_made))
        for tool in result.tool_calls_made:
            tool_call_dist[tool] += 1
        end_reason_dist[result.end_reason] += 1
        scenario_dist[outcome.scenario_name] += 1

    error_class_dist: Counter[str] = Counter()
    for outcome in failed_outcomes:
        if outcome.error:
            error_class_dist[outcome.error] += 1
        else:
            error_class_dist["unknown"] += 1

    avg_turns = sum(turn_counts) / len(turn_counts) if turn_counts else 0.0
    avg_tool_calls = sum(tool_call_counts) / len(tool_call_counts) if tool_call_counts else 0.0

    return CohortSloReport(
        name=name,
        cohort_size=cohort_size,
        completed=completed,
        failed=failed,
        setup_success_rate=setup_success_rate,
        post_call_completion_rate=post_call_completion_rate,
        first_response_p50_ms=_percentile(first_response_latencies, 50),
        first_response_p95_ms=_percentile(first_response_latencies, 95),
        avg_response_p50_ms=_percentile(avg_response_latencies, 50),
        avg_response_p95_ms=_percentile(avg_response_latencies, 95),
        total_duration_p50_ms=_percentile(durations, 50),
        total_duration_p95_ms=_percentile(durations, 95),
        avg_turns=avg_turns,
        avg_tool_calls_per_call=avg_tool_calls,
        tool_call_distribution=dict(tool_call_dist),
        end_reason_distribution=dict(end_reason_dist),
        error_class_distribution=dict(error_class_dist),
        scenario_distribution=dict(scenario_dist),
    )


# ---------------------------------------------------------------------------
# CohortComparison
# ---------------------------------------------------------------------------


@dataclass
class SloBreach:
    """A single SLO row that failed the threshold check."""

    metric: str
    cohort: str
    observed: float | None
    threshold: float
    direction: str  # "below" or "above"

    def to_dict(self) -> dict:
        return {
            "metric": self.metric,
            "cohort": self.cohort,
            "observed": self.observed,
            "threshold": self.threshold,
            "direction": self.direction,
        }


@dataclass
class CohortComparison:
    """Side-by-side comparison of two cohorts against §1.3 SLOs.

    ``breaches`` is the operator-facing punch list of rows that failed the
    threshold check. An empty list means both cohorts cleared the SLO
    targets relevant to the simulation.
    """

    control: CohortSloReport
    treatment: CohortSloReport
    thresholds: CohortSloThresholds
    breaches: list[SloBreach] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return not self.breaches

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "control": self.control.to_dict(),
            "treatment": self.treatment.to_dict(),
            "thresholds": {
                "outbound_call_setup_p95_ms": self.thresholds.outbound_call_setup_p95_ms,
                "post_call_critical_p95_seconds": self.thresholds.post_call_critical_p95_seconds,
                "setup_success_floor": self.thresholds.setup_success_floor,
                "post_call_completion_floor": self.thresholds.post_call_completion_floor,
            },
            "breaches": [b.to_dict() for b in self.breaches],
        }


def compare_cohorts(
    control: CohortSloReport,
    treatment: CohortSloReport,
    *,
    thresholds: CohortSloThresholds = DEFAULT_THRESHOLDS,
) -> CohortComparison:
    """Compare two cohort reports against the §1.3 SLO row set.

    Only checks SLOs that the simulation can observe directly: setup
    latency p95, setup success rate, post-call completion rate. SLOs that
    require live infrastructure (caller-ID answer rate, real DB pool idle
    at 600 concurrent calls, duplicate-call rate) are intentionally
    skipped — those need real Telnyx dials or production traffic.
    """
    breaches: list[SloBreach] = []

    for report in (control, treatment):
        # Setup latency p95
        if report.first_response_p95_ms is not None:
            if report.first_response_p95_ms > thresholds.outbound_call_setup_p95_ms:
                breaches.append(SloBreach(
                    metric="first_response_p95_ms",
                    cohort=report.name,
                    observed=report.first_response_p95_ms,
                    threshold=thresholds.outbound_call_setup_p95_ms,
                    direction="above",
                ))

        # Setup success rate
        if report.cohort_size > 0 and report.setup_success_rate < thresholds.setup_success_floor:
            breaches.append(SloBreach(
                metric="setup_success_rate",
                cohort=report.name,
                observed=report.setup_success_rate,
                threshold=thresholds.setup_success_floor,
                direction="below",
            ))

        # Post-call completion (skip cohorts where nothing completed at all
        # — that's already captured by setup_success_rate failure).
        if report.completed > 0 and report.post_call_completion_rate < thresholds.post_call_completion_floor:
            breaches.append(SloBreach(
                metric="post_call_completion_rate",
                cohort=report.name,
                observed=report.post_call_completion_rate,
                threshold=thresholds.post_call_completion_floor,
                direction="below",
            ))

    return CohortComparison(
        control=control,
        treatment=treatment,
        thresholds=thresholds,
        breaches=breaches,
    )
