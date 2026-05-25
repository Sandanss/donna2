"""Context cache service — pre-caches senior context at 5 AM local time.

Port of services/context-cache.js (365 lines). Caches:
- Recent call summaries
- Critical memories (Tier 1)

- Important memories (with decay)
- Legacy templated greeting helpers (active call greetings use services.greetings)

In-memory cache with 24-hour TTL. Called by scheduler hourly + at call connect.
News is also persisted to seniors.cached_news for cached interest/news context.
Live in-call web_search remains available for current user questions.
"""

from __future__ import annotations

import asyncio
import random
import time
from datetime import datetime
from zoneinfo import ZoneInfo
from loguru import logger
from db import execute
from services.time_context import format_call_time_label

# In-memory cache: senior_id -> cached context dict
_cache: dict[str, dict] = {}

CACHE_TTL_SECONDS = 24 * 60 * 60  # 24 hours
MAX_CACHE_SIZE = 2000
PREFETCH_HOUR = 5  # 5 AM local

# Greeting templates — {name} and {interest} replaced dynamically
GREETING_TEMPLATES = [
    "Hey {name}! It's Donna. I was just thinking about your {interest} - how's that going?",
    "Hi {name}, Donna here! Have you had a chance to enjoy any {interest} lately?",
    "{name}! So good to talk to you. Tell me - anything new with your {interest}?",
    "Hello {name}, it's Donna calling. I'd love to hear what you've been up to with {interest}.",
    "Hey there {name}! Donna checking in. Been doing any {interest} this week?",
    "{name}, hi! It's Donna. I was curious - how's the {interest} going these days?",
]

FALLBACK_TEMPLATES = [
    "Hey {name}! It's Donna. How have you been?",
    "Hi {name}, Donna here! How are you doing today?",
    "{name}! So good to talk to you. What's new?",
    "Hello {name}, it's Donna calling. How's everything going?",
    "Hey there {name}! Donna checking in. How are you?",
    "{name}, hi! It's Donna. How's your day been?",
]


def _get_local_hour(tz_name: str | None) -> int:
    """Get the current local hour for a timezone."""
    try:
        tz = ZoneInfo(tz_name or "America/New_York")
        return datetime.now(tz).hour
    except Exception:
        return datetime.now(ZoneInfo("America/New_York")).hour


def _select_interest(
    interests: list[str] | None,
    recent_memories: list[dict] | None,
    interest_scores: dict[str, float] | None = None,
) -> str | None:
    """Select an interest using weighted random (boosted by recent memory mentions)."""
    if not interests:
        return None

    now_ms = time.time() * 1000
    seven_days = 7 * 24 * 60 * 60 * 1000
    fourteen_days = 14 * 24 * 60 * 60 * 1000

    scores = interest_scores or {}
    weights: dict[str, float] = {i.lower(): scores.get(i.lower(), 1.0) for i in interests}

    for memory in (recent_memories or []):
        content = (memory.get("content") or "").lower()
        created = memory.get("created_at")
        if not created:
            continue
        if isinstance(created, datetime):
            mem_age = now_ms - created.timestamp() * 1000
        else:
            continue
        for interest in interests:
            key = interest.lower()
            if key in content:
                if mem_age <= seven_days:
                    weights[key] = weights.get(key, 1.0) + 2.0
                elif mem_age <= fourteen_days:
                    weights[key] = weights.get(key, 1.0) + 1.0

    total = sum(weights.values())
    r = random.random() * total
    for interest in interests:
        w = weights.get(interest.lower(), 1.0)
        r -= w
        if r <= 0:
            return interest
    return interests[0]


