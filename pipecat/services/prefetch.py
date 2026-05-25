"""Predictive Context Engine — speculative memory prefetch.

Extracts likely topics/entities from user speech using regex patterns
and Director LLM analysis, then pre-fetches memories in the background
so Donna can inject relevant context before Claude responds.

Key classes + functions:
- PrefetchCache: TTL cache for memory results (stored in session_state)
- extract_prefetch_queries(): regex-based topic/entity extraction
- extract_director_queries(): LLM-extracted topics from Director analysis
- run_prefetch(): async memory search with dedup + concurrency limit
"""

from __future__ import annotations

import re
import time
from typing import Any

import asyncio
from loguru import logger

from processors.conversation_tracker import _TOPIC_PATTERNS


# ---------------------------------------------------------------------------
# Entity extraction patterns (supplement _TOPIC_PATTERNS from tracker)
# ---------------------------------------------------------------------------

_POSSESSIVE_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bmy\s+(grandson|granddaughter|grandchild|grandkid)\b", re.I), "grandchild"),
    (re.compile(r"\bmy\s+(son|daughter|boy|girl)\b", re.I), "child"),
    (re.compile(r"\bmy\s+(husband|wife|spouse|partner)\b", re.I), "spouse"),
    (re.compile(r"\bmy\s+(brother|sister|sibling)\b", re.I), "sibling"),
    (re.compile(r"\bmy\s+(friend|neighbor|neighbour)\b", re.I), "friend"),
    (re.compile(r"\bmy\s+(cat|dog|bird|pet)\b", re.I), "pet"),
]

_ACTIVITY_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(?:went|going|go)\s+(?:to\s+)?(?:the\s+)?(church|store|market|park|library)\b", re.I), None),
    (re.compile(r"\b(?:played|playing|play)\s+(cards|bingo|golf|tennis|bridge)\b", re.I), None),
    (re.compile(r"\b(?:watched|watching|watch)\s+(?:the\s+)?(game|news|movie|show|baseball|football|basketball)\b", re.I), None),
]

# Name pattern: capitalized word after relational context
_NAME_AFTER_RELATION = re.compile(
    r"\b(?:my\s+(?:grandson|granddaughter|son|daughter|husband|wife|friend|neighbor|brother|sister|niece|nephew))\s+([A-Z][a-z]{2,})\b",
    re.I,
)

# Vague utterances to skip
_SKIP_PATTERNS = re.compile(
    r"^(?:yeah|yes|no|nah|okay|ok|uh huh|mm hmm|mhm|hmm|sure|right|I see|oh|ah|well|good|fine|alright|thank you|thanks|bye|goodbye)\.?$",
    re.I,
)

# Max queries per extraction
_MAX_QUERIES = 3

_MEMORY_CACHE_STOP_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by",
    "can", "could", "did", "do", "does", "for", "from", "had", "has",
    "have", "he", "her", "hers", "him", "his", "i", "if", "in", "is",
    "it", "its", "me", "my", "of", "on", "or", "our", "she", "so",
    "that", "the", "their", "them", "then", "there", "they", "this",
    "to", "was", "we", "were", "what", "when", "where", "with", "you",
    "your",
})


# ---------------------------------------------------------------------------
# PrefetchCache
# ---------------------------------------------------------------------------

