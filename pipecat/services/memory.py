"""Memory service with pgvector semantic search.

Port of services/memory.js — stores, searches, and builds context from memories.
Uses OpenAI text-embedding-3-small for embeddings, pgvector for similarity search.
"""

from __future__ import annotations

import json
import math
import os
import re
from datetime import datetime, timezone
from loguru import logger

from lib.circuit_breaker import CircuitBreaker
from lib.encryption import encrypt, decrypt
from services.time_context import format_call_time_label, format_local_datetime

_embedding_breaker = CircuitBreaker("openai_embedding", failure_threshold=3, recovery_timeout=60.0, call_timeout=10.0)

_openai_client = None

DECAY_HALF_LIFE_DAYS = 30
ACCESS_BOOST = 10
MAX_IMPORTANCE = 100
ALLOWED_MEMORY_TYPES = {"fact", "preference", "event", "relationship", "family", "interest", "routine"}
_TEMPORAL_REFERENCE_RE = re.compile(
    r"\b(today|tomorrow|yesterday|tonight|this morning|this afternoon|this evening|"
    r"next (day|week|month|time)|last (night|week|month)|later today|upcoming)\b",
    re.IGNORECASE,
)


def _memory_owner_target(
    senior_id: str | None,
    prospect_id: str | None,
) -> tuple[str, str, str] | None:
    """Return the physical memory table and owner predicate for this owner."""
    if senior_id:
        return ("memories", "senior_id", senior_id)
    if prospect_id:
        return ("prospect_memories", "prospect_id", prospect_id)
    return None


def _get_openai():
    global _openai_client
    if _openai_client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            logger.warning("OPENAI_API_KEY not set — memory features disabled")
            return None
        from openai import AsyncOpenAI
        _openai_client = AsyncOpenAI(api_key=api_key)
    return _openai_client


def _calculate_effective_importance(
    base_importance: int,
    created_at: datetime,
    last_accessed_at: datetime | None,
    decay_half_life_days: int = DECAY_HALF_LIFE_DAYS,
) -> int:
    """Apply exponential decay + recent-access boost."""
    now = datetime.now(timezone.utc)
    # Normalize DB datetimes to aware UTC for safe subtraction
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    age_days = (now - created_at).total_seconds() / 86400
    decay_factor = math.pow(0.5, age_days / decay_half_life_days)
    effective = base_importance * decay_factor

    if last_accessed_at:
        if last_accessed_at.tzinfo is None:
            last_accessed_at = last_accessed_at.replace(tzinfo=timezone.utc)
        days_since_access = (now - last_accessed_at).total_seconds() / 86400
        if days_since_access < 7:
            effective = min(MAX_IMPORTANCE, effective + ACCESS_BOOST * (1 - days_since_access / 7))

    return round(effective)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def generate_embedding(text: str) -> list[float] | None:
    """Generate an embedding vector using OpenAI text-embedding-3-small."""
    client = _get_openai()
    if client is None:
        return None

    async def _embed():
        response = await client.embeddings.create(model="text-embedding-3-small", input=text)
        return response.data[0].embedding

    return await _embedding_breaker.call(_embed(), fallback=None)


async def store(
    senior_id: str | None,
    type_: str,
    content: str,
    source: str | None = None,
    importance: int = 50,
    metadata: dict | None = None,
    prospect_id: str | None = None,
) -> dict | None:
    """Store a memory with deduplication (cosine similarity > 0.9 = duplicate).

    Pass senior_id for subscriber memories, prospect_id for onboarding caller memories.
    """
    from db import query_one, query_many

    owner_target = _memory_owner_target(senior_id, prospect_id)
    if not owner_target:
        logger.warning("store() called with no senior_id or prospect_id")
        return None
    table, owner_col, owner_id = owner_target

    embedding = await generate_embedding(content)
    if embedding is None:
        logger.info("Skipping store — OpenAI not configured")
        return None

    emb_str = json.dumps(embedding)

    # Dedup check
    dupes = await query_many(
        f"""SELECT id, content, importance,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM {table}
           WHERE {owner_col} = $2
             AND 1 - (embedding <=> $1::vector) > 0.9
           ORDER BY similarity DESC
           LIMIT 1""",
        emb_str,
        owner_id,
    )

    if dupes:
        existing = dupes[0]
        logger.info(
            "Dedup: similar to existing ({sim}%)",
            sim=round(existing["similarity"] * 100),
        )
        if importance > existing["importance"]:
            await query_one(
                f"""UPDATE {table}
                   SET importance = $1, last_accessed_at = NOW()
                   WHERE {owner_col} = $2 AND id = $3""",
                importance,
                owner_id,
                existing["id"],
            )
            logger.info("Updated importance {old} -> {new}", old=existing["importance"], new=importance)
        return None

    row = await query_one(
        f"""INSERT INTO {table} ({owner_col}, type, content, content_encrypted, source, importance, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector, ($8::text)::json)
           RETURNING *""",
        owner_id,
        type_,
        "[encrypted]",
        encrypt(content),
        source,
        importance,
        emb_str,
        json.dumps(metadata) if metadata else None,
    )
    logger.info(
        "Stored memory for {col}={sid} type={type} chars={chars}",
        col=owner_col,
        sid=str(owner_id)[:8],
        type=type_,
        chars=len(content),
    )
    return row