def generate_templated_greeting(
    senior: dict, recent_memories: list[dict] | None, last_greeting_index: int = -1
) -> dict:
    """Generate a templated greeting with rotation.

    Returns dict with keys: greeting, template_index, selected_interest.
    """
    first_name = (senior.get("name") or "there").split(" ")[0]
    interests = senior.get("interests") or []

    selected_interest = _select_interest(interests, recent_memories)
    templates = GREETING_TEMPLATES if selected_interest else FALLBACK_TEMPLATES

    available = [i for i in range(len(templates)) if i != last_greeting_index]
    if not available:
        available = list(range(len(templates)))
    template_index = random.choice(available)

    greeting = templates[template_index].replace("{name}", first_name)
    if selected_interest:
        greeting = greeting.replace("{interest}", selected_interest)

    return {
        "greeting": greeting,
        "template_index": template_index,
        "selected_interest": selected_interest,
    }


async def _fetch_conversations_consolidated(
    senior_id: str,
    limit: int = 3,
    timezone_name: str = "America/New_York",
) -> tuple:
    """Fetch recent conversations once, return (summaries_text, turns_text).

    Consolidates get_recent_summaries + get_recent_turns into a single DB query.
    """
    from db import query_many
    from lib.encryption import decrypt, decrypt_json
    import json
    import math

    rows = await query_many(
        """SELECT summary, summary_encrypted, transcript, transcript_encrypted,
                  started_at, duration_seconds
           FROM conversations
           WHERE senior_id = $1
             AND status = 'completed'
             AND (summary IS NOT NULL OR summary_encrypted IS NOT NULL
                  OR transcript IS NOT NULL OR transcript_encrypted IS NOT NULL)
           ORDER BY started_at DESC
           LIMIT $2""",
        senior_id,
        limit,
    )

    if not rows:
        return None, None

    def _time_label(started_at):
        return format_call_time_label(started_at, timezone_name)

    # Build summaries text
    summary_lines = []
    for row in rows:
        summary = decrypt(row.get("summary_encrypted")) if row.get("summary_encrypted") else row.get("summary")
        if summary and summary != "[encrypted]":
            time_ago = _time_label(row["started_at"])
            dur = f"({round(row['duration_seconds'] / 60)} min)" if row.get("duration_seconds") else ""
            summary_lines.append(f"- {time_ago} {dur}: {summary}")
    summaries_text = "\n".join(summary_lines) if summary_lines else None

    # Build turns text
    sections: list[str] = []
    total_turns = 0
    turns_per_call = 7
    max_turns = 20
    for row in rows:
        try:
            transcript = (
                decrypt_json(row.get("transcript_encrypted"))
                if row.get("transcript_encrypted")
                else row.get("transcript")
            )
            if not transcript:
                continue
            if isinstance(transcript, str):
                transcript = json.loads(transcript)
            if not isinstance(transcript, list) or not transcript:
                continue
            recent = transcript[-turns_per_call:]
            time_label = _time_label(row["started_at"])
            dur = row.get("duration_seconds")
            dur_str = f" ({math.ceil(dur / 60)} min)" if dur else ""
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
            if len(lines) > 1:
                sections.append("\n".join(lines))
        except Exception:
            continue
        if total_turns >= max_turns:
            break

    turns_text = None
    if sections:
        header = "RECENT CONVERSATIONS (from previous calls):"
        footer = "(Reference these naturally — show you remember without repeating exactly.)"
        turns_text = f"{header}\n" + "\n".join(sections) + f"\n{footer}"

    return summaries_text, turns_text


