"""Shared call metadata and context hydration for telephony providers."""

from __future__ import annotations

import asyncio
import hmac
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from loguru import logger

# In-memory call metadata (shared with WebSocket handler).
# call_id -> {senior, memory_context, conversation_id, reminder_prompt, ...}
# When REDIS_URL is set, metadata is also persisted to Redis for multi-instance.
call_metadata: dict[str, dict] = {}
_metadata_lock = asyncio.Lock()
CALL_METADATA_TTL_SECONDS = 1800


class WsTokenConsumeError(ValueError):
    """Raised when a media WebSocket token cannot be consumed."""


def _metadata_key(call_id: str) -> str:
    return f"call_metadata:{call_id}"


def _ws_token_consumed_key(call_id: str) -> str:
    return f"ws_token_consumed:{call_id}"


def _with_metadata_expiry(data: dict, *, now: float | None = None) -> dict:
    snapshot = dict(data)
    snapshot["call_metadata_expires_at"] = (now or time.time()) + CALL_METADATA_TTL_SECONDS
    return snapshot


def _metadata_is_expired(metadata: dict, *, now: float | None = None) -> bool:
    expires_at = metadata.get("call_metadata_expires_at")
    if expires_at is None:
        return False
    try:
        return (now or time.time()) > float(expires_at)
    except (TypeError, ValueError):
        return True


def _validate_ws_token(metadata: dict, provided_token: str, *, now: float | None = None) -> None:
    expected_token = metadata.get("ws_token")
    if not expected_token:
        raise WsTokenConsumeError("missing expected token")
    if metadata.get("ws_token_consumed"):
        raise WsTokenConsumeError("token already consumed")
    if (now or time.time()) > float(metadata.get("ws_token_expires_at") or 0):
        raise WsTokenConsumeError("token expired")
    if not provided_token or not hmac.compare_digest(str(expected_token), str(provided_token)):
        raise WsTokenConsumeError("invalid token")


async def _persist_metadata(call_id: str, data: dict) -> None:
    """Write encrypted metadata to Redis if configured for multi-instance routing."""
    data["call_metadata_expires_at"] = time.time() + CALL_METADATA_TTL_SECONDS
    try:
        from lib.redis_client import require_shared_state
        from lib.shared_state_phi import encode_phi_payload

        state = require_shared_state("call metadata persistence")
        if getattr(state, "is_shared", False):
            await state.set(
                _metadata_key(call_id),
                encode_phi_payload(data),
                ttl=CALL_METADATA_TTL_SECONDS,
            )
    except Exception as exc:
        from lib.redis_client import shared_state_required

        if shared_state_required():
            raise
        logger.warning("[{cs}] Redis metadata write failed: {err}", cs=call_id, err=str(exc))


async def get_call_metadata(call_id: str) -> dict | None:
    """Load call metadata from local memory, then Redis fallback."""
    metadata = call_metadata.get(call_id)
    if metadata is not None:
        if _metadata_is_expired(metadata):
            await _cleanup_metadata(call_id)
            return None
        return metadata
    try:
        from lib.redis_client import require_shared_state
        from lib.shared_state_phi import decode_phi_payload

        state = require_shared_state("call metadata lookup")
        if getattr(state, "is_shared", False):
            raw_metadata = await state.get(_metadata_key(call_id))
            metadata = decode_phi_payload(raw_metadata, label="call metadata")
            if metadata is not None:
                if _metadata_is_expired(metadata):
                    await state.delete(_metadata_key(call_id))
                    return None
                call_metadata[call_id] = metadata
            return metadata
    except Exception as exc:
        from lib.redis_client import shared_state_required

        if shared_state_required():
            raise
        logger.warning("[{cs}] Redis metadata lookup failed: {err}", cs=call_id, err=str(exc))
    return None


async def mark_ws_token_consumed(call_id: str, metadata: dict) -> None:
    """Mark the WebSocket admission token as consumed without expiring the call."""
    now = time.time()
    snapshot = _with_metadata_expiry(
        {
            **metadata,
            "ws_token_consumed": True,
            "ws_token_consumed_at": now,
        },
        now=now,
    )
    call_metadata[call_id] = snapshot
    await _persist_metadata(call_id, snapshot)


