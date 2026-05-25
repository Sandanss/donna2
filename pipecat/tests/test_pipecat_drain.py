"""Pipecat drain-flag coverage (Category D Phase 3 backfill).

Three contracts under test, all surfaced by the `_is_draining()` helper in
`pipecat/main.py`:

  (a) `GET /health` returns 503 with `"draining": true` while draining.
  (b) `WS /ws` is rejected with close code 1001 ("Server draining") before
      auth runs.
  (c) `build_capacity_heartbeat(...)` emits `ready=False, draining=True` so
      the global dispatcher routes traffic away from this replica.

The drain state is read by `_is_draining()` which OR's two sources:

  * `_shutting_down` (module-level bool flipped by the SIGTERM handler in
    `main.shutdown`), and
  * `settings.pipecat_draining` (env-driven, set at boot for pre-drain
    rollouts).

`settings` is a frozen dataclass, so we exercise the SIGTERM-equivalent
surface by flipping `_shutting_down` directly. This matches what the
`@app.on_event("shutdown")` handler does in production.
"""

import asyncio
import os
import time
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

# Required env so config.assert_production_config etc. don't trip during import.
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("TELNYX_API_KEY", "test-telnyx-key")
os.environ.setdefault("TELNYX_PUBLIC_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
os.environ.setdefault("TELNYX_PHONE_NUMBER", "+15551234567")
os.environ.setdefault("TELNYX_CONNECTION_ID", "test-connection")
os.environ.setdefault("ALLOW_UNSIGNED_TELNYX_WEBHOOKS", "true")

import main as pipecat_main
from api.routes.call_context import call_metadata
from services.capacity import build_capacity_heartbeat


@pytest.fixture(autouse=True)
def reset_drain_state():
    original_shutting_down = pipecat_main._shutting_down
    original_semaphore = pipecat_main._call_semaphore
    call_metadata.clear()
    pipecat_main._active_calls = 0
    yield
    pipecat_main._shutting_down = original_shutting_down
    pipecat_main._call_semaphore = original_semaphore
    call_metadata.clear()
    pipecat_main._active_calls = 0


@pytest.fixture
def client():
    return TestClient(pipecat_main.app)


class TestHealthEndpointWhileDraining:
    @patch("db.check_health", new_callable=AsyncMock, return_value=True)
    @patch("db.client.get_pool_stats", new_callable=AsyncMock, return_value={"size": 5, "idle": 3})
    def test_health_reports_503_and_draining_true(self, _pool_stats, _db_health, client, monkeypatch):
        monkeypatch.setattr(pipecat_main, "_shutting_down", True)
        response = client.get("/health")
        assert response.status_code == 503
        body = response.json()
        assert body["draining"] is True
        assert body["status"] == "draining"


class TestWebSocketRejectedWhileDraining:
    def test_new_ws_connection_closed_with_1001_before_auth(self, monkeypatch):
        """Drain check runs at the very top of the handler, before token consume.

        We register a dummy call_metadata entry to prove the rejection happens
        regardless of whether the token would have been valid — drain MUST
        short-circuit before auth.
        """
        monkeypatch.setattr(pipecat_main, "_shutting_down", True)
        # Ensure run_bot would crash loudly if reached — it must not be.
        crashing_run_bot = AsyncMock(side_effect=AssertionError(
            "run_bot reached during drain — WS handler did not short-circuit"
        ))
        monkeypatch.setattr(pipecat_main, "run_bot", crashing_run_bot)

        call_metadata["v3:drain-call"] = {
            "ws_token": "valid-token",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "senior": {"id": "senior-drain"},
            "call_type": "check-in",
        }

        client = TestClient(pipecat_main.app)
        # Server closes immediately on connect; TestClient surfaces this as
        # WebSocketDisconnect when we try to send.
        with pytest.raises(WebSocketDisconnect) as excinfo:
            with client.websocket_connect("/ws?ws_token=valid-token") as ws:
                # Try to send so the close is observed.
                ws.send_json({"event": "connected"})
                ws.receive_text()

        # Server-initiated close with code 1001 ("going away" / drain).
        assert excinfo.value.code == 1001
        crashing_run_bot.assert_not_awaited()


class TestCapacityHeartbeatDrainFlag:
    def test_build_capacity_heartbeat_marks_ready_false_when_draining(self):
        heartbeat = build_capacity_heartbeat(
            instance_id="instance-test",
            active_calls=3,
            max_calls=50,
            draining=True,
            healthy=True,
        )

        # Both flags MUST be set so the global dispatcher will skip this
        # replica even though it still has capacity (active < max).
        assert heartbeat["draining"] is True
        assert heartbeat["ready"] is False
        assert heartbeat["healthy"] is True
        assert heartbeat["active_calls"] == 3
        assert heartbeat["max_calls"] == 50

    def test_build_capacity_heartbeat_ready_when_not_draining(self):
        """Sanity foil: same call without draining=True yields ready=True.

        Phase 3 §8 readiness gate also requires db_pool_size>0 and
        circuit_breakers_open==0 — pass them explicitly so the foil
        isolates the drain flag from the gate composition.
        """
        heartbeat = build_capacity_heartbeat(
            instance_id="instance-test",
            active_calls=3,
            max_calls=50,
            draining=False,
            healthy=True,
            db_pool_size=10,
            circuit_breakers_open=0,
        )
        assert heartbeat["draining"] is False
        assert heartbeat["ready"] is True
