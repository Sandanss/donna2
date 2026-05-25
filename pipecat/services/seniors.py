"""Senior profile service.

Port of services/seniors.js — CRUD operations for senior profiles.
"""

from __future__ import annotations

import json
import re
from loguru import logger
from db import query_one, query_many, execute, get_pool
from lib.encryption import encrypt, encrypt_json
from lib.phi import decrypt_senior_phi
from lib.sanitize import mask_phone


def _normalize_phone(phone: str) -> str:
    """Keep last 10 digits of a phone number."""
    digits = re.sub(r"\D", "", phone)
    return digits[-10:]


async def find_by_phone(phone: str, *, active_only: bool = True) -> dict | None:
    """Find a senior by phone number (normalized to last 10 digits).

    Active-only is the safe default for voice calls because matched senior rows
    unlock PHI-bearing context.
    """
    normalized = _normalize_phone(phone)
    active_clause = " AND is_active = true" if active_only else ""
    row = await query_one(
        """SELECT id, name, phone, timezone, interests, family_info,
                  family_info_encrypted,
                  medical_notes, preferred_call_times, is_active,
                  medical_notes_encrypted, preferred_call_times_encrypted,
                  city, state, zip_code, additional_info,
                  additional_info_encrypted, call_context_snapshot,
                  call_context_snapshot_encrypted, cached_news,
                  cached_news_updated_at, call_settings,
                  interest_scores
           FROM seniors WHERE phone = $1""" + active_clause,
        normalized,
    )
    return decrypt_senior_phi(row)


async def find_any_by_phone(phone: str) -> dict | None:
    """Find a senior by phone regardless of active state."""
    return await find_by_phone(phone, active_only=False)


async def create(data: dict) -> dict:
    """Create a new senior profile."""
    phone = _normalize_phone(data["phone"])
    row = await query_one(
        """INSERT INTO seniors (name, phone, timezone, interests, family_info,
           family_info_encrypted, medical_notes, medical_notes_encrypted,
           preferred_call_times, preferred_call_times_encrypted,
           city, state, zip_code, additional_info, additional_info_encrypted)
           VALUES ($1, $2, $3, $4, NULL, $5, NULL, $6, NULL, $7, $8, $9, $10, NULL, $11)
           RETURNING *""",
        data.get("name"),
        phone,
        data.get("timezone", "America/New_York"),
        data.get("interests"),
        encrypt_json(data.get("familyInfo")),
        encrypt(data.get("medicalNotes")),
        encrypt_json(data.get("preferredCallTimes")),
        data.get("city"),
        data.get("state"),
        data.get("zipCode"),
        encrypt(data.get("additionalInfo")),
    )
    logger.info("Created senior: phone={phone}", phone=mask_phone(phone))
    return decrypt_senior_phi(row)


async def update(senior_id: str, data: dict) -> dict | None:
    """Update a senior profile. Returns updated row or None."""
    fields = []
    values = []
    idx = 1

    encrypted_json_fields = {
        "familyInfo": ("family_info", "family_info_encrypted"),
        "preferredCallTimes": ("preferred_call_times", "preferred_call_times_encrypted"),
    }
    encrypted_text_fields = {
        "medicalNotes": ("medical_notes", "medical_notes_encrypted"),
        "additionalInfo": ("additional_info", "additional_info_encrypted"),
    }

    for key, col in [
        ("name", "name"),
        ("phone", "phone"),
        ("timezone", "timezone"),
        ("interests", "interests"),
        ("interest_scores", "interest_scores"),
        ("city", "city"),
        ("state", "state"),
        ("zipCode", "zip_code"),
    ]:
        if key in data:
            val = data[key]
            if key == "phone":
                val = _normalize_phone(val)
            elif key == "interest_scores" and isinstance(val, dict):
                val = json.dumps(val)
            fields.append(f"{col} = ${idx}")
            values.append(val)
            idx += 1

    for key, (plain_col, encrypted_col) in encrypted_json_fields.items():
        if key in data:
            fields.append(f"{plain_col} = NULL")
            fields.append(f"{encrypted_col} = ${idx}")
            values.append(encrypt_json(data.get(key)))
            idx += 1

    for key, (plain_col, encrypted_col) in encrypted_text_fields.items():
        if key in data:
            fields.append(f"{plain_col} = NULL")
            fields.append(f"{encrypted_col} = ${idx}")
            values.append(encrypt(data.get(key)))
            idx += 1

    if not fields:
        return await get_by_id(senior_id)

    fields.append(f"updated_at = NOW()")
    values.append(senior_id)

    sql = f"UPDATE seniors SET {', '.join(fields)} WHERE id = ${idx} RETURNING *"
    row = await query_one(sql, *values)
    return decrypt_senior_phi(row)


async def list_active() -> list[dict]:
    """List all active seniors."""
    rows = await query_many(
        "SELECT id, name, phone, timezone, interests, is_active, city, state"
        " FROM seniors WHERE is_active = true"
    )
    return rows


async def get_by_id(senior_id: str) -> dict | None:
    """Get a senior by ID."""
    row = await query_one("SELECT * FROM seniors WHERE id = $1", senior_id)
    return decrypt_senior_phi(row)


async def deactivate(senior_id: str) -> dict | None:
    """Soft-delete a senior (set is_active = false)."""
    row = await query_one(
        "UPDATE seniors SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING *",
        senior_id,
    )
    return decrypt_senior_phi(row)


# Backward-compatible alias
delete = deactivate


