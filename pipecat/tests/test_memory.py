"""Tests for services/memory.py — pgvector semantic memory with decay."""

import json
import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, AsyncMock, MagicMock


class TestCalculateEffectiveImportance:
    def test_decay_at_half_life(self):
        from services.memory import _calculate_effective_importance, DECAY_HALF_LIFE_DAYS
        created = datetime.now(timezone.utc) - timedelta(days=DECAY_HALF_LIFE_DAYS)
        result = _calculate_effective_importance(100, created, None)
        assert 45 <= result <= 55  # ~50% after one half-life

    def test_no_decay_for_new_memory(self):
        from services.memory import _calculate_effective_importance
        created = datetime.now(timezone.utc)
        result = _calculate_effective_importance(80, created, None)
        assert result >= 78

    def test_access_boost(self):
        from services.memory import _calculate_effective_importance
        created = datetime.now(timezone.utc) - timedelta(days=15)
        last_accessed = datetime.now(timezone.utc) - timedelta(days=1)
        result_with = _calculate_effective_importance(60, created, last_accessed)
        result_without = _calculate_effective_importance(60, created, None)
        assert result_with > result_without

    def test_cap_at_max(self):
        from services.memory import _calculate_effective_importance, MAX_IMPORTANCE
        created = datetime.now(timezone.utc)
        last_accessed = datetime.now(timezone.utc)
        result = _calculate_effective_importance(100, created, last_accessed)
        assert result <= MAX_IMPORTANCE

    def test_naive_datetime(self):
        from services.memory import _calculate_effective_importance
        created = datetime.now(timezone.utc).replace(tzinfo=None)
        result = _calculate_effective_importance(80, created, None)
        assert isinstance(result, int)


class TestGroupByType:
    def test_groups_by_type(self):
        from services.memory import group_by_type
        memories = [
            {"type": "fact", "content": "Likes roses"},
            {"type": "fact", "content": "Has cat"},
            {"type": "concern", "content": "Knee pain"},
        ]
        groups = group_by_type(memories)
        assert len(groups["fact"]) == 2
        assert len(groups["concern"]) == 1

    def test_default_type_is_fact(self):
        from services.memory import group_by_type
        memories = [{"content": "Something"}]
        groups = group_by_type(memories)
        assert "fact" in groups

    def test_empty_list(self):
        from services.memory import group_by_type
        assert group_by_type([]) == {}


class TestFormatGroupedMemories:
    def test_label_mapping(self):
        from services.memory import format_grouped_memories
        groups = {"relationship": ["Son named Jake"], "concern": ["Knee pain"]}
        result = format_grouped_memories(groups)
        assert "Family/Friends" in result
        assert "Concerns" in result

    def test_relationship_uses_semicolon(self):
        from services.memory import format_grouped_memories
        groups = {"relationship": ["Son Jake", "Daughter Mary"]}
        result = format_grouped_memories(groups)
        assert "; " in result

    def test_other_types_use_comma(self):
        from services.memory import format_grouped_memories
        groups = {"fact": ["Likes roses", "Has cat"]}
        result = format_grouped_memories(groups)
        assert ", " in result

    def test_unknown_type_uses_type_name(self):
        from services.memory import format_grouped_memories
        groups = {"custom_type": ["Something"]}
        result = format_grouped_memories(groups)
        assert "custom_type" in result

    def test_temporal_memory_gets_recorded_time_anchor(self):
        from services.memory import format_memory_for_context

        memory = {
            "content": "Plans to work out tomorrow",
            "created_at": datetime(2026, 4, 14, 20, 30, tzinfo=timezone.utc),
        }

        with patch(
            "services.memory.format_call_time_label",
            return_value="Tuesday at 3:30 PM (2 days ago)",
        ) as mock_label:
            result = format_memory_for_context(memory, "America/Chicago")

        mock_label.assert_called_once_with(memory["created_at"], "America/Chicago")
        assert "Plans to work out tomorrow" in result
        assert "recorded" in result
        assert result.endswith("(recorded Tuesday at 3:30 PM (2 days ago))")


class TestGenerateEmbedding:
    @pytest.mark.asyncio
    async def test_returns_none_without_client(self):
        with patch("services.memory._get_openai", return_value=None):
            from services.memory import generate_embedding
            assert await generate_embedding("test") is None

    @pytest.mark.asyncio
    async def test_calls_correct_model(self):
        mock_embedding = MagicMock()
        mock_embedding.data = [MagicMock(embedding=[0.1, 0.2, 0.3])]
        mock_client = MagicMock()
        mock_client.embeddings.create = AsyncMock(return_value=mock_embedding)
        with patch("services.memory._get_openai", return_value=mock_client):
            from services.memory import generate_embedding
            result = await generate_embedding("test text")
            assert result == [0.1, 0.2, 0.3]
            mock_client.embeddings.create.assert_called_once_with(model="text-embedding-3-small", input="test text")


