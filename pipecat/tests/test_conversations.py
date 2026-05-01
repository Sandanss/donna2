"""Tests for services/conversations.py — conversation CRUD + history retrieval."""

import json
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock


class TestCreate:
    @pytest.mark.asyncio
    async def test_creates_conversation_record(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "conv-1", "call_sid": "CA-1"}):
            from services.conversations import create
            result = await create("senior-1", "CA-1")
            assert result["id"] == "conv-1"

    @pytest.mark.asyncio
    async def test_passes_correct_params(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import create
            await create("senior-1", "CA-1")
            args = mock_q.call_args[0]
            assert "INSERT INTO conversations" in args[0]
            assert args[1] == "senior-1"
            assert args[2] is None  # prospect_id
            assert args[3] == "CA-1"

    @pytest.mark.asyncio
    async def test_passes_prospect_id(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import create
            await create(None, "CA-2", prospect_id="prospect-1")
            args = mock_q.call_args[0]
            assert args[1] is None  # senior_id
            assert args[2] == "prospect-1"
            assert args[3] == "CA-2"


class TestComplete:
    @pytest.mark.asyncio
    async def test_updates_conversation(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1", "status": "completed"}):
            from services.conversations import complete
            result = await complete("CA-1", {"duration_seconds": 120, "status": "completed", "transcript": [{"role": "user", "content": "hi"}]})
            assert result["status"] == "completed"

    @pytest.mark.asyncio
    async def test_writes_encrypted_transcript_without_plaintext(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import complete
            transcript = [{"role": "user", "content": "hello"}]
            await complete("CA-1", {"transcript": transcript})
            args = mock_q.call_args[0]
            sql = args[0]
            assert "summary = NULL" in sql
            assert "concerns = NULL" in sql
            assert "transcript_encrypted = $6" in sql
            assert "transcript_text_encrypted = $7" in sql
            assert "transcript = $" not in sql
            assert json.loads(args[6]) == transcript

    @pytest.mark.asyncio
    async def test_writes_encrypted_text_transcript(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import complete
            transcript = [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "Hi there"},
            ]
            await complete("CA-1", {"transcript": transcript})
            args = mock_q.call_args[0]
            assert args[7] == "Senior: hello\nDonna: Hi there"


class TestTranscriptPersistence:
    def test_formats_transcript_text(self):
        from services.conversations import format_transcript_text

        transcript = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "Hi there"},
            {"role": "assistant", "content": "[EPHEMERAL: internal guidance]"},
        ]

        assert format_transcript_text(transcript) == "Senior: hello\nDonna: Hi there"

    @pytest.mark.asyncio
    async def test_update_transcript_writes_encrypted_fields_only(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import update_transcript

            transcript = [{"role": "user", "content": "hello"}]
            await update_transcript("CA-1", transcript)

            args = mock_q.call_args[0]
            sql = args[0]
            assert "transcript_encrypted = $1" in sql
            assert "transcript_text_encrypted = $2" in sql
            assert "transcript = $" not in sql
            assert json.loads(args[1]) == transcript
            assert args[2] == "Senior: hello"
            assert args[3] == "CA-1"

    @pytest.mark.asyncio
    async def test_get_transcript_prefers_encrypted_json(self):
        transcript = [{"role": "user", "content": "hello"}]
        row = {
            "transcript": None,
            "transcript_encrypted": json.dumps(transcript),
            "transcript_text_encrypted": "Senior: fallback",
        }
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value=row):
            from services.conversations import get_transcript_by_call_sid

            assert await get_transcript_by_call_sid("CA-1") == transcript

    @pytest.mark.asyncio
    async def test_get_transcript_falls_back_to_encrypted_text(self):
        row = {
            "transcript": None,
            "transcript_encrypted": None,
            "transcript_text_encrypted": "Senior: hello",
        }
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value=row):
            from services.conversations import get_transcript_by_call_sid

            assert await get_transcript_by_call_sid("CA-1") == "Senior: hello"


class TestGetByCallSid:
    @pytest.mark.asyncio
    async def test_returns_row(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1", "call_sid": "CA-1"}):
            from services.conversations import get_by_call_sid
            result = await get_by_call_sid("CA-1")
            assert result["call_sid"] == "CA-1"

    @pytest.mark.asyncio
    async def test_returns_none_when_not_found(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value=None):
            from services.conversations import get_by_call_sid
            assert await get_by_call_sid("CA-999") is None


class TestGetForSenior:
    @pytest.mark.asyncio
    async def test_returns_list(self):
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[{"id": "c1"}, {"id": "c2"}]):
            from services.conversations import get_for_senior
            result = await get_for_senior("senior-1")
            assert len(result) == 2

    @pytest.mark.asyncio
    async def test_empty_list(self):
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[]):
            from services.conversations import get_for_senior
            assert await get_for_senior("senior-1") == []


