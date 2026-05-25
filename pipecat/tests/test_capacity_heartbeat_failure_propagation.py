"""Phase 3 audit-gap test: capacity heartbeat failure propagation.

`start_capacity_heartbeat` in `pipecat/services/capacity.py` runs an infinite
loop and broad-excepts each iteration. When `shared_state_required()` is True,
the current code path logs at ERROR level and *continues looping* — the replica
is never marked unhealthy and remains counted by `list_capacity_instances`
peers via stale heartbeats.

Audit expectation: in scaled-mode (required shared state), a publish failure
should mark the replica unhealthy or bubble the exception so the runtime can
take corrective action (drain, restart, fail readiness probe). Today it only
logs.

This test asserts the desired behavior and is marked `xfail` to document the
gap. When the production code is corrected, remove the `xfail` mark.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_capacity_heartbeat_marks_replica_unhealthy_when_required_publish_fails(
    monkeypatch,
):
    """Required-mode publish failure must surface, not be silently logged.

    Phase 3 §8: when shared state is required, a heartbeat publish failure
    means peers will keep counting the replica's stale TTL'd entry as
    available capacity. start_capacity_heartbeat now re-raises in required
    mode so the heartbeat task terminates; the runtime can then drop the
    replica from the autoscaler pool / restart it.
    """
    from services import capacity

    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")

    publish_call_count = {"value": 0}

    async def failing_publish(*args, **kwargs):
        publish_call_count["value"] += 1
        raise RuntimeError("simulated heartbeat publish outage")

    with patch.object(capacity, "publish_capacity_heartbeat", side_effect=failing_publish):
        heartbeat_task = asyncio.create_task(
            capacity.start_capacity_heartbeat(
                get_active_calls=lambda: 5,
                get_max_calls=lambda: 10,
                is_draining=lambda: False,
                get_pending_start_count=AsyncMock(return_value=0),
                interval_seconds=0,
                instance_id="replica-test",
            )
        )

        with pytest.raises(RuntimeError, match="simulated heartbeat publish outage"):
            await asyncio.wait_for(heartbeat_task, timeout=1.0)

    assert publish_call_count["value"] >= 1, (
        "Sanity check: the patched publish should have been invoked at least once "
        "before the heartbeat task terminated."
    )


@pytest.mark.asyncio
async def test_capacity_heartbeat_keeps_looping_when_shared_state_not_required(monkeypatch):
    """Foil: without PIPECAT_REQUIRE_REDIS, a transient publish failure must
    NOT terminate the heartbeat task. The loop logs and continues so a flaky
    Redis blip during local dev doesn't crash the process.
    """
    from services import capacity

    monkeypatch.delenv("PIPECAT_REQUIRE_REDIS", raising=False)

    publish_call_count = {"value": 0}

    async def flaky_publish(*args, **kwargs):
        publish_call_count["value"] += 1
        raise RuntimeError("transient publish failure")

    with patch.object(capacity, "publish_capacity_heartbeat", side_effect=flaky_publish):
        heartbeat_task = asyncio.create_task(
            capacity.start_capacity_heartbeat(
                get_active_calls=lambda: 0,
                get_max_calls=lambda: 10,
                is_draining=lambda: False,
                get_pending_start_count=AsyncMock(return_value=0),
                interval_seconds=0,
                instance_id="replica-non-required",
            )
        )
        try:
            # Let the loop iterate a few times. It must NOT raise.
            await asyncio.sleep(0.1)
            assert not heartbeat_task.done(), (
                "heartbeat task terminated even though shared state is not required"
            )
            assert publish_call_count["value"] >= 2, (
                f"expected loop to iterate >= 2 times, got {publish_call_count['value']}"
            )
        finally:
            heartbeat_task.cancel()
            with pytest.raises((asyncio.CancelledError, RuntimeError)):
                await heartbeat_task
