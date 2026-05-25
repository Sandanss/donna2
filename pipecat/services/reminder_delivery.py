"""Reminder delivery record management.

CRUD operations for reminder_deliveries table — marking deliveries as
acknowledged, confirmed, retry_pending, or max_attempts. Also formats
reminder text for injection into system prompts.

Split from scheduler.py to separate delivery tracking (used by bot.py,
tools.py) from the polling loop and call triggering (used by main.py).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone

from loguru import logger
from db import query_one, execute
from lib.encryption import encrypt
from lib.phi import decrypt_reminder_phi


def build_reminder_delivery_key(reminder_id: str, scheduled_for: datetime) -> str:
    """Build an ID-only idempotency key for one reminder scheduled instance."""
    if not reminder_id:
        raise ValueError("reminder_id is required")
    if not isinstance(scheduled_for, datetime):
        raise ValueError("scheduled_for must be a datetime")

    if scheduled_for.tzinfo is not None:
        scheduled_for = scheduled_for.astimezone(timezone.utc).replace(tzinfo=None)
    normalized = scheduled_for.replace(second=0, microsecond=0)
    return f"reminder_delivery:{reminder_id}:{normalized.isoformat(timespec='minutes')}"


async def mark_delivered(reminder_id: str) -> None:
    """Update last_delivered_at on the reminders table."""
    await execute(
        "UPDATE reminders SET last_delivered_at = NOW() WHERE id = $1",
        reminder_id,
    )
    logger.info("Marked reminder delivered: {rid}", rid=reminder_id)


async def mark_reminder_acknowledged(
    delivery_id: str, status: str, user_response: str | None
) -> dict | None:
    """Mark a delivery as acknowledged or confirmed."""
    if not delivery_id:
        logger.error("No delivery_id provided for acknowledgment")
        return None

    if status not in ("acknowledged", "confirmed"):
        logger.error("Invalid status: {s}", s=status)
        return None

    try:
        row = await query_one(
            """UPDATE reminder_deliveries SET
                 status = $1, acknowledged_at = NOW(),
                 user_response = NULL, user_response_encrypted = $2
               WHERE id = $3 RETURNING *""",
            status,
            encrypt(user_response),
            delivery_id,
        )
        logger.info("Delivery {did} marked {s}", did=delivery_id, s=status)
        return row
    except Exception as e:
        logger.error("Failed to mark acknowledgment: {err}", err=str(e))
        return None


async def get_delivery_status(delivery_id: str) -> dict | None:
    """Fetch the current status for a reminder delivery."""
    if not delivery_id:
        return None

    try:
        return await query_one(
            "SELECT id, status, attempt_count FROM reminder_deliveries WHERE id = $1",
            delivery_id,
        )
    except Exception as e:
        logger.error("Failed to fetch delivery status: {err}", err=str(e))
        return None


async def mark_call_ended_without_acknowledgment(delivery_id: str) -> None:
    """Handle call end without acknowledgment — set retry_pending or max_attempts."""
    if not delivery_id:
        return

    try:
        delivery = await query_one(
            "SELECT * FROM reminder_deliveries WHERE id = $1", delivery_id
        )
        if not delivery:
            logger.info("Delivery not found: {did}", did=delivery_id)
            return

        if delivery["status"] in ("acknowledged", "confirmed"):
            logger.info("Delivery already handled: {did} status={s}", did=delivery_id, s=delivery["status"])
            return

        new_status = "max_attempts" if delivery.get("attempt_count", 0) >= 2 else "retry_pending"
        await execute(
            "UPDATE reminder_deliveries SET status = $1 WHERE id = $2",
            new_status,
            delivery_id,
        )
        logger.info("Delivery {did} -> {s} (attempt={a})", did=delivery_id, s=new_status, a=delivery.get("attempt_count"))
    except Exception as e:
        logger.error("Failed to update delivery status: {err}", err=str(e))


async def get_reminder_by_call_sid(call_sid: str) -> dict | None:
    """Look up an active reminder delivery by provider call id.

    Kept for archived Twilio compatibility and direct database recovery.

    Returns dict with reminder + delivery info, or None if not a reminder call.
    """
    if not call_sid:
        return None

    row = await query_one(
        """SELECT rd.id AS delivery_id, rd.reminder_id, rd.scheduled_for,
                  rd.status AS delivery_status, rd.attempt_count,
                  r.title, r.title_encrypted, r.description,
                  r.description_encrypted, r.type AS reminder_type
           FROM reminder_deliveries rd
           JOIN reminders r ON rd.reminder_id = r.id
           WHERE rd.call_sid = $1
           LIMIT 1""",
        call_sid,
    )
    if row:
        row = decrypt_reminder_phi(row)
        logger.info("Found reminder for call {cs}", cs=call_sid)
    return row


async def get_reminder_by_id(reminder_id: str) -> dict | None:
    """Fetch reminder details for a scheduled call."""
    if not reminder_id:
        return None

    row = await query_one(
        """SELECT r.id AS reminder_id, r.senior_id,
                  r.title, r.title_encrypted, r.description,
                  r.description_encrypted, r.type AS reminder_type,
                  r.scheduled_time, r.is_recurring, r.cron_expression
           FROM reminders r
           WHERE r.id = $1
           LIMIT 1""",
        reminder_id,
    )
    return decrypt_reminder_phi(row) if row else None


async def create_or_update_delivery_for_call(
    *,
    reminder_id: str,
    scheduled_for: datetime,
    call_sid: str,
    existing_delivery_id: str | None = None,
) -> dict:
    """Create or update a reminder delivery row for a call."""
    delivery_key = build_reminder_delivery_key(reminder_id, scheduled_for)

    if existing_delivery_id:
        delivery = await query_one(
            """UPDATE reminder_deliveries SET
                 delivered_at = NOW(),
                 call_sid = $1,
                 delivery_key = COALESCE(delivery_key, $3),
                 attempt_count = COALESCE(attempt_count, 0) + 1,
                 status = 'delivered'
               WHERE id = $2
               RETURNING *""",
            call_sid,
            existing_delivery_id,
            delivery_key,
        )
        if not delivery:
            raise ValueError("Existing reminder delivery not found")
        logger.info("Updated delivery {did} for call", did=delivery["id"])
        return delivery

    delivery = await query_one(
        """INSERT INTO reminder_deliveries
           (reminder_id, scheduled_for, delivered_at, call_sid, status, attempt_count, delivery_key)
           VALUES ($1, $2, NOW(), $3, 'delivered', 1, $4)
           ON CONFLICT (delivery_key) WHERE delivery_key IS NOT NULL
           DO UPDATE SET
             delivered_at = NOW(),
             call_sid = EXCLUDED.call_sid,
             attempt_count = COALESCE(reminder_deliveries.attempt_count, 0) + 1,
             status = 'delivered'
           RETURNING *""",
        reminder_id,
        scheduled_for,
        call_sid,
        delivery_key,
    )
    if not delivery:
        raise ValueError("Reminder delivery was not created")
    logger.info("Created delivery {did} for call", did=delivery["id"])
    return delivery


async def wait_for_reminder_by_call_sid(
    call_sid: str,
    *,
    timeout_seconds: float = 2.0,
    initial_delay_seconds: float = 0.1,
    max_delay_seconds: float = 0.5,
) -> dict | None:
    """Look up a reminder delivery, waiting briefly for scheduler DB writes.

    Older webhook paths could reach Pipecat before the scheduler committed the
    reminder_deliveries row containing call_sid. Waiting here keeps those calls
    on the reminder path instead of falling through to a generic call.
    """
    if not call_sid:
        return None

    deadline = time.monotonic() + timeout_seconds
    delay = initial_delay_seconds
    attempts = 0

    while True:
        attempts += 1
        row = await get_reminder_by_call_sid(call_sid)
        if row:
            if attempts > 1:
                logger.info(
                    "Found reminder for call {cs} after {attempts} attempts",
                    cs=call_sid,
                    attempts=attempts,
                )
            return row

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            logger.warning(
                "Reminder delivery not found for call {cs} after {attempts} attempts",
                cs=call_sid,
                attempts=attempts,
            )
            return None

        await asyncio.sleep(min(delay, remaining))
        delay = min(delay * 2, max_delay_seconds)


def format_reminder_prompt(reminder: dict) -> str:
    """Format a reminder for injection into system prompt."""
    lines = ["\n\nIMPORTANT REMINDER TO DELIVER:"]
    lines.append(f'You are calling to remind them about: "{reminder.get("title", "")}"')
    if reminder.get("description"):
        lines.append(f"Details: {reminder['description']}")
    lines.append("\nDeliver this reminder naturally in the conversation - don't sound robotic or alarming.")
    lines.append("Start with a warm greeting, then mention the reminder.")
    return "\n".join(lines)
