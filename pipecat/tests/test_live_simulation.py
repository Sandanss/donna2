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
import re
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
    async_search_overlap_scenario,
    cognitive_confusion_scenario,
    embedding_outage_scenario,
    false_goodbye_scenario,
    health_concern_scenario,
    low_engagement_scenario,
    memory_recall_scenario,
    memory_seed_scenario,
    multiple_reminders_scenario,
    reminder_scenario,
    reminder_creation_scenario,
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


@pytest_asyncio.fixture(loop_scope="module")
async def test_senior():
    """Seed a test senior and clean up after the test."""
    senior = await seed_test_senior(_fresh_test_senior())
    yield senior
    await cleanup_test_senior(senior.id)


def _fresh_test_senior(template: TestSenior | None = None) -> TestSenior:
    """Create an isolated senior profile for a live simulation run."""
    template = template or TestSenior()
    unique_suffix = uuid.uuid4().hex[:8]
    return TestSenior(
        id=str(uuid.uuid4()),
        name=f"{template.name.split()[0]} Sim-{unique_suffix[:6]}",
        phone=f"555{int(unique_suffix, 16) % 10_000_000:07d}",
        timezone=template.timezone,
        interests=list(template.interests),
        profile_notes=template.profile_notes,
        city=template.city,
        state=template.state,
    )


async def _run_with_scenario_senior(scenario, *, run_post_call_processing=False):
    """Run a scenario against its own senior profile and always clean up."""
    senior = await seed_test_senior(_fresh_test_senior(scenario.senior))
    try:
        return await run_simulated_call(
            scenario,
            senior=senior,
            run_post_call_processing=run_post_call_processing,
        )
    finally:
        await cleanup_test_senior(senior.id)


# ---------------------------------------------------------------------------
# TestWebSearch
# ---------------------------------------------------------------------------


