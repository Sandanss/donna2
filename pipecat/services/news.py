"""News and web search service.

Daily senior-friendly news uses OpenAI and cache storage. In-call web_search
uses Tavily first with OpenAI fallback.
"""

from __future__ import annotations

import asyncio
import os
import random
import re
import time
from loguru import logger

from lib.circuit_breaker import CircuitBreaker

_breaker = CircuitBreaker("openai_news", failure_threshold=3, recovery_timeout=60.0, call_timeout=10.0)
_tavily_breaker = CircuitBreaker("tavily_search", failure_threshold=3, recovery_timeout=60.0, call_timeout=8.0)

_openai_client = None
_tavily_client = None
_news_cache: dict[str, dict] = {}
CACHE_TTL = 3600  # 1 hour in seconds
_MAX_CACHE_ENTRIES = 50


def _get_openai():
    global _openai_client
    if _openai_client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
        if not api_key:
            return None
        from openai import OpenAI
        _openai_client = OpenAI(api_key=api_key)
    return _openai_client


def _get_tavily():
    global _tavily_client
    if _tavily_client is None:
        api_key = os.environ.get("TAVILY_API_KEY")
        if not api_key:
            return None
        from tavily import AsyncTavilyClient
        _tavily_client = AsyncTavilyClient(api_key=api_key)
    return _tavily_client


def _evict_expired():
    """Remove expired entries from the cache."""
    now = time.time()
    expired = [k for k, v in _news_cache.items() if now - v["timestamp"] >= CACHE_TTL]
    for k in expired:
        del _news_cache[k]


def _cache_key(interests: list[str]) -> str:
    return "|".join(sorted(i.lower() for i in interests))


async def get_news_for_senior(interests: list[str], limit: int = 3) -> str | None:
    """Fetch news relevant to a senior's interests using OpenAI web search."""
    if not interests:
        return None

    client = _get_openai()
    if client is None:
        logger.info("OpenAI not configured, skipping news fetch")
        return None

    key = _cache_key(interests)
    cached = _news_cache.get(key)
    if cached and time.time() - cached["timestamp"] < CACHE_TTL:
        logger.info("Using cached news")
        return cached["news"]

    try:
        interest_list = ", ".join(interests[:5])
        logger.info("Fetching news for {n} interests", n=min(len(interests), 5))

        async def _news_call():
            return await asyncio.to_thread(
                client.responses.create,
                model="gpt-4o-mini",
                tools=[{"type": "web_search_preview"}],
                input=(
                    f"Find 8-10 brief, positive news stories from today about: {interest_list}.\n"
                    "These are for an elderly person, so:\n"
                    "- Choose uplifting or interesting stories (avoid distressing news)\n"
                    "- Keep each summary to 1-2 sentences\n"
                    "- Focus on human interest, health tips, local events, or hobby-related news\n\n"
                    "Format as a simple list with bullet points."
                ),
                tool_choice="required",
            )

        response = await _breaker.call(_news_call(), fallback=None)
        if response is None:
            return None

        news_content = (response.output_text or "").strip()
        if not news_content:
            logger.info("No news content returned")
            return None

        formatted = format_news_context(news_content)
        # Evict expired entries if cache is getting large
        if len(_news_cache) >= _MAX_CACHE_ENTRIES:
            _evict_expired()
        _news_cache[key] = {"news": formatted, "timestamp": time.time()}
        logger.info("Fetched and cached news successfully")
        return formatted

    except Exception as e:
        logger.error("Error fetching news: {err}", err=str(e))
        return None


def format_news_context(raw_news: str) -> str:
    """Format news for natural conversation injection."""
    return (
        "Here are some recent news items you could mention naturally "
        f"if the conversation allows:\n{raw_news}\n\n"
        "Only bring these up if relevant to the conversation - don't force it."
    )


async def _tavily_search(query: str) -> str | None:
    """Search via Tavily (fast, 1-3s typical). Returns raw result snippets only —
    never use include_answer (LLM-generated, hallucinates on real-time data)."""
    client = _get_tavily()
    if client is None:
        return None

    async def _call():
        return await client.search(
            query=query,
            search_depth="basic",
            max_results=3,
        )

    result = await _tavily_breaker.call(_call(), fallback=None)
    if result is None:
        return None

    results = result.get("results", [])
    if not results:
        return None

    snippets = [f"- {r.get('title', '')}: {r.get('content', '')[:300]}" for r in results[:3]]
    return "\n".join(snippets).strip()


async def _openai_search(query: str) -> str | None:
    """Search via OpenAI web search (slower fallback, 6-10s)."""
    client = _get_openai()
    if client is None:
        return None

    response = await asyncio.to_thread(
        client.responses.create,
        model="gpt-4o-mini",
        tools=[{"type": "web_search_preview"}],
        input=(
            f"Answer this question concisely: {query}\n\n"
            "Keep the answer to 2-3 sentences max. "
            "Use simple, clear language suitable for an elderly person. "
            "If the question is about current events, include today's date context."
        ),
    )
    return (response.output_text or "").strip() or None


async def web_search_query(query: str) -> str | None:
    """General-purpose web search for answering a senior's question.

    Tries Tavily first (fast, ~1-3s), falls back to OpenAI web search.
    Live call searches are not cached because stale answers are worse than an
    extra API call for current-events and weather-style questions.
    """
    if not query:
        return None

    try:
        logger.info("Web search query requested (query_chars={n})", n=len(query))

        # Try Tavily first (fast)
        content = await _tavily_search(query)
        if content:
            logger.info("Web search completed via Tavily")
        else:
            # Fallback to OpenAI
            logger.info("Tavily unavailable, falling back to OpenAI web search")
            content = await _openai_search(query)
            if content:
                logger.info("Web search completed via OpenAI")

        if not content:
            logger.info("No web search content returned")
            return None

        return content

    except Exception as e:
        logger.error("Web search error: {err}", err=str(e))
        return None


def select_stories_for_call(
    full_news: str | None,
    interests: list[str] | None = None,
    interest_scores: dict[str, float] | None = None,
    count: int = 3,
) -> str | None:
    """Pick the best stories from the full cached news for a single call.

    Scores each bullet point by matching interest weight, adds random jitter
    so consecutive calls aren't identical, and returns the top *count* stories
    re-wrapped with the standard news context header.
    """
    if not full_news:
        return None

    # Parse bullet points (lines starting with - or *)
    bullets = [
        line.strip()
        for line in re.split(r"\n", full_news)
        if line.strip() and re.match(r"^[-*•]", line.strip())
    ]
    if not bullets:
        return full_news  # Can't parse, return as-is

    scores = interest_scores or {}
    interest_list = [i.lower() for i in (interests or [])]

    scored: list[tuple[float, str]] = []
    for bullet in bullets:
        bullet_lower = bullet.lower()
        weight = 0.0
        for interest in interest_list:
            if interest in bullet_lower:
                weight += scores.get(interest, 1.0)
        # Add random jitter (0–1) so ties are broken randomly
        weight += random.random()
        scored.append((weight, bullet))

    scored.sort(key=lambda x: x[0], reverse=True)
    selected = [b for _, b in scored[:count]]
    raw = "\n".join(selected)
    return format_news_context(raw)


def clear_cache():
    """Clear the news cache."""
    _news_cache.clear()
    logger.info("News cache cleared")
