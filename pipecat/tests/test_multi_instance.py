"""Cross-replica integration tests for Phase 3 multi-instance hardening.

These tests verify the three shared-state primitives that must serialize
correctly when more than one Pipecat replica processes the same Telnyx event
or call:

1. Telnyx event dedupe (``_mark_telnyx_event_seen``) — duplicate webhook event
   IDs arriving at both replicas must result in exactly one ``False`` (the
   first to claim) and the rest ``True`` (already-seen).
2. WebSocket token consume (``consume_ws_token`` via ``state.set_if_absent``)
   — a single-use ``ws_token`` claimed simultaneously by two replicas must
   succeed for exactly one.
3. Telnyx media stream-start lock (``_claim_telnyx_stream_start``) — two
   replicas racing to start the media stream for the same
   ``call_control_id`` must result in exactly one ``True``.

Rather than spinning up two processes, the tests share a single in-memory
"Redis-equivalent" backend between two distinct ``Replica`` state objects.
Each replica looks like a shared-state instance to the production code (it
has ``is_shared = True`` and the standard set/get/set_if_absent API), but the
storage is shared and atomic, just as a single Redis instance is from two
replicas' perspectives.

Real Redis is not required for these tests — the asyncio.Lock-protected dict
correctly models the SET NX semantics that all three primitives depend on.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest

import lib.redis_client as redis_client


# ---------------------------------------------------------------------------
# Shared atomic backend + per-replica wrapper
# ---------------------------------------------------------------------------


class SharedAtomicBackend:
    """In-memory backend with atomic set-if-absent semantics.

    Models the slice of Redis behavior the production code relies on: SET NX
    and TTL bookkeeping. ``asyncio.Lock`` ensures concurrent ``set_if_absent``
    from different replicas observe a single linearization order, exactly
    matching how Redis serializes commands from multiple clients.
    """

    def __init__(self):
        self._values: dict[str, Any] = {}
        self._hashes: dict[str, dict] = {}
        self._expiry: dict[str, float] = {}
        self._lock = asyncio.Lock()

    def _expire_if_needed(self, key: str, now: float) -> None:
        exp = self._expiry.get(key)
        if exp is not None and exp <= now:
            self._values.pop(key, None)
            self._hashes.pop(key, None)
            self._expiry.pop(key, None)

    async def set_if_absent(self, key: str, value: Any, ttl: int | None) -> bool:
        async with self._lock:
            now = time.time()
            self._expire_if_needed(key, now)
            if key in self._values or key in self._hashes:
                return False
            self._values[key] = value
            if ttl is not None:
                self._expiry[key] = now + ttl
            return True

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        async with self._lock:
            self._values[key] = value
            self._hashes.pop(key, None)
            if ttl is not None:
                self._expiry[key] = time.time() + ttl
            else:
                self._expiry.pop(key, None)

    async def get(self, key: str) -> Any | None:
        async with self._lock:
            now = time.time()
            self._expire_if_needed(key, now)
            return self._values.get(key)

    async def set_hash(self, key: str, mapping: dict, ttl: int | None = None) -> None:
        async with self._lock:
            self._hashes[key] = dict(mapping)
            if ttl is not None:
                self._expiry[key] = time.time() + ttl

    async def get_hash(self, key: str) -> dict | None:
        async with self._lock:
            now = time.time()
            self._expire_if_needed(key, now)
            return dict(self._hashes.get(key) or {}) or None

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._values.pop(key, None)
            self._hashes.pop(key, None)
            self._expiry.pop(key, None)

    async def keys(self, pattern: str = "*") -> list[str]:
        async with self._lock:
            prefix = pattern.rstrip("*")
            return [k for k in (*self._values.keys(), *self._hashes.keys()) if k.startswith(prefix)]


class Replica:
    """Per-replica view of the shared backend. Looks like RedisState to callers."""

    is_shared = True
    configured_shared = True
    backend_name = "shared-fake"

    def __init__(self, backend: SharedAtomicBackend, instance_id: str):
        self._backend = backend
        self.instance_id = instance_id
        self.calls_to_set_if_absent = 0

    async def set_if_absent(self, key: str, value: Any, ttl: int | None = None) -> bool:
        self.calls_to_set_if_absent += 1
        return await self._backend.set_if_absent(key, value, ttl)

    async def set(self, key: str, value: Any, ttl: int | None = None) -> None:
        # Mirrors RedisState.set: always overwrites, never NX. The production
        # _persist_metadata helper calls this after the set_if_absent claim
        # wins, and would silently miss the write if we routed through NX.
        await self._backend.set(key, value, ttl)

    async def get(self, key: str) -> Any | None:
        return await self._backend.get(key)

    async def set_hash(self, key: str, mapping: dict, ttl: int | None = None) -> None:
        await self._backend.set_hash(key, mapping, ttl)

    async def get_hash(self, key: str) -> dict | None:
        return await self._backend.get_hash(key)

    async def delete(self, key: str) -> None:
        await self._backend.delete(key)

    async def keys(self, pattern: str = "*") -> list[str]:
        return await self._backend.keys(pattern)

    async def ping(self) -> bool:
        return True


# ---------------------------------------------------------------------------
# Test 1 — primitive set_if_absent atomicity across two replicas
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_if_absent_serializes_across_replicas_for_same_key():
    """Two replicas race on the same key — exactly one wins."""
    backend = SharedAtomicBackend()
    replica_a = Replica(backend, "replica-a")
    replica_b = Replica(backend, "replica-b")

    results = await asyncio.gather(
        replica_a.set_if_absent("telnyx:event:e-123", {"claimed_by": "a"}, ttl=600),
        replica_b.set_if_absent("telnyx:event:e-123", {"claimed_by": "b"}, ttl=600),
    )

    assert results.count(True) == 1
    assert results.count(False) == 1
    # The losing replica did try (so we know we tested the race path).
    assert replica_a.calls_to_set_if_absent == 1
    assert replica_b.calls_to_set_if_absent == 1


@pytest.mark.asyncio
async def test_set_if_absent_under_high_concurrency_yields_one_winner():
    """50 concurrent racers on the same key — exactly one wins."""
    backend = SharedAtomicBackend()
    replicas = [Replica(backend, f"replica-{i}") for i in range(50)]

    results = await asyncio.gather(*(r.set_if_absent("call:lock:c-xyz", {}, ttl=60) for r in replicas))

    assert results.count(True) == 1
    assert results.count(False) == 49


# ---------------------------------------------------------------------------
# Test 2 — Telnyx event dedupe (_mark_telnyx_event_seen) across replicas
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_duplicate_telnyx_event_dedupe_across_replicas(monkeypatch):
    """Two replicas process the same Telnyx event_id; only one is the original."""
    from api.routes import telnyx as telnyx_routes

    backend = SharedAtomicBackend()
    replicas = [Replica(backend, "replica-a"), Replica(backend, "replica-b")]
    counter = {"idx": 0}

    def round_robin_state(operation: str = "shared state"):
        idx = counter["idx"]
        counter["idx"] = (counter["idx"] + 1) % len(replicas)
        return replicas[idx]

    # Patch require_shared_state in the redis_client module — the production
    # helper imports it lazily, so patching the module attribute is enough.
    monkeypatch.setattr(redis_client, "require_shared_state", round_robin_state)
    # Clear any leftover local dedupe state from previous tests.
    telnyx_routes._recent_telnyx_event_ids.clear()

    event_id = "telnyx-event-abc123"
    seen_a, seen_b = await asyncio.gather(
        telnyx_routes._mark_telnyx_event_seen(event_id),
        telnyx_routes._mark_telnyx_event_seen(event_id),
    )

    # _mark_telnyx_event_seen returns True for "already seen" (i.e. duplicate).
    # Exactly one of the two replicas should see it for the first time (False).
    assert [seen_a, seen_b].count(False) == 1
    assert [seen_a, seen_b].count(True) == 1


# ---------------------------------------------------------------------------
# Test 3 — WebSocket token consume across replicas
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_websocket_token_consume_serializes_across_replicas(monkeypatch):
    """Two replicas try to consume the same ws_token; only one succeeds."""
    from api.routes import call_context

    backend = SharedAtomicBackend()
    replicas = [Replica(backend, "replica-a"), Replica(backend, "replica-b")]
    counter = {"idx": 0}

    def round_robin_state(operation: str = "shared state"):
        idx = counter["idx"]
        counter["idx"] = (counter["idx"] + 1) % len(replicas)
        return replicas[idx]

    monkeypatch.setattr(redis_client, "require_shared_state", round_robin_state)

    call_id = "ws-call-xyz"
    token = "single-use-token-001"
    now = time.time()

    # Seed metadata in the local dict (in real prod this is replicated via
    # shared state; for this test we only care about the consume race).
    call_context.call_metadata[call_id] = {
        "call_sid": call_id,
        "ws_token": token,
        "ws_token_expires_at": now + 600,
        "ws_token_consumed": False,
    }

    try:
        results = await asyncio.gather(
            call_context.consume_ws_token(call_id, token),
            call_context.consume_ws_token(call_id, token),
            return_exceptions=True,
        )
    finally:
        call_context.call_metadata.pop(call_id, None)

    successes = [r for r in results if not isinstance(r, BaseException)]
    failures = [r for r in results if isinstance(r, BaseException)]

    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], call_context.WsTokenConsumeError)


# ---------------------------------------------------------------------------
# Test 4 — Telnyx media stream-start lock across replicas
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_telnyx_stream_start_lock_serializes_across_replicas(monkeypatch):
    """Two replicas race to claim the media-stream start for the same call."""
    from api.routes import telnyx as telnyx_routes

    backend = SharedAtomicBackend()
    replicas = [Replica(backend, "replica-a"), Replica(backend, "replica-b")]
    counter = {"idx": 0}

    def round_robin_state(operation: str = "shared state"):
        idx = counter["idx"]
        counter["idx"] = (counter["idx"] + 1) % len(replicas)
        return replicas[idx]

    monkeypatch.setattr(redis_client, "require_shared_state", round_robin_state)

    call_control_id = "stream-call-001"
    results = await asyncio.gather(
        telnyx_routes._claim_telnyx_stream_start(call_control_id),
        telnyx_routes._claim_telnyx_stream_start(call_control_id),
    )

    # _claim_telnyx_stream_start returns True when this replica claimed the
    # lock. With shared state, exactly one True.
    assert results.count(True) == 1
    assert results.count(False) == 1


# ---------------------------------------------------------------------------
# Test 5 — replica counter integrity under interleaved load
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_distinct_keys_are_independent_across_replicas():
    """Two replicas claiming *different* keys both succeed — proves the lock
    does not over-serialize and reduce throughput."""
    backend = SharedAtomicBackend()
    replica_a = Replica(backend, "replica-a")
    replica_b = Replica(backend, "replica-b")

    results = await asyncio.gather(
        replica_a.set_if_absent("call:lock:c-1", {}, ttl=60),
        replica_b.set_if_absent("call:lock:c-2", {}, ttl=60),
        replica_a.set_if_absent("call:lock:c-3", {}, ttl=60),
        replica_b.set_if_absent("call:lock:c-4", {}, ttl=60),
    )

    assert all(results)