DEFAULT_CALL_SETTINGS = {
    "max_call_minutes": 12,
    "winding_down_minutes": 9,
    "goodbye_delay_seconds": 5.0,
    "greeting_followup_chance": 0.3,
    "memory_decay_half_life_days": 30,
    "max_consecutive_questions": 2,
    "memory_refresh_after_minutes": 5,
}


async def get_call_settings(senior_id: str) -> dict:
    """Get per-senior call settings, with defaults."""
    row = await query_one(
        "SELECT call_settings FROM seniors WHERE id = $1", senior_id
    )
    overrides = (row or {}).get("call_settings") or {}
    if isinstance(overrides, str):
        import json as _json
        try:
            overrides = _json.loads(overrides)
        except Exception:
            overrides = {}
    return {**DEFAULT_CALL_SETTINGS, **overrides}


# ---------------------------------------------------------------------------
# Consent (migration 014 + 019: single-decision model)
# ---------------------------------------------------------------------------

# Single combined consent — see migration 019 / docs/plans/2026-05-24-consent-and-discovery-call-flows.md.
# Legacy values (call_permission / recording_permission) are still valid in
# the DB CHECK for backwards compatibility, but application code only writes
# this value going forward.
CONSENT_TYPE = "call_and_recording"


async def record_consent(
    *,
    senior_id: str,
    granted: bool,
    conversation_id: str | None = None,
    senior_quote: str | None = None,
    captured_by: str = "donna_tool",
) -> dict:
    """Insert a senior_consents row and roll up seniors.consent_status / callable.

    One row per consent call (consent_type='call_and_recording'). Atomic:
    insert + roll-up run in a single transaction. The roll-up is direct:
    granted=true  → consent_status='granted',  callable=true
    granted=false → consent_status='declined', callable=false
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            inserted = await conn.fetchrow(
                """INSERT INTO senior_consents
                     (senior_id, conversation_id, consent_type, granted,
                      senior_quote_encrypted, captured_by)
                   VALUES ($1, $2, $3, $4, $5, $6)
                   RETURNING id, captured_at""",
                senior_id,
                conversation_id,
                CONSENT_TYPE,
                granted,
                encrypt(senior_quote) if senior_quote else None,
                captured_by,
            )

            status = "granted" if granted else "declined"
            callable_flag = granted

            await conn.execute(
                """UPDATE seniors
                   SET consent_status = $1,
                       callable = $2,
                       consent_date = $3,
                       updated_at = NOW()
                   WHERE id = $4""",
                status,
                callable_flag,
                inserted["captured_at"],
                senior_id,
            )

    logger.info(
        "Recorded consent senior={sid} granted={g} → status={st}",
        sid=str(senior_id)[:8],
        g=granted,
        st=status,
    )

    # Fire-and-forget caregiver notification on decline. Bypasses opt-out
    # because a refused consent is a hard stop on service. Runs OUTSIDE the
    # transaction so the audit row is durable even if the notification fails.
    if status == "declined":
        import asyncio as _asyncio
        _asyncio.create_task(_notify_consent_declined(senior_id, granted))

    return {
        "id": str(inserted["id"]),
        "captured_at": inserted["captured_at"],
        "rolled_up_status": status,
        "callable": callable_flag,
    }


async def _notify_consent_declined(
    senior_id: str,
    granted: bool,
) -> None:
    """POST to Node /api/notifications/trigger to email caregivers.

    Mirrors the auth/header pattern used by services.post_call._trigger_caregiver_notification.
    Logged on failure but never raised — the consent audit row is the source
    of truth and must not be coupled to notification delivery.
    """
    import os
    import httpx

    node_url = os.environ.get("NODE_API_URL")
    if not node_url:
        logger.warning("consent_declined: NODE_API_URL not set, skipping notification")
        return

    from config import get_service_api_key
    api_key = get_service_api_key("pipecat") or get_service_api_key("notifications") or ""
    if not api_key:
        logger.warning("consent_declined: no service api key, skipping notification")
        return

    headers = {"X-API-Key": api_key, "Content-Type": "application/json"}
    payload = {
        "event_type": "consent_declined",
        "senior_id": str(senior_id),
        "data": {
            "consent_type": CONSENT_TYPE,
            "granted": granted,
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{node_url}/api/notifications/trigger",
                json=payload,
                headers=headers,
            )
            response.raise_for_status()
            logger.info(
                "consent_declined notification dispatched senior={sid} status={st}",
                sid=str(senior_id)[:8],
                st=response.status_code,
            )
    except Exception as exc:
        logger.error(
            "consent_declined notification failed senior={sid}: {err}",
            sid=str(senior_id)[:8],
            err=str(exc),
        )


async def get_consent_status(senior_id: str) -> dict:
    """Return the latest consent state for a senior. PHI-free (no quotes)."""
    row = await query_one(
        """SELECT consent_status, consent_date, callable, is_active
           FROM seniors WHERE id = $1""",
        senior_id,
    )
    if not row:
        return {"consent_status": "pending", "callable": True, "is_active": False}
    latest = await query_one(
        """SELECT consent_type, granted, captured_at
           FROM senior_consents
           WHERE senior_id = $1
           ORDER BY captured_at DESC
           LIMIT 1""",
        senior_id,
    )
    return {
        "consent_status": row["consent_status"],
        "consent_date": row["consent_date"],
        "callable": row["callable"],
        "is_active": row["is_active"],
        "latest_consent": dict(latest) if latest else None,
    }
