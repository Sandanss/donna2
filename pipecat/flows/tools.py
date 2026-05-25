"""LLM tool definitions for Donna's voice pipeline.

Active subscriber-call tools exposed to Claude (3 tools — Director-first architecture):
- web_search: Real-time web search with spoken filler UX
- mark_reminder_acknowledged: Track reminder delivery status with post-call DB verification
- create_reminder: Save senior-requested reminders after explicit confirmation

Retired tools (handlers kept for Gemini / future use):
- search_memories → Director injects memories as ephemeral context (500ms gate)
- save_important_detail → post-call extract_from_conversation handles it
- check_caregiver_notes → pre-fetched at call start, injected into system prompt

Uses closure pattern over session_state to give tool handlers access
to senior context without Pipecat's non-existent set_function_call_context().
"""

from __future__ import annotations

import asyncio
from datetime import date
import re
import time
from zoneinfo import ZoneInfo

from loguru import logger
from pipecat_flows import FlowsFunctionSchema
from lib.sanitize import sanitize_untrusted_text
from services.context_trace import record_context_event, record_latency_event


# ---------------------------------------------------------------------------
# Tool schemas (reusable across nodes)
# ---------------------------------------------------------------------------

SEARCH_MEMORIES_SCHEMA = {
    "name": "search_memories",
    "description": "Search the senior's memory bank for relevant past conversations, preferences, or details. Use when they mention something you might have discussed before, or when you need context about their life.",
    "properties": {
        "query": {
            "type": "string",
            "description": "What to search for (e.g., 'gardening', 'grandson birthday', 'favorite music')",
        },
    },
    "required": ["query"],
}

def _local_date_for_session(session_state: dict | None = None) -> date:
    senior = (session_state or {}).get("senior") or {}
    timezone_name = senior.get("timezone") or "America/New_York"
    try:
        from datetime import datetime
        return datetime.now(ZoneInfo(timezone_name)).date()
    except Exception:
        return date.today()


def _web_search_schema(today_date: date | None = None) -> dict:
    today_date = today_date or date.today()
    today = today_date.strftime("%B %d, %Y")
    return {
        "name": "web_search",
        "description": (
            f"Search the web for current information. Today is {today}. "
            "Use this whenever the senior asks about news, weather, sports, facts, "
            "or anything you're unsure about. Always include the current year in "
            "queries about recent events, scores, or elections. "
            "Never include names, phone numbers, addresses, caregiver names, private "
            "history, or medical history in the query. Do not use this tool for medical, medication, "
            "diagnosis, symptom, or emergency questions. "
            "IMPORTANT: Before calling this tool, always say a brief natural filler "
            "like 'Let me look that up for you', 'One moment while I check on that', "
            "or 'Hmm, let me find out'. This gives the senior something to hear while "
            "the search runs. Vary the phrasing each time. "
            "CRITICAL: Use the FIRST result. Do NOT call this tool a second time "
            "for the same question — if the result is empty or unhelpful, tell the "
            "senior so verbally and move on. Repeated calls with the same query waste "
            "their time on the line."
        ),
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    f"What to search for (include {today_date.year} for recent events). "
                    "Do not include personal names, phone numbers, addresses, private history, "
                    "or medical questions."
                ),
            },
        },
        "required": ["query"],
    }


def get_web_search_schema(session_state: dict | None = None, today_date: date | None = None) -> dict:
    return _web_search_schema(today_date or _local_date_for_session(session_state))


WEB_SEARCH_SCHEMA = get_web_search_schema()

CREATE_REMINDER_SCHEMA = {
    "name": "create_reminder",
    "description": (
        "Save a new reminder for the senior AND auto-schedule the call that will "
        "remind them. Use ONLY after confirming all details with the senior in this order: "
        "(1) propose a short title and confirm; (2) ask when the event is (date+time); "
        "(3) ask if it repeats — daily, certain days of the week, or just once; "
        "(4) read everything back ('So that's <title> on <date> at <time>, repeating "
        "<frequency> — does that sound right?') and only call this tool after they confirm. "
        "Compute scheduled_time in the senior's local timezone (from system prompt 'Current time') "
        "and emit ISO 8601 WITH offset. AFTER the tool returns success, briefly confirm aloud "
        "(e.g., 'Got it — I saved that and I'll call you at that time'). Use this for "
        "everyday routines and social tasks only."
    ),
    "properties": {
        "title": {
            "type": "string",
            "description": (
                "Short human-readable title (max 200 chars), in the same language the "
                "senior is speaking. Examples: 'Water the porch plants', 'Llamar a María', "
                "'Put out the trash'. Do NOT include the date/time "
                "in the title — that goes in scheduled_time."
            ),
        },
        "scheduled_time": {
            "type": "string",
            "description": (
                "ISO 8601 timestamp WITH timezone offset for the FIRST occurrence, in the "
                "senior's local timezone. Example for May 12, 2026 at 10:00 AM Eastern: "
                "'2026-05-12T10:00:00-04:00'. For weekly/daily reminders, use the next "
                "occurrence (e.g., next Monday at 8 AM if they said 'every Monday morning'). "
                "Use 'Current time' from the system prompt to resolve relative phrases."
            ),
        },
        "type": {
            "type": "string",
            "enum": ["custom", "social"],
            "description": "Category. Use 'social' for calls/visits to family/friends, 'custom' otherwise.",
        },
        "description": {
            "type": "string",
            "description": "Optional extra context, e.g., 'Bring insurance card' or 'With breakfast'.",
        },
        "frequency": {
            "type": "string",
            "enum": ["daily", "weekly", "one-time"],
            "description": (
                "How often it repeats. 'daily' = every day at the same time. "
                "'weekly' = certain days of the week (also fill recurring_days). "
                "'one-time' = a single occurrence on a specific date. If the senior is "
                "unclear, ask: '¿es algo que se repite todos los días, ciertos días de la "
                "semana, o una sola vez?' / 'is this every day, certain days, or just once?'"
            ),
        },
        "recurring_days": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
            },
            "description": (
                "REQUIRED ONLY when frequency='weekly'. Three-letter weekday codes for "
                "the days the reminder should fire. Example: ['Mon', 'Wed', 'Fri']."
            ),
        },
    },
    "required": ["title", "scheduled_time", "type", "frequency"],
}

