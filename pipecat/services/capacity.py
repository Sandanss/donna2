"""Pipecat capacity heartbeat helpers for horizontal scaling.

Heartbeats are PHI-free runtime state. They let the Node dispatcher estimate
global call capacity without relying on a load-balanced local `/health` result.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import socket
import time
from typing import Callable, Any

from loguru import logger

from config import settings
from lib.redis_client import require_shared_state, shared_state_required


HEARTBEAT_KEY_PREFIX = "pipecat:instance:"
RESERVATION_KEY_PREFIX = "pipecat:reservation:"
QUEUE_RESERVATION_KEY_PREFIX = "pipecat:queue-reservations:"
HEARTBEAT_TTL_SECONDS = 15
HEARTBEAT_INTERVAL_SECONDS = 5


def resolve_instance_id() -> str:
    """Return a stable-enough process instance ID for heartbeat keys."""
    configured = settings.instance_id or os.getenv("INSTANCE_ID") or os.getenv("RAILWAY_REPLICA_ID")
    if configured:
        return configured
    return f"{socket.gethostname()}:{os.getpid()}"


def heartbeat_key(instance_id: str) -> str:
    return f"{HEARTBEAT_KEY_PREFIX}{instance_id}"


def _int_value(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _bool_value(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").lower() in {"1", "true", "yes", "on"}


def build_capacity_heartbeat(
    *,
    instance_id: str,
    active_calls: int,
    max_calls: int,
    inbound_active_calls: int = 0,
    pending_start_count: int = 0,
    draining: bool = False,
    healthy: bool = True,
    is_ready: bool | None = None,
    service_version: str | None = None,
    db_pool_size: int | None = None,
    db_pool_idle: int | None = None,
    db_pool_stats_available: bool | None = None,
    circuit_breakers_open: int = 0,
    warmup_gate_green: bool | None = None,
    now: float | None = None,
) -> dict:
    """Build a PHI-free capacity heartbeat payload.

    When ``is_ready`` is None the legacy derivation is used so existing callers
    keep working. New callers (Phase 3 replica readiness gate) should pass an
    explicit bool that reflects ``prepare_for_traffic()`` results. Older
    callers can also pass ``warmup_gate_green`` and pool stats directly.
    """
    timestamp = now or time.time()
    active = max(0, int(active_calls))
    max_capacity = max(0, int(max_calls))
    drain = bool(draining)
    health = bool(healthy)
    stats_available = (
        db_pool_size is not None
        if db_pool_stats_available is None
        else bool(db_pool_stats_available)
    )
    pool_size = max(0, _int_value(db_pool_size))
    open_breakers = max(0, int(circuit_breakers_open))
    capacity_ready = health and not drain and active < max_capacity
    pool_ready = stats_available and pool_size > 0
    gate_ready = True if warmup_gate_green is None else bool(warmup_gate_green)
    readiness_ready = bool(is_ready) if is_ready is not None else pool_ready and gate_ready
    ready_flag = capacity_ready and readiness_ready and open_breakers == 0
    return {
        "instance_id": instance_id,
        "service": "donna-pipecat",
        "service_version": service_version or os.getenv("RAILWAY_GIT_COMMIT_SHA", "")[:12] or "unknown",
        "active_calls": active,
        "max_calls": max_capacity,
        "inbound_active_calls": max(0, int(inbound_active_calls)),
        "pending_start_count": max(0, int(pending_start_count)),
        "draining": drain,
        "healthy": health,
        "ready": ready_flag,
        "db_pool_stats_available": stats_available,
        "db_pool_size": pool_size,
        "db_pool_idle": max(0, _int_value(db_pool_idle)),
        "circuit_breakers_open": open_breakers,
        "warmup_gate_green": gate_ready if warmup_gate_green is not None else None,
        "started_at": timestamp,
        "updated_at": timestamp,
    }


async def publish_capacity_heartbeat(
    *,
    active_calls: int,
    max_calls: int,
    inbound_active_calls: int = 0,
    pending_start_count: int = 0,
    draining: bool = False,
    healthy: bool = True,
    is_ready: bool | None = None,
    service_version: str | None = None,
    db_pool_size: int | None = None,
    db_pool_idle: int | None = None,
    db_pool_stats_available: bool | None = None,
    circuit_breakers_open: int = 0,
    warmup_gate_green: bool | None = None,
    instance_id: str | None = None,
    state=None,
) -> dict | None:
    """Publish this replica's capacity heartbeat to Redis/shared state."""
    state = state or require_shared_state("Pipecat capacity heartbeat")
    if not getattr(state, "is_shared", False):
        return None

    resolved_instance_id = instance_id or resolve_instance_id()
    heartbeat = build_capacity_heartbeat(
        instance_id=resolved_instance_id,
        active_calls=active_calls,
        max_calls=max_calls,
        inbound_active_calls=inbound_active_calls,
        pending_start_count=pending_start_count,
        draining=draining,
        healthy=healthy,
        is_ready=is_ready,
        service_version=service_version,
        db_pool_size=db_pool_size,
        db_pool_idle=db_pool_idle,
        db_pool_stats_available=db_pool_stats_available,
        circuit_breakers_open=circuit_breakers_open,
        warmup_gate_green=warmup_gate_green,
    )
    await state.set_hash(
        heartbeat_key(resolved_instance_id),
        heartbeat,
        ttl=HEARTBEAT_TTL_SECONDS,
    )
    return heartbeat


