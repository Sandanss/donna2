"""Cross-replica WebSocket token replay protection (Category A, Phase 3/4).

Phase 3 exit criterion: two replicas attempting to consume the same one-time
WS token via shared state — exactly one wins. The production path uses
`state.set_if_absent("ws_token_consumed:{cid}", ..., ttl=...)`. If two
replicas point at the same shared backing, `set_if_absent` must return True
for the first and False for the second.

Mirrors the Node-side `tests/services/ws-token-cross-replica.test.js` against
the actual Pipecat consume_ws_token entrypoint.
"""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest


class FakeSharedState:
    """In-memory shared-state stand-in. Mirrors the FakeSharedState pattern in
    pipecat/tests/test_api_routes.py — both `replicas` get the SAME instance
    so SETNX semantics apply across the boundary."""

    is_shared = True

    def __init__(self):
        self.data: dict = {}
        self.ttls: dict = {}

    async def set(self, key, value, ttl=None):
        self.data[key] = value
        self.ttls[key] = ttl

    async def set_if_absent(self, key, value, ttl=None):
        if key in self.data:
            return False
        self.data[key] = value
        self.ttls[key] = ttl
        return True

    async def get(self, key):
        return self.data.get(key)

    async def delete(self, key):
        self.data.pop(key, None)
        self.ttls.pop(key, None)


def _build_call_metadata(call_id: str, *, ws_token: str, ttl_seconds: int = 600) -> dict:
    now = time.time()
    return {
        "call_sid": call_id,
        "ws_token": ws_token,
        "ws_token_expires_at": now + ttl_seconds,
        "ws_token_consumed": False,
    }


@pytest.mark.asyncio
async def test_consume_ws_token_concurrent_replicas_only_one_wins():
    """Two replicas race to consume the same token — exactly one succeeds."""
    from api.routes import call_context

    call_id = "v3:cci-cross-replica-1"
    ws_token = "tok-xyz"
    metadata = _build_call_metadata(call_id, ws_token=ws_token)
    shared = FakeSharedState()

    # Both "replicas" point at the same shared backing. Local call_metadata
    # is also shared in-process; the test exercises the shared SETNX claim,
    # which is the cross-replica barrier in production.
    call_context.call_metadata[call_id] = metadata
    try:
        with patch(
            "lib.redis_client.require_shared_state",
            return_value=shared,
        ):
            results = await asyncio.gather(
                call_context.consume_ws_token(call_id, ws_token),
                call_context.consume_ws_token(call_id, ws_token),
                return_exceptions=True,
            )
    finally:
        call_context.call_metadata.pop(call_id, None)

    successes = [r for r in results if not isinstance(r, Exception)]
    failures = [r for r in results if isinstance(r, Exception)]

    assert len(successes) == 1, f"expected exactly one winner, got {len(successes)} (results={results})"
    assert len(failures) == 1
    assert "consumed" in str(failures[0]).lower() or "already" in str(failures[0]).lower()


@pytest.mark.asyncio
async def test_consume_ws_token_sequential_replay_rejected():
    """First consume wins; every subsequent attempt with the same token fails."""
    from api.routes import call_context

    call_id = "v3:cci-replay-2"
    ws_token = "tok-replay"
    metadata = _build_call_metadata(call_id, ws_token=ws_token)
    shared = FakeSharedState()

    call_context.call_metadata[call_id] = metadata
    try:
        with patch(
            "lib.redis_client.require_shared_state",
            return_value=shared,
        ):
            first = await call_context.consume_ws_token(call_id, ws_token)
            with pytest.raises(Exception):
                await call_context.consume_ws_token(call_id, ws_token)
            with pytest.raises(Exception):
                await call_context.consume_ws_token(call_id, ws_token)
    finally:
        call_context.call_metadata.pop(call_id, None)

    assert first["ws_token_consumed"] is True
    assert shared.data.get(f"ws_token_consumed:{call_id}") is not None
