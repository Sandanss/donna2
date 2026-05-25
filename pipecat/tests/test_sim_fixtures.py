"""Integration tests for simulation DB fixtures.

These tests hit the real Neon dev database and are gated behind the
``integration`` marker + ``DATABASE_URL`` environment variable.

Run with:
    DATABASE_URL=... pytest tests/test_sim_fixtures.py -m integration -v
"""

from __future__ import annotations

import os
import socket
import uuid
from urllib.parse import urlparse

import pytest

from tests.simulation.fixtures import (
    TestSenior,
    cleanup_test_senior,
    create_test_conversation,
    seed_test_senior,
)


# ---------------------------------------------------------------------------
# Unit tests (no DB required)
# ---------------------------------------------------------------------------


class TestTestSenior:
    """Pure dataclass tests -- no database needed."""

    def test_default_values(self):
        senior = TestSenior()
        assert senior.name == "Margaret Simulation"
        assert senior.phone == "5551234567"
        assert senior.timezone == "America/New_York"
        assert "gardening" in senior.interests
        assert "crossword puzzles" in senior.interests
        assert len(senior.interests) == 5
        assert "gentle reminders" in senior.profile_notes.lower()

    def test_id_is_valid_uuid(self):
        senior = TestSenior()
        # Should not raise
        parsed = uuid.UUID(senior.id)
        assert str(parsed) == senior.id

    def test_unique_ids(self):
        a = TestSenior()
        b = TestSenior()
        assert a.id != b.id

    def test_custom_overrides(self):
        senior = TestSenior(
            name="Harold Smith",
            phone="5559876543",
            interests=["chess", "reading"],
        )
        assert senior.name == "Harold Smith"
        assert senior.interests == ["chess", "reading"]


# ---------------------------------------------------------------------------
# Integration tests (require DATABASE_URL)
# ---------------------------------------------------------------------------

def _database_available() -> bool:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url:
        return False

    parsed = urlparse(database_url)
    host = parsed.hostname
    port = parsed.port or 5432
    if not host:
        return False

    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


_skip_no_db = pytest.mark.skipif(
    not _database_available(),
    reason="Requires a reachable DATABASE_URL",
)


@pytest.mark.integration
@pytest.mark.asyncio
@_skip_no_db
async def test_seed_and_cleanup_test_senior():
    """Seed a senior, verify it exists with memories, then clean up."""
    from db import query_one, query_many

    senior = TestSenior()

    try:
        # --- Seed ---
        result = await seed_test_senior(senior)
        assert result.id == senior.id

        # Verify senior row exists
        row = await query_one(
            "SELECT id, name, phone, interests FROM seniors WHERE id = $1",
            uuid.UUID(senior.id),
        )
        assert row is not None, f"Senior {senior.id} not found after seed"
        assert row["name"] == senior.name

        # Verify memories were created (at least 5 seed memories)
        memories = await query_many(
            "SELECT id, content, type, importance FROM memories WHERE senior_id = $1",
            uuid.UUID(senior.id),
        )
        assert len(memories) >= 5, f"Expected >= 5 memories, got {len(memories)}"

        # Verify at least one memory has expected content
        contents = [m["content"] for m in memories]
        assert any("rose" in c.lower() for c in contents), "Expected rose memory"

    finally:
        # --- Cleanup ---
        await cleanup_test_senior(senior.id)

    # Verify cleanup removed the senior
    row = await query_one(
        "SELECT id FROM seniors WHERE id = $1",
        uuid.UUID(senior.id),
    )
    assert row is None, f"Senior {senior.id} still exists after cleanup"

    # Verify cleanup removed memories
    memories = await query_many(
        "SELECT id FROM memories WHERE senior_id = $1",
        uuid.UUID(senior.id),
    )
    assert len(memories) == 0, f"Memories still exist after cleanup: {len(memories)}"


@pytest.mark.integration
@pytest.mark.asyncio
@_skip_no_db
async def test_create_test_conversation():
    """Seed a senior, create a conversation, then clean up."""
    from db import query_one

    senior = TestSenior()

    try:
        await seed_test_senior(senior)
        conv_id = await create_test_conversation(senior.id)

        assert conv_id, "Expected a conversation ID"
        # Verify it's a valid UUID
        uuid.UUID(conv_id)

        # Verify conversation row
        row = await query_one(
            "SELECT id, status FROM conversations WHERE id = $1",
            uuid.UUID(conv_id),
        )
        assert row is not None
        assert row["status"] == "in_progress"

    finally:
        await cleanup_test_senior(senior.id)


@pytest.mark.integration
@pytest.mark.asyncio
@_skip_no_db
async def test_seed_is_idempotent():
    """Calling seed_test_senior twice with the same senior does not error."""
    senior = TestSenior()

    try:
        await seed_test_senior(senior)
        # Second call should not raise (ON CONFLICT DO NOTHING)
        await seed_test_senior(senior)
    finally:
        await cleanup_test_senior(senior.id)