MARK_REMINDER_SCHEMA = {
    "name": "mark_reminder_acknowledged",
    "description": "Mark a reminder as acknowledged after you have delivered it and the senior has responded. Call this after delivering a reminder and getting their response.",
    "properties": {
        "reminder_id": {
            "type": "string",
            "description": "The ID of the reminder that was delivered",
        },
        "status": {
            "type": "string",
            "enum": ["acknowledged", "confirmed"],
            "description": "Whether the senior acknowledged or explicitly confirmed the reminder",
        },
        "user_response": {
            "type": "string",
            "description": "Brief summary of what the senior said about the reminder",
        },
    },
    "required": ["reminder_id", "status"],
}

SAVE_DETAIL_SCHEMA = {
    "name": "save_important_detail",
    "description": "Save an important detail the senior mentioned that should be remembered for future calls. Use for significant life events, new interests, family updates, or emotional state changes.",
    "properties": {
        "detail": {
            "type": "string",
            "description": "The detail to remember (e.g., 'Grandson Jake graduated from college')",
        },
        "category": {
            "type": "string",
            "enum": ["family", "preference", "life_event", "emotional", "activity"],
            "description": "Category of the detail",
        },
    },
    "required": ["detail", "category"],
}

CHECK_CAREGIVER_NOTES_SCHEMA = {
    "name": "check_caregiver_notes",
    "description": (
        "Check if any family members or caregivers have left messages or questions "
        "for the senior. Use this naturally in conversation, e.g., 'Oh, by the way, "
        "your daughter wanted me to ask about...'"
    ),
    "properties": {},
    "required": [],
}


_PHONE_RE = re.compile(r"\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b")
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.I)
_SSN_RE = re.compile(r"\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b")
_ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z0-9 .'-]+?\s+"
    r"(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b",
    re.I,
)
_SPACE_RE = re.compile(r"\s+")
_MEDICAL_SEARCH_RE = re.compile(
    r"\b("
    r"medicine|medication|pill|prescription|pharmacy|dose|dosage|"
    r"metformin|lisinopril|symptom|side effect|diagnos|doctor|hospital|"
    r"urgent care|emergency|911|pain|dizzy|dizziness|blood pressure|"
    r"diabetes|insulin|chest pain|shortness of breath"
    r")\b",
    re.I,
)
_MAX_WEB_SEARCH_QUERY_CHARS = 240


def _known_private_terms(session_state: dict | None) -> set[str]:
    senior = (session_state or {}).get("senior") or {}
    terms: set[str] = set()

    def _add_name(value) -> None:
        if not value or not isinstance(value, str):
            return
        cleaned = value.strip()
        if len(cleaned) < 3:
            return
        terms.add(cleaned)
        for part in re.findall(r"[A-Za-z][A-Za-z'-]{2,}", cleaned):
            terms.add(part)

    _add_name(senior.get("name"))

    family_info = senior.get("family_info") or senior.get("familyInfo") or {}
    if isinstance(family_info, dict):
        for value in family_info.values():
            if isinstance(value, str):
                _add_name(value)
            elif isinstance(value, dict):
                for nested in value.values():
                    if isinstance(nested, str):
                        _add_name(nested)

    for note in (session_state or {}).get("_caregiver_notes_content") or []:
        if isinstance(note, dict):
            _add_name(note.get("caregiver_name") or note.get("caregiverName"))

    return {term for term in terms if len(term) >= 3}


def _known_location_terms(session_state: dict | None) -> set[str]:
    senior = (session_state or {}).get("senior") or {}
    terms: set[str] = set()
    for key in ("city", "zip_code", "zipCode"):
        value = senior.get(key)
        if isinstance(value, str) and len(value.strip()) >= 3:
            terms.add(value.strip())
    return terms


