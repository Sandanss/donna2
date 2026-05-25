"""Tests for distributed rate-limit configuration."""

from types import SimpleNamespace

import pytest

from api.middleware.rate_limit import (
    public_request_key,
    rate_limit_storage_uri,
    service_request_key,
)


def test_rate_limit_storage_disabled_by_default():
    assert rate_limit_storage_uri({}) is None


def test_rate_limit_storage_uses_redis_url_when_enabled():
    assert rate_limit_storage_uri({
        "REDIS_RATE_LIMITS_ENABLED": "true",
        "REDIS_URL": "redis://redis.internal:6379",
    }) == "redis://redis.internal:6379"


def test_rate_limit_storage_fails_closed_when_enabled_without_redis_url():
    with pytest.raises(RuntimeError, match="REDIS_URL is required"):
        rate_limit_storage_uri({
            "REDIS_RATE_LIMITS_ENABLED": "true",
            "UPSTASH_REDIS_REST_URL": "https://redis.example.com",
            "UPSTASH_REDIS_REST_TOKEN": "token",
        })


def _build_request(headers=None, *, client_host="203.0.113.10"):
    """Minimal SlowAPI-compatible request stub.

    SlowAPI's `get_remote_address` reads `request.client.host`; key_func
    callables in this module also inspect `request.headers`.
    """
    return SimpleNamespace(
        headers=headers or {},
        client=SimpleNamespace(host=client_host),
    )


def test_service_request_key_returns_label_for_valid_service_api_key(monkeypatch):
    monkeypatch.setenv("DONNA_API_KEYS", "dispatcher:dispatch-key-xyz,scheduler:scheduler-key-abc")
    request = _build_request({"x-api-key": "dispatch-key-xyz"})
    assert service_request_key(request) == "service:dispatcher"


def test_service_request_key_returns_none_for_public_caller(monkeypatch):
    monkeypatch.setenv("DONNA_API_KEYS", "dispatcher:dispatch-key-xyz")
    public = _build_request({"x-api-key": "not-a-service-key"})
    assert service_request_key(public) is None
    no_header = _build_request({})
    assert service_request_key(no_header) is None


def test_public_request_key_returns_ip_when_no_service_label(monkeypatch):
    monkeypatch.setenv("DONNA_API_KEYS", "dispatcher:dispatch-key-xyz")
    public = _build_request({"x-api-key": "anonymous"}, client_host="198.51.100.7")
    assert public_request_key(public) == "198.51.100.7"


def test_public_request_key_returns_none_when_service_label_present(monkeypatch):
    monkeypatch.setenv("DONNA_API_KEYS", "dispatcher:dispatch-key-xyz")
    service_call = _build_request({"x-api-key": "dispatch-key-xyz"})
    assert public_request_key(service_call) is None


def test_service_request_key_reads_bearer_authorization_header(monkeypatch):
    monkeypatch.setenv("DONNA_API_KEYS", "pipecat:pipecat-key-9001")
    request = _build_request({"authorization": "Bearer pipecat-key-9001"})
    assert service_request_key(request) == "service:pipecat"