async def search(
    senior_id: str | None, query: str, limit: int = 5, min_similarity: float = 0.45,
    prospect_id: str | None = None,
    track_access: bool = True,
) -> list[dict]:
    """Semantic search — find memories similar to *query*.

    Pass senior_id for subscriber memories, prospect_id for onboarding caller memories.
    Set track_access=False for speculative searches that may never be shown.
    """
    from db import query_many

    owner_target = _memory_owner_target(senior_id, prospect_id)
    if not owner_target:
        return []
    table, owner_col, owner_id = owner_target

    query_embedding = await generate_embedding(query)
    if query_embedding is None:
        return []

    emb_str = json.dumps(query_embedding)

    rows = await query_many(
        f"""SELECT id, type, content, content_encrypted, importance, metadata, created_at,
                  1 - (embedding <=> $1::vector) AS similarity
           FROM {table}
           WHERE {owner_col} = $2
             AND 1 - (embedding <=> $1::vector) > $3
           ORDER BY embedding <=> $1::vector
           LIMIT $4""",
        emb_str,
        owner_id,
        min_similarity,
        limit,
    )

    if rows and track_access:
        await _mark_accessed_for_owner(table, owner_col, owner_id, [r["id"] for r in rows])

    # Decrypt content: prefer encrypted column, fall back to original
    for r in rows:
        if r.get("content_encrypted"):
            r["content"] = decrypt(r["content_encrypted"])
        r.pop("content_encrypted", None)

    return rows


async def _mark_accessed_for_owner(
    table: str,
    owner_col: str,
    owner_id: str,
    memory_ids: list[str],
) -> int:
    """Update last_accessed_at using the owner key so partition pruning works."""
    from db import execute

    unique_ids = [mid for mid in dict.fromkeys(memory_ids or []) if mid]
    if not unique_ids:
        return 0

    placeholders = ", ".join(f"${i+2}" for i in range(len(unique_ids)))
    await execute(
        f"""UPDATE {table}
           SET last_accessed_at = NOW()
           WHERE {owner_col} = $1 AND id IN ({placeholders})""",
        owner_id,
        *unique_ids,
    )
    return len(unique_ids)


async def mark_accessed(memory_ids: list[str]) -> int:
    """Update last_accessed_at for memories that were actually used."""
    from db import execute

    unique_ids = [mid for mid in dict.fromkeys(memory_ids or []) if mid]
    if not unique_ids:
        return 0

    placeholders = ", ".join(f"${i+1}" for i in range(len(unique_ids)))
    await execute(
        f"UPDATE memories SET last_accessed_at = NOW() WHERE id IN ({placeholders})",
        *unique_ids,
    )
    return len(unique_ids)


async def get_recent(senior_id: str, limit: int = 10) -> list[dict]:
    """Get the most recent memories for a senior."""
    from db import query_many

    rows = await query_many(
        """SELECT id, type, content, content_encrypted, importance, metadata, created_at, last_accessed_at
           FROM memories WHERE senior_id = $1 ORDER BY created_at DESC LIMIT $2""",
        senior_id,
        limit,
    )
    for r in rows:
        if r.get("content_encrypted"):
            r["content"] = decrypt(r["content_encrypted"])
        r.pop("content_encrypted", None)
    return rows


async def get_important(senior_id: str, limit: int = 5) -> list[dict]:
    """Get important memories with decay applied."""
    from db import query_many

    rows = await query_many(
        """SELECT id, type, content, content_encrypted, importance, metadata, created_at, last_accessed_at
           FROM memories
           WHERE senior_id = $1 AND importance >= 50
           ORDER BY importance DESC
           LIMIT $2""",
        senior_id,
        limit * 3,
    )

    for r in rows:
        if r.get("content_encrypted"):
            r["content"] = decrypt(r["content_encrypted"])
        r.pop("content_encrypted", None)

    with_effective = []
    for m in rows:
        eff = _calculate_effective_importance(
            m["importance"], m["created_at"], m.get("last_accessed_at")
        )
        if eff >= 50:
            with_effective.append({**m, "effective_importance": eff})

    with_effective.sort(key=lambda m: m["effective_importance"], reverse=True)
    return with_effective[:limit]


