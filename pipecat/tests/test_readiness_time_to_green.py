"""Time-to-green metric spec test (Phase 3 work item 8 / §8.5).

Per `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`:

    §3 exit criteria (line 625):
      "Replica readiness gate verified: a cold replica takes scheduled
       traffic only after the gate flips green. Time-to-green measured
       and recorded."

    §8 monitoring (line 952):
      "pipecat_replica_warmup_seconds{instance_id} (rev 2)"

    §8 SLOs (line 1080):
      "Replica readiness gate green time-to-traffic < 60 seconds at
       scale-up."

Therefore the production startup sequence is expected to record a metric
of the elapsed seconds between process start and the moment the warmup
gate flips all-green. The audit in §8 ("Phase 3 exit criteria not yet
met") notes this is not yet implemented.

When production lands a `pipecat_replica_warmup_seconds` metric (Prometheus
counter / histogram OR loguru structured log line), remove the xfail.
"""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import AsyncMock

import pytest


@pytest.mark.asyncio
async def test_time_to_green_metric_emitted_when_gate_flips_green(monkeypatch):
    """A `pipecat_replica_warmup_seconds` metric must be emitted exactly once
    when the readiness gate transitions from red → green.

    Expected production shape (one of):

      (a) Prometheus histogram:
          `pipecat_replica_warmup_seconds.labels(instance_id=...).observe(t)`
      (b) Counter+gauge pair via `lib.metrics`:
          `record_replica_time_to_green(instance_id, seconds)`
      (c) Structured loguru line with `event="replica_time_to_green"`.

    This test tries (a) → (b) → (c) and asserts at least one fires.
    """

    # Try the most likely import paths the production code will use. None
    # of these exist today; the xfail above documents why.
    candidate_modules = [
        "lib.metrics",
        "services.metrics",
        "services.readiness",
    ]
    candidate_fn_names = [
        "record_replica_time_to_green",
        "observe_replica_warmup_seconds",
        "emit_time_to_green",
    ]

    found = False
    recorded: list[tuple[str, float]] = []

    def _spy(instance_id: str, seconds: float) -> None:
        recorded.append((instance_id, float(seconds)))

    for mod_name in candidate_modules:
        try:
            mod = __import__(mod_name, fromlist=["*"])
        except ImportError:
            continue
        for fn_name in candidate_fn_names:
            if hasattr(mod, fn_name):
                found = True
                monkeypatch.setattr(f"{mod_name}.{fn_name}", _spy)

    if not found:
        pytest.fail(
            "No time-to-green recording function found in lib.metrics, "
            "services.metrics, or services.readiness. Phase 3 work item 8 "
            "exit criterion 'time-to-green measured and recorded' is open."
        )

    # Drive a mock startup that flips the gate green and expect exactly
    # one recording with a positive `seconds` value.
    try:
        from services.readiness import (  # type: ignore[attr-defined]
            run_warmup_and_record_time_to_green,
        )
    except ImportError:
        pytest.fail(
            "services.readiness.run_warmup_and_record_time_to_green() is "
            "expected to drive warmup and call the metric recorder."
        )

    # Stub out every individual warmup precondition so the gate succeeds
    # immediately. Production will wire these via real `awaits`.
    monkeypatch.setattr(
        "services.readiness.warm_neon_pool", AsyncMock(return_value=True), raising=False
    )
    monkeypatch.setattr(
        "services.readiness.ensure_growthbook_initialized",
        AsyncMock(return_value=True), raising=False,
    )
    monkeypatch.setattr(
        "services.readiness.run_anthropic_prompt_cache_primer",
        AsyncMock(return_value=True), raising=False,
    )
    monkeypatch.setattr(
        "services.readiness.test_deepgram_session_open_close",
        AsyncMock(return_value=True), raising=False,
    )
    monkeypatch.setattr(
        "services.readiness.test_tts_session_open",
        AsyncMock(return_value=True), raising=False,
    )

    started_at = time.monotonic()
    await run_warmup_and_record_time_to_green(instance_id="replica-spec-1")
    elapsed = time.monotonic() - started_at

    assert len(recorded) == 1, (
        f"Expected exactly one time-to-green recording, got {len(recorded)}: "
        f"{recorded!r}"
    )
    instance_id, seconds = recorded[0]
    assert instance_id == "replica-spec-1"
    assert seconds >= 0.0
    assert seconds <= elapsed + 1.0, (
        f"Recorded {seconds=} exceeds wall-clock elapsed {elapsed=}"
    )


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Phase 3 §8 SLO 'replica readiness gate green time-to-traffic < 60 "
        "seconds at scale-up' (plan line 1080) requires a metric to alert "
        "on. No such metric exists yet."
    ),
)
@pytest.mark.asyncio
async def test_time_to_green_metric_has_instance_id_label():
    """The metric must carry an `instance_id` label so per-replica alerts
    (plan §8 line 951-952) can fire.

    Per Phase 3 monitoring requirements:
        - `pipecat_instance_readiness{instance_id}`
        - `pipecat_replica_warmup_seconds{instance_id}`
    """
    try:
        from services.readiness import (  # type: ignore[attr-defined]
            get_recorded_time_to_green_samples,
        )
    except ImportError:
        pytest.fail(
            "services.readiness.get_recorded_time_to_green_samples() is "
            "expected for per-instance assertion."
        )

    samples: list[dict[str, Any]] = get_recorded_time_to_green_samples()
    assert samples, "No time-to-green samples recorded at all."
    for sample in samples:
        assert "instance_id" in sample
        assert "seconds" in sample
        assert isinstance(sample["seconds"], (int, float))