class TestUpdateSummary:
    @pytest.mark.asyncio
    async def test_updates_summary(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1", "summary": "Good call"}):
            from services.conversations import update_summary
            result = await update_summary("CA-1", "Good call")
            assert result is not None

    @pytest.mark.asyncio
    async def test_updates_summary_and_sentiment(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, return_value={"id": "c1"}) as mock_q:
            from services.conversations import update_summary
            await update_summary("CA-1", "Good call", "positive")
            args = mock_q.call_args[0]
            sql = args[0]
            assert "summary_encrypted = $1" in sql
            assert "sentiment = COALESCE($2, sentiment)" in sql
            assert args[2] == "positive"
            assert args[3] == "CA-1"

    @pytest.mark.asyncio
    async def test_returns_none_on_error(self):
        with patch("services.conversations.query_one", new_callable=AsyncMock, side_effect=Exception("DB error")):
            from services.conversations import update_summary
            assert await update_summary("CA-1", "test") is None


class TestGetRecentSummaries:
    @pytest.mark.asyncio
    async def test_returns_none_when_empty(self):
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[]):
            from services.conversations import get_recent_summaries
            assert await get_recent_summaries("senior-1") is None

    @pytest.mark.asyncio
    async def test_earlier_today_formatting(self):
        # Pin time to midday UTC (8 AM ET) so "2 hours ago" is safely "today" in New York
        frozen_now = datetime(2026, 4, 15, 18, 0, 0, tzinfo=timezone.utc)
        row = {"summary": "Good call", "started_at": frozen_now.replace(tzinfo=None) - timedelta(hours=2), "duration_seconds": 300}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]), \
             patch("services.conversations.datetime", wraps=datetime) as mock_dt:
            mock_dt.now.return_value = frozen_now
            from services.conversations import get_recent_summaries
            result = await get_recent_summaries("senior-1")
            assert "Earlier today" in result
            assert "5 min" in result

    @pytest.mark.asyncio
    async def test_yesterday_formatting(self):
        # Pin time to midday UTC so "1 day + 2 hours ago" is safely "yesterday" in New York
        frozen_now = datetime(2026, 4, 15, 18, 0, 0, tzinfo=timezone.utc)
        row = {"summary": "Nice chat", "started_at": frozen_now.replace(tzinfo=None) - timedelta(days=1, hours=2), "duration_seconds": 600}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]), \
             patch("services.conversations.datetime", wraps=datetime) as mock_dt:
            mock_dt.now.return_value = frozen_now
            from services.conversations import get_recent_summaries
            result = await get_recent_summaries("senior-1")
            assert "Yesterday" in result

    @pytest.mark.asyncio
    async def test_days_ago_formatting(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = {"summary": "Talked about garden", "started_at": now - timedelta(days=5), "duration_seconds": 420}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_summaries
            result = await get_recent_summaries("senior-1")
            assert "5 days ago" in result

    @pytest.mark.asyncio
    async def test_no_duration(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = {"summary": "Quick call", "started_at": now - timedelta(hours=1), "duration_seconds": None}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_summaries
            result = await get_recent_summaries("senior-1")
            assert "Quick call" in result


class TestGetRecentTurns:
    @pytest.mark.asyncio
    async def test_returns_none_when_no_history(self):
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[]):
            from services.conversations import get_recent_turns
            assert await get_recent_turns("senior-1") is None

    @pytest.mark.asyncio
    async def test_parses_json_transcript(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        transcript = [{"role": "assistant", "content": "Hello!"}, {"role": "user", "content": "Hi there"}]
        row = {"transcript": json.dumps(transcript), "started_at": now - timedelta(hours=3), "duration_seconds": 180}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_turns
            result = await get_recent_turns("senior-1")
            assert "Donna: Hello!" in result
            assert "Senior: Hi there" in result

    @pytest.mark.asyncio
    async def test_handles_list_transcript(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        transcript = [{"role": "user", "content": "Good morning"}]
        row = {"transcript": transcript, "started_at": now - timedelta(hours=1), "duration_seconds": 60}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_turns
            result = await get_recent_turns("senior-1")
            assert "Senior: Good morning" in result

    @pytest.mark.asyncio
    async def test_skips_malformed_transcript(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        row = {"transcript": "not valid json{{{", "started_at": now - timedelta(hours=1), "duration_seconds": 60}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_turns
            result = await get_recent_turns("senior-1")
            assert result is None

    @pytest.mark.asyncio
    async def test_header_and_footer(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        transcript = [{"role": "user", "content": "test"}]
        row = {"transcript": transcript, "started_at": now - timedelta(hours=1), "duration_seconds": 60}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_turns
            result = await get_recent_turns("senior-1")
            assert "RECENT CONVERSATIONS" in result
            assert "Reference these naturally" in result


class TestGetRecentHistory:
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_history(self):
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[]):
            from services.conversations import get_recent_history
            assert await get_recent_history("senior-1") == []

    @pytest.mark.asyncio
    async def test_adds_from_previous_call_marker(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        transcript = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
        row = {"transcript": transcript, "started_at": now - timedelta(hours=1)}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_history
            result = await get_recent_history("senior-1")
            assert all(m.get("fromPreviousCall") for m in result)

    @pytest.mark.asyncio
    async def test_respects_message_limit(self):
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        transcript = [{"role": "user", "content": f"msg {i}"} for i in range(10)]
        row = {"transcript": transcript, "started_at": now - timedelta(hours=1)}
        with patch("services.conversations.query_many", new_callable=AsyncMock, return_value=[row]):
            from services.conversations import get_recent_history
            result = await get_recent_history("senior-1", message_limit=3)
            assert len(result) <= 3