async def list_capacity_instances(*, state=None, now: float | None = None) -> list[dict]:
    """Read fresh Pipecat capacity heartbeats from shared state."""
    state = state or require_shared_state("Pipecat capacity registry")
    if not getattr(state, "is_shared", False):
        return []

    current_time = now or time.time()
    instances: list[dict] = []
    for key in await state.keys(f"{HEARTBEAT_KEY_PREFIX}*"):
        row = await state.get_hash(key)
        if not row:
            continue

        updated_at = float(row.get("updated_at") or 0)
        if current_time - updated_at > HEARTBEAT_TTL_SECONDS:
            continue

        active_calls = _int_value(row.get("active_calls"))
        max_calls = _int_value(row.get("max_calls"))
        draining = _bool_value(row.get("draining"))
        healthy = _bool_value(row.get("healthy"))
        ready = _bool_value(row.get("ready")) if "ready" in row else healthy and not draining and active_calls < max_calls

        instances.append({
            "instance_id": str(row.get("instance_id") or key.removeprefix(HEARTBEAT_KEY_PREFIX)),
            "service": row.get("service") or "donna-pipecat",
            "service_version": row.get("service_version") or "unknown",
            "active_calls": active_calls,
            "max_calls": max_calls,
            "inbound_active_calls": _int_value(row.get("inbound_active_calls")),
            "pending_start_count": _int_value(row.get("pending_start_count")),
            "draining": draining,
            "healthy": healthy,
            "ready": ready,
            "db_pool_stats_available": (
                _bool_value(row.get("db_pool_stats_available"))
                if "db_pool_stats_available" in row
                else True
            ),
            "db_pool_size": _int_value(row.get("db_pool_size")),
            "db_pool_idle": _int_value(row.get("db_pool_idle")),
            "circuit_breakers_open": _int_value(row.get("circuit_breakers_open")),
            "warmup_gate_green": (
                None
                if row.get("warmup_gate_green") is None
                else _bool_value(row.get("warmup_gate_green"))
            ),
            "started_at": float(row.get("started_at") or updated_at),
            "updated_at": updated_at,
        })

    return instances


async def count_capacity_reservations(*, state=None) -> int:
    """Count live pending-start reservations from shared state."""
    state = state or require_shared_state("Pipecat capacity reservations")
    if not getattr(state, "is_shared", False):
        return 0
    keys = await state.keys(f"{RESERVATION_KEY_PREFIX}*")
    return len(keys)


async def release_capacity_reservation(
    *,
    reservation_id: str | None,
    queue_id: str | None = None,
    state=None,
) -> None:
    """Release a pending-start reservation after active admission or terminal failure."""
    if not reservation_id:
        return
    state = state or require_shared_state("Pipecat capacity reservation release")
    if not getattr(state, "is_shared", False):
        return

    await state.delete(f"{RESERVATION_KEY_PREFIX}{reservation_id}")
    if queue_id:
        await state.delete(f"{QUEUE_RESERVATION_KEY_PREFIX}{queue_id}")


