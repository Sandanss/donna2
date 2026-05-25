"""Level 2: Flow phase transition tests.

Tests that node builders produce correct NodeConfig structures for each phase,
and that transition functions return valid next-phase configs.
"""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from flows.nodes import (
    build_initial_node,
    build_main_node,
    build_reminder_node,
    build_winding_down_node,
    build_closing_node,
    _make_transition_reminder_to_main,
    _make_transition_to_winding_down,
    _make_transition_to_closing,
)
from flows.tools import make_flows_tools


class TestPhaseNodeConfigs:
    def test_initial_node_is_main_without_reminders(self, session_state):
        session_state["reminder_prompt"] = None
        flows_tools = make_flows_tools(session_state)
        node = build_initial_node(session_state, flows_tools)

        assert node["name"] == "main"
        func_names = [f.name for f in node["functions"]]
        assert "web_search" in func_names
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_winding_down" in func_names
        assert node.get("respond_immediately") is True

    def test_initial_node_is_reminder_with_pending(self, session_state):
        session_state["reminder_prompt"] = "Water the porch plants at 2pm"
        session_state["reminders_delivered"] = set()
        flows_tools = make_flows_tools(session_state)
        node = build_initial_node(session_state, flows_tools)

        assert node["name"] == "reminder"
        func_names = [f.name for f in node["functions"]]
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_main" in func_names
        assert node.get("respond_immediately") is True

    def test_main_node_has_all_tools(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_main_node(session_state, flows_tools)

        assert node["name"] == "main"
        func_names = [f.name for f in node["functions"]]
        assert "web_search" in func_names
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_winding_down" in func_names
        # search_memories, save_important_detail, check_caregiver_notes removed
        # (Director-first architecture: handled by prefetch/post-call/pre-fetch)

    def test_winding_down_node_limited_tools(self, session_state):
        flows_tools = make_flows_tools(session_state)
        node = build_winding_down_node(session_state, flows_tools)

        assert node["name"] == "winding_down"
        func_names = [f.name for f in node["functions"]]
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_closing" in func_names
        assert "get_news" not in func_names

    def test_closing_node_no_tools(self, session_state):
        node = build_closing_node(session_state)

        assert node["name"] == "closing"
        assert len(node["functions"]) == 0
        assert any(a.get("type") == "end_conversation" for a in node["post_actions"])


class TestPhaseTransitions:
    @pytest.mark.asyncio
    async def test_transition_reminder_to_main(self, session_state):
        flows_tools = make_flows_tools(session_state)
        transition = _make_transition_reminder_to_main(session_state, flows_tools)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node["name"] == "main"

    @pytest.mark.asyncio
    async def test_transition_reminder_to_main_records_missing_ack(
        self, reminder_session_state
    ):
        flows_tools = make_flows_tools(reminder_session_state)
        transition = _make_transition_reminder_to_main(
            reminder_session_state, flows_tools
        )

        with patch(
            "services.reminder_delivery.mark_reminder_acknowledged",
            new_callable=AsyncMock,
        ) as mock_ack:
            mock_ack.return_value = {
                "id": "delivery-001",
                "status": "acknowledged",
            }
            result, node = await transition({}, None)
            await reminder_session_state["_reminder_ack_task"]

        assert result["status"] == "success"
        assert node["name"] == "main"
        assert reminder_session_state["_reminder_ack_attempted"] is True
        assert "mark_reminder_acknowledged" in reminder_session_state["_tools_used"]
        mock_ack.assert_awaited_once_with(
            "delivery-001",
            "acknowledged",
            "Senior responded to the reminder before Donna moved into the main conversation.",
        )

    @pytest.mark.asyncio
    async def test_transition_reminder_to_main_records_multiple_missing_acks(
        self, reminder_session_state
    ):
        reminder_session_state["_pending_reminders"] = [
            {"id": "rem-001", "title": "Water the porch plants"},
            {"id": "rem-002", "title": "Call Eleanor about bridge club"},
        ]
        reminder_session_state["reminder_deliveries"] = [
            {
                "id": "delivery-001",
                "reminder_id": "rem-001",
                "title": "Water the porch plants",
            },
            {
                "id": "delivery-002",
                "reminder_id": "rem-002",
                "title": "Call Eleanor about bridge club",
            },
        ]
        flows_tools = make_flows_tools(reminder_session_state)
        transition = _make_transition_reminder_to_main(
            reminder_session_state, flows_tools
        )

        with patch(
            "services.reminder_delivery.mark_reminder_acknowledged",
            new_callable=AsyncMock,
        ) as mock_ack:
            mock_ack.return_value = {"status": "acknowledged"}
            result, node = await transition({}, None)
            await asyncio.gather(
                *list(reminder_session_state.get("_reminder_ack_tasks", []))
            )

        assert result["status"] == "success"
        assert node["name"] == "main"
        assert {"rem-001", "rem-002"} <= reminder_session_state["reminders_delivered"]
        assert {"Water the porch plants", "Call Eleanor about bridge club"} <= reminder_session_state[
            "reminders_delivered"
        ]
        assert mock_ack.await_count == 2
        assert [call.args[0] for call in mock_ack.await_args_list] == [
            "delivery-001",
            "delivery-002",
        ]

    @pytest.mark.asyncio
    async def test_transition_main_to_winding_down(self, session_state):
        flows_tools = make_flows_tools(session_state)
        transition = _make_transition_to_winding_down(session_state, flows_tools)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node["name"] == "winding_down"

    @pytest.mark.asyncio
    async def test_transition_to_closing(self, session_state):
        transition = _make_transition_to_closing(session_state)

        result, node = await transition({}, None)
        assert result["status"] == "success"
        assert node["name"] == "closing"

    def test_initial_node_routes_correctly(self, session_state):
        session_state["reminder_prompt"] = None
        flows_tools = make_flows_tools(session_state)
        node = build_initial_node(session_state, flows_tools)
        assert node["name"] == "main"