class TestStore:
    @pytest.mark.asyncio
    async def test_returns_none_without_openai(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=None):
            from services.memory import store
            assert await store("s1", "fact", "test") is None

    @pytest.mark.asyncio
    async def test_skips_insert_on_dedup(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1, 0.2]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=[{"id": "m1", "content": "similar", "importance": 60, "similarity": 0.95}]), \
             patch("db.query_one", new_callable=AsyncMock) as mock_q:
            from services.memory import store
            result = await store("s1", "fact", "similar content", importance=50)
            assert result is None

    @pytest.mark.asyncio
    async def test_updates_importance_on_dedup_if_higher(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1, 0.2]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=[{"id": "m1", "content": "similar", "importance": 40, "similarity": 0.95}]), \
             patch("db.query_one", new_callable=AsyncMock) as mock_q:
            from services.memory import store
            await store("s1", "fact", "similar content", importance=70)
            assert mock_q.called
            update_sql = mock_q.call_args[0][0]
            assert "UPDATE memories" in update_sql

    @pytest.mark.asyncio
    async def test_inserts_new_memory(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1, 0.2]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=[]), \
             patch("db.query_one", new_callable=AsyncMock, return_value={"id": "m-new", "content": "new memory"}) as mock_q:
            from services.memory import store
            result = await store("s1", "fact", "new memory")
            assert result is not None
            insert_sql = mock_q.call_args[0][0]
            assert "INSERT INTO memories" in insert_sql

    @pytest.mark.asyncio
    async def test_prospect_memory_uses_prospect_table(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1, 0.2]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=[]), \
             patch("db.query_one", new_callable=AsyncMock, return_value={"id": "m-new", "content": "new memory"}) as mock_q:
            from services.memory import store
            result = await store(None, "fact", "new memory", prospect_id="p1")
            assert result is not None
            insert_sql = mock_q.call_args[0][0]
            assert "INSERT INTO prospect_memories" in insert_sql
            assert "prospect_id" in insert_sql


class TestSearch:
    @pytest.mark.asyncio
    async def test_returns_empty_without_client(self):
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=None):
            from services.memory import search
            assert await search("s1", "test") == []

    @pytest.mark.asyncio
    async def test_returns_matching_rows(self):
        rows = [{"id": "m1", "type": "fact", "content": "Likes roses", "importance": 80, "metadata": None, "created_at": datetime.now(timezone.utc), "similarity": 0.85}]
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1, 0.2]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=rows), \
             patch("db.execute", new_callable=AsyncMock):
            from services.memory import search
            result = await search("s1", "roses")
            assert len(result) == 1
            assert result[0]["content"] == "Likes roses"

    @pytest.mark.asyncio
    async def test_updates_last_accessed(self):
        rows = [{"id": "m1", "type": "fact", "content": "test", "importance": 50, "metadata": None, "created_at": datetime.now(timezone.utc), "similarity": 0.8}]
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=rows), \
             patch("db.execute", new_callable=AsyncMock) as mock_exec:
            from services.memory import search
            await search("s1", "test")
            assert mock_exec.called
            assert "UPDATE memories" in mock_exec.call_args[0][0]

    @pytest.mark.asyncio
    async def test_search_can_skip_last_accessed_for_prefetch(self):
        rows = [{"id": "m1", "type": "fact", "content": "test", "importance": 50, "metadata": None, "created_at": datetime.now(timezone.utc), "similarity": 0.8}]
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=rows), \
             patch("db.execute", new_callable=AsyncMock) as mock_exec:
            from services.memory import search
            result = await search("s1", "test", track_access=False)
            assert len(result) == 1
            mock_exec.assert_not_called()

    @pytest.mark.asyncio
    async def test_mark_accessed_deduplicates_ids(self):
        with patch("db.execute", new_callable=AsyncMock) as mock_exec:
            from services.memory import mark_accessed
            count = await mark_accessed(["m1", "m1", "m2"])

        assert count == 2
        mock_exec.assert_awaited_once()
        assert mock_exec.await_args.args[1:] == ("m1", "m2")

    @pytest.mark.asyncio
    async def test_prospect_search_uses_prospect_table(self):
        rows = [{"id": "m1", "type": "fact", "content": "test", "importance": 50, "metadata": None, "created_at": datetime.now(timezone.utc), "similarity": 0.8}]
        with patch("services.memory.generate_embedding", new_callable=AsyncMock, return_value=[0.1]), \
             patch("db.query_many", new_callable=AsyncMock, return_value=rows) as mock_query, \
             patch("db.execute", new_callable=AsyncMock) as mock_exec:
            from services.memory import search
            result = await search(None, "test", prospect_id="p1")
            assert len(result) == 1
            assert "FROM prospect_memories" in mock_query.await_args.args[0]
            assert "UPDATE prospect_memories" in mock_exec.await_args.args[0]


