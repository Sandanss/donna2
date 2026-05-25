"""Phase 3 fail-closed coverage for `_claim_telnyx_stream_start`.

The existing test `test_telnyx_events_fail_closed_when_required_dedupe_unavailable`
covers the *event dedupe* path. The stream-start claim is the symmetric guard
that prevents two Pipecat replicas from each starting a media stream for the
same `call_control_id` — a double-start would mean two LLM sessions on one
call. We assert the same fail-closed semantics: in required (scaled) mode, when
the shared-state backend raises, the claim must propagate the error rather than
silently returning `True` (which would let both replicas proceed).
"""

from __future__ import annotations

from unittest.mock import patch

import pytest


class _RaisingSharedState:
    """Mimics a configured-shared backend that raises on every operation.

    `is_shared = True` is required so `_claim_telnyx_stream_start` enters the
    Redis branch instead of returning True early via the in-memory fallback.
    """

    is_shared = True

    async def set_if_absent(self, key, value, ttl=None):  # noqa: D401
        raise RuntimeError("simulated shared-state outage")

    async def delete(self, key):  # pragma: no cover - defensive
        raise RuntimeError("simulated shared-state outage")


@pytest.mark.asyncio
async def test_claim_telnyx_stream_start_raises_when_required_and_redis_down(monkeypatch):
    """Stream-start claim must fail closed in scaled mode.

    Returning True under shared-state failure would let two replicas double-
    start the same call. This mirrors the dedupe-path guard pattern.
    """
    from api.routes import telnyx
    from lib.redis_client import reset_shared_state_for_tests

    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    reset_shared_state_for_tests()
    try:
        with patch(
            "lib.redis_client.require_shared_state",
            return_value=_RaisingSharedState(),
        ):
            with pytest.raises(RuntimeError, match="simulated shared-state outage"):
                await telnyx._claim_telnyx_stream_start("v3:test-call-claim")
    finally:
        reset_shared_state_for_tests()


@pytest.mark.asyncio
async def test_claim_telnyx_stream_start_uses_local_fallback_when_not_required(monkeypatch):
    """Without `PIPECAT_REQUIRE_REDIS`, the claim degrades to the local path.

    This is the non-scaled mode behavior — a single replica without shared
    state must still be able to handle calls. The fail-closed assertion above
    only applies when scaled mode is explicitly required.
    """
    from api.routes import telnyx
    from lib.redis_client import reset_shared_state_for_tests

    monkeypatch.delenv("PIPECAT_REQUIRE_REDIS", raising=False)
    reset_shared_state_for_tests()
    try:
        with patch(
            "lib.redis_client.require_shared_state",
            return_value=_RaisingSharedState(),
        ):
            result = await telnyx._claim_telnyx_stream_start("v3:test-call-fallback")
        # Local fallback returns True (single-replica installs cannot double-start).
        assert result is True
    finally:
        reset_shared_state_for_tests()
