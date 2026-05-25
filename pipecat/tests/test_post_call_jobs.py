"""Tests for Phase 6 post-call job graph enqueue helpers."""

from unittest.mock import AsyncMock, patch

import pytest


def test_build_post_call_job_specs_dependencies():
    from services.post_call_jobs import JOB_TYPES, build_post_call_job_specs

    specs = build_post_call_job_specs(
        conversation_id="conv-test-001",
        call_sid="CA-test-001",
        senior_id="senior-test-001",
    )
    by_type = {spec.job_type: spec for spec in specs}

    assert by_type[JOB_TYPES["CAREGIVER_NOTIFICATIONS"]].depends_on_types == (
        JOB_TYPES["ANALYSIS"],
    )
    assert by_type[JOB_TYPES["INTEREST_DISCOVERY"]].depends_on_types == (
        JOB_TYPES["MEMORY_EXTRACTION"],
    )
    assert by_type[JOB_TYPES["SNAPSHOT_REBUILD"]].depends_on_types == (
        JOB_TYPES["MEMORY_EXTRACTION"],
        JOB_TYPES["DAILY_CONTEXT"],
    )
    assert by_type[JOB_TYPES["REMINDER_RECOVERY"]].max_attempts == 3


@pytest.mark.asyncio
async def test_enqueue_post_call_job_graph_inserts_dependencies_in_order():
    from services.post_call_jobs import JOB_TYPES, enqueue_post_call_job_graph

    rows = [
        {"id": "metrics-job", "job_type": JOB_TYPES["METRICS_FINALIZE"], "depends_on": []},
        {"id": "reminder-job", "job_type": JOB_TYPES["REMINDER_RECOVERY"], "depends_on": []},
        {"id": "analysis-job", "job_type": JOB_TYPES["ANALYSIS"], "depends_on": []},
        {"id": "memory-job", "job_type": JOB_TYPES["MEMORY_EXTRACTION"], "depends_on": []},
        {"id": "daily-job", "job_type": JOB_TYPES["DAILY_CONTEXT"], "depends_on": []},
        {"id": "notify-job", "job_type": JOB_TYPES["CAREGIVER_NOTIFICATIONS"], "depends_on": ["analysis-job"]},
        {"id": "interest-job", "job_type": JOB_TYPES["INTEREST_DISCOVERY"], "depends_on": ["memory-job"]},
        {"id": "snapshot-job", "job_type": JOB_TYPES["SNAPSHOT_REBUILD"], "depends_on": ["memory-job", "daily-job"]},
    ]

    with patch("services.post_call_jobs.query_one", new_callable=AsyncMock) as mock_query:
        mock_query.side_effect = rows

        result = await enqueue_post_call_job_graph(
            conversation_id="conv-test-001",
            call_sid="CA-test-001",
            senior_id="senior-test-001",
        )

    assert [row["job_type"] for row in result] == [row["job_type"] for row in rows]
    assert mock_query.await_count == 8
    notify_args = mock_query.await_args_list[5].args
    snapshot_args = mock_query.await_args_list[7].args
    assert notify_args[7] == ["analysis-job"]
    assert snapshot_args[7] == ["memory-job", "daily-job"]


@pytest.mark.asyncio
async def test_maybe_enqueue_post_call_job_graph_respects_flag(monkeypatch):
    from services.post_call_jobs import maybe_enqueue_post_call_job_graph

    monkeypatch.delenv("POST_CALL_QUEUE_ENABLED", raising=False)
    with patch("services.post_call_jobs.enqueue_post_call_job_graph", new_callable=AsyncMock) as mock_enqueue:
        result = await maybe_enqueue_post_call_job_graph(
            conversation_id="conv-test-001",
            call_sid="CA-test-001",
            senior_id="senior-test-001",
        )

    assert result == []
    mock_enqueue.assert_not_awaited()

    monkeypatch.setenv("POST_CALL_QUEUE_ENABLED", "true")
    with patch("services.post_call_jobs.enqueue_post_call_job_graph", new_callable=AsyncMock, return_value=[{"id": "job"}]) as mock_enqueue:
        result = await maybe_enqueue_post_call_job_graph(
            conversation_id="conv-test-001",
            call_sid="CA-test-001",
            senior_id="senior-test-001",
        )

    assert result == [{"id": "job"}]
    mock_enqueue.assert_awaited_once()
