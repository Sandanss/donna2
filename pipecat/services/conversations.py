"""Conversation history service.

Port of services/conversations.js — CRUD for call records + summary/transcript retrieval.
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone, timedelta
from loguru import logger
from db import query_one, query_many, execute
from lib.encryption import encrypt, decrypt, encrypt_json, decrypt_json
from services.time_context import format_call_time_label


async def create(senior_id: str | None, call_sid: str, prospect_id: str | None = None, direction: str | None = None) -> dict:
    """Create a new conversation record.

    Pass senior_id for subscriber calls, prospect_id for onboarding calls.
    """
    row = await query_one(
        """INSERT INTO conversations (senior_id, prospect_id, call_sid, started_at, status, direction)
           VALUES ($1, $2, $3, $4, 'in_progress', $5)
           RETURNING *""",
        senior_id,
        prospect_id,
        call_sid,
        datetime.now(timezone.utc).replace(tzinfo=None),
        direction,
    )
    logger.info("Created conversation {id} callSid={cs}", id=row["id"], cs=call_sid)
    return row


async def complete(call_sid: str, data: dict) -> dict | None:
    """Update a conversation when a call ends.

    Accepts snake_case keys: duration_seconds, status, summary, transcript,
    transcript_text, call_metrics, sentiment, concerns, amd_result,
    goodbye_detected_at, end_reason.

    Writes encrypted structured JSON and encrypted text transcript columns.
    The legacy plaintext transcript column remains read-only fallback for rows
    written before field encryption was available.
    """
    transcript = data.get("transcript")
    transcript_text = data.get("transcript_text") or format_transcript_text(transcript)
    summary_raw = data.get("summary")
    row = await query_one(
        """UPDATE conversations SET
             ended_at = NOW(),
             duration_seconds = $1,
             status = $2,
             summary = NULL,
             call_metrics = $3,
             sentiment = $4,
             concerns = NULL,
             summary_encrypted = $5,
             transcript_encrypted = $6,
             transcript_text_encrypted = $7,
             amd_result = COALESCE($9, amd_result),
             goodbye_detected_at = COALESCE($10, goodbye_detected_at),
             end_reason = COALESCE($11, end_reason)
           WHERE call_sid = $8
           RETURNING *""",
        data.get("duration_seconds"),
        data.get("status", "completed"),
        json.dumps(data["call_metrics"]) if data.get("call_metrics") else None,
        data.get("sentiment"),
        encrypt(summary_raw),
        encrypt_json(transcript) if transcript else None,
        encrypt(transcript_text),
        call_sid,
        data.get("amd_result"),
        data.get("goodbye_detected_at"),
        data.get("end_reason"),
    )
    if row:
        logger.info("Completed conversation {id} ({dur}s)", id=row["id"], dur=data.get("duration_seconds"))
    return row


def _content_to_text(content) -> str:
    """Convert Pipecat/OpenAI-style content blocks to plain text."""
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = str(block.get("text") or "")
                if text.startswith("[EPHEMERAL") or text.startswith("[Internal"):
                    continue
                parts.append(text)
        return " ".join(parts)
    return str(content)


def format_transcript_text(transcript) -> str | None:
    """Format a transcript as readable text for encrypted storage/analysis."""
    if transcript is None:
        return None
    if isinstance(transcript, str):
        text = transcript.strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text
        return format_transcript_text(parsed)
    if not isinstance(transcript, list):
        text = str(transcript).strip()
        return text or None

    lines: list[str] = []
    for turn in transcript:
        if not isinstance(turn, dict):
            continue
        text = _content_to_text(turn.get("content")).strip()
        if not text or text.startswith("[EPHEMERAL") or text.startswith("[Internal"):
            continue
        role = str(turn.get("role") or "unknown").lower()
        if role == "assistant":
            label = "Donna"
        elif role == "user":
            label = "Senior"
        else:
            label = role.title()
        lines.append(f"{label}: {text}")
    return "\n".join(lines) if lines else None


def _parse_transcript(value):
    """Normalize stored JSON transcript values into list/string form."""
    if value is None:
        return None
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text
    return value


async def update_transcript(call_sid: str, transcript: list[dict]) -> dict | None:
    """Persist the latest in-call transcript snapshot without completing call.

    Draft writes intentionally update encrypted transcript fields only. The
    legacy plaintext JSON column is read-only fallback for pre-encryption rows.
    """
    if not call_sid or not transcript:
        return None

    transcript_text = format_transcript_text(transcript)
    row = await query_one(
        """UPDATE conversations SET
             transcript_encrypted = $1,
             transcript_text_encrypted = $2
           WHERE call_sid = $3
           RETURNING id, call_sid""",
        encrypt_json(transcript),
        encrypt(transcript_text),
        call_sid,
    )
    if row:
        logger.info(
            "Updated transcript draft callSid={cs} turns={turns} text_chars={chars}",
            cs=call_sid,
            turns=len(transcript),
            chars=len(transcript_text or ""),
        )
    return row


async def get_transcript_by_call_sid(call_sid: str):
    """Fetch a persisted transcript for post-call fallback/retrieval.

    Prefers encrypted structured JSON, then legacy JSON, then encrypted text.
    """
    row = await query_one(
        """SELECT transcript, transcript_encrypted, transcript_text_encrypted
           FROM conversations WHERE call_sid = $1""",
        call_sid,
    )
    if not row:
        return None

    encrypted_transcript = row.get("transcript_encrypted")
    if encrypted_transcript:
        parsed = _parse_transcript(decrypt_json(encrypted_transcript))
        if parsed:
            return parsed

    parsed = _parse_transcript(row.get("transcript"))
    if parsed:
        return parsed

    encrypted_text = row.get("transcript_text_encrypted")
    if encrypted_text:
        text = decrypt(encrypted_text)
        if text and text != "[encrypted]":
            return text

    return None


async def get_by_call_sid(call_sid: str) -> dict | None:
    """Get a conversation by provider call id."""
    return await query_one(
        """SELECT id, senior_id, call_sid, started_at, ended_at,
                  duration_seconds, status, summary, sentiment, concerns
           FROM conversations WHERE call_sid = $1""",
        call_sid,
    )


async def get_for_senior(senior_id: str, limit: int = 10) -> list[dict]:
    """Get recent conversations for a senior."""
    return await query_many(
        """SELECT id, senior_id, call_sid, started_at, ended_at,
                  duration_seconds, status, summary, sentiment, concerns
           FROM conversations WHERE senior_id = $1 ORDER BY started_at DESC LIMIT $2""",
        senior_id,
        limit,
    )


async def update_summary(
    call_sid: str, summary: str, sentiment: str | None = None
) -> dict | None:
    """Update conversation summary and optional sentiment after post-call analysis."""
    try:
        row = await query_one(
            """UPDATE conversations
               SET summary = NULL,
                   summary_encrypted = $1,
                   sentiment = COALESCE($2, sentiment)
               WHERE call_sid = $3
               RETURNING *""",
            encrypt(summary),
            sentiment,
            call_sid,
        )
        if row:
            logger.info("Updated summary for callSid={cs}", cs=call_sid)
        return row
    except Exception as e:
        logger.error("Error updating summary: {err}", err=str(e))
        return None


async def update_sentiment(call_sid: str, sentiment: str) -> dict | None:
    """Set conversations.sentiment without touching summary or other fields.

    Used by the post-call analysis fallback path: when the analysis provider
    fails or returns unparseable structured output, we fall back to
    _get_default_analysis() which
    yields sentiment='neutral'. We still want the conversation row to
    reflect that we attempted analysis, so this writes ONLY sentiment.
    """
    try:
        row = await query_one(
            """UPDATE conversations
               SET sentiment = COALESCE($1, sentiment)
               WHERE call_sid = $2
               RETURNING id""",
            sentiment,
            call_sid,
        )
        return row
    except Exception as e:
        logger.error("Error updating sentiment: {err}", err=str(e))
        return None


async def get_recent_summaries(
    senior_id: str,
    limit: int = 3,
    timezone_name: str = "America/New_York",
) -> str | None:
    """Get recent call summaries formatted as a context string."""
    rows = await query_many(
        """SELECT summary, summary_encrypted, started_at, duration_seconds
           FROM conversations
           WHERE senior_id = $1
             AND status = 'completed'
             AND (summary IS NOT NULL OR summary_encrypted IS NOT NULL)
             AND (COALESCE(summary, '') != '' OR summary_encrypted IS NOT NULL)
           ORDER BY started_at DESC
           LIMIT $2""",
        senior_id,
        limit,
    )
    if not rows:
        return None

    now = datetime.now(timezone.utc)
    lines = []
    for row in rows:
        started_at = row["started_at"]
        time_ago = format_call_time_label(started_at, timezone_name, now=now)
        duration = f"({round(row['duration_seconds'] / 60)} min)" if row.get("duration_seconds") else ""
        summary = decrypt(row.get("summary_encrypted")) if row.get("summary_encrypted") else row.get("summary")
        if summary and summary != "[encrypted]":
            lines.append(f"- {time_ago} {duration}: {summary}")

    return "\n".join(lines) if lines else None


async def get_recent_turns(
    senior_id: str,
    max_calls: int = 3,
    turns_per_call: int = 7,
    max_turns: int = 20,
    timezone_name: str = "America/New_York",
) -> str | None:
    """Get recent turns from previous calls as formatted text for system prompt.

    Pulls the last `max_calls` completed calls with transcripts, takes the last
    `turns_per_call` turns from each, and formats them with time labels.
    Returns None if no history found.
    """
    rows = await query_many(
        """SELECT transcript, transcript_encrypted, started_at, duration_seconds
           FROM conversations
           WHERE senior_id = $1
             AND status = 'completed'
             AND (transcript IS NOT NULL OR transcript_encrypted IS NOT NULL)
           ORDER BY started_at DESC
           LIMIT $2""",
        senior_id,
        max_calls,
    )
    if not rows:
        return None

    now = datetime.now(timezone.utc)
    sections: list[str] = []
    total_turns = 0

    for row in rows:
        try:
            # Prefer encrypted column, fall back to original
            if row.get("transcript_encrypted"):
                transcript = decrypt_json(row["transcript_encrypted"])
            else:
                transcript = row["transcript"]
            if isinstance(transcript, str):
                transcript = json.loads(transcript)
            if not isinstance(transcript, list) or not transcript:
                continue

            # Take last N turns from this call
            recent = transcript[-turns_per_call:]

            started_at = row["started_at"]
            time_label = format_call_time_label(started_at, timezone_name, now=now)

            duration = row.get("duration_seconds")
            dur_str = f" ({math.ceil(duration / 60)} min)" if duration else ""

            lines: list[str] = [f"[{time_label}{dur_str}]"]
            for turn in recent:
                if not isinstance(turn, dict):
                    continue
                role = turn.get("role", "unknown")
                content = turn.get("content", "").strip()
                if not content:
                    continue
                speaker = "Donna" if role == "assistant" else "Senior"
                lines.append(f"  {speaker}: {content}")
                total_turns += 1

            if len(lines) > 1:  # has at least one turn beyond the header
                sections.append("\n".join(lines))
        except Exception:
            continue

        if total_turns >= max_turns:
            break

    if not sections:
        return None

    header = "RECENT CONVERSATIONS (from previous calls):"
    footer = "(Reference these naturally — show you remember without repeating exactly.)"
    return f"{header}\n" + "\n".join(sections) + f"\n{footer}"


async def get_recent_history(senior_id: str, message_limit: int = 6) -> list[dict]:
    """Legacy: get recent conversation messages for context."""
    rows = await query_many(
        """SELECT transcript, transcript_encrypted, started_at
           FROM conversations
           WHERE senior_id = $1
             AND status = 'completed'
             AND (transcript IS NOT NULL OR transcript_encrypted IS NOT NULL)
           ORDER BY started_at DESC
           LIMIT 2""",
        senior_id,
    )
    if not rows:
        return []

    all_messages: list[dict] = []
    for row in rows:
        try:
            if row.get("transcript_encrypted"):
                transcript = decrypt_json(row["transcript_encrypted"])
            else:
                transcript = row["transcript"]
            if isinstance(transcript, str):
                transcript = json.loads(transcript)
            if isinstance(transcript, list):
                msgs = [
                    {"role": m["role"], "content": m["content"], "fromPreviousCall": True}
                    for m in transcript[-4:]
                ]
                all_messages.extend(msgs)
        except Exception:
            pass

    return all_messages[-message_limit:]


async def get_recent(limit: int = 20) -> list[dict]:
    """Get all recent conversations with senior names (admin view)."""
    return await query_many(
        """SELECT c.*, s.name AS senior_name
           FROM conversations c
           LEFT JOIN seniors s ON c.senior_id = s.id
           ORDER BY c.started_at DESC
           LIMIT $1""",
        limit,
    )


async def save_profile_suggestions(conversation_id: str, payload: dict) -> dict | None:
    """Write the discovery-call profile_suggestions payload to conversations.

    Caregiver-review surface reads this column. See migration 015 / docs/plans/
    2026-05-24-consent-and-discovery-call-flows.md.
    """
    if not conversation_id:
        return None
    row = await query_one(
        """UPDATE conversations
           SET profile_suggestions = $1::jsonb
           WHERE id = $2
           RETURNING id, profile_suggestions""",
        json.dumps(payload),
        conversation_id,
    )
    return row
