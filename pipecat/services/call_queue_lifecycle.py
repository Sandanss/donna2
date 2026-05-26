"""Pipecat-side call_queue terminal/retry lifecycle updates.

The queue dispatcher owns leasing and dialing. Once Telnyx webhooks reach
Pipecat, the provider is the source of truth for answered, media-started, and
terminal outcomes. This module keeps queue rows and senior voice-discovery
state in sync without writing PHI into operational tables.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from loguru import logger

from db import execute, query_one


DISCOVERY_CALL_TYPE = "discovery"
DISCOVERY_MAX_ATTEMPTS = 3
DISCOVERY_RETRY_WINDOW_MINUTES = 30
DISCOVERY_MIN_COMPLETE_SECONDS = 180

_TERMINAL_ERROR_EVENTS = {
    "call.failed": "call_failed",
    "call.no_answer": "no_answer",
    "call.busy": "busy",
}
_TERMINAL_OK_EVENTS = {"call.hangup", "call.completed"}


def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _mutation_changed(result: Any) -> bool:
    if result is None:
        return False
    if isinstance(result, str):
        try:
            return int(result.strip().split()[-1]) > 0
        except (ValueError, IndexError):
            return bool(result)
    rowcount = getattr(result, "rowcount", None)
    if rowcount is not None:
        return rowcount > 0
    return bool(result)


def _retry_delay(attempt_count: int) -> timedelta:
    if attempt_count <= 1:
        return timedelta(hours=2)
    return timedelta(hours=24)


def _retry_target(now: datetime, attempt_count: int) -> tuple[datetime, datetime]:
    target = now + _retry_delay(attempt_count)
    latest = target + timedelta(minutes=DISCOVERY_RETRY_WINDOW_MINUTES)
    return target.replace(tzinfo=None), latest.replace(tzinfo=None)


async def _queue_row_for_call_control_id(call_control_id: str) -> dict[str, Any] | None:
    if not call_control_id:
        return None
    return await query_one(
        """
        SELECT
          q.id,
          q.senior_id,
          q.call_type,
          q.status,
          q.attempt_count,
          ca.answered_at,
          ca.media_started_at,
          ca.provider_error_code,
          ca.status AS attempt_status
        FROM call_attempts ca
        JOIN call_queue q ON q.id = ca.queue_id
        WHERE ca.call_control_id = $1
        ORDER BY ca.created_at DESC
        LIMIT 1
        """,
        call_control_id,
    )


async def _queue_row_for_id(queue_id: str) -> dict[str, Any] | None:
    if not queue_id:
        return None
    return await query_one(
        """
        SELECT id, senior_id, call_type, status, attempt_count
        FROM call_queue
        WHERE id = $1
        LIMIT 1
        """,
        queue_id,
    )


async def mark_discovery_attempt(
    *,
    senior_id: str,
    attempt_count: int,
    outcome: str,
    status: str | None = None,
    completed_at: datetime | None = None,
) -> None:
    if not senior_id:
        return
    await execute(
        """
        UPDATE seniors
           SET voice_discovery_status = CASE
                 WHEN voice_discovery_status IN ('complete', 'declined', 'unreachable')
                   THEN voice_discovery_status
                 WHEN $4::text IS NULL
                   THEN voice_discovery_status
                 ELSE $4::text
               END,
               voice_discovery_attempt_count = GREATEST(voice_discovery_attempt_count, $2),
               voice_discovery_last_attempt_at = NOW(),
               voice_discovery_last_outcome = $3,
               voice_discovery_completed_at = CASE
                 WHEN $5::timestamptz IS NULL THEN voice_discovery_completed_at
                 ELSE COALESCE(voice_discovery_completed_at, $5::timestamptz)
               END,
               updated_at = NOW()
         WHERE id = $1
        """,
        senior_id,
        max(0, int(attempt_count or 0)),
        str(outcome or "unknown")[:80],
        status,
        completed_at,
    )


async def mark_queue_completed(queue_id: str, *, outcome: str = "completed") -> bool:
    if not queue_id:
        return False
    result = await execute(
        """
        UPDATE call_queue
           SET status = 'completed',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = NULL,
               last_error_at = NULL,
               updated_at = NOW()
         WHERE id = $1
           AND status IN ('leased', 'initiating', 'started', 'queued', 'completed')
         RETURNING id
        """,
        queue_id,
    )
    return _mutation_changed(result)


async def mark_discovery_declined(
    *,
    senior_id: str,
    attempt_count: int,
    outcome: str = "senior_requested_no_more_calls",
) -> None:
    if not senior_id:
        return
    await execute(
        """
        UPDATE seniors
           SET voice_discovery_status = 'declined',
               voice_discovery_attempt_count = GREATEST(voice_discovery_attempt_count, $2),
               voice_discovery_last_attempt_at = NOW(),
               voice_discovery_last_outcome = $3,
               updated_at = NOW()
         WHERE id = $1
        """,
        senior_id,
        max(0, int(attempt_count or 0)),
        str(outcome or "senior_requested_no_more_calls")[:80],
    )


async def record_discovery_opt_out(
    *,
    senior_id: str,
    conversation_id: str | None = None,
    senior_quote: str | None = None,
) -> None:
    """Persist a clear no-more-calls request through the consent audit path."""
    if not senior_id:
        return
    try:
        from services.seniors import record_consent

        await record_consent(
            senior_id=senior_id,
            granted=False,
            conversation_id=conversation_id,
            senior_quote=senior_quote,
            captured_by="discovery_opt_out",
        )
    except Exception as exc:
        logger.error(
            "discovery opt-out consent rollup failed senior={sid}: {err}",
            sid=str(senior_id)[:8],
            err=str(exc),
        )
        await execute(
            """
            UPDATE seniors
               SET callable = false,
                   consent_status = CASE
                     WHEN consent_status = 'granted' THEN 'declined'
                     ELSE consent_status
                   END,
                   updated_at = NOW()
             WHERE id = $1
            """,
            senior_id,
        )


async def defer_discovery_retry(
    *,
    queue_id: str,
    senior_id: str | None = None,
    attempt_count: int | None = None,
    reason: str,
) -> dict[str, Any] | None:
    """Retry the same discovery queue row on a human-scale ladder.

    Attempt 1 retries later the same day. Attempt 2 retries the next day.
    Attempt 3 is terminal and marks the senior unreachable for caregiver follow-up.
    """
    row = await _queue_row_for_id(queue_id)
    if not row or row.get("call_type") != DISCOVERY_CALL_TYPE:
        return None

    resolved_senior_id = senior_id or row.get("senior_id")
    resolved_attempts = int(attempt_count if attempt_count is not None else row.get("attempt_count") or 0)
    safe_reason = str(reason or "retry")[:80]
    now = _now_utc()

    if resolved_attempts >= DISCOVERY_MAX_ATTEMPTS:
        await execute(
            """
            UPDATE call_queue
               SET status = 'failed',
                   lease_owner = NULL,
                   lease_expires_at = NULL,
                   last_error_code = $2,
                   last_error_at = NOW(),
                   updated_at = NOW()
             WHERE id = $1
               AND status IN ('queued', 'deferred', 'leased', 'initiating', 'started')
            """,
            queue_id,
            safe_reason,
        )
        await mark_discovery_attempt(
            senior_id=resolved_senior_id,
            attempt_count=resolved_attempts,
            outcome=safe_reason,
            status="unreachable",
        )
        logger.info(
            "discovery retry exhausted queue={qid} attempts={attempts} reason={reason}",
            qid=str(queue_id)[:8],
            attempts=resolved_attempts,
            reason=safe_reason,
        )
        return {"status": "failed", "attempt_count": resolved_attempts}

    target_at, latest_at = _retry_target(now, resolved_attempts)
    await execute(
        """
        UPDATE call_queue
           SET status = 'deferred',
               target_at = $2,
               earliest_at = $2,
               latest_at = $3,
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = $4,
               last_error_at = NOW(),
               updated_at = NOW()
         WHERE id = $1
           AND status IN ('queued', 'deferred', 'leased', 'initiating', 'started')
        """,
        queue_id,
        target_at,
        latest_at,
        safe_reason,
    )
    await mark_discovery_attempt(
        senior_id=resolved_senior_id,
        attempt_count=resolved_attempts,
        outcome=safe_reason,
        status="partial" if safe_reason == "interrupted_short_call" else "scheduled",
    )
    logger.info(
        "discovery retry scheduled queue={qid} attempts={attempts} reason={reason}",
        qid=str(queue_id)[:8],
        attempts=resolved_attempts,
        reason=safe_reason,
    )
    return {"status": "deferred", "attempt_count": resolved_attempts, "target_at": target_at}


async def finalize_queue_terminal_event(
    *,
    call_control_id: str,
    event_type: str,
    error_reason: str | None = None,
) -> None:
    """Update call_queue after Telnyx terminal events.

    No-answer/busy/failed discovery calls are deferred on a slower retry
    ladder. Calls that reached a human/media stream are completed here; the
    post-call worker decides whether the discovery content was complete enough
    or needs a follow-up retry.
    """
    row = await _queue_row_for_call_control_id(call_control_id)
    if not row:
        return

    queue_id = row["id"]
    call_type = row.get("call_type")
    senior_id = row.get("senior_id")
    attempt_count = int(row.get("attempt_count") or 0)
    reason = error_reason or _TERMINAL_ERROR_EVENTS.get(event_type)
    is_error = event_type in _TERMINAL_ERROR_EVENTS or bool(error_reason)

    if call_type == DISCOVERY_CALL_TYPE and is_error:
        await defer_discovery_retry(
            queue_id=queue_id,
            senior_id=senior_id,
            attempt_count=attempt_count,
            reason=reason or "provider_failed",
        )
        return

    if event_type in _TERMINAL_OK_EVENTS and not is_error:
        completed = await mark_queue_completed(queue_id)
        if completed and call_type == DISCOVERY_CALL_TYPE:
            await mark_discovery_attempt(
                senior_id=senior_id,
                attempt_count=attempt_count,
                outcome="answered",
                status="in_progress",
            )
        return

    await execute(
        """
        UPDATE call_queue
           SET status = 'failed',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error_code = $2,
               last_error_at = NOW(),
               updated_at = NOW()
         WHERE id = $1
        """,
        queue_id,
        (reason or "provider_failed")[:80],
    )


async def finalize_discovery_post_call(
    *,
    senior_id: str,
    queue_id: str | None,
    duration_seconds: int,
    captured_fact_count: int = 0,
    transcript_has_content: bool = False,
    senior_opted_out: bool = False,
    conversation_id: str | None = None,
    senior_opt_out_quote: str | None = None,
) -> None:
    """Complete or retry senior voice discovery after real conversation ends."""
    if not senior_id:
        return

    queue_row = await _queue_row_for_id(queue_id) if queue_id else None
    attempt_count = int((queue_row or {}).get("attempt_count") or 0)

    if senior_opted_out:
        await record_discovery_opt_out(
            senior_id=senior_id,
            conversation_id=conversation_id,
            senior_quote=senior_opt_out_quote,
        )
        if queue_id:
            await mark_queue_completed(queue_id, outcome="declined")
        await mark_discovery_declined(
            senior_id=senior_id,
            attempt_count=attempt_count,
        )
        return

    completed = (
        duration_seconds >= DISCOVERY_MIN_COMPLETE_SECONDS
        or captured_fact_count >= 3
    )
    if completed:
        if queue_id:
            await mark_queue_completed(queue_id)
        await mark_discovery_attempt(
            senior_id=senior_id,
            attempt_count=attempt_count,
            outcome="completed",
            status="complete",
            completed_at=_now_utc(),
        )
        return

    if transcript_has_content and queue_id:
        await defer_discovery_retry(
            queue_id=queue_id,
            senior_id=senior_id,
            attempt_count=attempt_count,
            reason="interrupted_short_call",
        )
        return

    if queue_id:
        retry_result = await defer_discovery_retry(
            queue_id=queue_id,
            senior_id=senior_id,
            attempt_count=attempt_count,
            reason="no_conversation_content",
        )
        if retry_result:
            return

    await mark_discovery_attempt(
        senior_id=senior_id,
        attempt_count=attempt_count,
        outcome="no_conversation_content",
        status="partial",
    )
