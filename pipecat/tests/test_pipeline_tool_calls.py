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
        assert "Take metformin" in delivered
        assert reminder_session_state["_reminder_ack_persisted"] is True
        mock_ack.assert_awaited_once_with("delivery-001", "acknowledged", "I'll take it now")

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