async def consume_ws_token(call_id: str, provided_token: str) -> dict:
    """Validate and atomically consume a one-time media WebSocket token."""
    now = time.time()
    metadata = await get_call_metadata(call_id)
    if not metadata:
        raise WsTokenConsumeError("unknown call_sid")
    _validate_ws_token(metadata, provided_token, now=now)

    shared_claimed = False
    try:
        from lib.redis_client import require_shared_state

        state = require_shared_state("WebSocket token consume")
        if getattr(state, "is_shared", False):
            ttl = max(1, min(CALL_METADATA_TTL_SECONDS, int(float(metadata.get("ws_token_expires_at")) - now)))
            shared_claimed = bool(
                await state.set_if_absent(
                    _ws_token_consumed_key(call_id),
                    {"consumed_at": now},
                    ttl=ttl,
                )
            )
            if not shared_claimed:
                raise WsTokenConsumeError("token already consumed")
    except WsTokenConsumeError:
        raise
    except Exception as exc:
        from lib.redis_client import shared_state_required

        if shared_state_required():
            raise WsTokenConsumeError("shared token consume unavailable") from exc
        logger.warning("[{cs}] Shared token consume claim failed: {err}", cs=call_id, err=str(exc))

    async with _metadata_lock:
        current = call_metadata.get(call_id) or metadata
        _validate_ws_token(current, provided_token, now=now)
        current = _with_metadata_expiry(
            {
                **current,
                "ws_token_consumed": True,
                "ws_token_consumed_at": now,
            },
            now=now,
        )
        call_metadata[call_id] = current

    await _persist_metadata(call_id, current)
    return current


async def _cleanup_metadata(call_id: str) -> dict | None:
    """Remove metadata from local dict and Redis."""
    metadata = call_metadata.pop(call_id, None)
    try:
        from lib.redis_client import get_shared_state

        state = get_shared_state()
        if getattr(state, "is_shared", False):
            if metadata is None:
                from lib.shared_state_phi import decode_phi_payload

                metadata = decode_phi_payload(
                    await state.get(_metadata_key(call_id)),
                    label="call metadata",
                )
            await state.delete(_metadata_key(call_id))
            await state.delete(_ws_token_consumed_key(call_id))
    except Exception:
        pass
    return metadata


def cleanup_expired_call_metadata(now: float | None = None) -> int:
    """Remove local PHI-bearing call metadata whose TTL has elapsed."""
    current_time = now or time.time()
    expired = [
        call_id
        for call_id, metadata in call_metadata.items()
        if _metadata_is_expired(metadata, now=current_time)
    ]
    for call_id in expired:
        call_metadata.pop(call_id, None)
    return len(expired)


def _json_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            import json

            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _senior_is_inactive(senior: dict | None) -> bool:
    if not senior:
        return False
    return senior.get("is_active") is False or senior.get("isActive") is False


def _parse_db_timestamp(value) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    elif isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    else:
        return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _cached_news_context_from_senior(senior: dict, *, max_age_hours: int = 36) -> str | None:
    """Return selected cached news only when the daily cache is fresh."""
    raw_cached_news = senior.get("cached_news") or senior.get("cachedNews")
    if not raw_cached_news:
        return None

    updated_at = _parse_db_timestamp(
        senior.get("cached_news_updated_at") or senior.get("cachedNewsUpdatedAt")
    )
    sid = str(senior.get("id", ""))[:8]
    if not updated_at:
        logger.warning("[News] Cached news has no freshness timestamp; skipping senior={sid}", sid=sid)
        return None

    timezone_name = senior.get("timezone") or "America/New_York"
    try:
        senior_tz = ZoneInfo(timezone_name)
    except Exception:
        senior_tz = ZoneInfo("America/New_York")
    if updated_at.astimezone(senior_tz).date() != datetime.now(senior_tz).date():
        logger.warning("[News] Cached news not from today; skipping senior={sid}", sid=sid)
        return None

    age = datetime.now(timezone.utc) - updated_at
    if age > timedelta(hours=max_age_hours):
        logger.warning(
            "[News] Cached news stale; skipping senior={sid} age_hours={age}",
            sid=sid,
            age=round(age.total_seconds() / 3600, 1),
        )
        return None

    try:
        from services.news import select_stories_for_call

        return select_stories_for_call(
            raw_cached_news,
            interests=senior.get("interests"),
            interest_scores=senior.get("interest_scores"),
            count=3,
        )
    except Exception:
        return raw_cached_news


