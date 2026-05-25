"""Donna Pipecat — FastAPI server entry point.

Serves:
- /health — health check
- /ws — WebSocket endpoint for Pipecat voice pipeline
- /api/call — outbound call initiation
- /api/calls — active call listing (admin)
- /api/metrics/* — call metrics for observability dashboard (admin)
"""

from __future__ import annotations

import asyncio
import sys
import time
import warnings

from loguru import logger
from config import assert_production_config, is_production_environment, settings

# Configure log level: INFO in production, DEBUG locally
_log_level = settings.log_level


def _safe_log_filter(record) -> bool:
    """Suppress third-party DEBUG logs that can include transcripts or credentials."""
    name = record.get("name") or ""
    if record["level"].no < logger.level("INFO").no and name.startswith("pipecat."):
        return False

    message = record.get("message") or ""
    sensitive_patterns = (
        "Generating chat from LLM-specific context",
        "Generating TTS [",
        "Parsed - Type:",
    )
    return not any(pattern in message for pattern in sensitive_patterns)


logger.remove()
logger.add(sys.stderr, level=_log_level, filter=_safe_log_filter)

# Route Python warnings through loguru instead of raw stderr.
# This gives them a proper @level tag in Railway so they can be filtered.
# DeprecationWarnings → DEBUG (hidden at INFO), other warnings → WARNING.
def _warning_handler(message, category, filename, lineno, file=None, line=None):
    if issubclass(category, DeprecationWarning):
        logger.debug("{msg}", msg=str(message))
    else:
        logger.warning("{cat}: {msg}", cat=category.__name__, msg=str(message))

warnings.showwarning = _warning_handler

# Sentry error monitoring (before FastAPI import for auto-instrumentation)
try:
    import sentry_sdk
    import hashlib as _hashlib

    def _sentry_before_send(event, hint):
        """Strip PII from Sentry events before transmission."""
        # Hash any senior_id tags to prevent direct identification
        tags = event.get("tags") or {}
        sid = tags.get("senior_id")
        if sid and sid not in ("unknown", "None", None, ""):
            tags["senior_id"] = _hashlib.sha256(str(sid).encode()).hexdigest()[:8]
        # Truncate exception values to prevent conversation context leaks
        for exc_info in (event.get("exception") or {}).get("values", []):
            val = exc_info.get("value", "")
            if len(val) > 200:
                exc_info["value"] = val[:200] + "...[truncated]"
        return event

    _sentry_dsn = settings.sentry_dsn
    if _sentry_dsn:
        sentry_sdk.init(
            dsn=_sentry_dsn,
            traces_sample_rate=0,
            send_default_pii=False,
            before_send=_sentry_before_send,
            environment="production" if is_production_environment() else "development",
        )
        logger.info("Sentry initialized")
except ImportError:
    pass

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from api.middleware.error_handler import register_error_handlers
from api.middleware.rate_limit import limiter
from api.middleware.security import SecurityHeadersMiddleware
from api.routes.auth import router as auth_router
from api.routes.calls import router as calls_router
from api.routes.data import router as data_router
from api.routes.export import router as export_router
from api.routes.metrics import router as metrics_router
from api.routes.telnyx import router as telnyx_router
from api.routes.call_context import _cleanup_metadata, call_metadata
from bot import (
    WebSocketAuthError,
    authenticate_websocket_call,
    prepare_websocket_call,
    run_bot,
)

app = FastAPI(title="Donna Pipecat", version="0.1.0")

# ---------------------------------------------------------------------------
# Active call tracking for graceful shutdown
# ---------------------------------------------------------------------------
_active_tasks: set[asyncio.Task] = set()
_shutting_down = False


def is_shutting_down() -> bool:
    """Check if the server is in shutdown mode."""
    return _shutting_down


def register_call_task(task: asyncio.Task) -> None:
    """Track an active call task for graceful shutdown draining."""
    _active_tasks.add(task)
    task.add_done_callback(_active_tasks.discard)


async def _reject_prepared_call_at_capacity(prepared_call: dict, session_state: dict) -> None:
    """End a validated Telnyx call that cannot be admitted to the AI pipeline."""
    call_sid = session_state.get("call_sid")
    metadata = prepared_call.get("metadata") or {}
    try:
        if call_sid and metadata.get("telephony_provider") == "telnyx":
            from api.routes.telnyx import _hangup_telnyx_call

            await _hangup_telnyx_call(call_sid)
            logger.info("[{cs}] Hung up Telnyx call rejected at capacity", cs=call_sid)
    except Exception as exc:
        logger.error("[{cs}] Failed to hang up capacity-rejected Telnyx call: {err}", cs=call_sid or "unknown", err=str(exc))
    finally:
        if call_sid:
            await _cleanup_metadata(call_sid)