async def _fetch_memories_consolidated(
    senior_id: str,
    timezone_name: str = "America/New_York",
) -> tuple:
    """Fetch memories once, return (critical, important, recent).

    Consolidates get_critical + get_important + get_recent into a single DB query.
    """
    from db import query_many
    from lib.encryption import decrypt
    from services.memory import _calculate_effective_importance, format_memory_for_context

    rows = await query_many(
        """SELECT id, type, content, content_encrypted, importance, metadata, created_at, last_accessed_at
           FROM memories
           WHERE senior_id = $1
           ORDER BY importance DESC, created_at DESC
           LIMIT 30""",
        senior_id,
    )

    for row in rows:
        if row.get("content_encrypted"):
            row["content"] = decrypt(row["content_encrypted"])
        row.pop("content_encrypted", None)
        row["content"] = format_memory_for_context(row, timezone_name)

    # Split into tiers
    critical = [m for m in rows if m.get("type") == "concern" or (m.get("importance") or 0) >= 80][:3]

    important_candidates = [m for m in rows if (m.get("importance") or 0) >= 50]
    with_effective = []
    for m in important_candidates:
        eff = _calculate_effective_importance(
            m["importance"], m["created_at"], m.get("last_accessed_at")
        )
        if eff >= 50:
            with_effective.append({**m, "effective_importance": eff})
    with_effective.sort(key=lambda m: m["effective_importance"], reverse=True)
    important = with_effective[:5]

    recent = sorted(rows, key=lambda m: m["created_at"], reverse=True)[:10]

    return critical, important, recent


async def prefetch_and_cache(senior_id: str) -> dict | None:
    """Pre-fetch and cache context for a senior (consolidated DB fetches)."""
    start = time.time()

    try:
        from services.seniors import get_by_id
        from services.memory import group_by_type, format_grouped_memories
        from services.greetings import get_greeting

        senior = await get_by_id(senior_id)
        if not senior:
            logger.info("Senior {sid} not found, skipping", sid=str(senior_id)[:8])
            return None

        # Consolidated fetches: 2 queries instead of 5
        (summaries, recent_turns), (critical, important, recent_mems) = await asyncio.gather(
            _fetch_conversations_consolidated(
                senior_id,
                3,
                senior.get("timezone") or "America/New_York",
            ),
            _fetch_memories_consolidated(
                senior_id,
                senior.get("timezone") or "America/New_York",
            ),
        )

        # Fetch news for seniors with interests (fetch full set, pick subset for prompt)
        news_context_full = None
        news_context = None
        interest_scores = senior.get("interest_scores") or {}
        if senior.get("interests"):
            try:
                from services.news import get_news_for_senior, select_stories_for_call
                news_context_full = await get_news_for_senior(senior["interests"], limit=8)
                news_context = select_stories_for_call(
                    news_context_full,
                    interests=senior.get("interests"),
                    interest_scores=interest_scores,
                    count=3,
                )
            except Exception as e:
                logger.error("Error fetching news for cache: {err}", err=str(e))

            # Persist news to DB so calls never need live web search
            if news_context_full:
                try:
                    await execute(
                        "UPDATE seniors SET cached_news = $1, cached_news_updated_at = NOW() WHERE id = $2",
                        news_context_full,
                        senior_id,
                    )
                    logger.info("Persisted cached news for senior_id={sid}", sid=str(senior_id)[:8])
                except Exception as e:
                    logger.error("Failed to persist news for senior_id={sid}: {err}", sid=str(senior_id)[:8], err=str(e))

        # Generate greeting using the greeting rotation service
        greeting_result = get_greeting(
            senior_name=senior.get("name", ""),
            timezone=senior.get("timezone"),
            interests=senior.get("interests"),
            last_call_summary=summaries,
            recent_memories=recent_mems,
            senior_id=senior_id,
            news_context=news_context,
            interest_scores=interest_scores,
        )

        logger.info(
            "Generated greeting for senior_id={sid}: period={p}, template={t}",
            sid=str(senior_id)[:8],
            p=greeting_result["period"],
            t=greeting_result["template_index"],
        )

        # Build memory context string
        memory_parts: list[str] = []
        if critical:
            memory_parts.append("Critical to know:")
            for m in critical:
                memory_parts.append(f"- {m['content']}")

        if important:
            critical_ids = {m["id"] for m in critical}
            unique = [m for m in important if m["id"] not in critical_ids]
            if unique:
                groups = group_by_type(unique)
                formatted = format_grouped_memories(groups)
                memory_parts.append(f"\nBackground:\n{formatted}")

        now = time.time()
        cached = {
            "senior_id": senior_id,
            "senior": senior,
            "summaries": summaries,
            "recent_turns": recent_turns,
            "critical_memories": critical,
            "important_memories": important,
            "memory_context": "\n".join(memory_parts),
            "news_context": news_context,
            "news_context_full": news_context_full,
            "interest_scores": interest_scores,
            "greeting": greeting_result["greeting"],
            "last_greeting_index": greeting_result["template_index"],
            "cached_at": now,
            "expires_at": now + CACHE_TTL_SECONDS,
        }

        # Evict oldest entries if cache exceeds max size
        if len(_cache) >= MAX_CACHE_SIZE:
            entries = sorted(_cache.items(), key=lambda kv: kv[1]["cached_at"])
            evict_count = len(_cache) - MAX_CACHE_SIZE + 1
            for key, _ in entries[:evict_count]:
                del _cache[key]
            logger.info("Evicted {n} oldest cache entries", n=evict_count)

        _cache[senior_id] = cached

        elapsed = round((time.time() - start) * 1000)
        logger.info("Pre-cached context for senior_id={sid} in {ms}ms", sid=str(senior_id)[:8], ms=elapsed)
        return cached

    except Exception as e:
        logger.error("Error pre-caching {sid}: {err}", sid=str(senior_id)[:8], err=str(e))
        return None