def sanitize_web_search_query(query: str, session_state: dict | None = None) -> str:
    """Remove direct identifiers before sending a live web-search query."""
    sanitized = sanitize_untrusted_text(
        query or "",
        max_len=_MAX_WEB_SEARCH_QUERY_CHARS,
        replacement="",
        redact_contact_info=False,
    )
    sanitized = _EMAIL_RE.sub("", sanitized)
    sanitized = _PHONE_RE.sub("", sanitized)
    sanitized = _SSN_RE.sub("", sanitized)
    sanitized = _ADDRESS_RE.sub("", sanitized)

    for term in sorted(_known_private_terms(session_state), key=len, reverse=True):
        sanitized = re.sub(rf"\b{re.escape(term)}\b", "", sanitized, flags=re.I)

    # Legacy privacy guard for any medical wording that reaches this sanitizer.
    if re.search(r"\b(medicine|medication|pill|metformin|lisinopril|dizzy|pain|doctor|symptom|side effect)\b", sanitized, re.I):
        for term in sorted(_known_location_terms(session_state), key=len, reverse=True):
            sanitized = re.sub(rf"\b{re.escape(term)}\b", "", sanitized, flags=re.I)
        sanitized = re.sub(r"\b(in|near|around)\s*(?=$|[?.!,;:])", "", sanitized, flags=re.I)
        sanitized = re.sub(r"\bmy\s+", "", sanitized, flags=re.I)
        sanitized = re.sub(r"\bI\s+(take|took|have|feel|felt|am|was)\b", r"a person \1", sanitized, flags=re.I)
        sanitized = re.sub(r"\bme\b", "a person", sanitized, flags=re.I)

    sanitized = _SPACE_RE.sub(" ", sanitized).strip(" ,.;:-")
    return sanitized


# ---------------------------------------------------------------------------
# Tool handler factory (closure over session_state)
# ---------------------------------------------------------------------------

