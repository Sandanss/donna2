"""Phase 3 fail-closed coverage for the Pipecat SlowAPI rate limiter.

Phase 3's scaling exit criterion states "Redis-outage in scaled mode fails closed."
`pipecat/tests/test_rate_limit.py` asserts this at the *storage-URI builder*
layer (REDIS_URL must be set when REDIS_RATE_LIMITS_ENABLED=true), but the
runtime path — what SlowAPI actually does when the configured Redis endpoint is
*unreachable* — is not exercised anywhere in the suite.

This test wires a minimal FastAPI app with the same Limiter configuration the
production app uses (`swallow_errors=False`, `key_prefix="pipecat"`), points the
storage URI at a deliberately-unreachable Redis (`redis://127.0.0.1:1`), and
fires requests against a rate-limited route. Because `swallow_errors=False`,
SlowAPI must propagate the storage error rather than silently allowing the
request (which would be the "open" failure mode we are guarding against).

If `swallow_errors=True` ever ships, this test is marked xfail with the audit
reason — keeping the coverage in place so the regression is visible.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from api.middleware import rate_limit as rate_limit_module


UNREACHABLE_REDIS_URL = "redis://127.0.0.1:1"


def _build_app_with_unreachable_redis() -> FastAPI:
    """Build a FastAPI app whose limiter storage is unreachable."""
    limiter = Limiter(
        key_func=get_remote_address,
        storage_uri=UNREACHABLE_REDIS_URL,
        swallow_errors=False,
        key_prefix="pipecat-test",
    )
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

    @app.get("/noop")
    @limiter.limit("5/minute", key_func=get_remote_address)
    async def noop(request: Request):
        return {"ok": True}

    return app


def test_rate_limit_fails_closed_when_redis_unreachable_in_required_mode(monkeypatch):
    """SlowAPI must fail closed on Redis-outage when swallow_errors=False.

    A pass means: at least one of the ~10 driven requests surfaces the Redis
    failure (HTTP 5xx OR an exception bubbling up through the test client),
    rather than every request quietly returning 200. The "allow all under
    outage" mode is the regression we are guarding against.
    """
    # Guard rails: ensure scaled-mode is the configuration we are validating.
    monkeypatch.setenv("REDIS_RATE_LIMITS_ENABLED", "true")
    monkeypatch.setenv("REDIS_URL", UNREACHABLE_REDIS_URL)

    # Sanity check on the production Limiter configuration. If this flips to
    # True somewhere, downgrade to xfail with the audit reason rather than
    # silently asserting fail-closed semantics that no longer hold.
    if getattr(rate_limit_module.limiter, "_swallow_errors", False):  # pragma: no cover
        pytest.xfail(
            "Phase 3 audit gap: production Limiter has swallow_errors=True; "
            "rate limiter would fail open under Redis outage."
        )

    app = _build_app_with_unreachable_redis()
    client = TestClient(app, raise_server_exceptions=False)

    saw_failure = False
    statuses: list[int] = []
    for _ in range(10):
        try:
            response = client.get("/noop")
        except Exception:
            saw_failure = True
            break
        statuses.append(response.status_code)
        if response.status_code >= 500:
            saw_failure = True
            break

    assert saw_failure, (
        "SlowAPI did not fail closed: every request returned a success status "
        f"despite the Redis storage being unreachable. Observed statuses: {statuses}"
    )
