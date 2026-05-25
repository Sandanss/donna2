"""Tests for telephony media WebSocket admission."""

import asyncio
import time
from unittest.mock import AsyncMock, patch

import pytest

import bot as bot_module
from api.routes.call_context import call_metadata
from bot import WebSocketAuthError, authenticate_websocket_call


@pytest.fixture(autouse=True)
def clear_call_metadata():
    call_metadata.clear()
    yield
    call_metadata.clear()


@pytest.mark.asyncio
async def test_websocket_auth_rejects_unknown_call_sid():
    with patch.object(bot_module, "WS_METADATA_LOOKUP_TIMEOUT_SECONDS", 0):
        with pytest.raises(WebSocketAuthError, match="unknown call_sid"):
            await authenticate_websocket_call(
                {"call_id": "CAunknown", "body": {"ws_token": "token"}},
                {},
            )


@pytest.mark.asyncio
async def test_websocket_auth_waits_briefly_for_metadata_to_appear(monkeypatch):
    metadata = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }
    mock_get = AsyncMock(side_effect=[None, None, metadata])
    mock_consume = AsyncMock(return_value=metadata)
    mock_sleep = AsyncMock()

    monkeypatch.setattr(bot_module, "WS_METADATA_LOOKUP_TIMEOUT_SECONDS", 0.2)
    monkeypatch.setattr(bot_module, "WS_METADATA_LOOKUP_POLL_INTERVAL_SECONDS", 0.01)

    with patch("api.routes.call_context.get_call_metadata", mock_get), \
         patch("api.routes.call_context.consume_ws_token", mock_consume), \
         patch("bot.asyncio.sleep", mock_sleep):
        loaded = await authenticate_websocket_call(
            {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
            {},
        )

    assert loaded is metadata
    assert mock_get.await_count == 3
    assert mock_sleep.await_count == 2
    mock_consume.assert_awaited_once_with("CA123", "expected-token")


@pytest.mark.asyncio
async def test_websocket_auth_rejects_missing_token():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    with pytest.raises(WebSocketAuthError, match="invalid token"):
        await authenticate_websocket_call({"call_id": "CA123", "body": {}}, {})


@pytest.mark.asyncio
async def test_websocket_auth_rejects_expired_token():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() - 1,
        "ws_token_consumed": False,
    }

    with pytest.raises(WebSocketAuthError, match="token expired"):
        await authenticate_websocket_call(
            {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
            {},
        )


@pytest.mark.asyncio
async def test_websocket_auth_rejects_reused_token():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": True,
    }

    with pytest.raises(WebSocketAuthError, match="token already consumed"):
        await authenticate_websocket_call(
            {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
            {},
        )


@pytest.mark.asyncio
async def test_websocket_auth_accepts_valid_token_once():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    metadata = await authenticate_websocket_call(
        {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
        {},
    )

    assert metadata["ws_token_consumed"] is True
    assert metadata["ws_token_consumed_at"] <= time.time()


@pytest.mark.asyncio
async def test_websocket_auth_fails_closed_when_required_shared_claim_fails(monkeypatch):
    class FailingSharedState:
        is_shared = True

        async def set_if_absent(self, key, value, ttl=None):
            raise RuntimeError("redis unavailable")

    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    with patch("lib.redis_client.get_shared_state", return_value=FailingSharedState()):
        with pytest.raises(WebSocketAuthError, match="shared token consume unavailable"):
            await authenticate_websocket_call(
                {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
                {},
            )


@pytest.mark.asyncio
async def test_websocket_auth_fails_closed_when_required_metadata_lookup_fails(monkeypatch):
    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)

    with patch.object(bot_module, "WS_METADATA_LOOKUP_TIMEOUT_SECONDS", 0):
        with pytest.raises(WebSocketAuthError, match="shared metadata unavailable"):
            await authenticate_websocket_call(
                {"call_id": "CAunknown", "body": {"ws_token": "token"}},
                {},
            )


@pytest.mark.asyncio
async def test_websocket_auth_consumes_valid_token_atomically():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    async def attempt():
        try:
            await authenticate_websocket_call(
                {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
                {},
            )
            return "accepted"
        except WebSocketAuthError as exc:
            return str(exc)

    results = await asyncio.gather(attempt(), attempt())

    assert results.count("accepted") == 1
    assert results.count("token already consumed") == 1


@pytest.mark.asyncio
async def test_websocket_auth_can_validate_without_consuming_token():
    call_metadata["CA123"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    metadata = await authenticate_websocket_call(
        {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
        {},
        consume_token=False,
    )

    assert metadata["ws_token_consumed"] is False

    consumed = await authenticate_websocket_call(
        {"call_id": "CA123", "body": {"ws_token": "expected-token"}},
        {},
    )
    assert consumed["ws_token_consumed"] is True


@pytest.mark.asyncio
async def test_websocket_auth_accepts_telnyx_call_control_id_with_query_token():
    call_metadata["v2:call-control"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    metadata = await authenticate_websocket_call(
        {
            "call_control_id": "v2:call-control",
            "query_params": {"ws_token": "expected-token"},
        },
        {},
    )

    assert metadata["ws_token_consumed"] is True


@pytest.mark.asyncio
async def test_websocket_auth_accepts_telnyx_stream_auth_token():
    call_metadata["v3:call-control"] = {
        "ws_token": "expected-token",
        "ws_token_expires_at": time.time() + 300,
        "ws_token_consumed": False,
    }

    metadata = await authenticate_websocket_call(
        {
            "call_control_id": "v3:call-control",
            "body": {"stream_auth_token": "expected-token"},
        },
        {},
    )

    assert metadata["ws_token_consumed"] is True
