"""Level 2/3: Post-call processing tests.

Tests run_post_call() with mocked services to verify the complete
post-call sequence: conversation completion, analysis, memory extraction,
daily context save, reminder cleanup, cache clearing.
"""

import json
import pytest
import asyncio
from unittest.mock import AsyncMock, patch

from processors.conversation_tracker import ConversationTrackerProcessor


class TestDiscoveryProfileSuggestions:
    """Discovery call post-call writer (services.post_call._save_discovery_profile_suggestions)."""

    @pytest.mark.asyncio
    async def test_writes_payload_when_facts_present(self):
        from services.post_call import _save_discovery_profile_suggestions
        state = {
            "call_type": "discovery",
            "_discovery_facts": [
                {"category": "friend", "content": "Eleanor — bridge Thursdays", "confidence": "stated"},
                {"category": "hobby", "content": "Loves crochet", "confidence": "stated"},
            ],
        }
        with patch(
            "services.conversations.save_profile_suggestions",
            new_callable=AsyncMock,
            return_value={"id": "conv-1"},
        ) as mock_save:
            await _save_discovery_profile_suggestions(state, conversation_id="conv-1")
        mock_save.assert_awaited_once()
        cid, payload = mock_save.await_args.args
        assert cid == "conv-1"
        assert len(payload["facts"]) == 2
        assert "captured_at" in payload

    @pytest.mark.asyncio
    async def test_skips_when_no_facts(self):
        from services.post_call import _save_discovery_profile_suggestions
        with patch(
            "services.conversations.save_profile_suggestions",
            new_callable=AsyncMock,
        ) as mock_save:
            await _save_discovery_profile_suggestions(
                {"call_type": "discovery", "_discovery_facts": []},
                conversation_id="conv-1",
            )
        mock_save.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_skips_when_no_conversation_id(self):
        from services.post_call import _save_discovery_profile_suggestions
        with patch(
            "services.conversations.save_profile_suggestions",
            new_callable=AsyncMock,
        ) as mock_save:
            await _save_discovery_profile_suggestions(
                {"call_type": "discovery", "_discovery_facts": [{"category": "friend", "content": "x"}]},
                conversation_id=None,
            )
        mock_save.assert_not_awaited()


