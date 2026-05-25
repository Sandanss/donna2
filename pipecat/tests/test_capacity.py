"""Tests for Pipecat capacity heartbeat helpers."""

import asyncio
import time

import pytest

from services.capacity import (
    HEARTBEAT_KEY_PREFIX,
    QUEUE_RESERVATION_KEY_PREFIX,
    RESERVATION_KEY_PREFIX,
    build_capacity_heartbeat,
    count_capacity_reservations,
    heartbeat_key,
    list_capacity_instances,
    publish_capacity_heartbeat,
    release_capacity_reservation,
    start_capacity_heartbeat,
)


class FakeSharedState:
    is_shared = True

    def __init__(self):
        self.hashes = {}
        self.values = {}
        self.ttls = {}

    async def set_hash(self, key, mapping, ttl=None):
        self.hashes[key] = dict(mapping)
        self.ttls[key] = ttl

    async def keys(self, pattern="*"):
        prefix = pattern.rstrip("*")
        return [
            key
            for key in [*self.hashes.keys(), *self.values.keys()]
            if key.startswith(prefix)
        ]

    async def get_hash(self, key):
        return self.hashes.get(key)

    async def delete(self, key):
        self.hashes.pop(key, None)
        self.values.pop(key, None)


@pytest.mark.asyncio
async def test_publish_capacity_heartbeat_is_phi_free_and_ttl_bound():
    state = FakeSharedState()

    heartbeat = await publish_capacity_heartbeat(
        state=state,
        instance_id="replica-1",
        active_calls=12,
        max_calls=75,
        inbound_active_calls=2,
        pending_start_count=3,
        draining=False,
        healthy=True,
        service_version="test-sha",
        db_pool_size=20,
        db_pool_idle=7,
        circuit_breakers_open=0,
    )

    key = heartbeat_key("replica-1")
    assert state.ttls[key] == 15
    assert heartbeat == state.hashes[key]
    assert heartbeat["instance_id"] == "replica-1"
    assert heartbeat["active_calls"] == 12
    assert heartbeat["inbound_active_calls"] == 2
    assert heartbeat["max_calls"] == 75
    # Phase 3 §8: ready=True requires healthy + not draining + capacity
    # headroom + db_pool_size>0 + circuit_breakers_open==0 (the readiness
    # gate composition added in services/readiness.py). The fixture above
    # satisfies all of those.
    assert heartbeat["ready"] is True
    assert heartbeat["service_version"] == "test-sha"
    assert heartbeat["db_pool_stats_available"] is True
    assert heartbeat["db_pool_size"] == 20
    assert heartbeat["db_pool_idle"] == 7
    assert heartbeat["circuit_breakers_open"] == 0
    assert heartbeat["warmup_gate_green"] is None
    assert "senior" not in heartbeat
    assert "phone" not in heartbeat
    assert "transcript" not in heartbeat


@pytest.mark.asyncio
async def test_start_capacity_heartbeat_publishes_cached_warmup_gate(monkeypatch):
    published_kwargs = {}

    async def fake_publish_capacity_heartbeat(**kwargs):
        published_kwargs.update(kwargs)
        raise asyncio.CancelledError()

    monkeypatch.setattr(
        "services.capacity.publish_capacity_heartbeat",
        fake_publish_capacity_heartbeat,
    )

    with pytest.raises(asyncio.CancelledError):
        await start_capacity_heartbeat(
            get_active_calls=lambda: 0,
            get_max_calls=lambda: 75,
            is_draining=lambda: False,
            get_pending_start_count=lambda: 0,
            get_db_pool_stats=lambda: {"size": 20, "idle": 7},
            get_circuit_breakers_open_count=lambda: 0,
            get_warmup_gate_green=lambda: False,
            instance_id="replica-gate-test",
        )

    assert published_kwargs["instance_id"] == "replica-gate-test"
    assert published_kwargs["db_pool_stats_available"] is True
    assert published_kwargs["warmup_gate_green"] is False


@pytest.mark.asyncio
async def test_list_capacity_instances_filters_stale_heartbeats():
    state = FakeSharedState()
    now = time.time()
    state.hashes[f"{HEARTBEAT_KEY_PREFIX}fresh"] = build_capacity_heartbeat(
        instance_id="fresh",
        active_calls=2,
        max_calls=75,
        inbound_active_calls=1,
        pending_start_count=1,
        draining=True,
        healthy=True,
        service_version="test-sha",
        db_pool_size=20,
        db_pool_idle=7,
        circuit_breakers_open=1,
        now=now,
    )
    state.hashes[f"{HEARTBEAT_KEY_PREFIX}stale"] = build_capacity_heartbeat(
        instance_id="stale",
        active_calls=99,
        max_calls=75,
        now=now - 60,
    )

    instances = await list_capacity_instances(state=state, now=now)

    assert instances == [{
        "instance_id": "fresh",
        "service": "donna-pipecat",
        "service_version": "test-sha",
        "active_calls": 2,
        "max_calls": 75,
        "inbound_active_calls": 1,
        "pending_start_count": 1,
        "draining": True,
        "healthy": True,
        "ready": False,
        "db_pool_stats_available": True,
        "db_pool_size": 20,
        "db_pool_idle": 7,
        "circuit_breakers_open": 1,
        "warmup_gate_green": None,
        "started_at": now,
        "updated_at": now,
    }]


@pytest.mark.asyncio
async def test_heartbeat_ready_flag_respects_explicit_is_ready():
    """Explicit prepare_for_traffic readiness must gate the heartbeat."""
    not_ready_yet = build_capacity_heartbeat(
        instance_id="cold-replica",
        active_calls=0,
        max_calls=50,
        healthy=True,
        draining=False,
        is_ready=False,
    )
    assert not_ready_yet["ready"] is False

    drained = build_capacity_heartbeat(
        instance_id="cold-replica",
        active_calls=0,
        max_calls=50,
        healthy=True,
        draining=True,
        is_ready=True,
    )
    assert drained["ready"] is False

    fully_ready = build_capacity_heartbeat(
        instance_id="warm-replica",
        active_calls=0,
        max_calls=50,
        healthy=True,
        draining=False,
        is_ready=True,
    )
    assert fully_ready["ready"] is True


@pytest.mark.asyncio
async def test_publish_heartbeat_propagates_is_ready_to_state():
    state = FakeSharedState()
    await publish_capacity_heartbeat(
        state=state,
        instance_id="replica-not-ready",
        active_calls=0,
        max_calls=50,
        healthy=True,
        is_ready=False,
    )
    key = heartbeat_key("replica-not-ready")
    assert state.hashes[key]["ready"] is False


@pytest.mark.asyncio
async def test_capacity_reservations_are_counted_and_released():
    state = FakeSharedState()
    state.values[f"{RESERVATION_KEY_PREFIX}reservation-1"] = "{}"
    state.values[f"{RESERVATION_KEY_PREFIX}reservation-2"] = "{}"
    state.values[f"{QUEUE_RESERVATION_KEY_PREFIX}queue-1"] = "reservation-1"

    assert await count_capacity_reservations(state=state) == 2

    await release_capacity_reservation(
        state=state,
        reservation_id="reservation-1",
        queue_id="queue-1",
    )

    assert f"{RESERVATION_KEY_PREFIX}reservation-1" not in state.values
    assert f"{QUEUE_RESERVATION_KEY_PREFIX}queue-1" not in state.values
    assert await count_capacity_reservations(state=state) == 1
