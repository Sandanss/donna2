"""Level 2: Tool handler integration tests.

Tests that tool handlers correctly interact with mocked external services
(memory, news, scheduler) via session_state closures.
"""

import pytest
from unittest.mock import AsyncMock, patch

from flows.tools import make_tool_handlers


class TestToolHandlerIntegration:
    @pytest.mark.asyncio
    async def test_mark_reminder_updates_session(self, reminder_session_state):
        """mark_reminder_acknowledged should update session and schedule DB persistence."""
        handlers = make_tool_handlers(reminder_session_state)

        with patch("services.reminder_delivery.mark_reminder_acknowledged", new_callable=AsyncMock) as mock_ack:
            mock_ack.return_value = {"id": "delivery-001", "status": "acknowledged"}
            result = await handlers["mark_reminder_acknowledged"]({
                "reminder_id": "rem-001",
                "status": "acknowledged",
                "user_response": "I'll take it now",
            })
            await reminder_session_state["_reminder_ack_task"]

        assert result["status"] == "success"
        delivered = reminder_session_state.get("reminders_delivered", set())
        assert "rem-001" in delivered
        assert "Water the porch plants" in delivered
        assert reminder_session_state["_reminder_ack_persisted"] is True
        mock_ack.assert_awaited_once_with("delivery-001", "acknowledged", "I'll take it now")

    @pytest.mark.asyncio
    async def test_mark_reminder_resolves_title_slug_for_multiple_reminders(
        self, reminder_session_state
    ):
        """LLMs may use human-readable title slugs instead of stored UUIDs."""
        reminder_session_state["reminder_delivery"] = {
            "id": "delivery-001",
            "reminder_id": "rem-001",
            "title": "Water the porch plants",
        }
        reminder_session_state["reminder_deliveries"] = [
            reminder_session_state["reminder_delivery"],
            {
                "id": "delivery-002",
                "reminder_id": "rem-002",
                "title": "Call Eleanor about bridge club",
            },
        ]
        handlers = make_tool_handlers(reminder_session_state)

        with patch(
            "services.reminder_delivery.mark_reminder_acknowledged",
            new_callable=AsyncMock,
        ) as mock_ack:
            mock_ack.return_value = {"id": "delivery-002", "status": "confirmed"}
            result = await handlers["mark_reminder_acknowledged"]({
                "reminder_id": "call-eleanor-bridge-club",
                "status": "confirmed",
                "user_response": "I wrote it down",
            })
            await reminder_session_state["_reminder_ack_task"]

        assert result["status"] == "success"
        delivered = reminder_session_state.get("reminders_delivered", set())
        assert "rem-002" in delivered
        assert "Call Eleanor about bridge club" in delivered
        mock_ack.assert_awaited_once_with(
            "delivery-002",
            "confirmed",
            "I wrote it down",
        )

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        ("arg_value", "expected_delivery_id", "expected_reminder_id"),
        [
            ("rem-001", "delivery-001", "rem-001"),
            ("Water the porch plants", "delivery-001", "rem-001"),
            ("water-porch-plants", "delivery-001", "rem-001"),
            ("second one", "delivery-002", "rem-002"),
            ("2nd reminder", "delivery-002", "rem-002"),
            ("call-eleanor-about-bridge-club", "delivery-003", "rem-003"),
        ],
    )
    async def test_mark_reminder_accepts_messy_llm_arguments(
        self,
        reminder_session_state,
        arg_value,
        expected_delivery_id,
        expected_reminder_id,
    ):
        """Tool handler should resolve UUIDs, titles, slugs, and ordinals."""
        reminder_session_state["reminder_delivery"] = {
            "id": "delivery-001",
            "reminder_id": "rem-001",
            "title": "Water the porch plants",
        }
        reminder_session_state["reminder_deliveries"] = [
            reminder_session_state["reminder_delivery"],
            {
                "id": "delivery-002",
                "reminder_id": "rem-002",
                "title": "Call Eleanor",
            },
            {
                "id": "delivery-003",
                "reminder_id": "rem-003",
                "title": "Call Eleanor about bridge club",
            },
        ]
        handlers = make_tool_handlers(reminder_session_state)

        with patch(
            "services.reminder_delivery.mark_reminder_acknowledged",
            new_callable=AsyncMock,
        ) as mock_ack:
            mock_ack.return_value = {"id": expected_delivery_id, "status": "acknowledged"}
            result = await handlers["mark_reminder_acknowledged"]({
                "reminder_id": arg_value,
                "status": "acknowledged",
                "user_response": "noted",
            })
            await reminder_session_state["_reminder_ack_task"]

        assert result["status"] == "success"
        delivered = reminder_session_state.get("reminders_delivered", set())
        assert expected_reminder_id in delivered
        mock_ack.assert_awaited_once_with(
            expected_delivery_id,
            "acknowledged",
            "noted",
        )

    @pytest.mark.asyncio
    async def test_web_search_handles_empty_query(self, session_state):
        """web_search should handle empty query gracefully."""
        handlers = make_tool_handlers(session_state)
        result = await handlers["web_search"]({"query": ""})
        assert result["status"] == "success"

    def test_handler_factory_keeps_active_and_retired_handlers(self, session_state):
        """Handler factory keeps active tool handlers plus retired future-use handlers."""
        handlers = make_tool_handlers(session_state)
        assert set(handlers.keys()) == {"web_search", "mark_reminder_acknowledged", "create_reminder", "search_memories", "save_important_detail", "check_caregiver_notes"}
