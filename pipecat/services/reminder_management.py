"""Voice-driven reminder creation.

Inserts a new reminders row when Donna's `create_reminder` tool fires
during a call. Mirrors the encryption + cron-derivation behavior of
routes/reminders.js so reminders show up identically in the caregiver
mobile/web UIs and the existing scheduler picks up recurring ones.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from loguru import logger

from db import query_one
from lib.encryption import encrypt
from lib.phi import ENCRYPTED_PLACEHOLDER, decrypt_reminder_phi


def _daily_cron_from_local_time(scheduled_time: datetime, timezone_name: str) -> str | None:
    """Mirror dailyCronFromScheduledTime in routes/reminders.js — minute hour * * *
    in the senior's local timezone."""
    try:
        local = scheduled_time.astimezone(ZoneInfo(timezone_name))
    except Exception:
        local = scheduled_time
    return f"{local.minute} {local.hour} * * *"


async def create_reminder(
    *,
    senior_id: str,
    reminder_type: str,
    title: str,
    description: str | None,
    scheduled_time: datetime,
    is_recurring: bool,
    timezone_name: str = "America/New_York",
) -> dict:
    cron = _daily_cron_from_local_time(scheduled_time, timezone_name) if is_recurring else None

    row = await query_one(
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
    if not row:
        raise RuntimeError("reminders INSERT returned no row")
    logger.info(
        "Voice-created reminder rid={rid} senior={sid} type={t} recurring={r}",
        rid=row["id"],
        sid=str(senior_id)[:8],
        t=reminder_type,
        r=is_recurring,
    )
    return decrypt_reminder_phi(row) or row
