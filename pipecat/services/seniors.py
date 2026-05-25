"""Senior profile service.

Port of services/seniors.js — CRUD operations for senior profiles.
"""

from __future__ import annotations

import json
import re
from loguru import logger
from db import query_one, query_many, execute
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
                  preferred_call_times, is_active,
                  preferred_call_times_encrypted,
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
           VALUES ($1, $2, $3, $4, NULL, $5, NULL, NULL, NULL, $6, $7, $8, $9, NULL, $10)
           RETURNING *""",
        data.get("name"),
        phone,
        data.get("timezone", "America/New_York"),
        data.get("interests"),
        encrypt_json(data.get("familyInfo")),
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
