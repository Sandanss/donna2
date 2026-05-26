"""Tests for Pipecat-side queue lifecycle and discovery retry handling."""

from unittest.mock import AsyncMock, patch

import pytest

from services.call_queue_lifecycle import (
    finalize_queue_terminal_event,
    finalize_discovery_post_call,
)


@pytest.mark.asyncio
async def test_discovery_no_answer_defers_same_queue_row():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.execute", new_callable=AsyncMock) as execute:
        query_one.side_effect = [
            {
                "id": "queue-1",
                "senior_id": "senior-1",
                "call_type": "discovery",
                "attempt_count": 1,
            },
            {
                "id": "queue-1",
                "senior_id": "senior-1",
                "call_type": "discovery",
                "attempt_count": 1,
            },
        ]

        await finalize_queue_terminal_event(
            call_control_id="call-1",
            event_type="call.no_answer",
        )

        assert execute.await_count == 2
        first_sql = execute.await_args_list[0].args[0]
        second_sql = execute.await_args_list[1].args[0]
        assert "status = 'deferred'" in first_sql
        assert "voice_discovery_status" in second_sql
        assert execute.await_args_list[0].args[4] == "no_answer"


@pytest.mark.asyncio
async def test_discovery_retry_exhaustion_marks_unreachable():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.execute", new_callable=AsyncMock) as execute:
        query_one.side_effect = [
            {
                "id": "queue-1",
                "senior_id": "senior-1",
                "call_type": "discovery",
                "attempt_count": 3,
            },
            {
                "id": "queue-1",
                "senior_id": "senior-1",
                "call_type": "discovery",
                "attempt_count": 3,
            },
        ]

        await finalize_queue_terminal_event(
            call_control_id="call-1",
            event_type="call.busy",
        )

        assert execute.await_count == 2
        assert "status = 'failed'" in execute.await_args_list[0].args[0]
        assert execute.await_args_list[1].args[4] == "unreachable"


@pytest.mark.asyncio
async def test_discovery_post_call_completes_after_enough_facts():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.mark_queue_completed", new_callable=AsyncMock) as mark_completed, \
         patch("services.call_queue_lifecycle.mark_discovery_attempt", new_callable=AsyncMock) as mark_attempt:
        query_one.return_value = {
            "id": "queue-1",
            "senior_id": "senior-1",
            "call_type": "discovery",
            "attempt_count": 1,
        }

        await finalize_discovery_post_call(
            senior_id="senior-1",
            queue_id="queue-1",
            duration_seconds=60,
            captured_fact_count=3,
            transcript_has_content=True,
        )

        mark_completed.assert_awaited_once_with("queue-1")
        assert mark_attempt.await_args.kwargs["status"] == "complete"
        assert mark_attempt.await_args.kwargs["outcome"] == "completed"


@pytest.mark.asyncio
async def test_discovery_post_call_retries_short_interrupted_call():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.defer_discovery_retry", new_callable=AsyncMock) as defer_retry:
        query_one.return_value = {
            "id": "queue-1",
            "senior_id": "senior-1",
            "call_type": "discovery",
            "attempt_count": 1,
        }

        await finalize_discovery_post_call(
            senior_id="senior-1",
            queue_id="queue-1",
            duration_seconds=60,
            captured_fact_count=1,
            transcript_has_content=True,
        )

        defer_retry.assert_awaited_once_with(
            queue_id="queue-1",
            senior_id="senior-1",
            attempt_count=1,
            reason="interrupted_short_call",
        )


@pytest.mark.asyncio
async def test_discovery_post_call_retries_no_conversation_content():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.defer_discovery_retry", new_callable=AsyncMock) as defer_retry:
        query_one.return_value = {
            "id": "queue-1",
            "senior_id": "senior-1",
            "call_type": "discovery",
            "attempt_count": 1,
        }

        await finalize_discovery_post_call(
            senior_id="senior-1",
            queue_id="queue-1",
            duration_seconds=5,
            captured_fact_count=0,
            transcript_has_content=False,
        )

        defer_retry.assert_awaited_once_with(
            queue_id="queue-1",
            senior_id="senior-1",
            attempt_count=1,
            reason="no_conversation_content",
        )


@pytest.mark.asyncio
async def test_duplicate_terminal_event_does_not_complete_deferred_discovery_retry():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.execute", new_callable=AsyncMock) as execute:
        query_one.return_value = {
            "id": "queue-1",
            "senior_id": "senior-1",
            "call_type": "discovery",
            "status": "deferred",
            "attempt_count": 1,
        }
        execute.return_value = "UPDATE 0"

        await finalize_queue_terminal_event(
            call_control_id="call-1",
            event_type="call.hangup",
        )

        assert execute.await_count == 1
        assert "status = 'completed'" in execute.await_args.args[0]


@pytest.mark.asyncio
async def test_discovery_opt_out_records_decline_and_completes_queue():
    with patch("services.call_queue_lifecycle.query_one", new_callable=AsyncMock) as query_one, \
         patch("services.call_queue_lifecycle.record_discovery_opt_out", new_callable=AsyncMock) as record_opt_out, \
         patch("services.call_queue_lifecycle.mark_queue_completed", new_callable=AsyncMock) as mark_completed, \
         patch("services.call_queue_lifecycle.mark_discovery_declined", new_callable=AsyncMock) as mark_declined:
        query_one.return_value = {
            "id": "queue-1",
            "senior_id": "senior-1",
            "call_type": "discovery",
            "attempt_count": 1,
        }

        await finalize_discovery_post_call(
            senior_id="senior-1",
            queue_id="queue-1",
            duration_seconds=30,
            captured_fact_count=0,
            transcript_has_content=True,
            senior_opted_out=True,
            conversation_id="conversation-1",
            senior_opt_out_quote="Please don't call me again.",
        )

        record_opt_out.assert_awaited_once_with(
            senior_id="senior-1",
            conversation_id="conversation-1",
            senior_quote="Please don't call me again.",
        )
        mark_completed.assert_awaited_once_with("queue-1", outcome="declined")
        mark_declined.assert_awaited_once_with(
            senior_id="senior-1",
            attempt_count=1,
        )