class TestPostCallProcessing:
    @pytest.mark.asyncio
    async def test_full_post_call_sequence(self, session_state):
        """Verify all 6 post-call steps execute in order."""
        session_state["_transcript"] = [
            {"role": "user", "content": "Hello Donna"},
            {"role": "assistant", "content": "Hello Margaret! How are you?"},
            {"role": "user", "content": "I'm doing well"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)
        tracker.state.topics_discussed = ["greeting"]
        tracker.state.advice_given = []

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock) as mock_save_analysis, \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock) as mock_extract, \
             patch("services.interest_discovery.discover_new_interests", return_value=[]) as mock_discover, \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={"gardening": 5.0}) as mock_scores, \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock) as mock_update_scores, \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock) as mock_daily, \
             patch("services.context_cache.clear_cache") as mock_cache_clear, \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock) as mock_sched_clear:

            mock_analyze.return_value = {
                    "mood": "positive",
                    "caregiver_sms": "Donna just chatted with Margaret for 2 minutes. She was in great spirits today!",
                    "summary": "Good call",
                }

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=120)

            # 1. Conversation completed
            mock_complete.assert_awaited_once()
            # 2. Call analysis run
            mock_analyze.assert_awaited_once()
            # 3. Analysis saved
            mock_save_analysis.assert_awaited_once()
            # 4. Memories extracted
            mock_extract.assert_awaited_once()
            # 3.5. Interest discovery checked
            mock_discover.assert_called_once()
            # 3.6. Interest scores computed
            mock_scores.assert_awaited_once()
            mock_update_scores.assert_awaited_once()
            # 5. Daily context saved
            mock_daily.assert_awaited_once()
            # 6. Caches cleared
            mock_cache_clear.assert_called_once_with("senior-test-001")

    @pytest.mark.asyncio
    async def test_post_call_enqueues_job_graph_when_enabled(self, session_state, monkeypatch):
        """Queue materialization is gated, PHI-free, and does not replace inline processing yet."""
        monkeypatch.setenv("POST_CALL_QUEUE_ENABLED", "true")
        session_state["_transcript"] = [
            {"role": "user", "content": "Hello Donna"},
            {"role": "assistant", "content": "Hello!"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)
        tracker.state.topics_discussed = ["greeting"]
        tracker.state.advice_given = []

        with patch("services.post_call_jobs.maybe_enqueue_post_call_job_graph", new_callable=AsyncMock) as mock_enqueue, \
             patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock, return_value={"summary": "Good call"}), \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.discover_new_interests", return_value=[]), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock):

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=60)

        mock_enqueue.assert_awaited_once_with(
            conversation_id="conv-test-001",
            call_sid="CA-test-001",
            senior_id="senior-test-001",
        )

    @pytest.mark.asyncio
    async def test_post_call_with_unacknowledged_reminder(self, reminder_session_state):
        """Undelivered reminders should trigger mark_call_ended_without_acknowledgment."""
        reminder_session_state["_transcript"] = [
            {"role": "user", "content": "Goodbye"},
        ]
        reminder_session_state["reminders_delivered"] = set()  # None delivered

        tracker = ConversationTrackerProcessor(session_state=reminder_session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.discover_new_interests", return_value=[]), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.reminder_delivery.get_delivery_status", new_callable=AsyncMock, return_value={"id": "delivery-001", "status": "delivered"}), \
             patch("services.reminder_delivery.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack:

            mock_analyze.return_value = {
                    "mood": "neutral",
                    "caregiver_sms": "Donna spoke with Margaret briefly today.",
                    "summary": "Short call",
                }

            from services.post_call import run_post_call
            await run_post_call(reminder_session_state, tracker, duration_seconds=30)

            mock_no_ack.assert_awaited_once_with("delivery-001")

    @pytest.mark.asyncio
    async def test_post_call_rechecks_reminder_status_even_when_locally_delivered(self, reminder_session_state):
        """Local reminder tracking should not suppress DB retry cleanup."""
        reminder_session_state["_transcript"] = [
            {"role": "assistant", "content": "Remember to take your metformin."},
        ]
        reminder_session_state["reminders_delivered"] = {"rem-001", "Take metformin"}

        tracker = ConversationTrackerProcessor(session_state=reminder_session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock, return_value=None), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.reminder_delivery.get_delivery_status", new_callable=AsyncMock, return_value={"id": "delivery-001", "status": "delivered"}), \
             patch("services.reminder_delivery.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack:

            from services.post_call import run_post_call
            await run_post_call(reminder_session_state, tracker, duration_seconds=30)

            mock_no_ack.assert_awaited_once_with("delivery-001")

    @pytest.mark.asyncio
    async def test_post_call_recovers_reminder_ack_from_transcript(self, reminder_session_state):
        """If Claude misses the tool, transcript evidence can still persist the ack."""
        reminder_session_state["_transcript"] = [
            {"role": "assistant", "content": "Remember to take your metformin with dinner tonight."},
            {"role": "user", "content": "Okay, I will do that."},
        ]

        tracker = ConversationTrackerProcessor(session_state=reminder_session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock, return_value=None), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.reminder_delivery.get_delivery_status", new_callable=AsyncMock, return_value={"id": "delivery-001", "status": "delivered"}), \
             patch("services.reminder_delivery.mark_reminder_acknowledged", new_callable=AsyncMock, return_value={"id": "delivery-001", "status": "acknowledged"}) as mock_ack, \
             patch("services.reminder_delivery.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack:

            from services.post_call import run_post_call
            await run_post_call(reminder_session_state, tracker, duration_seconds=30)

            mock_ack.assert_awaited_once_with("delivery-001", "acknowledged", "Okay, I will do that.")
            mock_no_ack.assert_not_awaited()

    def test_reminder_ack_inference_requires_delivery_evidence(self, reminder_session_state):
        from services.post_call import _infer_reminder_ack_from_transcript

        transcript = [
            {"role": "assistant", "content": "Hello, how are you?"},
            {"role": "user", "content": "Okay."},
        ]

        assert _infer_reminder_ack_from_transcript(reminder_session_state, transcript) is None

    @pytest.mark.asyncio
    async def test_post_call_waits_for_reminder_ack_task_before_status_check(self, reminder_session_state):
        """A no-latency tool ack still gets a brief post-call settlement window."""
        reminder_session_state["_transcript"] = [
            {"role": "assistant", "content": "Remember to take your metformin."},
        ]

        async def finished_ack():
            reminder_session_state["_reminder_ack_persisted"] = True

        reminder_session_state["_reminder_ack_task"] = asyncio.create_task(finished_ack())
        tracker = ConversationTrackerProcessor(session_state=reminder_session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock, return_value=None), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.reminder_delivery.get_delivery_status", new_callable=AsyncMock, return_value={"id": "delivery-001", "status": "acknowledged"}) as mock_status, \
             patch("services.reminder_delivery.mark_call_ended_without_acknowledgment", new_callable=AsyncMock) as mock_no_ack:

            from services.post_call import run_post_call
            await run_post_call(reminder_session_state, tracker, duration_seconds=30)

            assert reminder_session_state["_reminder_ack_persisted"] is True
            mock_status.assert_awaited_once_with("delivery-001")
            mock_no_ack.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_post_call_marks_caregiver_note_after_assistant_delivery(self, session_state):
        """Caregiver notes should be marked delivered only with transcript evidence."""
        session_state["_caregiver_notes_content"] = [
            {
                "id": "note-001",
                "content": "Sarah asked about your knee pain.",
            }
        ]
        session_state["_transcript"] = [
            {
                "role": "assistant",
                "content": "Before I forget, Sarah wanted me to ask about your knee pain.",
            },
            {"role": "user", "content": "It's better today."},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.caregivers.mark_note_delivered", new_callable=AsyncMock) as mock_note, \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("lib.growthbook.is_on", return_value=False):

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=60)

            mock_note.assert_awaited_once_with("note-001", "CA-test-001")

    def test_format_concern_for_notification_uses_node_expected_string(self):
        from services.post_call import _format_concern_for_notification

        concern = {
            "severity": "high",
            "description": "Margaret reported feeling dizzy.",
            "recommended_action": "Caregiver should check in today.",
            "evidence": "Full transcript evidence should not be needed here.",
        }

        text = _format_concern_for_notification(concern)

        assert "dizzy" in text
        assert "check in" in text
        assert "Full transcript" not in text
        assert len(text) <= 300

    @pytest.mark.asyncio
    async def test_caregiver_notification_requires_node_api_url(self, monkeypatch):
        """Missing NODE_API_URL should not fall through to a production default."""
        monkeypatch.delenv("NODE_API_URL", raising=False)

        from services.post_call import _trigger_caregiver_notification

        await _trigger_caregiver_notification(
            "senior-001",
            "CA-test-001",
            {"summary": "Good call", "sentiment": "positive"},
            120,
        )

    @pytest.mark.asyncio
    async def test_persist_call_metrics_uses_error_count(self, session_state):
        from services.post_call import _persist_call_metrics

        session_state["_call_metrics"] = {"token_usage": {}, "turn_count": 2}

        with patch("db.client.execute", new_callable=AsyncMock) as mock_execute:
            await _persist_call_metrics(session_state, 60, None, error_count=3)

        args = mock_execute.await_args.args
        assert args[-2] == 3

    @pytest.mark.asyncio
    async def test_persist_call_metrics_includes_stage_breakdown(self, session_state):
        from services.post_call import _persist_call_metrics

        session_state["_call_metrics"] = {
            "token_usage": {},
            "turn_count": 2,
            "stage_latency_values": {
                "director.query": [120, 180],
                "tool.web_search": [640],
            },
        }

        with patch("db.client.execute", new_callable=AsyncMock) as mock_execute:
            await _persist_call_metrics(session_state, 60, None, error_count=0)

        args = mock_execute.await_args.args
        latency_json = json.loads(args[8])
        assert latency_json["stage_breakdown"]["director.query"]["avg_ms"] == 150
        assert latency_json["stage_breakdown"]["tool.web_search"]["max_ms"] == 640

    @pytest.mark.asyncio
    async def test_persist_call_metrics_prefers_conversation_turn_count_and_tracks_llm_invocations(self, session_state):
        from services.post_call import _persist_call_metrics

        session_state["_current_turn_sequence"] = 4
        session_state["_call_metrics"] = {
            "token_usage": {"prompt_tokens": 10, "completion_tokens": 12},
            "turn_count": 2,
            "llm_invocation_count": 5,
        }

        with patch("db.client.execute", new_callable=AsyncMock) as mock_execute:
            await _persist_call_metrics(session_state, 60, None, error_count=0)

        args = mock_execute.await_args.args
        assert args[6] == 4
        token_usage_json = json.loads(args[11])
        assert token_usage_json["llm_invocation_count"] == 5

    @pytest.mark.asyncio
    async def test_persist_call_metrics_third_retry_overwrites_not_accumulates(self, session_state):
        """Three INSERT->UPDATE cycles must overwrite, not accumulate.

        Background: each invocation of `_persist_call_metrics` issues an
        INSERT. On UniqueViolation it falls back to UPDATE with the SAME
        parameters. A second / third invocation for the same call_sid (e.g.
        from a retried post-call job) must therefore overwrite the existing
        row to reflect the latest input — never sum prior columns.
        """
        from services.post_call import _persist_call_metrics

        class UniqueViolationError(Exception):
            sqlstate = "23505"

        # Three successive post-call snapshots for the same call_sid. Every
        # numeric value differs so accumulation would be obvious if it ever
        # crept in.
        snapshots = [
            {
                "error_count": 1,
                "metrics": {
                    "token_usage": {"prompt_tokens": 100, "completion_tokens": 50},
                    "turn_count": 4,
                    "llm_ttfb_values": [200, 400],  # avg 300
                },
            },
            {
                "error_count": 2,
                "metrics": {
                    "token_usage": {"prompt_tokens": 200, "completion_tokens": 80},
                    "turn_count": 5,
                    "llm_ttfb_values": [500],  # avg 500
                },
            },
            {
                "error_count": 7,
                "metrics": {
                    "token_usage": {"prompt_tokens": 333, "completion_tokens": 110},
                    "turn_count": 6,
                    "llm_ttfb_values": [800],  # avg 800
                },
            },
        ]

        captured_args = []

        with patch("db.client.execute", new_callable=AsyncMock) as mock_execute:
            # For each invocation: INSERT raises UniqueViolationError, then
            # UPDATE succeeds. So for 3 invocations we need 6 calls with
            # alternating exception / success.
            mock_execute.side_effect = [
                UniqueViolationError(), None,
                UniqueViolationError(), None,
                UniqueViolationError(), None,
            ]

            for snap in snapshots:
                session_state["_call_metrics"] = snap["metrics"]
                await _persist_call_metrics(
                    session_state, 60, None, error_count=snap["error_count"]
                )
                # Capture the UPDATE args (the second call of each pair).
                captured_args.append(mock_execute.await_args_list[-1].args)

        # 3 invocations × 2 execute calls each = 6 total
        assert mock_execute.await_count == 6

        # Each captured UPDATE must be `UPDATE call_metrics ... WHERE call_sid = $1`.
        for args in captured_args:
            assert "UPDATE call_metrics" in args[0]

        # Verify each UPDATE reflects ONLY its own snapshot's values
        # (overwrites, never accumulates).
        for idx, snap in enumerate(snapshots):
            args = captured_args[idx]
            # Positional args after the SQL string:
            # $1=call_sid, $2=senior_id, $3=call_type, $4=duration_seconds,
            # $5=end_reason, $6=turn_count, $7=phase_durations, $8=latency,
            # $9=breaker_states, $10=tools_used, $11=token_usage, $12=error_count,
            # $13=context_trace_encrypted
            turn_count = args[6]
            latency_json = json.loads(args[8])
            token_usage_json = json.loads(args[11])
            error_count = args[12]

            assert error_count == snap["error_count"], f"error_count drifted at retry #{idx + 1}"
            assert turn_count == snap["metrics"]["turn_count"]
            assert token_usage_json["prompt_tokens"] == snap["metrics"]["token_usage"]["prompt_tokens"]

            # Latency average reflects only THIS invocation's samples — if it
            # were accumulating, the average would skew lower across retries.
            expected_avg = round(
                sum(snap["metrics"]["llm_ttfb_values"]) / len(snap["metrics"]["llm_ttfb_values"])
            )
            assert latency_json["llm_ttfb_avg_ms"] == expected_avg

        # Final row reflects the LAST snapshot, not the sum.
        final_args = captured_args[-1]
        final_token_usage = json.loads(final_args[11])
        final_latency = json.loads(final_args[8])

        assert final_args[12] == 7  # NOT 1 + 2 + 7 == 10
        assert final_token_usage["prompt_tokens"] == 333  # NOT 100 + 200 + 333
        assert final_latency["llm_ttfb_avg_ms"] == 800  # NOT some accumulated value

    @pytest.mark.asyncio
    async def test_persist_call_metrics_updates_duplicate_call_sid(self, session_state):
        from services.post_call import _persist_call_metrics

        class UniqueViolationError(Exception):
            sqlstate = "23505"

        session_state["_call_metrics"] = {"token_usage": {}, "turn_count": 2}

        with patch("db.client.execute", new_callable=AsyncMock) as mock_execute:
            mock_execute.side_effect = [UniqueViolationError(), None]
            await _persist_call_metrics(session_state, 60, None, error_count=0)

        assert mock_execute.await_count == 2
        update_sql = mock_execute.await_args_list[1].args[0]
        assert "UPDATE call_metrics" in update_sql
        assert "WHERE call_sid = $1" in update_sql

    @pytest.mark.asyncio
    async def test_post_call_discovers_new_interests(self, session_state):
        """Steps 3.5 + 3.6: new interests are discovered and scores computed."""
        session_state["_transcript"] = [
            {"role": "user", "content": "I love painting"},
            {"role": "assistant", "content": "That sounds wonderful!"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)
        tracker.state.topics_discussed = ["painting"]
        tracker.state.advice_given = []

        with patch("services.conversations.complete", new_callable=AsyncMock), \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.conversations.update_summary", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.discover_new_interests", return_value=["painting"]) as mock_discover, \
             patch("services.interest_discovery.add_interests_to_senior", new_callable=AsyncMock) as mock_add, \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={"gardening": 5.0, "painting": 8.0}) as mock_scores, \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock) as mock_update_scores, \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock):

            mock_analyze.return_value = {
                "topics_discussed": ["painting"],
                "engagement_score": 9,
                "positive_observations": ["Loved discussing painting"],
                "summary": "Great call about painting",
            }
            mock_add.return_value = ["gardening", "cooking", "grandchildren", "painting"]

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=120)

            # 3.5: Interest discovery called
            mock_discover.assert_called_once()
            mock_add.assert_awaited_once()
            # 3.6: Scores computed with updated interests
            mock_scores.assert_awaited_once()
            mock_update_scores.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_post_call_uses_full_transcript_not_bounded_director_transcript(self, session_state):
        """Post-call analysis and completion should receive the complete call."""
        full_transcript = [
            {"role": "user", "content": "early turn"},
            {"role": "assistant", "content": "early response"},
            {"role": "user", "content": "latest turn"},
        ]
        session_state["_full_transcript"] = full_transcript
        session_state["_transcript"] = full_transcript[-1:]

        tracker = ConversationTrackerProcessor(session_state=session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.conversations.update_summary", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.discover_new_interests", return_value=[]), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.post_call._trigger_caregiver_notification", new_callable=AsyncMock), \
             patch("lib.growthbook.is_on", return_value=True):

            mock_analyze.return_value = {"summary": "Full call summary"}

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=120)

            complete_payload = mock_complete.await_args.args[1]
            assert complete_payload["transcript"] == full_transcript
            assert mock_analyze.await_args.args[0] == full_transcript

    @pytest.mark.asyncio
    async def test_post_call_falls_back_to_persisted_transcript(self, session_state):
        """If in-memory transcript is missing, load the Neon draft by call SID."""
        persisted_transcript = [
            {"role": "user", "content": "persisted hello"},
            {"role": "assistant", "content": "persisted response"},
        ]
        session_state["_transcript"] = []
        session_state["_full_transcript"] = []

        with patch("services.conversations.get_transcript_by_call_sid", new_callable=AsyncMock, return_value=persisted_transcript) as mock_get, \
             patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.call_analysis.analyze_completed_call", new_callable=AsyncMock) as mock_analyze, \
             patch("services.call_analysis.save_call_analysis", new_callable=AsyncMock), \
             patch("services.conversations.update_summary", new_callable=AsyncMock), \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock), \
             patch("services.interest_discovery.discover_new_interests", return_value=[]), \
             patch("services.interest_discovery.compute_interest_scores", new_callable=AsyncMock, return_value={}), \
             patch("services.interest_discovery.update_interest_scores", new_callable=AsyncMock), \
             patch("services.daily_context.save_call_context", new_callable=AsyncMock), \
             patch("services.context_cache.clear_cache"), \
             patch("services.scheduler.clear_reminder_context_async", new_callable=AsyncMock), \
             patch("services.post_call._trigger_caregiver_notification", new_callable=AsyncMock), \
             patch("lib.growthbook.is_on", return_value=True):

            mock_analyze.return_value = {"summary": "Recovered call"}

            from services.post_call import run_post_call
            await run_post_call(session_state, None, duration_seconds=90)

            mock_get.assert_awaited_once_with("CA-test-001")
            complete_payload = mock_complete.await_args.args[1]
            assert complete_payload["transcript"] == persisted_transcript
            assert mock_analyze.await_args.args[0] == persisted_transcript

    @pytest.mark.asyncio
    async def test_onboarding_post_call_falls_back_to_persisted_transcript(self, session_state):
        """Onboarding post-call should also recover from the durable transcript."""
        persisted_transcript = [
            {"role": "user", "content": "Hi, I'm Lisa calling about my mom."},
            {"role": "assistant", "content": "Nice to meet you, Lisa."},
        ]
        session_state.update({
            "call_type": "onboarding",
            "senior_id": None,
            "senior": None,
            "prospect_id": "prospect-001",
            "_transcript": [],
            "_full_transcript": [],
        })

        with patch("services.conversations.get_transcript_by_call_sid", new_callable=AsyncMock, return_value=persisted_transcript) as mock_get, \
             patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock) as mock_memory, \
             patch("services.post_call._summarize_onboarding_call", new_callable=AsyncMock, return_value="Lisa called about her mom."), \
             patch("services.prospects.extract_prospect_details", new_callable=AsyncMock, return_value={}), \
             patch("services.prospects.update_after_call", new_callable=AsyncMock):

            from services.post_call import run_post_call
            await run_post_call(session_state, None, duration_seconds=90)

            mock_get.assert_awaited_once_with("CA-test-001")
            assert mock_complete.await_args.args[1]["transcript"] == persisted_transcript
            mock_memory.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_post_call_handles_errors_gracefully(self, session_state):
        """Post-call should not crash if a service fails."""
        session_state["_transcript"] = [
            {"role": "user", "content": "Hello"},
        ]

        tracker = ConversationTrackerProcessor(session_state=session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete:
            mock_complete.side_effect = Exception("DB error")

            from services.post_call import run_post_call
            # Should not raise
            await run_post_call(session_state, tracker, duration_seconds=10)

    @pytest.mark.asyncio
    async def test_onboarding_post_call_extracts_prospect_details_once(self, session_state):
        """Onboarding calls extract prospect details post-call and update once."""
        session_state.update({
            "call_type": "onboarding",
            "senior_id": None,
            "senior": None,
            "prospect_id": "prospect-001",
            "_transcript": [
                {"role": "user", "content": "Hi, I'm Lisa. I'm calling about my mom, Maria."},
                {"role": "assistant", "content": "Nice to meet you, Lisa. What is Maria like?"},
                {"role": "user", "content": "She loves gardening, and I worry she gets lonely."},
            ],
        })

        tracker = ConversationTrackerProcessor(session_state=session_state)

        with patch("services.conversations.complete", new_callable=AsyncMock) as mock_complete, \
             patch("services.memory.extract_from_conversation", new_callable=AsyncMock) as mock_memory, \
             patch("services.post_call._summarize_onboarding_call", new_callable=AsyncMock) as mock_summary, \
             patch("services.prospects.extract_prospect_details", new_callable=AsyncMock) as mock_details, \
             patch("services.prospects.update_after_call", new_callable=AsyncMock) as mock_update:

            mock_summary.return_value = "Lisa called about her mom Maria, who loves gardening."
            mock_details.return_value = {
                "learned_name": "Lisa",
                "relationship": "daughter",
                "loved_one_name": "Maria",
                "caller_context": {
                    "interests": ["gardening"],
                    "concerns": ["loneliness"],
                },
            }

            from services.post_call import run_post_call
            await run_post_call(session_state, tracker, duration_seconds=90)

            mock_complete.assert_awaited_once()
            mock_memory.assert_awaited_once()
            mock_details.assert_awaited_once()
            mock_update.assert_awaited_once()

            prospect_id, update_data = mock_update.await_args.args
            assert prospect_id == "prospect-001"
            assert update_data["learned_name"] == "Lisa"
            assert update_data["relationship"] == "daughter"
            assert update_data["loved_one_name"] == "Maria"
            assert update_data["caller_context"]["call_summary"].startswith("Lisa called")
            assert update_data["caller_context"]["interests"] == ["gardening"]
            assert update_data["caller_context"]["concerns"] == ["loneliness"]
