"""Reminder scheduler service.

Node is the authoritative scheduler. This opt-in Pipecat scheduler uses the
same Telnyx outbound path if explicitly enabled.
"""

from __future__ import annotations

import asyncio
import os
import re
from datetime import datetime, timezone, timedelta
from loguru import logger
from db import query_one, query_many, execute
from lib.sanitize import mask_phone
from lib.phi import decrypt_reminder_phi, decrypt_senior_phi
from services.reminder_delivery import mark_delivered

# Pre-fetched context maps (shared state — same semantics as Node.js Maps)
pending_reminder_calls: dict[str, dict] = {}
prefetched_context_by_phone: dict[str, dict] = {}
REMINDER_CONTEXT_TTL_SECONDS = 30 * 60


def _normalize_phone(phone: str) -> str:
    return re.sub(r"\D", "", phone)[-10:]


def _reminder_context_key(call_sid: str) -> str:
    return f"reminder_ctx:{call_sid}"


def _coerce_datetime(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


async def _delete_shared_reminder_context(call_sid: str) -> None:
    try:
        from lib.redis_client import get_shared_state
        state = get_shared_state()
        if getattr(state, "is_shared", False):
            await state.delete(_reminder_context_key(call_sid))
    except Exception as exc:
        logger.warning("[{cs}] Shared reminder context delete failed: {err}", cs=call_sid, err=str(exc))


async def store_reminder_context(call_sid: str, context: dict) -> None:
    """Store reminder call context locally and encrypted in shared state."""
    pending_reminder_calls[call_sid] = context
    try:
        from lib.redis_client import get_shared_state
        from lib.shared_state_phi import encode_phi_payload
        state = get_shared_state()
        if getattr(state, "is_shared", False):
            await state.set(
                _reminder_context_key(call_sid),
                encode_phi_payload(context),
                ttl=REMINDER_CONTEXT_TTL_SECONDS,
            )
    except Exception as exc:
        logger.warning("[{cs}] Shared reminder context write failed: {err}", cs=call_sid, err=str(exc))


def get_scheduled_for_time(reminder: dict) -> datetime | None:
    """Calculate the 'scheduled for' time for a reminder instance."""
    scheduled_time = reminder.get("scheduled_time")
    if not scheduled_time:
        return None

    if isinstance(scheduled_time, str):
        scheduled_time = datetime.fromisoformat(scheduled_time)

    if reminder.get("is_recurring"):
        now = datetime.now(timezone.utc)
        return now.replace(
            hour=scheduled_time.hour,
            minute=scheduled_time.minute,
            second=0,
            microsecond=0,
        )
    return scheduled_time


async def get_due_reminders() -> list[dict]:
    """Find reminders that are due now.

    Checks: non-recurring past due, recurring time-of-day match,
    and retry-pending deliveries ready for retry (>30 min since last attempt).
    """
    now = datetime.now(timezone.utc)
    one_minute = now + timedelta(minutes=1)
    thirty_minutes_ago = now - timedelta(minutes=30)

    # Non-recurring reminders due now
    non_recurring = await query_many(
        """SELECT r.id AS reminder_id, s.id AS senior_id,
                  r.type, r.title, r.title_encrypted,
                  r.description, r.description_encrypted, r.scheduled_time,
                  r.is_recurring, r.cron_expression, r.is_active AS r_active,
                  r.last_delivered_at,
                  s.name, s.phone, s.timezone, s.interests,
                  s.family_info, s.family_info_encrypted,
                  s.preferred_call_times, s.preferred_call_times_encrypted,
                  s.additional_info, s.additional_info_encrypted,
                  s.call_context_snapshot, s.call_context_snapshot_encrypted,
                  s.is_active AS s_active
           FROM reminders r
           INNER JOIN seniors s ON r.senior_id = s.id
           WHERE r.is_active = true
             AND r.is_recurring = false
             AND r.scheduled_time <= $1
             AND s.is_active = true""",
        one_minute,
    )

    # Recurring reminders (all active — filter by time-of-day in Python)
    recurring_all = await query_many(
        """SELECT r.id AS reminder_id, s.id AS senior_id,
                  r.type, r.title, r.title_encrypted,
                  r.description, r.description_encrypted, r.scheduled_time,
                  r.is_recurring, r.cron_expression, r.is_active AS r_active,
                  r.last_delivered_at,
                  s.name, s.phone, s.timezone, s.interests,
                  s.family_info, s.family_info_encrypted,
                  s.preferred_call_times, s.preferred_call_times_encrypted,
                  s.additional_info, s.additional_info_encrypted,
                  s.call_context_snapshot, s.call_context_snapshot_encrypted,
                  s.is_active AS s_active
           FROM reminders r
           INNER JOIN seniors s ON r.senior_id = s.id
           WHERE r.is_active = true
             AND r.is_recurring = true
             AND s.is_active = true""",
    )

    # Filter recurring to those whose time-of-day matches now (within 5 min).
    # scheduled_time is stored in the senior's local timezone, so convert
    # UTC `now` to the senior's timezone before comparing.
    recurring_due = []
    for row in recurring_all:
        st = row.get("scheduled_time")
        if not st:
            continue
        if isinstance(st, str):
            st = datetime.fromisoformat(st)
        sched_minutes = st.hour * 60 + st.minute

        # Convert UTC now to the senior's local timezone for comparison
        senior_tz_name = row.get("timezone")
        if senior_tz_name:
            try:
                from zoneinfo import ZoneInfo
                local_now = now.astimezone(ZoneInfo(senior_tz_name))
            except Exception:
                local_now = now
        else:
            local_now = now
        now_minutes = local_now.hour * 60 + local_now.minute

        # Handle midnight wrap-around (e.g. 23:58 vs 00:02 = 4 min, not 1436)
        diff = abs(sched_minutes - now_minutes)
        if min(diff, 1440 - diff) <= 5:
            recurring_due.append(row)

    all_candidates = non_recurring + recurring_due

    due_reminders = []
    for candidate in all_candidates:
        reminder = _extract_reminder(candidate)
        senior = _extract_senior(candidate)
        scheduled_for = get_scheduled_for_time(reminder)
        if not scheduled_for:
            continue

        window_start = scheduled_for - timedelta(minutes=5)
        window_end = scheduled_for + timedelta(minutes=5)

        # Check for already acknowledged/confirmed/max_attempts delivery
        existing = await query_one(
            """SELECT id FROM reminder_deliveries
               WHERE reminder_id = $1
                 AND scheduled_for BETWEEN $2 AND $3
                 AND status IN ('acknowledged', 'confirmed', 'max_attempts')
               LIMIT 1""",
            reminder["id"],
            window_start,
            window_end,
        )
        if existing:
            continue

        # Check for already-delivered (pending) delivery
        pending = await query_one(
            """SELECT id FROM reminder_deliveries
               WHERE reminder_id = $1
                 AND scheduled_for BETWEEN $2 AND $3
                 AND status IN ('delivered', 'retry_pending')
               LIMIT 1""",
            reminder["id"],
            window_start,
            window_end,
        )
        if not pending:
            due_reminders.append({
                "reminder": reminder,
                "senior": senior,
                "scheduled_for": scheduled_for,
            })

    # Retries: retry_pending deliveries >30 min since last attempt
    retries = await query_many(
        """SELECT rd.id AS delivery_id, rd.scheduled_for, rd.delivered_at,
                  rd.status AS delivery_status, rd.attempt_count, rd.call_sid,
                  r.id AS reminder_id, s.id AS senior_id,
                  r.type, r.title, r.title_encrypted,
                  r.description, r.description_encrypted, r.scheduled_time,
                  r.is_recurring, r.cron_expression, r.is_active AS r_active,
                  r.last_delivered_at,
                  s.name, s.phone, s.timezone, s.interests,
                  s.family_info, s.family_info_encrypted,
                  s.preferred_call_times, s.preferred_call_times_encrypted,
                  s.additional_info, s.additional_info_encrypted,
                  s.call_context_snapshot, s.call_context_snapshot_encrypted,
                  s.is_active AS s_active
           FROM reminder_deliveries rd
           INNER JOIN reminders r ON rd.reminder_id = r.id
           INNER JOIN seniors s ON r.senior_id = s.id
           WHERE rd.status = 'retry_pending'
             AND rd.delivered_at < $1
             AND r.is_active = true
             AND s.is_active = true""",
        thirty_minutes_ago,
    )
    for row in retries:
        due_reminders.append({
            "reminder": _extract_reminder(row),
            "senior": _extract_senior(row),
            "scheduled_for": row.get("scheduled_for"),
            "existing_delivery": _extract_delivery(row),
        })

    return due_reminders


async def trigger_reminder_call(
    reminder: dict,
    senior: dict,
    base_url: str,
    scheduled_for: datetime | None = None,
    existing_delivery: dict | None = None,
) -> dict | None:
    """Trigger an outbound Telnyx call for a reminder."""

    try:
        target_scheduled_for = scheduled_for or get_scheduled_for_time(reminder) or datetime.now(timezone.utc)

        from api.routes.telnyx import TelnyxOutboundCallRequest, create_telnyx_outbound_call

        call = await create_telnyx_outbound_call(
            TelnyxOutboundCallRequest(
                seniorId=str(senior["id"]),
                callType="reminder",
                reminderId=str(reminder["id"]),
                scheduledFor=target_scheduled_for,
                existingDeliveryId=str(existing_delivery["id"]) if existing_delivery else None,
            )
        )

        logger.info("Telnyx call initiated callSid={cs}", cs=call["callSid"])
        return {"sid": call["callSid"]}

    except Exception as e:
        logger.error("Failed to initiate call: {err}", err=str(e))
        return None


async def prefetch_for_phone(phone_number: str, senior: dict | None) -> dict:
    """Pre-fetch context for a manual outbound call."""
    logger.info("Pre-fetching for manual call has_senior={has}", has=bool(senior))

    memory_context = None
    pre_generated_greeting = None
    cached = None

    if senior:
        try:
            from services.context_cache import get_cache
            cached = get_cache(senior["id"])
        except ImportError:
            cached = None

        if cached:
            memory_context = cached.get("memory_context")
            pre_generated_greeting = cached.get("greeting")
            logger.info("Using cached context for senior_id={sid}", sid=str(senior.get("id", ""))[:8])
        else:
            from services.memory import build_context
            memory_context = await build_context(senior["id"], None, senior)

    recent_turns = None
    if cached:
        recent_turns = cached.get("recent_turns")

    normalized = _normalize_phone(phone_number)
    prefetched_context_by_phone[normalized] = {
        "senior": senior,
        "memory_context": memory_context,
        "pre_generated_greeting": pre_generated_greeting,
        "recent_turns": recent_turns,
        "fetched_at": datetime.now(timezone.utc),
    }

    logger.info("Pre-fetch complete phone={p} greeting_ready={g}", p=mask_phone(phone_number), g=bool(pre_generated_greeting))
    return {"senior": senior, "memory_context": memory_context, "pre_generated_greeting": pre_generated_greeting}


def get_prefetched_context(phone_number: str) -> dict | None:
    """Get pre-fetched context for a phone number (one-time use)."""
    normalized = _normalize_phone(phone_number)
    return prefetched_context_by_phone.pop(normalized, None)


def get_reminder_context(call_sid: str) -> dict | None:
    """Get locally cached reminder context for a call."""
    return pending_reminder_calls.get(call_sid)


async def get_reminder_context_async(call_sid: str) -> dict | None:
    """Get reminder context from local memory, then Redis shared state."""
    context = pending_reminder_calls.get(call_sid)
    if context:
        return context

    try:
        from lib.redis_client import get_shared_state
        state = get_shared_state()
        if not getattr(state, "is_shared", False):
            return None

        from lib.shared_state_phi import decode_phi_payload

        context = decode_phi_payload(
            await state.get(_reminder_context_key(call_sid)),
            label="reminder context",
        )
        if isinstance(context, dict) and context:
            pending_reminder_calls[call_sid] = context
            logger.info("[{cs}] Loaded reminder context from shared state", cs=call_sid)
            return context
    except Exception as exc:
        logger.warning("[{cs}] Shared reminder context lookup failed: {err}", cs=call_sid, err=str(exc))

    return None


def clear_reminder_context(call_sid: str) -> None:
    """Clear reminder context after call ends.

    Synchronous compatibility wrapper. Async callers should prefer
    clear_reminder_context_async() so Redis cleanup is awaited.
    """
    pending_reminder_calls.pop(call_sid, None)
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(_delete_shared_reminder_context(call_sid))
    else:
        loop.create_task(_delete_shared_reminder_context(call_sid))


async def clear_reminder_context_async(call_sid: str) -> None:
    """Clear reminder context from local memory and shared state."""
    pending_reminder_calls.pop(call_sid, None)
    await _delete_shared_reminder_context(call_sid)


def cleanup_stale_contexts(max_age_minutes: int = 30) -> int:
    """Remove pending_reminder_calls entries older than max_age_minutes."""
    now = datetime.now(timezone.utc)
    stale = []
    for sid, ctx in pending_reminder_calls.items():
        triggered_at = _coerce_datetime(ctx.get("triggered_at")) or now
        if (now - triggered_at).total_seconds() > max_age_minutes * 60:
            stale.append(sid)
    for sid in stale:
        pending_reminder_calls.pop(sid, None)
    if stale:
        logger.info("Cleaned up {n} stale reminder contexts", n=len(stale))
    return len(stale)


# ---------------------------------------------------------------------------
# Row extraction helpers (flat join rows → structured dicts)
# ---------------------------------------------------------------------------

def _extract_reminder(row: dict) -> dict:
    """Extract reminder fields from a joined row."""
    return decrypt_reminder_phi({
        "id": row.get("reminder_id") or row.get("id"),
        "senior_id": row.get("senior_id"),
        "type": row.get("type"),
        "title": row.get("title"),
        "title_encrypted": row.get("title_encrypted"),
        "description": row.get("description"),
        "description_encrypted": row.get("description_encrypted"),
        "scheduled_time": row.get("scheduled_time"),
        "is_recurring": row.get("is_recurring"),
        "cron_expression": row.get("cron_expression"),
        "is_active": row.get("r_active") if "r_active" in row else row.get("is_active"),
        "last_delivered_at": row.get("last_delivered_at"),
    })


def _extract_senior(row: dict) -> dict:
    """Extract senior fields from a joined row."""
    return decrypt_senior_phi({
        "id": row.get("senior_id"),
        "name": row.get("name"),
        "phone": row.get("phone"),
        "timezone": row.get("timezone"),
        "interests": row.get("interests"),
        "family_info": row.get("family_info"),
        "family_info_encrypted": row.get("family_info_encrypted"),
        "preferred_call_times": row.get("preferred_call_times"),
        "preferred_call_times_encrypted": row.get("preferred_call_times_encrypted"),
        "additional_info": row.get("additional_info"),
        "additional_info_encrypted": row.get("additional_info_encrypted"),
        "call_context_snapshot": row.get("call_context_snapshot"),
        "call_context_snapshot_encrypted": row.get("call_context_snapshot_encrypted"),
        "is_active": row.get("s_active") if "s_active" in row else row.get("is_active"),
    })


def _extract_delivery(row: dict) -> dict:
    """Extract delivery fields from a joined row."""
    return {
        "id": row.get("delivery_id"),
        "reminder_id": row.get("reminder_id"),
        "scheduled_for": row.get("scheduled_for"),
        "delivered_at": row.get("delivered_at"),
        "status": row.get("delivery_status") or row.get("status"),
        "attempt_count": row.get("attempt_count"),
        "call_sid": row.get("call_sid"),
    }


# ---------------------------------------------------------------------------
# Scheduler loop (replaces Node.js setInterval)
# ---------------------------------------------------------------------------

# Advisory lock ID for scheduler leader election.
# Only one instance can hold this lock at a time.
SCHEDULER_LOCK_ID = 8675309  # Arbitrary unique int64


async def _try_acquire_leader_lock() -> bool:
    """Try to acquire the scheduler advisory lock. Non-blocking."""
    try:
        row = await query_one("SELECT pg_try_advisory_lock($1) AS acquired", SCHEDULER_LOCK_ID)
        return row and row.get("acquired", False)
    except Exception as e:
        logger.warning("Failed to acquire scheduler lock: {err}", err=str(e))
        return False


async def _release_leader_lock() -> None:
    """Release the scheduler advisory lock."""
    try:
        await query_one("SELECT pg_advisory_unlock($1)", SCHEDULER_LOCK_ID)
    except Exception as e:
        logger.warning("Failed to release scheduler lock: {err}", err=str(e))


async def start_scheduler(base_url: str, interval_seconds: int = 60) -> None:
    """Start the reminder polling loop and hourly context pre-fetch.

    Uses PostgreSQL advisory locks for leader election — only one instance
    runs the scheduler at a time. If the leader dies, another instance
    acquires the lock within one polling interval.

    This runs forever — call as an asyncio task:
        asyncio.create_task(start_scheduler(base_url))
    """
    scheduler_enabled = os.environ.get("SCHEDULER_ENABLED", "false").lower()
    if scheduler_enabled != "true":
        logger.info("Scheduler disabled (SCHEDULER_ENABLED != 'true')")
        return

    logger.info("Starting scheduler (interval={i}s)", i=interval_seconds)

    _trigger_sem = asyncio.Semaphore(10)  # Limit concurrent Telnyx call requests

    async def check_reminders():
        try:
            cleanup_stale_contexts()
            due = await get_due_reminders()
            if not due:
                return
            logger.info("Found {n} due reminders", n=len(due))

            async def _limited_trigger(item):
                async with _trigger_sem:
                    result = await trigger_reminder_call(
                        item["reminder"],
                        item["senior"],
                        base_url,
                        item.get("scheduled_for"),
                        item.get("existing_delivery"),
                    )
                    if result:
                        await mark_delivered(item["reminder"]["id"])
                    return result

            results = await asyncio.gather(
                *[_limited_trigger(item) for item in due],
                return_exceptions=True,
            )
            succeeded = sum(1 for r in results if r and not isinstance(r, Exception))
            failed = sum(1 for r in results if isinstance(r, Exception))
            if failed:
                for i, r in enumerate(results):
                    if isinstance(r, Exception):
                        logger.error("Reminder trigger failed: {err}", err=str(r))
            logger.info("Triggered {ok}/{total} reminders ({fail} failed)",
                        ok=succeeded, total=len(due), fail=failed)
        except Exception as e:
            logger.error("Error checking reminders: {err}", err=str(e))

    async def prefetch_loop():
        while True:
            try:
                from services.context_cache import run_daily_prefetch, cleanup_expired
                cleanup_expired()
                await run_daily_prefetch()
            except Exception as e:
                logger.error("Context pre-fetch error: {err}", err=str(e))
            await asyncio.sleep(3600)  # Every hour

    # Prefetch runs on all instances (read-only, safe to duplicate)
    asyncio.create_task(prefetch_loop())
    logger.info("Context pre-caching enabled (hourly check for 5 AM local time)")

    # Leader election loop — only the leader runs check_reminders()
    is_leader = False
    while True:
        if not is_leader:
            is_leader = await _try_acquire_leader_lock()
            if is_leader:
                logger.info("Acquired scheduler leader lock — this instance is the scheduler leader")
                await check_reminders()  # Initial check on becoming leader
            else:
                logger.debug("Another instance holds scheduler lock — standing by")
        else:
            await check_reminders()

        await asyncio.sleep(interval_seconds)
