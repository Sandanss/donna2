"""LLM-to-LLM voice simulation tests.

Runs Haiku (synthetic caller) against the real Donna pipeline with:
- Real Claude Haiku (LLM responses)
- Real Director (Groq speculative analysis)
- Real Quick Observer (268 regex patterns, goodbye detection)
- Real tool handlers (web_search -> Tavily, mark_reminder -> DB)
- Real post-call processing (analysis, memory extraction, daily context)
- Real Neon dev database

Requires: ANTHROPIC_API_KEY, DATABASE_URL
Optional: GROQ_API_KEY (Director), TAVILY_API_KEY (web search)

Run: cd pipecat && python -m pytest tests/test_live_simulation.py -v -m llm_simulation
"""

import asyncio
import os
import uuid

import pytest
import pytest_asyncio

from tests.simulation.fixtures import (
    TestSenior,
    cleanup_test_senior,
    create_test_conversation,
    seed_test_senior,
)
from tests.simulation.runner import run_simulated_call
from tests.simulation.scenarios import (
    consent_decline_scenario,
    consent_grant_scenario,
    discovery_scenario,
    memory_recall_scenario,
    memory_seed_scenario,
    reminder_scenario,
    web_search_scenario,
)

# ---------------------------------------------------------------------------
# Skip entire module if missing required env vars
# ---------------------------------------------------------------------------

pytestmark = [
    pytest.mark.llm_simulation,
    pytest.mark.skipif(
        not all(os.environ.get(k) for k in ["ANTHROPIC_API_KEY", "DATABASE_URL"]),
        reason="Requires ANTHROPIC_API_KEY and DATABASE_URL",
    ),
]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def test_senior():
    """Seed a test senior and clean up after the test.

    Uses pytest_asyncio.fixture (not pytest.fixture) so the async generator
    is materialised correctly under pytest-asyncio strict mode (1.x).
    """
    senior = await seed_test_senior()
    yield senior
    await cleanup_test_senior(senior.id)


# ---------------------------------------------------------------------------
# TestWebSearch
# ---------------------------------------------------------------------------


class TestWebSearch:
    """Tests that web search is triggered via the active tool path."""

    @pytest.mark.asyncio
    async def test_web_search_triggered(self, test_senior: TestSenior):
        """Run the web_search_scenario and verify search activity.

        The pipeline should satisfy a web search request through the tool path:
        1. Claude calls the ``web_search`` tool directly.
        """
        scenario = web_search_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        # The active search indicator should fire
        web_search_via_tool = "web_search" in result.tool_calls_made

        assert web_search_via_tool, (
            f"Expected web search activity but found none. "
            f"tool_calls={result.tool_calls_made}, "
            f"web_results={len(result.web_search_results)}, "
            f"fillers={len(result.fillers)}"
        )

        # Should have at least 2 conversational turns (greeting + response)
        assert len(result.turns) >= 2, (
            f"Expected at least 2 turns, got {len(result.turns)}"
        )

        # Average latency should be reasonable (under 30s)
        latencies = [
            t["latency_ms"]
            for t in result.turns
            if t.get("latency_ms") is not None
        ]
        if latencies:
            avg_latency = sum(latencies) / len(latencies)
            assert avg_latency < 30_000, (
                f"Average latency {avg_latency:.0f}ms exceeds 30s threshold"
            )


# ---------------------------------------------------------------------------
# TestMemoryAcrossCalls
# ---------------------------------------------------------------------------


