"""Prospect service — CRUD for unsubscribed callers.

Tracks callers whose phone number is not in the seniors table.
Stores learned info across calls so return callers can be recognized.
"""

from __future__ import annotations

import json
import os
import re

from loguru import logger
from db import query_one, execute
from lib.encryption import encrypt_json
from lib.phi import decrypt_prospect_phi, prospect_details


def _normalize_phone(phone: str) -> str:
    """Keep last 10 digits of a phone number."""
    digits = re.sub(r"\D", "", phone)
    return digits[-10:]


async def find_by_phone(phone: str) -> dict | None:
    """Find a prospect by phone number (normalized to last 10 digits)."""
    normalized = _normalize_phone(phone)
    row = await query_one("SELECT * FROM prospects WHERE phone = $1", normalized)
    return decrypt_prospect_phi(row)


async def create(phone: str) -> dict:
    """Create a new prospect record for a first-time unsubscribed caller."""
    normalized = _normalize_phone(phone)
    row = await query_one(
        """INSERT INTO prospects (phone)
           VALUES ($1)
           ON CONFLICT (phone) DO UPDATE SET last_call_at = NOW()
           RETURNING *""",
        normalized,
    )
    logger.info("Created/found prospect")
    return decrypt_prospect_phi(row)


async def update_after_call(prospect_id: str, data: dict) -> None:
    """Update prospect record after a call completes.

    Args:
        prospect_id: UUID of the prospect.
        data: Dict with optional keys: learned_name, relationship,
              loved_one_name, caller_context (dict to merge).
    """
    existing = await query_one("SELECT * FROM prospects WHERE id = $1", prospect_id)
    details = prospect_details(existing)

    for key in ("learned_name", "relationship", "loved_one_name"):
        if data.get(key):
            details[key] = data[key]

    current_context = details.get("caller_context") or {}
    if data.get("caller_context"):
        current_context = {**current_context, **data["caller_context"]}
    details["caller_context"] = current_context

    await execute(
        """UPDATE prospects SET
             call_count = call_count + 1,
             last_call_at = NOW(),
             updated_at = NOW(),
             learned_name = NULL,
             relationship = NULL,
             loved_one_name = NULL,
             caller_context = '{}'::jsonb,
             details_encrypted = $1
           WHERE id = $2""",
        encrypt_json(details),
        prospect_id,
    )
    logger.info("Updated prospect after call")


def _clean_extracted_list(value) -> list[str]:
    if not isinstance(value, list):
        return []
    cleaned = []
    for item in value:
        if not isinstance(item, str):
            continue
        text = item.strip()
        if text:
            cleaned.append(text[:300])
    return cleaned[:10]


def _clean_extracted_details(data: dict) -> dict:
    """Keep only expected prospect fields and compact non-empty values."""
    cleaned: dict = {}

    for key in ("learned_name", "relationship", "loved_one_name"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            cleaned[key] = value.strip()[:120]

    caller_context = data.get("caller_context")
    if isinstance(caller_context, dict):
        ctx = {}
        for key in ("interests", "concerns", "context"):
            values = _clean_extracted_list(caller_context.get(key))
            if values:
                ctx[key] = values
        if ctx:
            cleaned["caller_context"] = ctx

    return cleaned


async def extract_prospect_details(transcript: str) -> dict:
    """Extract structured prospect details from a new customer transcript."""
    if not transcript or len(transcript.strip()) < 50:
        return {}

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("extract_prospect_details: OPENAI_API_KEY not set")
        return {}

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=api_key)
        prompt = (
            "Analyze this new customer phone conversation between Donna, an AI "
            "companion service for seniors, and a prospective caller. Extract "
            "only details clearly stated in the conversation.\n\n"
            f"Conversation:\n{transcript}\n\n"
            "Return JSON with this shape:\n"
            "{\n"
            '  "learned_name": "caller first name, or null",\n'
            '  "relationship": "relationship to the senior, or null",\n'
            '  "loved_one_name": "senior name, or null",\n'
            '  "caller_context": {\n'
            '    "interests": ["senior interests or hobbies"],\n'
            '    "concerns": ["caller concerns about the senior"],\n'
            '    "context": ["other concise useful details"]\n'
            "  }\n"
            "}\n\n"
            "Use null or empty arrays for anything not mentioned. Keep values concise."
        )

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content or "{}"
        result = json.loads(content)
        if not isinstance(result, dict):
            return {}
        return _clean_extracted_details(result)
    except Exception as e:
        logger.error("extract_prospect_details failed: {err}", err=str(e))
        return {}


def build_context_for_prompt(prospect: dict) -> str:
    """Format prospect data into context string for the new customer system prompt."""
    prospect = decrypt_prospect_phi(prospect) or {}
    parts: list[str] = []

    call_count = prospect.get("call_count", 0)
    name = prospect.get("learned_name")
    relationship = prospect.get("relationship")
    loved_one = prospect.get("loved_one_name")
    ctx = prospect.get("caller_context") or {}
    if isinstance(ctx, str):
        import json as _json
        try:
            ctx = _json.loads(ctx)
        except (ValueError, TypeError):
            ctx = {}

    if call_count > 0 and name:
        parts.append(f"RETURN CALLER: You have spoken with {name} before ({call_count} previous call{'s' if call_count != 1 else ''}).")
        if relationship:
            parts.append(f"They are a {relationship}.")
        if loved_one:
            parts.append(f"They are calling about {loved_one}.")
        call_summary = ctx.get("call_summary")
        if call_summary:
            parts.append(f"Last conversation: {call_summary}")
    else:
        parts.append("NEW CALLER: This is an unsubscribed caller you have not spoken with before.")

    return "\n".join(parts)