def get_cache(senior_id: str) -> dict | None:
    """Get cached context for a senior. Returns None if not cached or expired."""
    cached = _cache.get(senior_id)
    if not cached:
        return None

    if time.time() > cached["expires_at"]:
        del _cache[senior_id]
        logger.info("Cache expired for {sid}", sid=str(senior_id)[:8])
        return None

    age_min = round((time.time() - cached["cached_at"]) / 60)
    logger.info("Cache hit for {sid} (age: {age} min)", sid=str(senior_id)[:8], age=age_min)
    return cached


def clear_cache(senior_id: str) -> None:
    """Clear cache for a senior (e.g., after call ends and new memories stored)."""
    if senior_id in _cache:
        del _cache[senior_id]
        logger.info("Cleared cache for {sid}", sid=str(senior_id)[:8])


def clear_all() -> None:
    """Clear all caches."""
    count = len(_cache)
    _cache.clear()
    logger.info("Cleared all {n} cached contexts", n=count)


async def run_daily_prefetch() -> None:
    """Run pre-fetch for seniors whose local time is 5 AM. Called hourly by scheduler."""
    from lib.growthbook import is_on
    if not is_on("context_cache_enabled", {}):
        logger.info("Context cache disabled via GrowthBook flag — skipping prefetch")
        return

    logger.info("Running daily pre-fetch check...")

    try:
        from services.seniors import list_active
        seniors = await list_active()
        prefetched = 0

        for senior in seniors:
            local_hour = _get_local_hour(senior.get("timezone"))
            if local_hour == PREFETCH_HOUR:
                await prefetch_and_cache(senior["id"])
                prefetched += 1

        if prefetched > 0:
            logger.info("Pre-fetched context for {n} seniors", n=prefetched)
    except Exception as e:
        logger.error("Daily pre-fetch error: {err}", err=str(e))


def cleanup_expired() -> int:
    """Remove expired entries from cache. Returns count removed."""
    now = time.time()
    expired_keys = [k for k, v in _cache.items() if now > v["expires_at"]]
    for k in expired_keys:
        del _cache[k]
    if expired_keys:
        logger.info("Cleaned up {n} expired cache entries", n=len(expired_keys))
    return len(expired_keys)


def get_stats() -> dict:
    """Get cache statistics."""
    now = time.time()
    valid = sum(1 for c in _cache.values() if now <= c["expires_at"])
    expired = len(_cache) - valid
    return {"total": len(_cache), "valid": valid, "expired": expired}
