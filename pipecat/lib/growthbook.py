"""GrowthBook feature flag integration.

Provides a shared async client that initializes once at startup and resolves
flags per-call using UserContext. Falls back gracefully when GrowthBook is
unavailable — all flags return their defaults.

Usage:
    from lib.growthbook import init_growthbook, resolve_flags, is_on, get_value

    # At startup (main.py)
    await init_growthbook()

    # Per call (bot.py)
    flags = await resolve_flags(senior_id=senior_id, timezone=tz, call_type="check-in")
    session_state["_flags"] = flags

    # In service code
    if is_on("director_enabled", session_state):
        ...
"""

from __future__ import annotations

import os

from loguru import logger

_client = None
_initialized = False


async def init_growthbook() -> bool:
    """Initialize the GrowthBook client. Call once at startup.

    Returns True if initialization succeeded, False otherwise.
    When False, all flag checks return their defaults (safe degradation).
    """
    global _client, _initialized

    from config import settings

    if not settings.growthbook_api_host or not settings.growthbook_client_key:
        logger.info("GrowthBook not configured (no GROWTHBOOK_API_HOST/CLIENT_KEY)")
        return False

    try:
        from growthbook import GrowthBookClient, Options

        _client = GrowthBookClient(
            Options(
                api_host=settings.growthbook_api_host,
                client_key=settings.growthbook_client_key,
                cache_ttl=300,  # 5-minute cache
            )
        )
        success = await _client.initialize()
        if success:
            _initialized = True
            logger.info("GrowthBook initialized")
        else:
            logger.warning("GrowthBook initialization returned False — using defaults")
        return success
    except Exception as e:
        logger.warning("GrowthBook init failed — using defaults: {err}", err=str(e))
        return False


def is_loaded() -> bool:
    """Return True if the GrowthBook client has been successfully initialized.

    Used by the Phase 3 replica readiness gate — a configured-but-not-loaded
    GrowthBook indicates a startup-time network failure that should keep the
    replica out of capacity rotation until it recovers.
    """
    return bool(_initialized and _client is not None)


def is_configured() -> bool:
    """Return True if GrowthBook env vars are set, regardless of init status."""
    from config import settings

    return bool(settings.growthbook_api_host and settings.growthbook_client_key)


async def close_growthbook() -> None:
    """Clean up the GrowthBook client. Call at shutdown."""
    global _client, _initialized
    if _client:
        try:
            await _client.close()
        except Exception:
            pass
        _client = None
        _initialized = False


async def resolve_flags(
    senior_id: str | None = None,
    timezone: str | None = None,
    call_type: str = "check-in",
) -> dict:
    """Resolve all feature flags for a call. Returns a dict of flag values.

    When GrowthBook is unavailable, returns all defaults (everything enabled).
    Store the result in session_state["_flags"] for the duration of the call.
    """
    defaults = {
        "director_enabled": True,
        "news_search_enabled": True,
        "memory_search_enabled": True,
        "tts_fallback": False,
        "tts_provider": os.getenv("TTS_PROVIDER", "elevenlabs"),  # "cartesia" or "elevenlabs"
        "context_cache_enabled": True,
        "post_call_analysis_enabled": True,
        "scheduler_call_stagger_ms": 5000,
        "voice_backend": "claude",  # "claude" or "gemini_live"
    }

    if not _initialized or not _client:
        return defaults

    try:
        from growthbook import UserContext

        user = UserContext(
            attributes={
                "id": senior_id or "unknown",
                "timezone": timezone or "UTC",
                "call_type": call_type,
            }
        )

        resolved = {}
        for key, default in defaults.items():
            if isinstance(default, bool):
                resolved[key] = await _client.is_on(key, user)
            else:
                resolved[key] = await _client.get_feature_value(key, default, user)
        return resolved
    except Exception as e:
        logger.warning("GrowthBook flag resolution failed — using defaults: {err}", err=str(e))
        return defaults


def is_on(flag: str, session_state: dict, default: bool = True) -> bool:
    """Check if a flag is enabled from session_state["_flags"].

    Synchronous — reads from the pre-resolved flags dict.
    Returns default if flags haven't been resolved yet.
    """
    flags = session_state.get("_flags", {})
    return flags.get(flag, default)


def get_value(flag: str, session_state: dict, default=None):
    """Get a flag value from session_state["_flags"].

    Synchronous — reads from the pre-resolved flags dict.
    """
    flags = session_state.get("_flags", {})
    return flags.get(flag, default)