async def _hydrate_senior_call_context(
    *,
    senior: dict,
    call_sid: str,
    is_outbound: bool,
    memory_context=None,
    pre_generated_greeting=None,
    news_context=None,
    recent_turns=None,
    previous_calls_summary=None,
    todays_context=None,
    last_call_analysis=None,
    call_settings=None,
    caregiver_notes_content=None,
) -> dict:
    """Load PHI-bearing call context for any active known senior."""
    senior_id = senior["id"]

    tasks: list[tuple[str, object]] = []
    if memory_context is None:
        from services.memory import build_context

        tasks.append(("memory_context", build_context(senior_id, None, senior)))
    if caregiver_notes_content is None:
        from services.caregivers import get_pending_notes

        tasks.append(("caregiver_notes_content", get_pending_notes(senior_id)))

    if tasks:
        results = await asyncio.gather(*(task for _, task in tasks), return_exceptions=True)
        for (name, _), result in zip(tasks, results):
            if isinstance(result, Exception):
                logger.error("[{cs}] Context fetch failed: {name}: {err}", cs=call_sid, name=name, err=str(result))
                if name == "caregiver_notes_content":
                    caregiver_notes_content = []
            elif name == "memory_context":
                memory_context = result
            elif name == "caregiver_notes_content":
                caregiver_notes_content = result or []

    if news_context is None:
        news_context = _cached_news_context_from_senior(senior)

    snapshot = senior.get("call_context_snapshot")
    if isinstance(snapshot, str):
        try:
            import json

            snapshot = json.loads(snapshot)
        except Exception:
            snapshot = None

    if snapshot:
        last_call_analysis = last_call_analysis if last_call_analysis is not None else snapshot.get("last_call_analysis")
        previous_calls_summary = previous_calls_summary if previous_calls_summary is not None else snapshot.get("recent_summaries")
        recent_turns = recent_turns if recent_turns is not None else snapshot.get("recent_turns")
        todays_context = todays_context if todays_context is not None else snapshot.get("todays_context")
        logger.info(
            "[{cs}] Using senior call snapshot (updated {ts})",
            cs=call_sid,
            ts=snapshot.get("snapshot_updated_at", "?"),
        )
    elif (
        last_call_analysis is None
        and previous_calls_summary is None
        and recent_turns is None
        and todays_context is None
    ):
        logger.info("[{cs}] No senior snapshot, fetching call history individually", cs=call_sid)
        from services.call_analysis import get_latest_analysis
        from services.conversations import get_recent_summaries, get_recent_turns
        from services.daily_context import get_todays_context, format_todays_context

        senior_tz = senior.get("timezone", "America/New_York")
        analysis_result, summaries_result, turns_result, today_result = await asyncio.gather(
            get_latest_analysis(senior_id, senior_tz),
            get_recent_summaries(senior_id, 3, senior_tz),
            get_recent_turns(senior_id, timezone_name=senior_tz),
            get_todays_context(senior_id, senior_tz),
            return_exceptions=True,
        )
        if not isinstance(analysis_result, Exception):
            last_call_analysis = analysis_result
        if not isinstance(summaries_result, Exception):
            previous_calls_summary = summaries_result
        if not isinstance(turns_result, Exception):
            recent_turns = turns_result
        if not isinstance(today_result, Exception):
            todays_context = format_todays_context(today_result)

    if call_settings is None:
        from services.seniors import DEFAULT_CALL_SETTINGS

        call_settings = {
            **DEFAULT_CALL_SETTINGS,
            **_json_dict(senior.get("call_settings") or {}),
        }

    if not pre_generated_greeting:
        try:
            analysis_data = _json_dict(last_call_analysis or {})
            call_quality = _json_dict(analysis_data.get("call_quality") or {})
            if is_outbound:
                from services.greetings import get_greeting

                greeting_result = get_greeting(
                    senior_name=senior.get("name", ""),
                    timezone=senior.get("timezone"),
                    interests=senior.get("interests"),
                    last_call_summary=previous_calls_summary or analysis_data.get("summary"),
                    senior_id=senior_id,
                    news_context=news_context,
                    interest_scores=senior.get("interest_scores"),
                    last_call_sentiment=(
                        analysis_data.get("sentiment")
                        or analysis_data.get("mood")
                        or call_quality.get("rapport")
                    ),
                    last_call_engagement=analysis_data.get("engagement_score"),
                    followup_chance=(call_settings or {}).get("greeting_followup_chance", 0.6),
                )
                pre_generated_greeting = greeting_result.get("greeting", "")
            else:
                from services.greetings import get_inbound_greeting

                greeting_result = get_inbound_greeting(
                    senior_name=senior.get("name", ""),
                    senior_id=senior_id,
                )
                pre_generated_greeting = greeting_result.get("greeting", "")
        except Exception as e:
            logger.error("[{cs}] Greeting generation failed: {err}", cs=call_sid, err=str(e))

    caregiver_notes_content = caregiver_notes_content or []

    return {
        "memory_context": memory_context,
        "pre_generated_greeting": pre_generated_greeting,
        "news_context": news_context,
        "recent_turns": recent_turns,
        "previous_calls_summary": previous_calls_summary,
        "todays_context": todays_context,
        "last_call_analysis": last_call_analysis,
        "call_settings": call_settings,
        "has_caregiver_notes": bool(caregiver_notes_content),
        "caregiver_notes_content": caregiver_notes_content,
    }