class PrefetchCache:
    """TTL-based in-memory cache for prefetched memory results.

    Stored in session_state so it's per-call. Uses fuzzy word-overlap
    (Jaccard similarity on word sets) for lookup — no embeddings needed.
    """

    DEFAULT_TTL = 30.0  # seconds
    MAX_ENTRIES = 10

    def __init__(self, ttl: float = DEFAULT_TTL):
        self._ttl = ttl
        self._entries: dict[str, dict[str, Any]] = {}
        self._inflight: dict[str, dict[str, Any]] = {}
        self._hits = 0
        self._misses = 0

    def _normalize_key(self, query: str) -> str:
        return " ".join(sorted(self._word_set(query)))

    def _word_set(self, text: str) -> set[str]:
        return {
            w
            for w in re.findall(r"[a-z0-9]+", text.lower())
            if w and w not in _MEMORY_CACHE_STOP_WORDS
        }

    def _purge_expired(self, entries: dict[str, dict[str, Any]] | None = None) -> None:
        now = time.time()
        target = entries if entries is not None else self._entries
        for key, entry in list(target.items()):
            if now - entry["ts"] > self._ttl:
                del target[key]

    def _best_match(
        self,
        query: str,
        entries: dict[str, dict[str, Any]],
        threshold: float,
    ) -> dict[str, Any] | None:
        self._purge_expired(entries)
        query_words = self._word_set(query)
        if not query_words:
            return None

        best_match: dict[str, Any] | None = None
        best_sim = 0.0

        for entry in entries.values():
            entry_words = self._word_set(entry["query"])
            if not entry_words:
                continue

            intersection = len(query_words & entry_words)
            union = len(query_words | entry_words)
            sim = intersection / union if union > 0 else 0.0

            if sim > best_sim:
                best_sim = sim
                best_match = entry

        if best_match and best_sim >= threshold:
            return best_match
        return None

    def put(self, query: str, results: list[dict], source: str = "prefetch") -> None:
        """Store prefetch results. Evicts oldest entry if at capacity."""
        key = self._normalize_key(query)

        # Evict oldest if at capacity
        if len(self._entries) >= self.MAX_ENTRIES and key not in self._entries:
            oldest_key = min(self._entries, key=lambda k: self._entries[k]["ts"])
            del self._entries[oldest_key]

        self._entries[key] = {
            "results": results,
            "source": source,
            "ts": time.time(),
            "query": query,
        }
        self.clear_inflight(query)

    def get(self, query: str, threshold: float = 0.3) -> list[dict] | None:
        """Fuzzy lookup via Jaccard word-overlap similarity.

        Returns cached results if a matching entry is found and not expired.
        """
        best_match = self._best_match(query, self._entries, threshold)
        if best_match:
            self._hits += 1
            return best_match["results"]

        self._misses += 1
        return None

    def has_cached(self, query: str, threshold: float = 0.3) -> bool:
        """Return whether a relevant cached result exists without mutating stats."""
        return self._best_match(query, self._entries, threshold) is not None

    def mark_inflight(self, query: str, source: str = "prefetch") -> None:
        """Track a memory search that is currently running for this call."""
        if not query:
            return
        self._inflight[self._normalize_key(query)] = {
            "source": source,
            "ts": time.time(),
            "query": query,
        }

    def clear_inflight(self, query: str) -> None:
        """Clear in-flight tracking for a completed or skipped query."""
        if not query:
            return
        self._inflight.pop(self._normalize_key(query), None)

    def has_relevant_inflight(self, query: str, threshold: float = 0.3) -> bool:
        """Return whether a relevant search is in flight without mutating stats."""
        return self._best_match(query, self._inflight, threshold) is not None

    def get_inflight_queries(self) -> list[str]:
        """Return non-expired in-flight query strings."""
        self._purge_expired(self._inflight)
        return [entry["query"] for entry in self._inflight.values()]

    def get_recent_queries(self) -> list[str]:
        """Return queries from non-expired entries (for dedup + hints)."""
        self._purge_expired(self._entries)
        return [entry["query"] for entry in self._entries.values()]

    def stats(self) -> dict[str, int]:
        """Cache statistics for metrics logging."""
        total = self._hits + self._misses
        return {
            "hits": self._hits,
            "misses": self._misses,
            "total": total,
            "hit_rate_pct": round(self._hits / total * 100) if total > 0 else 0,
            "entries": len(self._entries),
            "inflight": len(self._inflight),
        }


# ---------------------------------------------------------------------------
# Query extraction
# ---------------------------------------------------------------------------

def extract_prefetch_queries(
    text: str,
    session_state: dict | None = None,
    source: str = "final",
) -> list[str]:
    """Extract memory-search queries from user speech.

    Uses the raw utterance as the search query — let pgvector similarity
    do the filtering instead of regex gatekeeping. Skips only vague
    utterances ("yeah", "okay", "mhm").

    Args:
        text: User transcription text.
        session_state: Pipeline session state (unused, kept for API compat).
        source: "final" or "interim" — interim requires longer text.
    """
    if not text or len(text.strip()) < 10:
        return []

    text = text.strip()

    # Skip vague utterances
    if _SKIP_PATTERNS.match(text):
        return []

    # Interims need more text to be worth searching (avoid noise)
    if source == "interim" and len(text) < 25:
        return []

    # Use the raw utterance as the search query — vector similarity
    # will find relevant memories without regex pre-filtering.
    return [text]