def make_tool_handlers(session_state: dict) -> dict:
    """Create tool handler functions with session_state in closure scope.

    Args:
        session_state: Mutable dict with at minimum:
            - senior_id: str
            - senior: dict (senior profile)
            - reminders_delivered: set[str]

    Returns:
        Dict mapping tool name → async handler function.
    """

    def _find_reminder_delivery(deliveries: list, reminder_id: str) -> dict | None:
        needle = str(reminder_id or "").strip().lower()
        if not needle:
            return None

        def _normalize(value: str) -> str:
            return "".join(ch for ch in str(value or "").lower() if ch.isalnum())

        def _tokens(value: str) -> set[str]:
            stopwords = {"a", "an", "the", "to", "for", "with", "about", "and"}
            return {
                token
                for token in re.findall(r"[a-z0-9]+", str(value or "").lower())
                if len(token) > 2 and token not in stopwords
            }

        ordinal_patterns = (
            (0, r"(?:the\s+)?(?:first|1st|one|#?1)(?:\s+(?:one|reminder))?"),
            (1, r"(?:the\s+)?(?:second|2nd|two|#?2)(?:\s+(?:one|reminder))?"),
            (2, r"(?:the\s+)?(?:third|3rd|three|#?3)(?:\s+(?:one|reminder))?"),
            (3, r"(?:the\s+)?(?:fourth|4th|four|#?4)(?:\s+(?:one|reminder))?"),
            (4, r"(?:the\s+)?(?:fifth|5th|five|#?5)(?:\s+(?:one|reminder))?"),
        )
        for index, pattern in ordinal_patterns:
            if re.fullmatch(pattern, needle) and index < len(deliveries):
                delivery = deliveries[index]
                if isinstance(delivery, dict):
                    return delivery

        needle_normalized = _normalize(needle)
        needle_tokens = _tokens(needle)
        token_matches: list[tuple[int, int, dict]] = []
        for delivery in deliveries:
            if not isinstance(delivery, dict):
                continue
            candidates = (
                delivery.get("reminder_id"),
                delivery.get("id"),
                delivery.get("title"),
            )
            if any(str(value or "").strip().lower() == needle for value in candidates):
                return delivery
            if any(_normalize(value) == needle_normalized for value in candidates):
                return delivery
            title_tokens = _tokens(delivery.get("title") or "")
            if title_tokens and title_tokens <= needle_tokens:
                token_matches.append((len(title_tokens), len(_normalize(delivery.get("title") or "")), delivery))
            elif needle_tokens and needle_tokens <= title_tokens:
                token_matches.append((len(needle_tokens), -len(title_tokens), delivery))
        if token_matches:
            return max(token_matches, key=lambda match: (match[0], match[1]))[2]
        return None

    async def handle_search_memories(args: dict) -> dict:
        senior_id = session_state.get("senior_id")
        if not senior_id:
            return {"status": "success", "result": "No memories available right now. Continue naturally."}

        query = args.get("query", "")
        logger.info("Tool: search_memories senior={sid}", sid=str(senior_id)[:8])

        # Check prefetch cache first (instant return on hit)
        cache = session_state.get("_prefetch_cache")
        if cache:
            cached = cache.get(query)
            if cached:
                logger.info("Tool: search_memories CACHE HIT")
                formatted = "[MEMORY] " + "\n[MEMORY] ".join(
                    r["content"] for r in cached if r.get("content")
                )
                return {"status": "success", "result": formatted}

        try:
            from services.memory import search
            results = await search(senior_id, query, limit=3)
            if not results:
                return {"status": "success", "result": "No matching memories found."}
            formatted = "[MEMORY] " + "\n[MEMORY] ".join(
                r["content"] for r in results if r.get("content")
            )
            return {"status": "success", "result": formatted}
        except Exception as e:
            logger.error("search_memories error: {err}", err=str(e))
            return {"status": "success", "result": "Memory search unavailable. Continue naturally."}

    async def handle_web_search(args: dict) -> dict:
        import time as _time
        from lib.growthbook import is_on
        if not is_on("news_search_enabled", session_state):
            logger.info("Tool: web_search BLOCKED by news_search_enabled flag")
            return {"status": "success", "result": "Search unavailable. Continue naturally."}

        query = args.get("query", "")
        logger.info("Tool: web_search CALLED query_chars={n}", n=len(query))

        if not query:
            return {"status": "success", "result": "No query provided."}

        if _MEDICAL_SEARCH_RE.search(query):
            logger.info("Tool: web_search blocked medical query")
            return {
                "status": "success",
                "result": (
                    "Donna is not a medical or emergency service. Suggest they contact "
                    "a trusted person or qualified professional for medical questions."
                ),
            }

        sanitized_query = sanitize_web_search_query(query, session_state)
        if not sanitized_query:
            logger.warning("Tool: web_search empty after sanitization")
            return {"status": "success", "result": "I need a less personal search query for that."}
        if sanitized_query != query:
            logger.info(
                "Tool: web_search sanitized query original_chars={orig} sanitized_chars={san}",
                orig=len(query),
                san=len(sanitized_query),
            )

        # Duplicate-query guard. Surfaced by the mock-call harness on
        # 2026-05-24: Claude generated filler + tool_use, received the result,
        # then on the next inference round generated *another* filler + the
        # SAME tool_use — wasting 2-3 seconds of caller time per repeat.
        # Cache the last query + result per call (30s TTL) and short-circuit
        # repeats so Claude is forced to use the existing result. The schema
        # description also tells Claude not to repeat, but a model can ignore
        # that; the handler is the hard stop. 30s = long enough to cover one
        # Claude reasoning loop, short enough that a legitimate re-ask much
        # later in the same call still goes through.
        normalized_query = sanitized_query.strip().lower()
        last_search = session_state.get("_last_web_search") or {}
        if (
            last_search.get("query") == normalized_query
            and (_time.time() - float(last_search.get("at") or 0)) < 30
        ):
            logger.info(
                "Tool: web_search SUPPRESSED duplicate query within 30s — reusing cached result"
            )
            cached_result = last_search.get("result") or "I already shared what I found."
            return {
                "status": "success",
                "result": (
                    f"{cached_result}\n[NOTE: This is the same search you already ran in this call. "
                    f"Share the result you already have with the senior instead of calling again.]"
                ),
            }

        start = _time.time()
        try:
            from services.news import web_search_query
            result = await asyncio.wait_for(web_search_query(sanitized_query), timeout=15.0)
            elapsed_ms = round((_time.time() - start) * 1000)
            if not result:
                logger.info("Tool: web_search empty result ({ms}ms)", ms=elapsed_ms)
                empty_response = "I couldn't find reliable information about that."
                session_state["_last_web_search"] = {
                    "query": normalized_query,
                    "at": _time.time(),
                    "result": empty_response,
                }
                return {"status": "success", "result": empty_response}
            logger.info("Tool: web_search SUCCESS ({ms}ms, {n} chars)", ms=elapsed_ms, n=len(result))
            session_state["_last_web_search"] = {
                "query": normalized_query,
                "at": _time.time(),
                "result": f"[NEWS] {result}",
            }
            return {"status": "success", "result": f"[NEWS] {result}"}
        except asyncio.TimeoutError:
            elapsed_ms = round((_time.time() - start) * 1000)
            logger.warning("Tool: web_search TIMEOUT ({ms}ms)", ms=elapsed_ms)
            return {"status": "success", "result": "Search took too long. Continue naturally."}
        except Exception as e:
            import traceback
            elapsed_ms = round((_time.time() - start) * 1000)
            logger.error("Tool: web_search ERROR ({ms}ms): {err}\n{tb}", ms=elapsed_ms, err=str(e), tb=traceback.format_exc())
            return {"status": "success", "result": "Search unavailable. Continue naturally."}

    async def handle_mark_reminder(args: dict) -> dict:
        reminder_id = args.get("reminder_id", "")
        status = args.get("status", "acknowledged")
        user_response = args.get("user_response", "")
        logger.info("Tool: mark_reminder id={rid} status={s}", rid=reminder_id, s=status)

        # Local tracking is synchronous (critical for prompt context), but
        # post-call cleanup verifies the DB status before skipping retries.
        delivered = session_state.setdefault("reminders_delivered", set())
        deliveries = session_state.get("reminder_deliveries") or []
        delivery = _find_reminder_delivery(deliveries, reminder_id)
        if delivery is None:
            delivery = session_state.get("reminder_delivery") or {}

        if reminder_id:
            delivered.add(reminder_id)
        delivery_reminder_id = delivery.get("reminder_id") or delivery.get("id")
        if delivery_reminder_id:
            delivered.add(delivery_reminder_id)
        title = delivery.get("title")
        if title:
            delivered.add(title)

        session_state["_reminder_ack_attempted"] = True
        attempted_ids = session_state.setdefault("_reminder_ack_attempted_ids", set())
        for value in (reminder_id, delivery_reminder_id, title):
            if value:
                attempted_ids.add(value)

        async def _persist_ack():
            try:
                from services.reminder_delivery import mark_reminder_acknowledged
                delivery_id = delivery.get("id") if delivery else None
                if not delivery_id:
                    session_state["_reminder_ack_persisted"] = False
                    logger.warning("mark_reminder: no delivery_id in session")
                    return None

                row = await mark_reminder_acknowledged(delivery_id, status, user_response)
                session_state["_reminder_ack_persisted"] = bool(row)
                if row:
                    logger.info("mark_reminder persisted: {rid}", rid=reminder_id)
                else:
                    logger.warning("mark_reminder persistence returned no row: {rid}", rid=reminder_id)
                return row
            except Exception as e:
                session_state["_reminder_ack_persisted"] = False
                logger.error("mark_reminder persistence failed: {err}", err=str(e))
                return None

        if not (delivery.get("id") if delivery else None):
            session_state["_reminder_ack_persisted"] = False
            logger.warning("mark_reminder: no delivery_id in session")
            return {"status": "success", "result": "Reminder response noted."}

        try:
            task = asyncio.create_task(_persist_ack())
            session_state["_reminder_ack_task"] = task
            ack_tasks = session_state.setdefault("_reminder_ack_tasks", set())
            ack_tasks.add(task)
            task.add_done_callback(ack_tasks.discard)
        except Exception as e:
            session_state["_reminder_ack_persisted"] = False
            logger.error("mark_reminder scheduling failed: {err}", err=str(e))

        return {"status": "success", "result": f"Reminder marked as {status}."}

    async def handle_save_detail(args: dict) -> dict:
        detail = args.get("detail", "")
        category = args.get("category", "life_event")
        senior_id = session_state.get("senior_id")
        logger.info("Tool: save_important_detail cat={c} detail_chars={n}", c=category, n=len(detail))

        if not detail or not senior_id:
            return {"status": "success", "result": "Detail noted."}

        # Fire-and-forget: save in background
        async def _background_save():
            try:
                from services.memory import store
                category_to_type = {
                    "family": "relationship",
                    "preference": "preference",
                    "life_event": "fact",
                    "emotional": "fact",
                    "activity": "preference",
                }
                await store(
                    senior_id=senior_id,
                    type_=category_to_type.get(category, "fact"),
                    content=detail,
                    source="conversation",
                    importance=70,
                )
                logger.info("Background save_detail completed")
            except Exception as e:
                logger.error("Background save_detail failed: {err}", err=str(e))

        asyncio.create_task(_background_save())
        return {"status": "success", "result": f"I'll remember that: {detail[:50]}"}

    async def handle_create_reminder(args: dict) -> dict:
        senior_id = session_state.get("senior_id")
        if not senior_id:
            return {
                "status": "error",
                "result": "I can't save reminders for this caller. Continue naturally.",
            }

        title = (args.get("title") or "").strip()[:255]
        scheduled_time_str = (args.get("scheduled_time") or "").strip()
        reminder_type = (args.get("type") or "custom").strip().lower()
        description = args.get("description")
        frequency = (args.get("frequency") or "one-time").strip().lower()
        recurring_days_input = args.get("recurring_days") or []

        if not title:
            return {
                "status": "error",
                "result": "I need a title. Ask them what to remind them about.",
            }

        if reminder_type not in {"custom", "social"}:
            reminder_type = "custom"

        if frequency not in {"daily", "weekly", "one-time"}:
            frequency = "one-time"

        # Map English weekday codes to JS Date.getDay() integers (0=Sun..6=Sat).
        day_map = {"Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6}
        recurring_days: list[int] = []
        if frequency == "weekly":
            for d in recurring_days_input:
                if isinstance(d, str) and d.capitalize() in day_map:
                    recurring_days.append(day_map[d.capitalize()])
                elif isinstance(d, int) and 0 <= d <= 6:
                    recurring_days.append(d)
            recurring_days = sorted(set(recurring_days))
            if not recurring_days:
                return {
                    "status": "error",
                    "result": "I need to know which days. Ask them which days of the week.",
                }

        try:
            from datetime import datetime
            scheduled_time = datetime.fromisoformat(scheduled_time_str)
        except (ValueError, TypeError):
            logger.warning(
                "Tool: create_reminder bad scheduled_time={t}", t=scheduled_time_str[:80]
            )
            return {
                "status": "error",
                "result": "I couldn't parse that time. Ask them for the date and time again.",
            }

        senior = session_state.get("senior") or {}
        timezone_name = senior.get("timezone") or "America/New_York"

        try:
            from services.reminder_management import create_reminder
            result = await create_reminder(
                senior_id=senior_id,
                reminder_type=reminder_type,
                title=title,
                description=description,
                scheduled_time=scheduled_time,
                frequency=frequency,
                recurring_days=recurring_days,
                timezone_name=timezone_name,
            )
        except Exception as e:
            logger.error("Tool: create_reminder DB insert failed: {err}", err=str(e))
            return {
                "status": "error",
                "result": "I had trouble saving that reminder. Try again in a moment.",
            }

        logger.info(
            "Tool: create_reminder saved rid={rid} schedule_id={sched} senior={sid} freq={f}",
            rid=str(result.get("reminder", {}).get("id"))[:8],
            sched=str(result.get("schedule_item_id"))[:8],
            sid=str(senior_id)[:8],
            f=frequency,
        )
        return {"status": "success", "result": f"Reminder saved: {title}"}

    async def handle_check_caregiver_notes(args: dict) -> dict:
        logger.info("Tool: check_caregiver_notes")

        # Check pre-fetched notes first (from call start)
        notes = session_state.get("_caregiver_notes_content") or []
        if notes:
            formatted = "\n".join(
                f"- {n.get('content', '') if isinstance(n, dict) else str(n)}"
                for n in notes if (n.get("content") if isinstance(n, dict) else n)
            )
            return {"status": "success", "result": f"[CAREGIVER NOTES]\n{formatted}"}

        # Fallback: check DB
        senior_id = session_state.get("senior_id")
        if not senior_id:
            return {"status": "success", "result": "No caregiver notes at this time."}

        try:
            from services.caregivers import get_pending_notes
            notes_db = await get_pending_notes(senior_id)
            if not notes_db:
                return {"status": "success", "result": "No caregiver notes at this time."}
            formatted = "\n".join(f"- {n.get('content', '')}" for n in notes_db)
            return {"status": "success", "result": f"[CAREGIVER NOTES]\n{formatted}"}
        except Exception as e:
            logger.error("check_caregiver_notes error: {err}", err=str(e))
            return {"status": "success", "result": "No caregiver notes at this time."}

    handlers = {
        "search_memories": handle_search_memories,
        "web_search": handle_web_search,
        "mark_reminder_acknowledged": handle_mark_reminder,
        "create_reminder": handle_create_reminder,
        "save_important_detail": handle_save_detail,
        "check_caregiver_notes": handle_check_caregiver_notes,
    }

    # Wrap each handler to track tools_used in session_state for metrics
    tools_used = session_state.setdefault("_tools_used", [])

    def _wrap(name, fn):
        async def tracked(args):
            turn_sequence = session_state.get("_current_turn_sequence")
            if name not in tools_used:
                tools_used.append(name)
            logger.info("Tool CALL: {name}", name=name)
            record_context_event(
                session_state,
                source="tool",
                action="called",
                label=f"{name} called",
                provider="llm_tool",
                turn_sequence=turn_sequence,
                metadata={"tool": name, "arguments": args or {}},
            )
            start = time.time()
            result = await fn(args)
            elapsed_ms = round((time.time() - start) * 1000)
            result_text = result.get("result", "") if isinstance(result, dict) else str(result)
            record_latency_event(
                session_state,
                stage=f"tool.{name}",
                source=name,
                action="result",
                label=f"{name} result",
                content=result_text,
                provider="llm_tool",
                latency_ms=elapsed_ms,
                turn_sequence=turn_sequence,
                metadata={
                    "tool": name,
                    "status": result.get("status", "?") if isinstance(result, dict) else "unknown",
                    "result_chars": len(str(result_text)),
                },
            )
            logger.info(
                "Tool RESULT: {name} -> {status} result_chars={n}",
                name=name,
                status=result.get("status", "?"),
                n=len(str(result.get("result", ""))),
            )
            return result
        return tracked

    return {name: _wrap(name, fn) for name, fn in handlers.items()}


def make_flows_tools(session_state: dict) -> dict[str, FlowsFunctionSchema]:
    """Create FlowsFunctionSchema instances for use with Pipecat Flows.

    Returns dict mapping tool name → FlowsFunctionSchema.

    IMPORTANT — only 3 subscriber-call tools are exposed to Claude. The others are intentionally
    excluded because exposing them would cost ~4.3s per call (two sequential LLM
    round trips: one to generate the tool call, one to respond after seeing the
    result). Each excluded tool has a zero-latency alternative:

    - search_memories: EXCLUDED — the Director prefetches memories on every
      interim transcription and injects them as ephemeral context before Claude
      ever processes the turn (500ms gate, usually 0ms on cache hit). Giving
      Claude this tool causes it to fetch memories it already has, at 4.3s cost.

    - save_important_detail: EXCLUDED — post-call extract_from_conversation
      (Gemini) extracts all important details from the full transcript after
      the call ends. In-call saving is redundant and adds latency.

    - check_caregiver_notes: EXCLUDED — notes are hydrated at call start
      (Telnyx call metadata setup) and injected directly into the system
      prompt. Claude already has them before the first word is spoken.
    """
    handlers = make_tool_handlers(session_state)

    all_schemas = [
        get_web_search_schema(session_state),
        MARK_REMINDER_SCHEMA,
        CREATE_REMINDER_SCHEMA,
    ]

    schemas = {}
    for schema_def in all_schemas:
        name = schema_def["name"]
        schemas[name] = FlowsFunctionSchema(
            name=name,
            description=schema_def["description"],
            properties=schema_def["properties"],
            required=schema_def["required"],
            handler=handlers[name],
        )

    return schemas


def make_onboarding_flows_tools(session_state: dict) -> dict[str, FlowsFunctionSchema]:
    """Create FlowsFunctionSchema instances for onboarding calls.

    Returns: web_search only (prospect details are extracted post-call).
    """
    subscriber_handlers = make_tool_handlers(session_state)

    schemas = {}

    # web_search (for onboarding too)
    web_search_schema = get_web_search_schema(session_state)
    schemas["web_search"] = FlowsFunctionSchema(
        name=web_search_schema["name"],
        description=web_search_schema["description"],
        properties=web_search_schema["properties"],
        required=web_search_schema["required"],
        handler=subscriber_handlers["web_search"],
    )

    return schemas


# ---------------------------------------------------------------------------
# Consent call tools (call_type="consent")
# See docs/plans/2026-05-24-consent-and-discovery-call-flows.md
# ---------------------------------------------------------------------------

RECORD_CONSENT_RESPONSE_SCHEMA = {
    "name": "record_consent_response",
    "description": (
        "Capture the senior's yes/no answer to the combined consent question "
        "(\"is it okay to call you regularly AND record our calls?\"). Call "
        "exactly ONCE per consent call, immediately after the senior gives a "
        "clear answer — confirm fuzzy answers before calling. Pass the senior's "
        "actual words in senior_quote — do not paraphrase. This writes to the "
        "senior_consents audit table and rolls up seniors.consent_status / callable."
    ),
    "properties": {
        "granted": {
            "type": "boolean",
            "description": (
                "True if the senior said yes to BOTH calling and recording. "
                "False if they said no to either or to both — any 'no' is a "
                "full decline."
            ),
        },
        "senior_quote": {
            "type": "string",
            "description": (
                "The senior's actual verbatim words confirming this consent "
                "(e.g., 'Yeah that's fine' or 'No I'd rather not'). Do NOT paraphrase."
            ),
        },
    },
    "required": ["granted"],
}


def make_consent_flows_tools(session_state: dict) -> dict[str, FlowsFunctionSchema]:
    """Create FlowsFunctionSchema for consent calls.

    Returns: record_consent_response only. Consent calls are intentionally
    stripped — no web search, no memory, no caregiver notes. Single-decision
    model: one combined consent per call (see migration 019).
    """

    async def handle_record_consent(args: dict) -> dict:
        from services.seniors import record_consent

        senior_id = session_state.get("senior_id")
        if not senior_id:
            logger.warning("record_consent_response called with no senior_id")
            return {
                "status": "error",
                "result": "I'm having trouble saving that. Let me try again.",
            }

        granted = bool(args.get("granted"))
        senior_quote = (args.get("senior_quote") or "").strip() or None

        # Idempotency: refuse a second capture in the same call. The model is
        # instructed once-per-call; this is the hard stop. The first answer wins.
        if session_state.get("_consent_captured") is not None:
            prior = session_state["_consent_captured"]
            logger.info(
                "record_consent_response: duplicate suppressed (prior granted={g})",
                g=prior.get("granted"),
            )
            return {
                "status": "success",
                "result": (
                    f"Already captured granted={prior.get('granted')} this call. "
                    "Move on — do not re-ask."
                ),
            }

        conversation_id = session_state.get("conversation_id")
        try:
            result = await record_consent(
                senior_id=senior_id,
                conversation_id=conversation_id,
                granted=granted,
                senior_quote=senior_quote,
                captured_by="donna_tool",
            )
        except Exception as e:
            logger.error("record_consent_response DB error: {err}", err=str(e))
            return {
                "status": "error",
                "result": "I had trouble saving that. Let me try once more.",
            }

        session_state["_consent_captured"] = {
            "granted": granted,
            "rolled_up_status": result.get("rolled_up_status"),
            "captured_at": result.get("captured_at"),
        }
        session_state["_consent_rolled_up_status"] = result.get("rolled_up_status")
        return {
            "status": "success",
            "result": f"Recorded consent granted={granted}.",
        }

    schemas: dict[str, FlowsFunctionSchema] = {}
    schemas["record_consent_response"] = FlowsFunctionSchema(
        name=RECORD_CONSENT_RESPONSE_SCHEMA["name"],
        description=RECORD_CONSENT_RESPONSE_SCHEMA["description"],
        properties=RECORD_CONSENT_RESPONSE_SCHEMA["properties"],
        required=RECORD_CONSENT_RESPONSE_SCHEMA["required"],
        handler=handle_record_consent,
    )
    return schemas


# ---------------------------------------------------------------------------
# Discovery call tools (call_type="discovery")
# See docs/plans/2026-05-24-consent-and-discovery-call-flows.md
# ---------------------------------------------------------------------------

# Map discovery categories → memories.type values. Source-of-truth list lives
# in db/schema.js (memories.type = fact|preference|event|concern|relationship).
_DISCOVERY_CATEGORY_TO_MEMORY_TYPE = {
    "friend": "relationship",
    "family": "relationship",
    "hobby": "preference",
    "interest": "preference",
    "routine": "fact",
}

RECORD_DISCOVERY_FACT_SCHEMA = {
    "name": "record_discovery_fact",
    "description": (
        "Capture a specific fact the senior just shared about themselves — a friend "
        "or family member, a hobby, an interest, a routine. Use their own words for "
        "content; do not paraphrase or guess. Call between turns, naturally, "
        "without pausing the conversation. Only capture things they STATED — do "
        "not call this for things you inferred."
    ),
    "properties": {
        "category": {
            "type": "string",
            "enum": ["friend", "hobby", "interest", "routine", "family"],
            "description": (
                "What kind of fact this is. friend = someone they see socially. "
                "family = a relative. hobby = something they actively do. "
                "interest = a topic/thing they care about. routine = a recurring activity."
            ),
        },
        "content": {
            "type": "string",
            "description": (
                "The fact in 1-2 short sentences, using the senior's words where "
                "possible. Example: \"Plays bridge every Thursday at the church with "
                "Eleanor and two other friends.\""
            ),
        },
        "confidence": {
            "type": "string",
            "enum": ["stated", "inferred"],
            "description": (
                "stated = the senior directly said this. inferred = you read between "
                "the lines. Prefer stated; only use inferred for clear context like "
                "\"my husband Frank\" → spouse relationship."
            ),
        },
    },
    "required": ["category", "content"],
}


def make_discovery_flows_tools(session_state: dict) -> dict[str, FlowsFunctionSchema]:
    """Create FlowsFunctionSchema for discovery calls.

    Returns: record_discovery_fact + web_search. No reminder/memory-search
    tools — Director handles memory retrieval; web_search lets Donna riff on
    things the senior brings up (weather, news, etc.).
    """
    subscriber_handlers = make_tool_handlers(session_state)
    captured_facts = session_state.setdefault("_discovery_facts", [])

    async def handle_record_discovery_fact(args: dict) -> dict:
        from services.memory import store

        senior_id = session_state.get("senior_id")
        if not senior_id:
            logger.warning("record_discovery_fact called with no senior_id")
            return {"status": "error", "result": "Continue naturally."}

        category = (args.get("category") or "").strip().lower()
        if category not in _DISCOVERY_CATEGORY_TO_MEMORY_TYPE:
            return {
                "status": "error",
                "result": f"Invalid category: {category}.",
            }

        content = (args.get("content") or "").strip()
        if not content:
            return {"status": "error", "result": "Empty content — skipped."}

        confidence = (args.get("confidence") or "stated").strip().lower()
        if confidence not in ("stated", "inferred"):
            confidence = "stated"

        # Buffered for post-call profile_suggestions extractor. Memory write
        # is fire-and-forget — Donna shouldn't wait on embeddings.
        captured_facts.append({
            "category": category,
            "content": content,
            "confidence": confidence,
            "captured_at_turn": session_state.get("_current_turn_sequence"),
        })

        async def _background_store():
            try:
                # stated → importance 80, inferred → 60. Caregiver review
                # surface should weight these similarly when proposing
                # profile updates.
                importance = 80 if confidence == "stated" else 60
                await store(
                    senior_id=senior_id,
                    type_=_DISCOVERY_CATEGORY_TO_MEMORY_TYPE[category],
                    content=content,
                    source=session_state.get("conversation_id") or "discovery",
                    importance=importance,
                    metadata={
                        "discovery_category": category,
                        "discovery_confidence": confidence,
                    },
                )
            except Exception as e:
                logger.error("record_discovery_fact background store failed: {err}", err=str(e))

        asyncio.create_task(_background_store())
        return {"status": "success", "result": f"Captured {category}: {content[:60]}"}

    schemas: dict[str, FlowsFunctionSchema] = {}
    schemas["record_discovery_fact"] = FlowsFunctionSchema(
        name=RECORD_DISCOVERY_FACT_SCHEMA["name"],
        description=RECORD_DISCOVERY_FACT_SCHEMA["description"],
        properties=RECORD_DISCOVERY_FACT_SCHEMA["properties"],
        required=RECORD_DISCOVERY_FACT_SCHEMA["required"],
        handler=handle_record_discovery_fact,
    )

    web_search_schema = get_web_search_schema(session_state)
    schemas["web_search"] = FlowsFunctionSchema(
        name=web_search_schema["name"],
        description=web_search_schema["description"],
        properties=web_search_schema["properties"],
        required=web_search_schema["required"],
        handler=subscriber_handlers["web_search"],
    )

    return schemas


# ---------------------------------------------------------------------------
# Tool factory dispatch
# ---------------------------------------------------------------------------

# call_type → factory function. Used by bot.py (real calls) and by the
# live-sim pipeline (tests/simulation/pipeline.py) so mock-call scenarios
# expose the same tool set Donna would see on a real call. Register new
# flows here when adding a call type with its own tool set.
_CALL_TYPE_TOOL_FACTORIES = {
    "onboarding": make_onboarding_flows_tools,
    "consent": make_consent_flows_tools,
    "discovery": make_discovery_flows_tools,
}


def select_flows_tools(session_state: dict) -> dict[str, FlowsFunctionSchema]:
    """Pick the tool factory for this call_type. Defaults to the subscriber stack."""
    call_type = (session_state or {}).get("call_type", "")
    factory = _CALL_TYPE_TOOL_FACTORIES.get(call_type, make_flows_tools)
    return factory(session_state)
