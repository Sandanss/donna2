import asyncio
import base64
import time
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import main as pipecat_main
from api.routes.call_context import call_metadata


@pytest.fixture(autouse=True)
def reset_websocket_state():
    original_semaphore = pipecat_main._call_semaphore
    call_metadata.clear()
    pipecat_main._active_calls = 0
    yield
    call_metadata.clear()
    pipecat_main._active_calls = 0
    pipecat_main._call_semaphore = original_semaphore


def test_telnyx_websocket_accepts_authenticated_l16_media_smoke(monkeypatch):
    call_control_id = "v3:smoke-call"
    ws_token = "smoke-token"
    media_payload = base64.b64encode(b"\x00\x01" * 320).decode()
    captured = {}

    async def fake_run_bot(websocket, session_state, prepared_call=None):
        captured["prepared_call"] = prepared_call
        captured["session_call_sid"] = session_state["call_sid"]
        frame = await websocket.receive_json()
        captured["media_event"] = frame

    monkeypatch.setattr(pipecat_main, "run_bot", fake_run_bot)
    call_metadata[call_control_id] = {
        "ws_token": ws_token,
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
        "senior": {"id": "senior-smoke"},
        "call_type": "check-in",
    }

    client = TestClient(pipecat_main.app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws?ws_token={ws_token}") as websocket:
            websocket.send_json({"event": "connected"})
            websocket.send_json({
                "event": "start",
                "stream_id": "stream-smoke",
                "start": {
                    "call_control_id": call_control_id,
                    "media_format": {
                        "encoding": "L16",
                        "sample_rate": 16000,
                    },
                    "from": "+15550000000",
                    "to": "+15551111111",
                },
            })
            websocket.send_json({
                "event": "media",
                "media": {"payload": media_payload},
            })
            websocket.receive_text()

    assert captured["session_call_sid"] == call_control_id
    assert captured["prepared_call"]["transport_type"] == "telnyx"
    assert captured["prepared_call"]["call_data"] == {
        "stream_id": "stream-smoke",
        "call_control_id": call_control_id,
        "outbound_encoding": "L16",
        "from": "+15550000000",
        "to": "+15551111111",
        "query_params": {"ws_token": ws_token},
    }
    assert captured["prepared_call"]["metadata"]["ws_token_consumed"] is True
    assert captured["media_event"]["event"] == "media"
    assert len(base64.b64decode(captured["media_event"]["media"]["payload"])) == 640
    assert pipecat_main._active_calls == 0


def test_telnyx_websocket_rejects_bad_token_before_pipeline(monkeypatch):
    call_metadata["v3:smoke-call"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }
    run_bot = AsyncMock()
    monkeypatch.setattr(pipecat_main, "run_bot", run_bot)

    client = TestClient(pipecat_main.app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?ws_token=wrong-token") as websocket:
            websocket.send_json({"event": "connected"})
            websocket.send_json({
                "event": "start",
                "stream_id": "stream-smoke",
                "start": {
                    "call_control_id": "v3:smoke-call",
                    "media_format": {"encoding": "L16", "sample_rate": 16000},
                },
            })
            websocket.receive_text()

    run_bot.assert_not_awaited()


def test_telnyx_websocket_hangs_up_and_cleans_metadata_when_at_capacity(monkeypatch):
    call_control_id = "v3:capacity-call"
    ws_token = "capacity-token"
    run_bot = AsyncMock()
    hangup = AsyncMock()
    monkeypatch.setattr(pipecat_main, "run_bot", run_bot)
    monkeypatch.setattr("api.routes.telnyx._hangup_telnyx_call", hangup)
    pipecat_main._call_semaphore = asyncio.Semaphore(0)

    call_metadata[call_control_id] = {
        "ws_token": ws_token,
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
        "telephony_provider": "telnyx",
        "senior": {"id": "senior-capacity"},
        "call_type": "check-in",
    }

    client = TestClient(pipecat_main.app)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws?ws_token={ws_token}") as websocket:
            websocket.send_json({"event": "connected"})
            websocket.send_json({
                "event": "start",
                "stream_id": "stream-capacity",
                "start": {
                    "call_control_id": call_control_id,
                    "media_format": {"encoding": "L16", "sample_rate": 16000},
                },
            })
            websocket.receive_text()

    hangup.assert_awaited_once_with(call_control_id)
    run_bot.assert_not_awaited()
    assert call_control_id not in call_metadata