# ---------------------------------------------------------------------------
# Director-driven query extraction (second wave — multi-turn context)
# ---------------------------------------------------------------------------

def extract_director_queries(
    direction: dict,
    session_state: dict | None = None,
) -> list[str]:
    """Extract prefetch queries from Director analysis (multi-turn context).

    Uses Director LLM-extracted memory_queries (highest quality) with
    heuristic fallbacks from structured output fields.

    Called after Director analysis completes (~600ms).
    """
    queries: list[str] = []
    seen: set[str] = set()

    def _add(q: str) -> None:
        q = q.strip().lower()
        if q and q not in seen and len(q) >= 3:
            seen.add(q)
            queries.append(q)

    # 1. LLM-extracted memory queries (highest quality, from prefetch section)
    prefetch = direction.get("prefetch", {})
    for mq in prefetch.get("memory_queries", []):
        if isinstance(mq, str):
            _add(mq)

    # 2. Heuristic fallbacks from structured analysis
    analysis = direction.get("analysis", {})
    dir_section = direction.get("direction", {})
    reminder = direction.get("reminder", {})

    next_topic = dir_section.get("next_topic")
    if next_topic and next_topic != analysis.get("current_topic"):
        _add(next_topic)

    if reminder.get("should_deliver") and reminder.get("which_reminder"):
        _add(reminder["which_reminder"])

    if dir_section.get("should_mention_news") and dir_section.get("news_topic"):
        _add(dir_section["news_topic"])

    current_topic = analysis.get("current_topic")
    turns_on_topic = analysis.get("turns_on_current_topic", 0)
    if current_topic and current_topic != "unknown" and turns_on_topic >= 2:
        _add(current_topic)

    return queries[:_MAX_QUERIES]


# ---------------------------------------------------------------------------
# Prefetch runner
# ---------------------------------------------------------------------------

_MAX_CONCURRENT_SEARCHES = 2


async def run_prefetch(
    senior_id: str,
    queries: list[str],
    cache: PrefetchCache,
) -> int:
    """Run speculative memory searches and store results in cache.

    Skips queries already in cache. Runs up to 2 concurrent searches.
    Returns count of successful prefetches.

    Args:
        senior_id: Senior UUID.
        queries: Query strings to prefetch.
        cache: PrefetchCache instance to store results.
    """
    if not queries or not senior_id:
        return 0

    # Dedup: skip queries already cached or being searched by another
    # overlapping interim/final prefetch task. Similarity is intentionally
    # higher than the injection threshold so related-but-distinct topics can
    # still search while repeated interim refinements collapse together.
    new_queries = [
        q for q in queries
        if not cache.has_cached(q, threshold=0.75)
        and not cache.has_relevant_inflight(q, threshold=0.75)
    ]

    if not new_queries:
        return 0

    # Limit concurrency, then mark before yielding so overlapping tasks see it.
    new_queries = new_queries[:_MAX_CONCURRENT_SEARCHES]
    for query in new_queries:
        cache.mark_inflight(query)

    async def _search_one(query: str) -> bool:
        try:
            from services.memory import search
            start = time.time()
            results = await search(senior_id, query, limit=3, track_access=False)
            elapsed_ms = round((time.time() - start) * 1000)
            if results:
                cache.put(query, results, source="prefetch")
                logger.info(
                    "[Prefetch] Cached {n} results ({ms}ms, query_chars={chars})",
                    n=len(results), ms=elapsed_ms, chars=len(query),
                )
                return True
            else:
                logger.debug(
                    "[Prefetch] No results ({ms}ms, query_chars={chars})",
                    ms=elapsed_ms, chars=len(query),
                )
                return False
        except Exception as e:
            logger.warning("[Prefetch] Search failed (query_chars={chars}): {err}", chars=len(query), err=str(e))
            return False
        finally:
            cache.clear_inflight(query)

    results = await asyncio.gather(*[_search_one(q) for q in new_queries])
    return sum(1 for r in results if r)
