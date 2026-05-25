"""Rate limiting middleware.

Port of middleware/rate-limit.js — 5 rate limiters using slowapi, plus a
service-label-aware carve-out for backend-to-backend dispatcher traffic.

Phase 4 §8 — the dispatcher dials up to ~600 calls per 15-minute window from a
single Railway egress IP. The public per-IP CALL_LIMIT would throttle the
dispatcher into itself. Requests authenticated by a labeled DONNA_API_KEYS key
are routed onto a separate (much looser) bucket keyed by service label so the
public IP bucket continues to protect non-service callers.
"""

from __future__ import annotations

import hmac
import os
from typing import Callable

from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address

from config import parse_service_api_keys


def _truthy(value: str | None) -> bool:
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def rate_limit_storage_uri(env: dict[str, str] | None = None) -> str | None:
    """Return Redis storage URI for distributed SlowAPI counters."""
    env = env or os.environ
    if not _truthy(env.get("REDIS_RATE_LIMITS_ENABLED")):
        return None
    redis_url = str(env.get("REDIS_URL") or "").strip()
    if not redis_url:
        raise RuntimeError("REDIS_URL is required when REDIS_RATE_LIMITS_ENABLED=true for Pipecat")
    return redis_url


def _provided_api_key(request: Request) -> str:
    """Extract a presented service API key from a FastAPI request."""
    if request is None:
        return ""
    headers = getattr(request, "headers", None)
    if headers is None:
        return ""
    provided = headers.get("x-api-key", "") or ""
    if provided:
        return str(provided)
    auth = headers.get("authorization", "") or ""
    if auth.startswith("Bearer "):
        return str(auth[7:])
    return ""


def _resolve_service_label(request: Request) -> str | None:
    """Return the labeled service-key label when present, else None.

    Labels come from DONNA_API_KEYS (e.g. dispatcher, scheduler, pipecat).
    Comparison is constant-time so the lookup is not a timing-side-channel.
    """
    provided = _provided_api_key(request)
    if not provided:
        return None
    for label, key in parse_service_api_keys().items():
        if not key:
            continue
        if hmac.compare_digest(str(provided), str(key)):
            return label
    return None


def service_request_key(request: Request) -> str | None:
    """Key function for the service-label bucket — None for public callers."""
    label = _resolve_service_label(request)
    if not label:
        return None
    return f"service:{label}"


def public_request_key(request: Request) -> str | None:
    """Key function for the public IP bucket — None for service-key callers."""
    if _resolve_service_label(request) is not None:
        return None
    return get_remote_address(request)


limiter = Limiter(
    key_func=get_remote_address,
    storage_uri=rate_limit_storage_uri(),
    swallow_errors=False,
    key_prefix="pipecat",
)

# Public per-IP rate limit strings (apply via key_func=public_request_key on
# routes that should let service-key traffic bypass).
API_LIMIT = "100/minute"        # All /api/* routes
CALL_LIMIT = "5/minute"         # Call initiation endpoints
WRITE_LIMIT = "30/minute"       # POST/PUT/DELETE operations
AUTH_LIMIT = "10/minute"        # Login/auth endpoints
WEBHOOK_LIMIT = "500/minute"    # Voice webhooks

# Service-label rate limits (apply via key_func=service_request_key). These are
# tuned so the dispatcher's 600-dial peak-window burst never throttles itself
# at the public CALL_LIMIT. Per-label buckets prevent cross-service interference.
SERVICE_CALL_LIMIT = "5000/minute"
SERVICE_WRITE_LIMIT = "5000/minute"