class TestMemoryAcrossCalls:
    """Tests that memories seeded in one call can be recalled in the next."""

    @pytest.mark.asyncio
    async def test_memory_seed_then_recall(self, test_senior: TestSenior):
        """Two-call sequence: seed new facts, then verify recall.

        Call 1 (memory_seed_scenario):
          Margaret tells Donna about grandson Jake winning his baseball
          championship and her plans to visit daughter Lisa in Florida.
          Post-call processing extracts these as new memories.

        Call 2 (memory_recall_scenario):
          Margaret asks Donna if she remembers Jake's game and mentions
          the Florida trip again. The Director should inject relevant
          memories, or Donna should reference them in her response.
        """
        # -- Call 1: Seed memories --
        seed_scenario = memory_seed_scenario()
        seed_result = await run_simulated_call(
            seed_scenario,
            senior=test_senior,
            run_post_call_processing=True,
        )

        # Wait for async memory extraction to complete
        await asyncio.sleep(3)

        # Verify memories were saved to DB
        from db import query

        rows = await query(
            """SELECT content FROM memories
               WHERE senior_id = $1
                 AND source = 'conversation'
            """,
            uuid.UUID(test_senior.id),
        )

        # Post-call should have extracted at least one memory
        assert rows is not None and len(rows) > 0, (
            "Expected post-call memory extraction to save at least one "
            "memory with source='conversation'"
        )

        # -- Call 2: Recall memories --
        recall_scenario = memory_recall_scenario()
        recall_result = await run_simulated_call(
            recall_scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        # Donna should reference the seeded topics in her responses, OR
        # the Director should have injected relevant memories
        donna_text = " ".join(
            t["donna"].lower()
            for t in recall_result.turns
            if t.get("donna")
        )

        memory_keywords = ["jake", "baseball", "lisa", "florida"]
        keyword_mentioned = any(kw in donna_text for kw in memory_keywords)
        memories_injected = len(recall_result.injected_memories) > 0

        assert keyword_mentioned or memories_injected, (
            f"Expected Donna to reference seeded topics or Director to "
            f"inject memories. Keywords in Donna text: "
            f"{[kw for kw in memory_keywords if kw in donna_text]}, "
            f"injected_memories: {len(recall_result.injected_memories)}"
        )


# ---------------------------------------------------------------------------
# TestReminderAcknowledgment
# ---------------------------------------------------------------------------


class TestReminderAcknowledgment:
    """Tests that medication reminders are delivered and acknowledged."""

    @pytest.mark.asyncio
    async def test_reminder_delivered_and_acknowledged(
        self, test_senior: TestSenior
    ):
        """Run the reminder scenario and verify tool call + mention.

        The reminder scenario is a ``call_type="reminder"`` call where
        Margaret receives a metformin reminder and acknowledges it.
        The pipeline should invoke ``mark_reminder_acknowledged`` and
        mention the medication in Donna's speech.
        """
        scenario = reminder_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        # The mark_reminder_acknowledged tool should have been called
        assert "mark_reminder_acknowledged" in result.tool_calls_made, (
            f"Expected 'mark_reminder_acknowledged' in tool calls, "
            f"got: {result.tool_calls_made}"
        )

        # Donna should mention metformin or medication in her responses
        donna_text = " ".join(
            t["donna"].lower()
            for t in result.turns
            if t.get("donna")
        )
        assert "metformin" in donna_text or "medication" in donna_text, (
            f"Expected Donna to mention 'metformin' or 'medication'. "
            f"Donna said: {donna_text[:500]}"
        )


# ---------------------------------------------------------------------------
# TestCallMetrics
# ---------------------------------------------------------------------------


class TestCallMetrics:
    """Tests that latency metrics are captured for each turn."""

    @pytest.mark.asyncio
    async def test_latency_recorded(self, test_senior: TestSenior):
        """Run a scenario and verify per-turn latency is recorded.

        Uses the web_search_scenario (skipping post-call for speed) and
        checks that at least one turn has a valid latency measurement.
        """
        scenario = web_search_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        latencies = [
            t["latency_ms"]
            for t in result.turns
            if t.get("latency_ms") is not None
        ]

        # At least one turn should have a recorded latency
        assert len(latencies) > 0, (
            f"Expected at least one turn with recorded latency, "
            f"got {len(result.turns)} turns with no latency data"
        )

        # Each recorded latency should be positive and under 60s
        for lat in latencies:
            assert lat > 0, f"Latency should be positive, got {lat}ms"
            assert lat < 60_000, (
                f"Latency {lat:.0f}ms exceeds 60s — likely a hang"
            )


# ---------------------------------------------------------------------------
# TestConsentCall
# ---------------------------------------------------------------------------


class TestConsentCall:
    """End-to-end consent flow: run a simulated call, verify DB writes.

    These tests are the answer to "did the consent flow actually update the
    database correctly?". They:
      1. Seed a TestSenior — defaults to consent_status='pending' via the
         column DEFAULT from migration 014.
      2. Run consent_grant_scenario / consent_decline_scenario through the
         real pipeline (real Claude Haiku, real Director-bypass path, real
         Pipecat Flows, real DB tool handler).
      3. Assert senior_consents has the expected rows and seniors has the
         expected rolled-up state.

    These calls exercise the record_consent_response tool, which is the
    only way two rows land in senior_consents during a consent call.
    """

    @pytest.mark.asyncio
    async def test_consent_grant_persists_one_row_and_rolls_up_granted(
        self, test_senior: TestSenior
    ):
        """consent_grant: combined yes → senior_consents has 1 granted row
        (consent_type='call_and_recording'), seniors.consent_status='granted',
        seniors.callable=true."""
        from db import query_many, query_one

        # Sanity check the precondition: a fresh test senior starts pending.
        # The migration backfilled existing seniors to 'granted', but newly
        # inserted seniors get the DEFAULT 'pending' value.
        before = await query_one(
            "SELECT consent_status, callable FROM seniors WHERE id = $1",
            uuid.UUID(test_senior.id),
        )
        assert before["consent_status"] == "pending", (
            f"Test fixture should start at 'pending', got {before['consent_status']}"
        )
        assert before["callable"] is True

        # Run the simulated call. Post-call processing OFF — consent calls
        # already skip the heavy post-call analysis path, and we don't need
        # any of it for this assertion.
        scenario = consent_grant_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        # Give the in-transaction tool handler a tick to settle (DB writes
        # happen synchronously inside the handler, so this is belt-and-braces).
        await asyncio.sleep(0.5)

        # 1. Single-decision model: exactly one row, granted=true.
        consent_rows = await query_many(
            """SELECT consent_type, granted, captured_at
               FROM senior_consents
               WHERE senior_id = $1
               ORDER BY captured_at""",
            uuid.UUID(test_senior.id),
        )
        assert consent_rows and len(consent_rows) == 1, (
            f"Expected exactly one senior_consents row, got {len(consent_rows or [])}. "
            f"Tool calls: {result.tool_calls_made}"
        )
        row = consent_rows[0]
        assert row["consent_type"] == "call_and_recording", (
            f"Expected consent_type='call_and_recording', got {row['consent_type']}"
        )
        assert row["granted"] is True

        # 2. Rolled-up seniors columns should reflect granted.
        after = await query_one(
            """SELECT consent_status, callable, consent_date
               FROM seniors WHERE id = $1""",
            uuid.UUID(test_senior.id),
        )
        assert after["consent_status"] == "granted", (
            f"Expected consent_status='granted', got {after['consent_status']}"
        )
        assert after["callable"] is True
        assert after["consent_date"] is not None

        # 3. The tool actually fired (this is what the integration is proving).
        assert "record_consent_response" in result.tool_calls_made, (
            f"Expected record_consent_response to be called. "
            f"Got tool_calls={result.tool_calls_made}"
        )

    @pytest.mark.asyncio
    async def test_consent_decline_flips_callable_false(
        self, test_senior: TestSenior
    ):
        """consent_decline scenario: combined no → senior_consents has 1
        granted=false row, seniors.consent_status='declined', callable=false."""
        from db import query_many, query_one

        scenario = consent_decline_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        await asyncio.sleep(0.5)

        # Single-decision model: exactly one row, granted=false.
        consent_rows = await query_many(
            """SELECT consent_type, granted
               FROM senior_consents
               WHERE senior_id = $1
               ORDER BY captured_at""",
            uuid.UUID(test_senior.id),
        )
        assert consent_rows and len(consent_rows) == 1, (
            f"Expected exactly one senior_consents row, got {len(consent_rows or [])}. "
            f"Tool calls: {result.tool_calls_made}"
        )
        row = consent_rows[0]
        assert row["consent_type"] == "call_and_recording"
        assert row["granted"] is False, (
            "Persona declined — granted should be False"
        )

        # Rolled-up state: declined consent flips both consent_status and the
        # callable gate the scheduler reads.
        after = await query_one(
            "SELECT consent_status, callable FROM seniors WHERE id = $1",
            uuid.UUID(test_senior.id),
        )
        assert after["consent_status"] == "declined", (
            f"Expected consent_status='declined', got {after['consent_status']}"
        )
        assert after["callable"] is False, (
            "callable should flip to false on consent decline — "
            "this is what gates the scheduler from dispatching"
        )


# ---------------------------------------------------------------------------
# TestDiscoveryCall
# ---------------------------------------------------------------------------


class TestDiscoveryCall:
    """End-to-end discovery flow: verify facts land in memories AND the
    caregiver-reviewable profile_suggestions JSONB on conversations."""

    @pytest.mark.asyncio
    async def test_discovery_writes_profile_suggestions_and_memories(
        self, test_senior: TestSenior
    ):
        """discovery_scenario: senior shares friends, routines, family.
        Expect record_discovery_fact invoked multiple times; post-call
        snapshots the buffer to conversations.profile_suggestions."""
        from db import query_many, query_one

        scenario = discovery_scenario()
        # Post-call processing ON — that's what writes profile_suggestions.
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=True,
        )

        # The async memory.store + post-call writer both run in the
        # background; give them time to settle.
        await asyncio.sleep(3)

        # 1. The discovery tool actually fired.
        assert "record_discovery_fact" in result.tool_calls_made, (
            f"Expected record_discovery_fact tool call. "
            f"Got tool_calls={result.tool_calls_made}"
        )

        # 2. The most recent conversation for this senior should have a
        #    populated profile_suggestions payload.
        conv = await query_one(
            """SELECT id, profile_suggestions
               FROM conversations
               WHERE senior_id = $1
               ORDER BY started_at DESC
               LIMIT 1""",
            uuid.UUID(test_senior.id),
        )
        assert conv is not None, "Expected at least one conversation row"
        assert conv["profile_suggestions"] is not None, (
            "Expected profile_suggestions to be written by the discovery "
            "post-call writer"
        )

        # Payload is asyncpg-decoded JSONB → dict in Python.
        payload = conv["profile_suggestions"]
        if isinstance(payload, str):
            import json
            payload = json.loads(payload)
        facts = payload.get("facts") or []
        assert len(facts) > 0, (
            f"Expected at least one captured discovery fact, got {payload}"
        )
        # Categories should be valid enums.
        valid_cats = {"friend", "hobby", "interest", "routine", "family"}
        for f in facts:
            assert f.get("category") in valid_cats, (
                f"Unexpected category {f.get('category')} in {f}"
            )

        # 3. record_discovery_fact also writes into memories (fire-and-forget).
        memory_rows = await query_many(
            """SELECT id FROM memories
               WHERE senior_id = $1
                 AND metadata->>'discovery_category' IS NOT NULL""",
            uuid.UUID(test_senior.id),
        )
        assert memory_rows is not None and len(memory_rows) > 0, (
            "Expected at least one memory row tagged with discovery_category. "
            "The background memory.store may have raced past the test window — "
            "if this flakes, bump the sleep above."
        )