class TestWebSearch:
    """Tests that web search is triggered via the active tool path."""

    @pytest.mark.asyncio(loop_scope="module")
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

    @pytest.mark.asyncio(loop_scope="module")
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
        from db import query_many

        rows = await query_many(
            """SELECT content FROM memories
               WHERE senior_id = $1
                 AND source = $2
            """,
            uuid.UUID(test_senior.id),
            seed_result.conversation_id,
        )

        # Post-call should have extracted at least one memory
        assert rows is not None and len(rows) > 0, (
            "Expected post-call memory extraction to save at least one "
            "memory linked to the seed conversation"
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
    """Tests that everyday reminders are delivered and acknowledged."""

    @pytest.mark.asyncio(loop_scope="module")
    async def test_reminder_delivered_and_acknowledged(
        self, test_senior: TestSenior
    ):
        """Run the reminder scenario and verify tool call + mention.

        The reminder scenario is a ``call_type="reminder"`` call where
        Margaret receives a household reminder and acknowledges it.
        The pipeline should invoke ``mark_reminder_acknowledged`` and
        mention the reminder in Donna's speech.
        """
        scenario = reminder_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        # Donna should bring up the reminder in the opening hello/intro.
        opening_text = (result.initial_donna_text or "").lower()
        assert _mentions_reminder(opening_text), (
            "Expected Donna's opening greeting to naturally include the "
            f"reminder. Opening: {opening_text[:500]}"
        )

        # The mark_reminder_acknowledged tool should have been called
        assert "mark_reminder_acknowledged" in result.tool_calls_made, (
            f"Expected 'mark_reminder_acknowledged' in tool calls, "
            f"got: {result.tool_calls_made}"
        )

        # Donna should bring up the reminder before Margaret acknowledges it.
        first_ack_turn = _first_reminder_acknowledgement_turn(result.turns)
        assert first_ack_turn is not None, (
            "Expected the simulated senior to acknowledge the reminder"
        )
        donna_before_ack = " ".join([
            opening_text,
            *(
                t["donna"].lower()
                for t in result.turns[:first_ack_turn]
                if t.get("donna")
            ),
        ])
        assert _mentions_reminder(donna_before_ack), (
            "Expected Donna to surface the reminder before the senior "
            f"acknowledged it. Donna before ack: {donna_before_ack[:500]}"
        )

        # Donna should mention the household reminder somewhere in the call.
        donna_text = " ".join(
            t["donna"].lower()
            for t in result.turns
            if t.get("donna")
        )
        assert "plants" in donna_text or "water" in donna_text, (
            "Expected Donna to mention the plant-watering reminder. "
            f"Donna said: {donna_text[:500]}"
        )

    @pytest.mark.asyncio(loop_scope="module")
    async def test_multiple_reminders_brought_up_in_opening(
        self, test_senior: TestSenior
    ):
        """Donna should surface every pending reminder in the opening."""
        scenario = multiple_reminders_scenario()
        result = await run_simulated_call(
            scenario,
            senior=test_senior,
            run_post_call_processing=False,
        )

        opening_text = (result.initial_donna_text or "").lower()
        assert _mentions_multiple_reminders(opening_text), (
            "Expected Donna's opening greeting to include every pending "
            f"reminder. Opening: {opening_text[:700]}"
        )

        caller_text = " ".join(
            turn.get("caller", "").lower() for turn in result.turns
        )
        assert "plants" in caller_text
        assert "bridge" in caller_text or "eleanor" in caller_text

        ack_calls = [
            call
            for call in result.tool_call_details
            if call.get("name") == "mark_reminder_acknowledged"
        ]
        ack_values = {
            str((call.get("args") or {}).get("reminder_id") or "").lower()
            for call in ack_calls
        }
        missing = [
            reminder
            for reminder in scenario.reminders
            if not _ack_values_match_reminder(ack_values, reminder)
        ]
        assert not missing, (
            "Expected an acknowledgement call for each reminder. "
            f"Missing={missing}, got={ack_calls}"
        )


def _first_reminder_acknowledgement_turn(turns: list[dict]) -> int | None:
    """Return the first turn index where the caller acknowledges the reminder."""
    for index, turn in enumerate(turns):
        caller = (turn.get("caller") or "").lower()
        if "plants" in caller and any(
            word in caller for word in ("water", "watering", "reminding")
        ):
            return index
    return None


def _mentions_reminder(text: str) -> bool:
    """Return whether Donna brought up the reminder content."""
    lowered = text.lower()
    return any(
        phrase in lowered
        for phrase in ("plants", "porch", "water", "watering", "reminder")
    )


def _mentions_multiple_reminders(text: str) -> bool:
    """Return whether Donna brought up both multi-reminder items."""
    lowered = text.lower()
    mentions_plants = "plants" in lowered or "porch" in lowered or "water" in lowered
    mentions_bridge = "bridge" in lowered or "eleanor" in lowered
    mentions_time = "9" in lowered or "nine" in lowered or "tomorrow" in lowered
    return mentions_plants and mentions_bridge and mentions_time


def _ack_values_match_reminder(ack_values: set[str], reminder: dict) -> bool:
    """Accept stored IDs, exact titles, or readable title slugs."""
    expected_id = str(reminder.get("id") or "").lower()
    title = str(reminder.get("title") or "").lower()
    title_tokens = {
        token
        for token in re.findall(r"[a-z0-9]+", title)
        if len(token) > 2 and token not in {"the", "about", "and", "with", "for"}
    }
    for value in ack_values:
        if value in {expected_id, title}:
            return True
        value_tokens = set(re.findall(r"[a-z0-9]+", value))
        if title_tokens and title_tokens <= value_tokens:
            return True
    return False


# ---------------------------------------------------------------------------
# TestCallMetrics
# ---------------------------------------------------------------------------


class TestCallMetrics:
    """Tests that latency metrics are captured for each turn."""

    @pytest.mark.asyncio(loop_scope="module")
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
# TestAdditionalSituations
# ---------------------------------------------------------------------------


class TestAdditionalSituations:
    """Live-sim coverage for the expanded mock-call situation catalog."""

    @pytest.mark.asyncio(loop_scope="module")
    async def test_embedding_outage_degrades_gracefully(self):
        scenario = embedding_outage_scenario()
        result = await _run_with_scenario_senior(scenario)

        assert result.end_reason not in {"no_greeting", "timeout"}
        assert len(result.turns) >= 2
        assert result.injected_memories == []

    @pytest.mark.asyncio(loop_scope="module")
    async def test_false_goodbye_does_not_end_immediately(self):
        scenario = false_goodbye_scenario()
        result = await _run_with_scenario_senior(scenario)

        assert result.end_reason not in {"no_greeting", "timeout"}
        assert len(result.turns) >= 2, (
            "Expected conversation to continue after the mid-call neighbor goodbye"
        )

    @pytest.mark.parametrize(
        "scenario_factory",
        [
            low_engagement_scenario,
            health_concern_scenario,
            cognitive_confusion_scenario,
        ],
    )
    @pytest.mark.asyncio(loop_scope="module")
    async def test_behavioral_scenarios_complete_without_hanging(self, scenario_factory):
        scenario = scenario_factory()
        result = await _run_with_scenario_senior(scenario)

        assert result.end_reason not in {"no_greeting", "timeout"}
        assert len(result.turns) >= 2

    @pytest.mark.asyncio(loop_scope="module")
    async def test_reminder_creation_invokes_tool(self):
        scenario = reminder_creation_scenario()
        result = await _run_with_scenario_senior(scenario)

        assert "create_reminder" in result.tool_calls_made, (
            f"Expected create_reminder tool call, got {result.tool_calls_made}"
        )

    @pytest.mark.asyncio(loop_scope="module")
    async def test_async_search_overlap_invokes_search(self):
        scenario = async_search_overlap_scenario()
        result = await _run_with_scenario_senior(scenario)

        assert "web_search" in result.tool_calls_made, (
            f"Expected web_search tool call, got {result.tool_calls_made}"
        )