# ---------------------------------------------------------------------------
# Scalability: Concurrency control & metrics
# ---------------------------------------------------------------------------
MAX_CALLS = settings.max_concurrent_calls
_call_semaphore = asyncio.Semaphore(MAX_CALLS)
_active_calls = 0
_inbound_active_calls = 0
_peak_calls = 0
_startup_time = time.monotonic()

# Phase 3 replica readiness gate. Default False until prepare_for_traffic()
# completes successfully. Reflected in /health and in the capacity heartbeat
# `ready` field — the Node dispatcher will not lease this replica until True.
_is_ready: bool = False
_readiness_report: dict | None = None


def _is_draining() -> bool:
    return _shutting_down or settings.pipecat_draining


def _set_ready(value: bool) -> None:
    global _is_ready
    _is_ready = bool(value)


def _set_readiness_report(report) -> None:
    global _readiness_report
    try:
        _readiness_report = report.to_dict() if hasattr(report, "to_dict") else dict(report)
    except Exception:
        _readiness_report = None

# ---------------------------------------------------------------------------
# Middleware (order matters — outermost first)
# ---------------------------------------------------------------------------

# Security headers (HSTS, X-Frame-Options, etc.)
app.add_middleware(SecurityHeadersMiddleware)

# CORS
ALLOWED_ORIGINS = [
    "https://admin-v2-liart.vercel.app",
    settings.admin_url,
]
if not is_production_environment():
    ALLOWED_ORIGINS.extend(["http://localhost:5173", "http://localhost:3000"])

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in ALLOWED_ORIGINS if o],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Error handlers
register_error_handlers(app)

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
app.include_router(auth_router)
app.include_router(calls_router)
app.include_router(data_router)
app.include_router(export_router)
app.include_router(metrics_router)
app.include_router(telnyx_router)


@app.get("/health")
async def health():
    """Health check endpoint with service status, pool stats, and call metrics."""
    from db import check_health as db_health
    from db.client import get_pool_stats
    from lib.circuit_breaker import get_breaker_states
    from lib.cache_cleanup import get_cache_sizes
    from lib.redis_client import check_shared_state_health

    db_ok = await db_health()
    try:
        pool_stats = await get_pool_stats()
    except Exception:
        pool_stats = {}
    shared_state = await check_shared_state_health()
    breakers = get_breaker_states()
    caches = get_cache_sizes()
    any_breaker_open = any(s == "open" for s in breakers.values())
    shared_state_ok = bool(shared_state.get("ok"))
    shared_state_degraded = bool(shared_state.get("degraded"))

    status_code = 200 if db_ok and shared_state_ok and not _is_draining() else 503
    body = {
        "status": (
            "draining" if _is_draining()
            else "degraded" if (not db_ok or not shared_state_ok or shared_state_degraded or any_breaker_open)
            else "ok"
        ),
        "service": "donna-pipecat",
        "active_calls": _active_calls,
        "inbound_active_calls": _inbound_active_calls,
        "peak_calls": _peak_calls,
        "max_calls": MAX_CALLS,
        "uptime_seconds": round(time.monotonic() - _startup_time),
        "shutting_down": _shutting_down,
        "draining": _is_draining(),
        "ready": _is_ready and not _is_draining(),
        "readiness": _readiness_report,
        "database": "ok" if db_ok else "error",
        "shared_state": shared_state,
        "pool": pool_stats,
        "circuit_breakers": breakers,
        "cache": caches,
    }
    return JSONResponse(content=body, status_code=status_code)


@app.get("/live")
async def live():
    """Lightweight liveness check for Railway deploy health checks.

    Keep this endpoint free of database and vendor calls. `/health` remains the
    readiness endpoint for CI smoke tests and monitoring.
    """
    status_code = 503 if _shutting_down else 200
    return JSONResponse(
        content={
            "status": "draining" if _is_draining() else "ok",
            "service": "donna-pipecat",
            "active_calls": _active_calls,
            "inbound_active_calls": _inbound_active_calls,
            "max_calls": MAX_CALLS,
            "uptime_seconds": round(time.monotonic() - _startup_time),
            "shutting_down": _shutting_down,
            "draining": _is_draining(),
        },
        status_code=status_code,
    )