async def get_critical(senior_id: str, limit: int = 3) -> list[dict]:
    """Tier 1: high-importance memories."""
    from db import query_many

    rows = await query_many(
        """SELECT id, type, content, content_encrypted, importance, metadata, created_at, last_accessed_at
           FROM memories
           WHERE senior_id = $1
             AND importance >= 80
           ORDER BY importance DESC
           LIMIT $2""",
        senior_id,
        limit,
    )
    for r in rows:
        if r.get("content_encrypted"):
            r["content"] = decrypt(r["content_encrypted"])
        r.pop("content_encrypted", None)
    return rows


def group_by_type(memories_list: list[dict]) -> dict[str, list[str]]:
    """Group memories by type for compact display."""
    groups: dict[str, list[str]] = {}
    for m in memories_list:
        t = m.get("type") or "fact"
        groups.setdefault(t, []).append(m["content"])
    return groups


def format_grouped_memories(groups: dict[str, list[str]]) -> str:
    """Format grouped memories compactly."""
    type_labels = {
        "relationship": "Family/Friends",
        "family": "Family/Friends",
        "preference": "Preferences",
        "event": "Recent events",
        "interest": "Interests",
        "routine": "Routines",
        "concern": "Concerns",
        "fact": "Facts",
    }
    lines = []
    for t, contents in groups.items():
        label = type_labels.get(t, t)
        sep = "; " if t == "relationship" else ", "
        lines.append(f"{label}: {sep.join(contents)}")
    return "\n".join(lines)


def format_memory_for_context(memory: dict, timezone_name: str = "America/New_York") -> str:
    """Return memory content with a recorded-time anchor when it uses relative time."""
    content = memory.get("content") or ""
    if not content:
        return ""
    if _TEMPORAL_REFERENCE_RE.search(content):
        label = format_call_time_label(memory.get("created_at"), timezone_name)
        if label != "previous call":
            return f"{content} (recorded {label})"
    return content


async def build_context(
    senior_id: str,
    current_topic: str | None = None,
    senior: dict | None = None,
    is_first_turn: bool = True,
) -> str:
    """Build memory context for the system prompt.

    Loads top memories by effective importance - enough to feel personal without
    duplicating recent turns/summaries that are already in the prompt.
    Speculative prefetch fills in the rest mid-conversation.
    """
    from db import query_many

    parts: list[str] = []

    # Pull a slightly wider candidate set, then rank with decay/access boosts.
    all_memories = await query_many(
        """SELECT id, type, content, content_encrypted, importance, metadata, created_at, last_accessed_at
           FROM memories
           WHERE senior_id = $1
           ORDER BY importance DESC, created_at DESC
           LIMIT 50""",
        senior_id,
    )

    for r in all_memories:
        if r.get("content_encrypted"):
            r["content"] = decrypt(r["content_encrypted"])
        r.pop("content_encrypted", None)
        r["effective_importance"] = _calculate_effective_importance(
            r.get("importance", 50),
            r.get("created_at"),
            r.get("last_accessed_at"),
        )

    def _created_sort_value(memory: dict) -> float:
        created = memory.get("created_at")
        if isinstance(created, datetime):
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            return created.timestamp()
        return 0.0

    all_memories.sort(
        key=lambda m: (m.get("effective_importance", 0), _created_sort_value(m)),
        reverse=True,
    )
    all_memories = all_memories[:20]

    logger.info(
        "build_context({sid}): loaded {n} memories",
        sid=str(senior_id)[:8], n=len(all_memories),
    )

    if not all_memories:
        return ""

    timezone_name = (senior or {}).get("timezone") or "America/New_York"
    for memory in all_memories:
        memory["content"] = format_memory_for_context(memory, timezone_name)

    # Group by type for readable presentation
    groups = group_by_type(all_memories)
    formatted = format_grouped_memories(groups)
    parts.append(f"What you know about them:\n{formatted}")

    result = "\n".join(parts)
    logger.info(
        "build_context({sid}): total={n} chars, {m} memories",
        sid=str(senior_id)[:8], n=len(result), m=len(all_memories),
    )
    return result


async def refresh_context(senior_id: str, current_topics: list[str]) -> str | None:
    """Refresh memory context mid-call, prioritized by current conversation topics.

    Called by ConversationDirector for calls >5 minutes.
    """
    parts: list[str] = []
    included_ids: set[str] = set()

    # Topic-relevant memories first
    for topic in current_topics[:3]:
        relevant = await search(senior_id, topic, 3, 0.45)
        for m in relevant:
            if m["id"] not in included_ids:
                parts.append(f"- {format_memory_for_context(m)}")
                included_ids.add(m["id"])

    # Then critical (always)
    critical = await get_critical(senior_id, 3)
    for m in critical:
        if m["id"] not in included_ids:
            parts.append(f"- {format_memory_for_context(m)}")
            included_ids.add(m["id"])

    logger.info("refresh_context({sid}): {n} memories for {t} topics",
                sid=str(senior_id)[:8], n=len(parts), t=len(current_topics))
    return "\n".join(parts) if parts else None


