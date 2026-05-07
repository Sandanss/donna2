"""Voice-driven reminder creation.

When Donna's `create_reminder` tool fires during a call, this:
1. Inserts a row in `reminders` (PHI fields encrypted, `created_via='voice'`).
2. Appends a matching schedule item to the senior's
   `preferred_call_times.schedule` so the existing scheduler (services/scheduler.js
   and pipecat/services/scheduler.py) automatically calls them at the right time.

Both writes happen inside a single asyncpg transaction so a partial failure
never leaves a reminder without its scheduled call (or vice versa).
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo

from loguru import logger

from db.client import get_pool
from lib.encryption import encrypt, encrypt_json
from lib.phi import (
    ENCRYPTED_PLACEHOLDER,
    decrypt_reminder_phi,
)


def _local_wall_clock(scheduled_time: datetime, timezone_name: str) -> datetime:
    try:
        return scheduled_time.astimezone(ZoneInfo(timezone_name))
    except Exception:
        return scheduled_time


def _daily_cron_from_local_time(scheduled_time: datetime, timezone_name: str) -> str:
    local = _local_wall_clock(scheduled_time, timezone_name)
    return f"{local.minute} {local.hour} * * *"


def _hhmm(scheduled_time: datetime, timezone_name: str) -> str:
    local = _local_wall_clock(scheduled_time, timezone_name)
    return f"{local.hour:02d}:{local.minute:02d}"


def _iso_date(scheduled_time: datetime, timezone_name: str) -> str:
    local = _local_wall_clock(scheduled_time, timezone_name)
    return local.date().isoformat()


def _build_schedule_item(
    *,
    reminder_id: str,
    title: str,
    scheduled_time: datetime,
    timezone_name: str,
    frequency: str,
    recurring_days: list[int],
) -> dict:
    """Build a schedule item that matches the shape used elsewhere
    (services/scheduler.js, apps/website/.../SchedulePage.jsx, mobile schedule tab)."""
    item: dict = {
        "id": str(uuid.uuid4()),
        "title": title,
        "time": _hhmm(scheduled_time, timezone_name),
        "reminderIds": [reminder_id],
        "createdVia": "voice",
    }
    if frequency == "weekly":
        item["frequency"] = "recurring"
        item["recurringDays"] = sorted(set(int(d) for d in recurring_days))
    elif frequency == "daily":
        item["frequency"] = "daily"
    else:
        item["frequency"] = "one-time"
        item["date"] = _iso_date(scheduled_time, timezone_name)
    return item


async def create_reminder(
    *,
    senior_id: str,
    reminder_type: str,
    title: str,
    description: str | None,
    scheduled_time: datetime,
    frequency: str,
    recurring_days: list[int] | None = None,
    timezone_name: str = "America/New_York",
) -> dict:
    """Create a reminder + schedule item for the senior.

    Args:
        frequency: 'daily', 'weekly', or 'one-time'.
        recurring_days: Required when frequency='weekly'. JS Date.getDay() ints (0=Sun..6=Sat).

    Returns:
        {"reminder": <decrypted reminder row>, "schedule_item_id": str}
    """
    is_recurring = frequency != "one-time"
    cron = _daily_cron_from_local_time(scheduled_time, timezone_name) if is_recurring else None
    recurring_days = recurring_days or []

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            reminder_row = await conn.fetchrow(
                """INSERT INTO reminders (
                      senior_id, type, title, title_encrypted,
                      description, description_encrypted,
                      scheduled_time, is_recurring, cron_expression, is_active,
                      created_via
                   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, 'voice')
                   RETURNING id, senior_id, type, title, title_encrypted,
                             description, description_encrypted,
                             scheduled_time, is_recurring, cron_expression, created_via""",
                senior_id,
                reminder_type,
                ENCRYPTED_PLACEHOLDER,
                encrypt(title),
                None,
                encrypt(description) if description else None,
                scheduled_time,
                is_recurring,
                cron,
            )
            if not reminder_row:
                raise RuntimeError("reminders INSERT returned no row")
            reminder = dict(reminder_row)

            senior_row = await conn.fetchrow(
                """SELECT preferred_call_times, preferred_call_times_encrypted
                   FROM seniors WHERE id = $1 FOR UPDATE""",
                senior_id,
            )
            if not senior_row:
                raise RuntimeError(f"senior {senior_id} not found")

            from lib.encryption import decrypt_json
            existing = (
                decrypt_json(senior_row["preferred_call_times_encrypted"])
                if senior_row["preferred_call_times_encrypted"]
                else senior_row["preferred_call_times"]
            ) or {}
            if not isinstance(existing, dict):
                existing = {}
            schedule_list = existing.get("schedule") or []
            if not isinstance(schedule_list, list):
                schedule_list = []

            new_item = _build_schedule_item(
                reminder_id=str(reminder["id"]),
                title=title,
                scheduled_time=scheduled_time,
                timezone_name=timezone_name,
                frequency=frequency,
                recurring_days=recurring_days,
            )
            updated_call_times = {**existing, "schedule": [*schedule_list, new_item]}

            encrypted_call_times = encrypt_json(updated_call_times)
            await conn.execute(
                """UPDATE seniors
                   SET preferred_call_times = NULL,
                       preferred_call_times_encrypted = $1,
                       updated_at = NOW()
                   WHERE id = $2""",
                encrypted_call_times,
                senior_id,
            )

    decrypted = decrypt_reminder_phi(reminder) or reminder
    logger.info(
        "Voice reminder + schedule item created rid={rid} sched_id={sid} senior={s} freq={f}",
        rid=str(decrypted.get("id"))[:8],
        sid=new_item["id"][:8],
        s=str(senior_id)[:8],
        f=frequency,
    )
    return {"reminder": decrypted, "schedule_item_id": new_item["id"]}
