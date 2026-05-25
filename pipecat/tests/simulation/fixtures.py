"""Test fixtures -- seed data for simulation tests.

Provides ``TestSenior``, a lightweight dataclass representing a senior profile
used by scenario definitions, plus DB seed/cleanup functions for integration
tests that run against a real Neon database (``DATABASE_URL``).

DB functions:
- ``seed_test_senior``        -- inserts senior + 5 memories with embeddings
- ``create_test_conversation`` -- inserts an in-progress conversation record
- ``build_session_state``     -- assembles a dict matching what ``bot.py`` produces
- ``cleanup_test_senior``     -- deletes all related rows across 8 tables
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

from loguru import logger


# ---------------------------------------------------------------------------
# TestSenior dataclass
# ---------------------------------------------------------------------------


@dataclass
class TestSenior:
    __test__ = False  # Prevent pytest from trying to collect this as a test class
    """Senior profile used in simulation scenarios.

    Mirrors the columns that matter for call behaviour.  When used with
    ``seed_test_senior`` the profile is written to the real ``seniors`` table;
    for unit tests the dataclass can be used standalone without a database.

    Attributes:
        id: Valid UUID string for the ``seniors.id`` column.
        name: Display name used in greetings and prompts.
        phone: 10-digit phone number (not dialled in sim tests).
        timezone: IANA timezone for scheduling logic.
        interests: List of interest strings injected into the system prompt.
        profile_notes: Profile notes available to the pipeline.
        city: City for weather/news personalisation.
        state: US state abbreviation.
    """

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = "Margaret Simulation"
    phone: str = "5551234567"
    timezone: str = "America/New_York"
    interests: list[str] = field(default_factory=lambda: [
        "gardening", "cooking", "grandchildren", "bird watching", "crossword puzzles",
    ])
    profile_notes: str = "Prefers gentle reminders and concise check-ins"
    city: str = "Dallas"
    state: str = "TX"


# ---------------------------------------------------------------------------
# Seed memories (content, type, importance)
# ---------------------------------------------------------------------------

SEED_MEMORIES: list[tuple[str, str, int]] = [
    ("Margaret planted new rose bushes in her garden last spring", "preference", 80),
    ("Her grandson Jake plays baseball for his high school team", "relationship", 85),
    ("She makes the best apple pie -- her grandmother's recipe", "preference", 70),
    ("Margaret's daughter Lisa visits every Sunday for dinner", "relationship", 75),
    ("She's been doing the crossword puzzle in the morning paper for 30 years", "preference", 65),
]

DEFAULT_CACHED_NEWS = (
    "The local garden show is this weekend featuring new rose varieties. "
    "Weather expected to be sunny with highs in the 70s."
)

_SENIOR_PROFILE_NOTES_COLUMN: str | None = None


def _pick_profile_notes_column(columns: set[str]) -> str:
    """Choose the active senior notes column during the rename migration."""
    if "profile_notes" in columns:
        return "profile_notes"
    if "medical_notes" in columns:
        return "medical_notes"
    return "profile_notes"


async def _senior_profile_notes_column() -> str:
    """Return the DB column used for senior profile notes in this environment."""
    global _SENIOR_PROFILE_NOTES_COLUMN
    if _SENIOR_PROFILE_NOTES_COLUMN:
        return _SENIOR_PROFILE_NOTES_COLUMN

    from db import query_many

    rows = await query_many(
        """SELECT column_name
             FROM information_schema.columns
            WHERE table_name = 'seniors'
              AND column_name IN ('profile_notes', 'medical_notes')"""
    )
    _SENIOR_PROFILE_NOTES_COLUMN = _pick_profile_notes_column(
        {str(row["column_name"]) for row in rows}
    )
    return _SENIOR_PROFILE_NOTES_COLUMN


# ---------------------------------------------------------------------------
# seed_test_senior
# ---------------------------------------------------------------------------


async def seed_test_senior(senior: TestSenior | None = None) -> TestSenior:
    """Insert a test senior into the database with realistic context.

    Creates:
    - Senior profile (``seniors`` table) with ``ON CONFLICT DO NOTHING``
    - 5 seed memories (``memories`` table) with real OpenAI embeddings
      when ``OPENAI_API_KEY`` is available, otherwise without embeddings
    - Cached news (``seniors.cached_news``)

    Returns the ``TestSenior`` instance (with its generated ``id``).
    """
    from db import execute

    senior = senior or TestSenior()
    notes_column = await _senior_profile_notes_column()

    # Insert senior -- ON CONFLICT guards against re-runs
    await execute(
        f"""INSERT INTO seniors (id, name, phone, timezone, interests,
               {notes_column}, cached_news, is_active, consent_status, callable)
            VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'pending', true)
            ON CONFLICT (id) DO NOTHING""",
        uuid.UUID(senior.id),
        senior.name,
        senior.phone,
        senior.timezone,
        senior.interests,
        senior.profile_notes,
        DEFAULT_CACHED_NEWS,
    )

    # Seed memories with real embeddings when possible
    for content, type_, importance in SEED_MEMORIES:
        embedding = None
        try:
            from services.memory import generate_embedding
            embedding = await generate_embedding(content)
        except Exception:
            pass

        mem_id = uuid.UUID(str(uuid.uuid4()))
        if embedding:
            emb_str = json.dumps(embedding)
            await execute(
                """INSERT INTO memories (id, senior_id, type, content, source, importance, embedding)
                   VALUES ($1, $2, $3, $4, 'seed', $5, $6::vector)
                   ON CONFLICT (id) DO NOTHING""",
                mem_id, uuid.UUID(senior.id), type_, content, importance, emb_str,
            )
        else:
            await execute(
                """INSERT INTO memories (id, senior_id, type, content, source, importance)
                   VALUES ($1, $2, $3, $4, 'seed', $5)
                   ON CONFLICT (id) DO NOTHING""",
                mem_id, uuid.UUID(senior.id), type_, content, importance,
            )

    logger.info("[Fixtures] Seeded test senior: {id} ({name})", id=senior.id, name=senior.name)
    return senior


# ---------------------------------------------------------------------------
# create_test_conversation
# ---------------------------------------------------------------------------


async def create_test_conversation(senior_id: str, call_type: str = "check-in") -> str:
    """Insert a conversation record with ``status='in_progress'``.

    Returns the conversation ID as a string.
    """
    from db import query_one

    call_sid = f"SIM-{uuid.uuid4().hex[:12]}"
    row = await query_one(
        """INSERT INTO conversations (senior_id, call_sid, started_at, status)
           VALUES ($1, $2, $3, 'in_progress')
           RETURNING id""",
        uuid.UUID(senior_id),
        call_sid,
        datetime.now(timezone.utc).replace(tzinfo=None),
    )
    conv_id = str(row["id"]) if row else ""
    logger.info("[Fixtures] Created conversation {cid} for senior {sid}", cid=conv_id[:8], sid=senior_id[:8])
    return conv_id


# ---------------------------------------------------------------------------
# build_session_state
# ---------------------------------------------------------------------------


async def build_session_state(
    senior: TestSenior,
    conversation_id: str,
    call_type: str = "check-in",
) -> dict:
    """Build a ``session_state`` dict matching what ``bot.py`` produces.

    Fetches real memory context from the database via ``services.memory.search``
    and generates a greeting via ``services.greetings.get_greeting``.
    """
    from services.memory import search as memory_search
    from services.greetings import get_greeting

    # Fetch memory context
    memory_results = await memory_search(senior.id, "general context", limit=10)
    memory_context = (
        "\n".join(r["content"] for r in memory_results if r.get("content"))
        if memory_results
        else ""
    )

    # Generate greeting
    greeting_result = get_greeting(
        senior_name=senior.name,
        timezone=senior.timezone,
        interests=senior.interests,
    )

    return {
        "senior_id": senior.id,
        "senior": {
            "id": senior.id,
            "name": senior.name,
            "phone": senior.phone,
            "timezone": senior.timezone,
            "interests": senior.interests,
            "profile_notes": senior.profile_notes,
            "interest_scores": None,
        },
        "memory_context": memory_context,
        "greeting": greeting_result.get("greeting", f"Hello, {senior.name}!"),
        "reminder_prompt": None,
        "reminder_delivery": None,
        "reminders_delivered": set(),
        "conversation_id": conversation_id,
        "call_sid": f"SIM-{uuid.uuid4().hex[:12]}",
        "call_type": call_type,
        "is_outbound": True,
        "previous_calls_summary": None,
        "recent_turns": None,
        "todays_context": None,
        "news_context": DEFAULT_CACHED_NEWS,
        "last_call_analysis": None,
        "_transcript": [],
        "_call_start_time": None,
    }


# ---------------------------------------------------------------------------
# cleanup_test_senior
# ---------------------------------------------------------------------------


async def cleanup_test_senior(senior_id: str) -> None:
    """Delete all data for a test senior across all related tables.

    Previously this ran ``DELETE FROM {table} WHERE senior_id = $1`` for
    every table — which silently no-op'd on ``seniors`` (column is ``id``)
    and on ``reminder_deliveries`` (no ``senior_id`` column at all; it
    links via ``reminder_id``). Both left rows behind, and the
    ``seniors_phone_unique`` constraint then blocked re-running the demo.

    This walks each table with its actual column / join.
    """
    from db import execute

    sid = uuid.UUID(senior_id)

    # Child tables that have a direct senior_id column. Phase 1 queue
    # tables may not exist on every environment, so we tolerate missing
    # tables at debug level.
    #
    # ORDER MATTERS: conversations comes after every table that has an FK
    # to conversations.id (post_call_jobs.conversation_id, call_attempts.
    # conversation_id, call_metrics.conversation_id where present). Otherwise
    # the conversations DELETE silently fails on FK violation and leaves
    # rows behind, which then blocks the final seniors DELETE.
    senior_id_tables = [
        # Tables that may also reference conversations.id — clear first.
        "call_metrics",
        "daily_call_context",
        "call_analyses",
        "memories",
        "caregivers",
        "call_attempts",
        "call_queue",
        "outbound_call_guards",
        "post_call_jobs",
        "scheduler_shadow_comparisons",
        "senior_call_schedules",
        "canary_cohort_membership",
        "senior_consents",  # ON DELETE CASCADE on seniors, but explicit is safer
        # conversations LAST so any conversation_id FKs above are already gone.
        "conversations",
    ]
    for table in senior_id_tables:
        try:
            await execute(f"DELETE FROM {table} WHERE senior_id = $1", sid)
        except Exception as exc:
            logger.debug("[Fixtures] Cleanup {t} skipped: {e}", t=table, e=str(exc))

    # reminder_deliveries links via reminder_id, not senior_id.
    try:
        await execute(
            """DELETE FROM reminder_deliveries
                WHERE reminder_id IN (SELECT id FROM reminders WHERE senior_id = $1)""",
            sid,
        )
    except Exception as exc:
        logger.debug("[Fixtures] Cleanup reminder_deliveries skipped: {e}", e=str(exc))

    try:
        await execute("DELETE FROM reminders WHERE senior_id = $1", sid)
    except Exception as exc:
        logger.debug("[Fixtures] Cleanup reminders skipped: {e}", e=str(exc))

    # Finally the seniors row itself — column is `id`, not `senior_id`.
    try:
        await execute("DELETE FROM seniors WHERE id = $1", sid)
    except Exception as exc:
        logger.debug("[Fixtures] Cleanup seniors row skipped: {e}", e=str(exc))

    logger.info("[Fixtures] Cleaned up test senior: {id}", id=senior_id[:8])