async def start_capacity_heartbeat(
    *,
    get_active_calls: Callable[[], int],
    get_max_calls: Callable[[], int],
    is_draining: Callable[[], bool],
    get_inbound_active_calls: Callable[[], int] | None = None,
    get_pending_start_count: Callable[[], int] | None = None,
    get_db_pool_stats: Callable[[], dict] | None = None,
    get_circuit_breakers_open_count: Callable[[], int] | None = None,
    get_warmup_gate_green: Callable[[], bool] | None = None,
    get_service_version: Callable[[], str] | None = None,
    get_is_ready: Callable[[], bool] | None = None,
    interval_seconds: int = HEARTBEAT_INTERVAL_SECONDS,
    instance_id: str | None = None,
) -> None:
    """Run the capacity heartbeat loop until cancelled."""
    resolved_instance_id = instance_id or resolve_instance_id()

    while True:
        try:
            if get_pending_start_count:
                pending_value = get_pending_start_count()
                if inspect.isawaitable(pending_value):
                    pending_value = await pending_value
            else:
                pending_value = await count_capacity_reservations()

            inbound_value = get_inbound_active_calls() if get_inbound_active_calls else 0
            if inspect.isawaitable(inbound_value):
                inbound_value = await inbound_value

            pool_stats = get_db_pool_stats() if get_db_pool_stats else {}
            if inspect.isawaitable(pool_stats):
                pool_stats = await pool_stats
            pool_stats = pool_stats if isinstance(pool_stats, dict) else {}

            open_breakers = get_circuit_breakers_open_count() if get_circuit_breakers_open_count else 0
            if inspect.isawaitable(open_breakers):
                open_breakers = await open_breakers

            service_version = get_service_version() if get_service_version else None
            if inspect.isawaitable(service_version):
                service_version = await service_version

            ready_value = None
            if get_is_ready is not None:
                ready_value = get_is_ready()
                if inspect.isawaitable(ready_value):
                    ready_value = await ready_value
                ready_value = bool(ready_value)

            if get_warmup_gate_green:
                warmup_gate_green = get_warmup_gate_green()
                if inspect.isawaitable(warmup_gate_green):
                    warmup_gate_green = await warmup_gate_green
            else:
                try:
                    from services.readiness import is_warmup_gate_green
                    warmup_gate_green = is_warmup_gate_green()
                except Exception as gate_exc:
                    logger.warning("Capacity heartbeat readiness gate unavailable: {err}", err=str(gate_exc))
                    warmup_gate_green = False

            pool_stats_available = bool(pool_stats.get("available", pool_stats.get("size") is not None))

            await publish_capacity_heartbeat(
                instance_id=resolved_instance_id,
                active_calls=get_active_calls(),
                max_calls=get_max_calls(),
                inbound_active_calls=inbound_value,
                pending_start_count=pending_value,
                draining=is_draining(),
                healthy=True,
                is_ready=ready_value,
                service_version=service_version,
                db_pool_size=_int_value(pool_stats.get("size")),
                db_pool_idle=_int_value(pool_stats.get("idle")),
                db_pool_stats_available=pool_stats_available,
                circuit_breakers_open=_int_value(open_breakers),
                warmup_gate_green=bool(warmup_gate_green),
            )
        except Exception as exc:
            if shared_state_required():
                # Fail-closed in scaled mode (Phase 3 §8): a publish failure
                # means the replica's heartbeat is stale and peers will keep
                # counting it as live capacity. Re-raise so the heartbeat
                # task terminates; the runtime can then mark the replica
                # unhealthy / restart / drop it from the autoscaler pool.
                logger.error(
                    "Capacity heartbeat failed in required shared-state mode; terminating heartbeat task: {err}",
                    err=str(exc),
                )
                raise
            logger.debug("Capacity heartbeat skipped or failed: {err}", err=str(exc))

        await asyncio.sleep(interval_seconds)