# ---------------------------------------------------------------------------
# WebSocket — Pipecat voice pipeline
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Telnyx connects here for media streaming. Runs the Pipecat pipeline."""
    global _active_calls, _inbound_active_calls, _peak_calls

    if _is_draining():
        await websocket.close(code=1001, reason="Server draining")
        return

    await websocket.accept()

    session_state = {
        "senior_id": None,
        "senior": None,
        "prospect": None,
        "prospect_id": None,
        "memory_context": None,
        "news_context": None,
        "greeting": None,
        "reminder_prompt": None,
        "reminder_delivery": None,
        "reminders_delivered": set(),
        "conversation_id": None,
        "call_sid": None,
        "call_type": "check-in",
        "is_outbound": True,
        "previous_calls_summary": None,
        "todays_context": None,
        "_transcript": [],
        "_full_transcript": [],
        "_transcript_persistence_enabled": True,
        "_call_metadata": call_metadata,
    }

    try:
        prepared_call = await prepare_websocket_call(
            websocket,
            session_state,
            consume_token=False,
        )
    except WebSocketAuthError as exc:
        logger.warning("[{cs}] Rejected WebSocket before capacity: {reason}",
                       cs=session_state.get("call_sid") or "unknown", reason=str(exc))
        await websocket.close(code=1008)
        return
    except Exception as exc:
        logger.warning("[{cs}] WebSocket handshake failed before capacity: {reason}",
                       cs=session_state.get("call_sid") or "unknown", reason=str(exc))
        await websocket.close(code=1008)
        return

    # Admission control: reject valid calls if no AI call slot is immediately free.
    try:
        await asyncio.wait_for(_call_semaphore.acquire(), timeout=0.01)
    except asyncio.TimeoutError:
        logger.warning("Rejected authenticated call: at capacity ({max})", max=MAX_CALLS)
        await _reject_prepared_call_at_capacity(prepared_call, session_state)
        await websocket.close(code=1013)  # Try Again Later
        return

    try:
        prepared_call["metadata"] = await authenticate_websocket_call(
            prepared_call["call_data"],
            session_state,
            consume_token=True,
        )
    except WebSocketAuthError as exc:
        logger.warning("[{cs}] WebSocket auth failed at token consume: {reason}",
                       cs=session_state.get("call_sid") or "unknown", reason=str(exc))
        _call_semaphore.release()
        await websocket.close(code=1008)
        return

    metadata = prepared_call.get("metadata") or {}
    inbound_tracked = not bool(metadata.get("is_outbound", True))

    _active_calls += 1
    if inbound_tracked:
        _inbound_active_calls += 1
    if _active_calls > _peak_calls:
        _peak_calls = _active_calls

    try:
        if metadata.get("reservation_id"):
            from services.capacity import release_capacity_reservation

            await release_capacity_reservation(
                reservation_id=metadata.get("reservation_id"),
                queue_id=metadata.get("queue_id"),
            )
    except Exception as exc:
        logger.warning(
            "[{cs}] Failed to release queue capacity reservation after admission: {err}",
            cs=session_state.get("call_sid") or "unknown",
            err=str(exc),
        )

    # Track this task for graceful shutdown draining
    current_task = asyncio.current_task()
    if current_task:
        register_call_task(current_task)

    try:
        import sentry_sdk as _sentry
        _sentry.set_tag("senior_id", session_state.get("senior_id", "unknown"))
        _sentry.set_tag("call_type", session_state.get("call_type", "unknown"))
    except ImportError:
        pass

    try:
        await run_bot(websocket, session_state, prepared_call=prepared_call)
    except Exception as e:
        import traceback as _tb
        logger.error("Pipeline error: {err}\n{tb}", err=str(e), tb=_tb.format_exc())
        try:
            import sentry_sdk as _sentry
            _sentry.capture_exception(e)
        except ImportError:
            pass
    finally:
        _call_semaphore.release()
        _active_calls -= 1
        if inbound_tracked:
            _inbound_active_calls = max(0, _inbound_active_calls - 1)
        # Clean up call_metadata to prevent memory leaks on crashes
        cs = session_state.get("call_sid")
        if cs:
            await _cleanup_metadata(cs)
        if websocket.client_state.name != "DISCONNECTED":
            try:
                await websocket.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def startup():
    assert_production_config()

    port = settings.port
    logger.info(
        "Donna Pipecat starting on port {port} (max_concurrent_calls={max})",
        port=port,
        max=MAX_CALLS,
    )

    # Initialize database pool
    try:
        from db.client import get_pool
        await get_pool()
        logger.info("Database pool initialized")
    except Exception as e:
        logger.error("Database init failed: {err}", err=str(e))

    # Validate Redis/shared-state readiness before admitting calls in scaled mode.
    try:
        from lib.redis_client import check_shared_state_health

        shared_state = await check_shared_state_health()
        if not shared_state.get("ok"):
            if settings.pipecat_require_redis:
                raise RuntimeError(str(shared_state.get("error") or "shared_state_unavailable"))
            logger.warning("Shared state degraded; local single-instance mode only: {state}", state=shared_state)
        elif shared_state.get("degraded"):
            logger.warning("Shared state degraded; local single-instance mode only: {state}", state=shared_state)
        else:
            logger.info(
                "Shared state ready (backend={backend}, required={required})",
                backend=shared_state.get("backend"),
                required=shared_state.get("required"),
            )
    except Exception as e:
        if settings.pipecat_require_redis:
            logger.error("Shared state init failed in required mode: {err}", err=str(e))
            raise
        logger.warning("Shared state init failed; local single-instance mode only: {err}", err=str(e))

    # Initialize GrowthBook feature flags
    try:
        from lib.growthbook import init_growthbook
        await init_growthbook()
    except Exception as e:
        logger.warning("GrowthBook init failed — flags will use defaults: {err}", err=str(e))

    # Start background cache cleanup loop
    from lib.cache_cleanup import start_cleanup_loop
    asyncio.create_task(start_cleanup_loop())

    # Publish PHI-free capacity heartbeats for global dispatch decisions.
    try:
        from services.capacity import start_capacity_heartbeat

        async def _capacity_db_pool_stats() -> dict:
            try:
                from db.client import get_pool_stats
                return await get_pool_stats()
            except Exception:
                return {}

        def _capacity_open_breakers() -> int:
            try:
                from lib.circuit_breaker import get_breaker_states
                return sum(1 for state in get_breaker_states().values() if state == "open")
            except Exception:
                return 0

        asyncio.create_task(start_capacity_heartbeat(
            get_active_calls=lambda: _active_calls,
            get_inbound_active_calls=lambda: _inbound_active_calls,
            get_max_calls=lambda: MAX_CALLS,
            is_draining=_is_draining,
            get_db_pool_stats=_capacity_db_pool_stats,
            get_circuit_breakers_open_count=_capacity_open_breakers,
            get_is_ready=lambda: _is_ready,
        ))
        logger.info("Capacity heartbeat loop started")
    except Exception as e:
        if settings.pipecat_require_redis:
            logger.error("Capacity heartbeat init failed in required mode: {err}", err=str(e))
            raise
        logger.warning("Capacity heartbeat init failed: {err}", err=str(e))

    # Phase 3 replica readiness gate. Runs vendor session + pool checks in the
    # background so startup() doesn't block; flips _is_ready when all required
    # checks pass. The Node dispatcher filters on the heartbeat's `ready` flag.
    try:
        from services.readiness import prepare_for_traffic

        asyncio.create_task(
            prepare_for_traffic(set_ready=_set_ready, set_report=_set_readiness_report)
        )
        logger.info("Replica readiness gate started")
    except Exception as e:
        logger.warning("Readiness gate init failed: {err}", err=str(e))

    # Node is the authoritative scheduler/retention worker. Keep Pipecat's
    # worker opt-in only to avoid two services purging the same PHI tables.
    retention_enabled = settings.pipecat_retention_enabled
    if retention_enabled:
        try:
            from services.data_retention import start_retention_loop
            asyncio.create_task(start_retention_loop())
            logger.info("Data retention loop started")
        except Exception as e:
            logger.warning("Data retention init failed: {err}", err=str(e))
    else:
        logger.info("Pipecat data retention loop disabled; Node owns retention")

    # Start scheduler ONLY if explicitly enabled (prevents dual-scheduler conflict)
    scheduler_enabled = settings.scheduler_enabled
    base_url = settings.base_url
    if scheduler_enabled and base_url:
        from services.scheduler import start_scheduler
        asyncio.create_task(start_scheduler(base_url))
        logger.info("Scheduler started")
    else:
        logger.info(
            "Scheduler disabled (SCHEDULER_ENABLED={se}, BASE_URL={bu})",
            se=str(scheduler_enabled).lower(),
            bu="set" if base_url else "unset",
        )


@app.on_event("shutdown")
async def shutdown():
    global _shutting_down
    _shutting_down = True
    logger.info("Shutdown: draining {n} active calls", n=len(_active_tasks))

    if _active_tasks:
        # Give active calls up to 7 seconds to finish (Railway gives 10s)
        done, pending = await asyncio.wait(list(_active_tasks), timeout=7.0)
        if pending:
            logger.warning("Shutdown: {n} calls didn't finish, cancelling", n=len(pending))
            for t in pending:
                t.cancel()
            await asyncio.wait(pending, timeout=2.0)

    # Close GrowthBook client
    try:
        from lib.growthbook import close_growthbook
        await close_growthbook()
    except Exception:
        pass

    # Close DB pool last
    try:
        from lib.redis_client import get_shared_state
        await get_shared_state().close()
        logger.info("Shared state closed")
    except Exception as e:
        logger.warning("Shared state shutdown error: {err}", err=str(e))

    try:
        from db.client import close_pool
        await close_pool()
        logger.info("Database pool closed")
    except Exception as e:
        logger.error("Database shutdown error: {err}", err=str(e))
