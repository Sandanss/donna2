"""Tests for shared-state backend selection and Upstash REST commands."""

import json
import time

import httpx
import pytest

import lib.redis_client as redis_client
from lib.redis_client import (
    InMemoryState,
    RedisState,
    UpstashRestState,
    check_shared_state_health,
    create_shared_state,
    require_shared_state,
    reset_shared_state_for_tests,
)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.commands = []
        self.closed = False

    async def post(self, path, json):
        self.commands.append((path, json))
        return _FakeResponse(self.responses.pop(0))

    async def aclose(self):
        self.closed = True


class _FailingClient:
    async def post(self, path, json):
        raise httpx.ConnectError("DNS failure")


def test_create_shared_state_prefers_redis_url():
    state = create_shared_state(
        redis_url="redis://localhost:6379",
        upstash_url="https://example.upstash.io",
        upstash_token="token",
    )
    assert isinstance(state, RedisState)
    assert state.is_shared is True


def test_create_shared_state_uses_upstash_when_redis_url_missing():
    state = create_shared_state(
        upstash_url="https://example.upstash.io",
        upstash_token="token",
    )
    assert isinstance(state, UpstashRestState)
    assert state.is_shared is True


def test_create_shared_state_falls_back_to_memory():
    state = create_shared_state()
    assert isinstance(state, InMemoryState)
    assert state.is_shared is False


def test_require_shared_state_rejects_memory_when_required(monkeypatch):
    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    reset_shared_state_for_tests()
    try:
        with pytest.raises(RuntimeError, match="PIPECAT_REQUIRE_REDIS=true"):
            require_shared_state("test operation")
    finally:
        reset_shared_state_for_tests()


@pytest.mark.asyncio
async def test_shared_state_health_fails_closed_when_required_without_config(monkeypatch):
    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    monkeypatch.delenv("REDIS_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    reset_shared_state_for_tests()
    try:
        health = await check_shared_state_health()
    finally:
        reset_shared_state_for_tests()

    assert health == {
        "required": True,
        "configured": False,
        "backend": "memory",
        "shared": False,
        "available": False,
        "ok": False,
        "error": "shared_state_not_configured",
    }


@pytest.mark.asyncio
async def test_shared_state_health_reports_degraded_optional_upstash_outage(monkeypatch):
    monkeypatch.delenv("PIPECAT_REQUIRE_REDIS", raising=False)
    monkeypatch.setenv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
    monkeypatch.setenv("UPSTASH_REDIS_REST_TOKEN", "token")
    state = UpstashRestState("https://example.upstash.io", "token")
    state._client = _FailingClient()
    monkeypatch.setattr(redis_client, "_state", state)
    try:
        health = await check_shared_state_health()
    finally:
        reset_shared_state_for_tests()

    assert health == {
        "required": False,
        "configured": True,
        "backend": "upstash",
        "shared": True,
        "available": False,
        "ok": True,
        "error": "shared_state_unreachable",
        "degraded": True,
        "fallback": "local_memory",
    }


@pytest.mark.asyncio
async def test_shared_state_health_fails_required_upstash_outage(monkeypatch):
    monkeypatch.setenv("PIPECAT_REQUIRE_REDIS", "true")
    monkeypatch.setenv("UPSTASH_REDIS_REST_URL", "https://example.upstash.io")
    monkeypatch.setenv("UPSTASH_REDIS_REST_TOKEN", "token")
    state = UpstashRestState("https://example.upstash.io", "token")
    state._client = _FailingClient()
    monkeypatch.setattr(redis_client, "_state", state)
    try:
        health = await check_shared_state_health()
    finally:
        reset_shared_state_for_tests()

    assert health == {
        "required": True,
        "configured": True,
        "backend": "upstash",
        "shared": True,
        "available": False,
        "ok": False,
        "error": "shared_state_unreachable",
        "degraded": True,
        "fallback": None,
    }


def test_upstash_rest_state_adds_https_scheme_when_missing():
    state = UpstashRestState("example.upstash.io/", "token")

    assert state._url == "https://example.upstash.io"


@pytest.mark.asyncio
async def test_upstash_rest_state_set_and_get_json_with_ttl():
    client = _FakeClient([
        {"result": "OK"},
        {"result": json.dumps({"call_type": "check-in"})},
    ])
    state = UpstashRestState("https://example.upstash.io/", "token")
    state._client = client

    await state.set("call_metadata:CA123", {"call_type": "check-in"}, ttl=1800)
    result = await state.get("call_metadata:CA123")

    assert result == {"call_type": "check-in"}
    assert client.commands[0][1] == [
        "SET",
        "call_metadata:CA123",
        json.dumps({"call_type": "check-in"}),
        "EX",
        1800,
    ]
    assert client.commands[1][1] == ["GET", "call_metadata:CA123"]


@pytest.mark.asyncio
async def test_upstash_rest_state_ping():
    client = _FakeClient([
        {"result": "PONG"},
    ])
    state = UpstashRestState("https://example.upstash.io/", "token")
    state._client = client

    assert await state.ping() is True
    assert client.commands[0][1] == ["PING"]


@pytest.mark.asyncio
async def test_in_memory_state_set_if_absent_claims_once():
    state = InMemoryState()

    assert await state.set_if_absent("ws_token_consumed:CA123", {"ok": True}, ttl=30) is True
    assert await state.set_if_absent("ws_token_consumed:CA123", {"ok": True}, ttl=30) is False


@pytest.mark.asyncio
async def test_upstash_rest_state_set_if_absent_uses_nx_with_ttl():
    client = _FakeClient([
        {"result": "OK"},
        {"result": None},
    ])
    state = UpstashRestState("https://example.upstash.io/", "token")
    state._client = client

    first = await state.set_if_absent("ws_token_consumed:CA123", {"consumed": True}, ttl=300)
    second = await state.set_if_absent("ws_token_consumed:CA123", {"consumed": True}, ttl=300)

    assert first is True
    assert second is False
    assert client.commands[0][1] == [
        "SET",
        "ws_token_consumed:CA123",
        json.dumps({"consumed": True}),
        "EX",
        300,
        "NX",
    ]


@pytest.mark.asyncio
async def test_upstash_rest_state_hash_roundtrip_shape():
    client = _FakeClient([
        {"result": 2},
        {"result": 1},
        {"result": ["field", json.dumps({"ok": True})]},
        {"result": 1},
    ])
    state = UpstashRestState("https://example.upstash.io", "token")
    state._client = client

    await state.set_hash("hash", {"field": {"ok": True}}, ttl=30)
    result = await state.get_hash("hash")
    await state.delete_hash_field("hash", "field")

    assert result == {"field": {"ok": True}}
    assert client.commands[0][1] == ["HSET", "hash", "field", json.dumps({"ok": True})]
    assert client.commands[1][1] == ["EXPIRE", "hash", 30]
    assert client.commands[2][1] == ["HGETALL", "hash"]
    assert client.commands[3][1] == ["HDEL", "hash", "field"]


@pytest.mark.asyncio
async def test_upstash_rest_state_temporarily_disables_after_http_failure():
    state = UpstashRestState("https://example.upstash.io", "token")
    state._client = _FailingClient()

    with pytest.raises(httpx.ConnectError):
        await state.set("key", {"value": True})

    assert state.is_shared is False
    assert state._disabled_until > time.monotonic()