class TestBuildContext:
    @pytest.mark.asyncio
    async def test_returns_empty_when_no_memories(self):
        with patch("db.query_many", new_callable=AsyncMock, return_value=[]):
            from services.memory import build_context
            result = await build_context("s1")
            assert result == ""

    @pytest.mark.asyncio
    async def test_includes_all_memory_types(self):
        memories = [
            {"id": "m1", "type": "concern", "content": "Health concern", "importance": 90, "metadata": None, "created_at": datetime.now(timezone.utc)},
            {"id": "m2", "type": "fact", "content": "Likes roses", "importance": 60, "metadata": None, "created_at": datetime.now(timezone.utc)},
            {"id": "m3", "type": "relationship", "content": "Son named Jake", "importance": 70, "metadata": None, "created_at": datetime.now(timezone.utc)},
        ]
        with patch("db.query_many", new_callable=AsyncMock, return_value=memories):
            from services.memory import build_context
            result = await build_context("s1")
            assert "Health concern" in result
            assert "Likes roses" in result
            assert "Son named Jake" in result

    @pytest.mark.asyncio
    async def test_formats_with_type_labels(self):
        memories = [
            {"id": "m1", "type": "concern", "content": "Knee pain", "importance": 80, "metadata": None, "created_at": datetime.now(timezone.utc)},
            {"id": "m2", "type": "relationship", "content": "Daughter Mary", "importance": 70, "metadata": None, "created_at": datetime.now(timezone.utc)},
        ]
        with patch("db.query_many", new_callable=AsyncMock, return_value=memories):
            from services.memory import build_context
            result = await build_context("s1")
            assert "Concerns" in result
            assert "Family/Friends" in result

    @pytest.mark.asyncio
    async def test_queries_with_senior_id(self):
        with patch("db.query_many", new_callable=AsyncMock, return_value=[]) as mock_q:
            from services.memory import build_context
            await build_context("senior-123")
            mock_q.assert_called_once()
            assert mock_q.call_args[0][1] == "senior-123"

    @pytest.mark.asyncio
    async def test_ranks_wider_candidate_set_by_effective_importance(self):
        now = datetime.now(timezone.utc)
        memories = [
            {
                "id": "old-high",
                "type": "fact",
                "content": "Old high base importance",
                "importance": 100,
                "metadata": None,
                "created_at": now - timedelta(days=120),
                "last_accessed_at": None,
            },
            {
                "id": "recent-medium",
                "type": "fact",
                "content": "Recent medium importance",
                "importance": 60,
                "metadata": None,
                "created_at": now,
                "last_accessed_at": now,
            },
        ]
        with patch("db.query_many", new_callable=AsyncMock, return_value=memories) as mock_q:
            from services.memory import build_context
            result = await build_context("s1")

        sql = mock_q.call_args[0][0]
        assert "last_accessed_at" in sql
        assert "LIMIT 50" in sql
        assert result.index("Recent medium importance") < result.index("Old high base importance")


class TestExtractFromConversation:
    @pytest.mark.asyncio
    async def test_skips_without_openai(self):
        with patch("services.memory._get_openai", return_value=None):
            from services.memory import extract_from_conversation
            await extract_from_conversation("s1", "transcript", "conv-1")

    @pytest.mark.asyncio
    async def test_handles_json_array_response(self):
        memories = [{"type": "fact", "content": "Likes roses", "importance": 60}]
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content=json.dumps(memories)))]
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
        with patch("services.memory._get_openai", return_value=mock_client), \
             patch("services.memory.store", new_callable=AsyncMock) as mock_store:
            from services.memory import extract_from_conversation
            await extract_from_conversation("s1", "User: I love roses", "conv-1")
            mock_store.assert_called_once()

    @pytest.mark.asyncio
    async def test_handles_json_dict_response(self):
        memories_dict = {"memories": [{"type": "fact", "content": "Has cat", "importance": 50}]}
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content=json.dumps(memories_dict)))]
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
        with patch("services.memory._get_openai", return_value=mock_client), \
             patch("services.memory.store", new_callable=AsyncMock) as mock_store:
            from services.memory import extract_from_conversation
            await extract_from_conversation("s1", "User: My cat is named Whiskers", "conv-1")
            mock_store.assert_called_once()

    @pytest.mark.asyncio
    async def test_extraction_prompt_anchors_relative_dates(self):
        memories_dict = {"memories": [{"type": "event", "content": "Plans to work out on April 15, 2026", "importance": 60}]}
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content=json.dumps(memories_dict)))]
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=mock_response)
        call_started_at = datetime(2026, 4, 14, 20, 30, tzinfo=timezone.utc)

        with patch("services.memory._get_openai", return_value=mock_client), \
             patch("services.memory.store", new_callable=AsyncMock):
            from services.memory import extract_from_conversation
            await extract_from_conversation(
                "s1",
                "User: I am too busy today, so I will work out tomorrow.",
                "conv-1",
                call_started_at=call_started_at,
                timezone_name="America/Chicago",
            )

        prompt = mock_client.chat.completions.create.call_args.kwargs["messages"][0]["content"]
        assert "Call date/time: Tuesday, April 14, 2026 at 3:30 PM" in prompt
        assert "Resolve relative dates" in prompt
        assert "Avoid standalone memories like \"plans to work out tomorrow\"" in prompt

    @pytest.mark.asyncio
    async def test_handles_api_error(self):
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=Exception("API error"))
        with patch("services.memory._get_openai", return_value=mock_client):
            from services.memory import extract_from_conversation
            await extract_from_conversation("s1", "transcript", "conv-1")
