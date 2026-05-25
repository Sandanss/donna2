"""Concurrent simulation runner.

The single-call runner (`run_simulated_call`) is fine for behavior assertions,
but Phase 5 (synthetic A/B) and Phase 6 (post-call stampede) need to run many
simulated calls *in parallel* against the real pipeline to exercise:

- Concurrency-safe DB writes (memories, conversations, post_call_jobs)
- Director / Observer state isolation across calls
- Post-call job queue saturation shape
- Cohort-level metric collection (control vs treatment)

``run_simulated_calls_concurrent`` is a thin asyncio orchestrator on top of
``run_simulated_call``. Each call gets its own ``TestSenior`` (so DB writes
don't collide on senior_id), its own conversation, its own session_state,
and its own pipeline instance. Concurrency is capped by a semaphore so the
caller can opt into "fire N at once, only M live at a time" patterns.

Vendor reality: the existing live-sim pipeline already mocks STT and TTS
(``TestInputTransport``, ``MockTTSProcessor``). The only real vendor calls
per simulated call are Anthropic Claude (LLM) and the Director's Groq/Gemini
calls. Concurrent runs scale those linearly.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Iterable

from loguru import logger

from tests.simulation.fixtures import TestSenior, seed_test_senior, cleanup_test_senior
from tests.simulation.runner import run_simulated_call
from tests.simulation.scenarios import LiveSimScenario
from tests.simulation.transport import CallResult


@dataclass
class ConcurrentCallSpec:
    """One slot in a concurrent run: a scenario plus an optional senior override.

    When ``senior`` is None the orchestrator auto-generates a fresh
    ``TestSenior`` with a unique UUID + phone so two concurrent calls cannot
    collide on the database primary key. Seeding is opt-in via ``seed_db``
    (true by default for integration runs, false for unit tests that build
    their own DB fixtures upstream).
    """

    scenario: LiveSimScenario
    senior: TestSenior | None = None
    seed_db: bool = True
    cleanup_after: bool = True
    label: str | None = None  # e.g. "control" / "treatment" / "stampede-042"


@dataclass
class ConcurrentCallOutcome:
    """Result of one slot in a concurrent run.

    ``result`` is None when ``error`` is set (the call never completed) or
    when the call failed before producing turn data. ``label`` mirrors the
    spec label so a cohort comparator can sort outcomes after the fact.
    """

    label: str | None
    senior_id: str
    scenario_name: str
    result: CallResult | None = None
    error: str | None = None  # PHI-free: exception class name only


@dataclass
class ConcurrentRunSummary:
    started: int = 0
    completed: int = 0
    failed: int = 0
    duration_seconds: float = 0.0
    outcomes: list[ConcurrentCallOutcome] = field(default_factory=list)

    def by_label(self, label: str) -> list[ConcurrentCallOutcome]:
        return [o for o in self.outcomes if o.label == label]


def _auto_senior(scenario: LiveSimScenario, index: int) -> TestSenior:
    """Generate a unique TestSenior for one slot in a concurrent run.

    Copies scenario interests / city / state / profile_notes so the call
    runs with the same context the scenario expects, but assigns a fresh
    UUID + phone to keep DB writes per-call isolated.
    """
    template = scenario.senior
    return TestSenior(
        id=str(uuid.uuid4()),
        # Names stay on a non-PHI generic pattern; the actual scenario logic
        # only reads the senior dataclass, not real PII.
        name=f"{template.name.split()[0]} Sim-{index:04d}",
        phone=f"55512{index:05d}"[:10].ljust(10, "0"),
        timezone=template.timezone,
        interests=list(template.interests),
        profile_notes=template.profile_notes,
        city=template.city,
        state=template.state,
    )


async def _run_one(
    spec: ConcurrentCallSpec,
    *,
    index: int,
    semaphore: asyncio.Semaphore,
    timeout_per_call: float,
    run_post_call_processing: bool,
    on_progress: Callable[[ConcurrentCallOutcome], None] | None,
) -> ConcurrentCallOutcome:
    """Execute one slot under the concurrency semaphore."""
    senior = spec.senior or _auto_senior(spec.scenario, index)
    outcome = ConcurrentCallOutcome(
        label=spec.label,
        senior_id=senior.id,
        scenario_name=spec.scenario.name,
    )

    async with semaphore:
        try:
            if spec.seed_db:
                await seed_test_senior(senior)

            outcome.result = await asyncio.wait_for(
                run_simulated_call(
                    spec.scenario,
                    senior=senior,
                    run_post_call_processing=run_post_call_processing,
                ),
                timeout=timeout_per_call,
            )
        except asyncio.TimeoutError:
            outcome.error = "TimeoutError"
            logger.warning(
                "[ConcurrentRunner] slot {idx} ({label}) timed out after {t}s",
                idx=index,
                label=spec.label or "-",
                t=timeout_per_call,
            )
        except Exception as exc:
            # PHI-safe: class name only, never the exception body.
            outcome.error = type(exc).__name__
            logger.warning(
                "[ConcurrentRunner] slot {idx} ({label}) failed: {cls}",
                idx=index,
                label=spec.label or "-",
                cls=outcome.error,
            )
        finally:
            if spec.cleanup_after and spec.seed_db:
                try:
                    await cleanup_test_senior(senior.id)
                except Exception:
                    logger.debug("[ConcurrentRunner] cleanup_test_senior failed for slot {idx}", idx=index)

    if on_progress is not None:
        try:
            on_progress(outcome)
        except Exception:
            logger.debug("[ConcurrentRunner] on_progress callback failed")

    return outcome


async def run_simulated_calls_concurrent(
    specs: Iterable[ConcurrentCallSpec | LiveSimScenario],
    *,
    max_concurrent: int = 10,
    timeout_per_call: float = 300.0,
    run_post_call_processing: bool = True,
    on_progress: Callable[[ConcurrentCallOutcome], None] | None = None,
) -> ConcurrentRunSummary:
    """Run N simulated calls in parallel, capped at ``max_concurrent`` at a time.

    Args:
        specs: Iterable of ``ConcurrentCallSpec`` or bare ``LiveSimScenario``
            (auto-wrapped). Each spec produces exactly one call.
        max_concurrent: Maximum number of in-flight calls at any moment.
        timeout_per_call: Hard timeout per call (seconds). On timeout the
            outcome carries ``error="TimeoutError"`` and ``result=None``.
        run_post_call_processing: Whether each call runs post-call analysis
            after the conversation ends.
        on_progress: Optional callable invoked with each outcome as it
            completes (in completion order, not submission order). Useful
            for streaming progress bars or live SLO dashboards.

    Returns:
        ``ConcurrentRunSummary`` with per-slot outcomes and aggregate counts.
    """
    normalized: list[ConcurrentCallSpec] = []
    for item in specs:
        if isinstance(item, ConcurrentCallSpec):
            normalized.append(item)
        elif isinstance(item, LiveSimScenario):
            normalized.append(ConcurrentCallSpec(scenario=item))
        else:
            raise TypeError(
                f"specs must contain ConcurrentCallSpec or LiveSimScenario, "
                f"got {type(item).__name__}"
            )

    if not normalized:
        return ConcurrentRunSummary()

    if max_concurrent < 1:
        raise ValueError("max_concurrent must be >= 1")

    semaphore = asyncio.Semaphore(max_concurrent)
    start = asyncio.get_event_loop().time()
    summary = ConcurrentRunSummary(started=len(normalized))

    tasks = [
        asyncio.create_task(
            _run_one(
                spec,
                index=i,
                semaphore=semaphore,
                timeout_per_call=timeout_per_call,
                run_post_call_processing=run_post_call_processing,
                on_progress=on_progress,
            )
        )
        for i, spec in enumerate(normalized)
    ]

    for finished in asyncio.as_completed(tasks):
        outcome = await finished
        summary.outcomes.append(outcome)
        if outcome.error is None and outcome.result is not None:
            summary.completed += 1
        else:
            summary.failed += 1

    summary.duration_seconds = asyncio.get_event_loop().time() - start
    logger.info(
        "[ConcurrentRunner] {n} calls in {dur:.1f}s: {ok} completed, {fail} failed (max_concurrent={mc})",
        n=summary.started,
        dur=summary.duration_seconds,
        ok=summary.completed,
        fail=summary.failed,
        mc=max_concurrent,
    )
    return summary