async def transfer_to_senior(prospect_id: str, senior_id: str) -> int:
    """Transfer all prospect memories to a senior (on conversion).

    Returns the number of memories transferred.
    """
    from db import get_pool

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                "SELECT id FROM prospect_memories WHERE prospect_id = $1",
                prospect_id,
            )
            if not rows:
                return 0
            await conn.execute(
                """INSERT INTO memories
                   (id, senior_id, type, content, content_encrypted, source,
                    importance, embedding, metadata, created_at, last_accessed_at)
                   SELECT id, $1, type, content, content_encrypted, source,
                          importance, embedding, metadata, created_at, last_accessed_at
                   FROM prospect_memories
                   WHERE prospect_id = $2
                   ON CONFLICT (senior_id, id) DO NOTHING""",
                senior_id,
                prospect_id,
            )
            await conn.execute(
                "DELETE FROM prospect_memories WHERE prospect_id = $1",
                prospect_id,
            )
    logger.info(
        "Transferred {n} memories from prospect {pid} to senior {sid}",
        n=len(rows),
        pid=str(prospect_id)[:8],
        sid=str(senior_id)[:8],
    )
    return len(rows)


async def extract_from_conversation(
    senior_id: str | None, transcript: str, conversation_id: str,
    prospect_id: str | None = None,
    call_started_at=None,
    timezone_name: str = "America/New_York",
) -> None:
    """Extract and store memories from a conversation transcript via OpenAI."""
    owner_id = senior_id or prospect_id
    logger.info("extract_from_conversation: transcript_len={n}", n=len(transcript) if transcript else 0)
    client = _get_openai()
    if client is None:
        logger.warning("Skipping extraction — OPENAI_API_KEY not set")
        return

    call_datetime = format_local_datetime(call_started_at, timezone_name) or "Unknown"
    prompt = (
        "Analyze this conversation between Donna (AI companion) and an elderly person. "
        "Extract important memories that will help personalize future calls. "
        "Do not extract medical, health, safety, or care concerns; Donna is a companion product, not a medical monitoring product.\n\n"
        f"Call date/time: {call_datetime}\n\n"
        f"Conversation:\n{transcript}\n\n"
        'Respond with a json object in this format:\n{{"memories": [\n  {{"type": "fact|preference|event|relationship|family|interest|routine", '
        '"content": "...", "importance": 50-100}}\n]}}\n\n'
        "CRITICAL — write RICH, DETAILED content strings that will match semantic search:\n"
        "- BAD: \"User may enjoy playing padel\" (too vague, won't match searches)\n"
        "- GOOD: \"Enjoys playing padel (paddle tennis) regularly as a sport and hobby\"\n"
        "- BAD: \"User is working on a project\" (useless)\n"
        "- GOOD: \"Building an AI companion called Donna that makes phone calls to elderly people\"\n\n"
        "Each memory should:\n"
        "- Include specific names, places, activities, and context\n"
        "- Use synonyms and related terms (helps semantic matching)\n"
        "- Be a complete sentence that stands alone without conversation context\n"
        "- Reference the person naturally (e.g., \"Has a grandson named Jake who plays baseball\")\n\n"
        "TEMPORAL GROUNDING:\n"
        "- Resolve relative dates against the call date/time above.\n"
        "- If they say \"tomorrow\", store it as an upcoming plan with the actual date, not as something already done.\n"
        "- If they say they are postponing something, preserve that it is planned for the future.\n"
        "- Avoid standalone memories like \"plans to work out tomorrow\" because future calls won't know which tomorrow that meant.\n\n"
        "Extract 5-15 memories per conversation. Include both big life facts and "
        "small personal details that show you were really listening."
    )

    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
        )
        result = json.loads(response.choices[0].message.content)
        memories_array = result.get("memories", result) if isinstance(result, dict) else result

        if isinstance(memories_array, list):
            stored = 0
            for mem in memories_array:
                content = mem.get("content")
                if not content:
                    continue
                try:
                    mem_type = mem.get("type", "fact")
                    if mem_type not in ALLOWED_MEMORY_TYPES:
                        mem_type = "fact"
                    await store(
                        senior_id,
                        mem_type,
                        content,
                        conversation_id,
                        mem.get("importance", 50),
                        prospect_id=prospect_id,
                    )
                    stored += 1
                except Exception as e:
                    logger.warning("Failed to store memory: {err}", err=str(e))
            logger.info("Extracted {n} memories from conversation", n=stored)
    except Exception as e:
        logger.error("Failed to extract memories: {err}", err=str(e))
