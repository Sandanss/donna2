"""Background cache cleanup loop — prevents unbounded memory growth.

Runs every 5 minutes and evicts stale entries from in-memory caches:
- context_cache._cache: entries past their expires_at TTL
- scheduler.pending_reminder_calls: entries older than 30 minutes
- scheduler.prefetched_context_by_phone: entries older than 30 minutes
- call_context.call_metadata: PHI-bearing call metadata past its TTL
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from loguru import logger

CLEANUP_INTERVAL_SECONDS = 300  # 5 minutes
STALE_THRESHOLD_SECONDS = 1800  # 30 minutes


async def start_cleanup_loop() -> None:
    """Run cache cleanup every 5 minutes. Call once at startup as a background task."""
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            cleaned = _run_cleanup()
            if cleaned > 0:
                logger.info("[CacheCleanup] Evicted {n} stale entries", n=cleaned)
        except Exception as e:
            logger.error("[CacheCleanup] Error: {err}", err=str(e))

        # Also clean up expired token revocations (DB-backed, not in-memory)
        try:
            from services.token_revocation import cleanup_expired
            db_cleaned = await cleanup_expired()
            if db_cleaned > 0:
                logger.info("[CacheCleanup] Cleaned {n} expired token revocations", n=db_cleaned)
        except Exception as e:
            # Table may not exist yet (pre-migration), skip silently
            logger.debug("[CacheCleanup] Token revocation cleanup skipped: {err}", err=str(e))


def _run_cleanup() -> int:
    """Evict stale entries from all in-memory caches. Returns count evicted."""
    now = time.time()
    now_dt = datetime.now(timezone.utc)
    total = 0

    # 1. Context cache — has expires_at (unix timestamp)
    try:
        from services.context_cache import _cache as context_cache
        expired = [k for k, v in context_cache.items() if now > v.get("expires_at", 0)]
        for k in expired:
            del context_cache[k]
        total += len(expired)
    except Exception:
        pass

    # 2. Pending reminder calls — has triggered_at (datetime)
    try:
        from services.scheduler import pending_reminder_calls
        stale = [
            k for k, v in pending_reminder_calls.items()
            if _age_seconds(v.get("triggered_at"), now_dt) > STALE_THRESHOLD_SECONDS
        ]
        for k in stale:
            del pending_reminder_calls[k]
        total += len(stale)
    except Exception:
        pass

    # 3. Prefetched context by phone — has fetched_at (datetime)
    try:
        from services.scheduler import prefetched_context_by_phone
        stale = [
            k for k, v in prefetched_context_by_phone.items()
            if _age_seconds(v.get("fetched_at"), now_dt) > STALE_THRESHOLD_SECONDS
        ]
        for k in stale:
            del prefetched_context_by_phone[k]
        total += len(stale)
    except Exception:
        pass

    # 4. Call metadata — stores PHI-bearing context for active Telnyx calls.
    try:
        from api.routes.call_context import cleanup_expired_call_metadata

        total += cleanup_expired_call_metadata(now)
    except Exception:
        pass

    return total


def get_cache_sizes() -> dict[str, int]:
    """Return current size of each in-memory cache."""
    sizes: dict[str, int] = {}
    try:
        from services.context_cache import _cache
        sizes["context_cache"] = len(_cache)
    except Exception:
        sizes["context_cache"] = -1
    try:
        from services.scheduler import pending_reminder_calls, prefetched_context_by_phone
        sizes["pending_calls"] = len(pending_reminder_calls)
        sizes["prefetched_phones"] = len(prefetched_context_by_phone)
    except Exception:
        sizes["pending_calls"] = -1
        sizes["prefetched_phones"] = -1
    try:
        from api.routes.call_context import call_metadata

        sizes["call_metadata"] = len(call_metadata)
    except Exception:
        sizes["call_metadata"] = -1
    return sizes


def _age_seconds(dt: datetime | None, now: datetime) -> float:
    """Compute age in seconds of a datetime. Returns inf if dt is None."""
    if dt is None:
        return float("inf")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return (now - dt).total_seconds()
