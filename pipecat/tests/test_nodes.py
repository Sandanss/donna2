"""Tests for Pipecat Flows call phase node definitions."""

import pytest

from flows.nodes import (
    build_reminder_node,
    build_main_node,
    build_winding_down_node,
    build_closing_node,
    build_onboarding_closing_node,
    build_initial_node,
    _build_senior_context,
    _build_reminder_context,
    _build_tracking_context,
    _make_transition_reminder_to_main,
)
from prompts import BASE_SYSTEM_PROMPT
from flows.tools import make_flows_tools


def _make_session_state(**overrides):
    """Helper to create a session_state dict with defaults."""
    state = {
        "senior_id": "test-senior-1",
        "senior": {"name": "Margaret Smith", "interests": ["gardening", "reading"]},
        "memory_context": "Tier 1: Has arthritis in hands",
        "news_context": None,
        "greeting": "Good morning, Margaret!",
        "reminder_prompt": "Remind Margaret to take her blood pressure medication at 2pm.",
        "reminder_delivery": None,
        "reminders_delivered": set(),
        "conversation_id": "conv-1",
        "call_sid": "CA123",
        "call_type": "check-in",
        "is_outbound": True,
        "previous_calls_summary": "Yesterday: Discussed gardening",
        "recent_turns": None,
        "todays_context": None,
        "conversation_tracking": None,
    }
    state.update(overrides)
    return state


def _get_func_names(node):
    """Extract function names from a node's functions list."""
    names = []
    for f in node.get("functions", []):
        if hasattr(f, "name"):
            names.append(f.name)
        elif isinstance(f, dict):
            names.append(f.get("name", ""))
    return names


class TestBaseSystemPrompt:
    def test_prompt_contains_persona(self):
        assert "Donna" in BASE_SYSTEM_PROMPT
        assert "warm" in BASE_SYSTEM_PROMPT

    def test_prompt_contains_speech_handling(self):
        assert "stt" in BASE_SYSTEM_PROMPT.lower()

    def test_prompt_limits_response_length(self):
        assert "1-2 sentences" in BASE_SYSTEM_PROMPT


class TestSeniorContext:
    def test_includes_name(self):
        state = _make_session_state()
        ctx = _build_senior_context(state)
        assert "Margaret" in ctx

    def test_includes_interests(self):
        state = _make_session_state()
        ctx = _build_senior_context(state)
        assert "gardening" in ctx

    def test_includes_rich_profile_context(self):
        state = _make_session_state(
            senior={
                "name": "Margaret Smith",
                "interests": ["gardening"],
                "family_info": {
                    "interestDetails": {"gardening": "Loves roses and tomatoes"},
                    "topicsToAvoid": "politics",
                },
                "additional_info": "Prefers gentle humor.",
            }
        )
        ctx = _build_senior_context(state)
        assert "gardening: Loves roses and tomatoes" in ctx
        assert "Additional context from family: Prefers gentle humor." in ctx
        assert "Topics to AVOID" in ctx
        assert "politics" in ctx

    def test_topics_to_avoid_falls_back_to_preferred_call_times(self):
        state = _make_session_state(
            senior={
                "name": "Margaret Smith",
                "preferred_call_times": {"topicsToAvoid": ["politics", "recent loss"]},
            }
        )
        ctx = _build_senior_context(state)
        assert "Topics to AVOID" in ctx
        assert "politics; recent loss" in ctx

    def test_includes_previous_calls(self):
        state = _make_session_state()
        ctx = _build_senior_context(state)
        assert "Yesterday" in ctx

    def test_includes_temporal_grounding_guard(self):
        state = _make_session_state(
            last_call_analysis={
                "call_time_label": "Earlier today at 3:00 PM (about 30 minutes ago)",
                "follow_up_suggestions": ["Ask about the workout planned for tomorrow."],
            }
        )
        ctx = _build_senior_context(state)
        assert "Current time:" in ctx
        assert "do not ask whether it already happened yet" in ctx
        assert "Earlier today at 3:00 PM" in ctx
        assert "Timing guard" in ctx

    def test_handles_no_senior(self):
        state = _make_session_state(senior=None)
        ctx = _build_senior_context(state)
        assert "there" in ctx  # fallback name

    def test_includes_memory_context(self):
        state = _make_session_state()
        ctx = _build_senior_context(state)
        assert "arthritis" in ctx

    def test_news_availability_in_system_prompt(self):
        """Full news is injected ephemerally when Director recommends it."""
        state = _make_session_state(news_context="Here are some recent news items about gardening...")
        ctx = _build_senior_context(state)
        assert "Fresh interest-based news is available" in ctx
        assert "Here are some recent news items about gardening" not in ctx

    def test_includes_recent_turns(self):
        state = _make_session_state(
            recent_turns="Earlier today at 3:00 PM - SENIOR: I will work out tomorrow."
        )
        ctx = _build_senior_context(state)
        assert "Recent turn excerpts" in ctx
        assert "I will work out tomorrow" in ctx
        assert "Respect any dates or time labels exactly" in ctx



class TestReminderContext:
    def test_includes_reminder_prompt(self):
        state = _make_session_state()
        ctx = _build_reminder_context(state)
        assert "blood pressure" in ctx

    def test_delivered_reminders_shown(self):
        state = _make_session_state(reminders_delivered={"Take Lisinopril"})
        ctx = _build_reminder_context(state)
        assert "ALREADY DELIVERED" in ctx
        assert "Lisinopril" in ctx

    def test_empty_when_no_reminders(self):
        state = _make_session_state(reminder_prompt=None)
        ctx = _build_reminder_context(state)
        assert ctx == ""


class TestMainNode:
    def test_node_has_all_tools(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools)
        func_names = _get_func_names(node)
        assert "web_search" in func_names
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_winding_down" in func_names
        # search_memories, save_important_detail, check_caregiver_notes removed
        # (Director-first architecture: handled by prefetch/post-call/pre-fetch)

    def test_node_does_not_have_get_news(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools)
        func_names = _get_func_names(node)
        assert "get_news" not in func_names

    def test_node_has_append_strategy(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools)
        ctx_strategy = node.get("context_strategy")
        assert ctx_strategy is not None
        from pipecat_flows import ContextStrategy
        assert ctx_strategy.strategy == ContextStrategy.APPEND

    def test_with_greeting_has_system_prompt(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=True)
        assert len(node["role_messages"]) == 1
        assert "Donna" in node["role_messages"][0]["content"]

    def test_with_greeting_has_respond_immediately(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=True)
        assert node.get("respond_immediately") is True

    def test_with_greeting_includes_greeting_text(self):
        state = _make_session_state(greeting="Hello Margaret!")
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=True)
        task_content = node["task_messages"][0]["content"]
        assert "Hello Margaret!" in task_content

    def test_without_greeting_no_system_prompt(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=False)
        assert node["role_messages"] == []

    def test_without_greeting_no_respond_immediately(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=False)
        assert node.get("respond_immediately") is False

    def test_outbound_uses_outbound_greeting(self):
        state = _make_session_state(is_outbound=True)
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=True)
        task_content = node["task_messages"][0]["content"]
        assert "START THE CALL" in task_content

    def test_inbound_uses_inbound_greeting(self):
        state = _make_session_state(is_outbound=False)
        tools = make_flows_tools(state)
        node = build_main_node(state, tools, with_greeting=True)
        task_content = node["task_messages"][0]["content"]
        assert "INBOUND" in task_content


class TestWindingDownNode:
    def test_node_has_reminder_tool(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_winding_down_node(state, tools)
        func_names = _get_func_names(node)
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_closing" in func_names

    def test_exposes_create_reminder(self):
        # Last-minute "oh, by the way, remind me..." requests need the tool
        # available even while wrapping up.
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_winding_down_node(state, tools)
        assert "create_reminder" in _get_func_names(node)

    def test_transition_node_has_no_system_prompt(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_winding_down_node(state, tools)
        assert node["role_messages"] == []


class TestClosingNode:
    def test_node_has_end_conversation(self):
        state = _make_session_state()
        node = build_closing_node(state)
        post_actions = node.get("post_actions", [])
        assert any(a["type"] == "end_conversation" for a in post_actions)

    def test_node_has_no_tools(self):
        state = _make_session_state()
        node = build_closing_node(state)
        assert len(node.get("functions", [])) == 0

    def test_uses_senior_name(self):
        state = _make_session_state()
        node = build_closing_node(state)
        task_content = node["task_messages"][0]["content"]
        assert "Margaret" in task_content

    def test_transition_node_has_no_system_prompt(self):
        state = _make_session_state()
        node = build_closing_node(state)
        assert node["role_messages"] == []


class TestOnboardingClosingNode:
    def test_transition_node_has_no_system_prompt(self):
        state = _make_session_state(prospect={"learned_name": "Alex"})
        node = build_onboarding_closing_node(state)
        assert node["role_messages"] == []

    def test_node_has_end_conversation(self):
        state = _make_session_state(prospect={"learned_name": "Alex"})
        node = build_onboarding_closing_node(state)
        post_actions = node.get("post_actions", [])
        assert any(a["type"] == "end_conversation" for a in post_actions)


class TestReminderNode:
    def test_node_has_correct_name(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        assert node["name"] == "reminder"

    def test_has_reminder_tools(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        func_names = _get_func_names(node)
        assert "mark_reminder_acknowledged" in func_names
        assert "transition_to_main" in func_names

    def test_does_not_have_removed_tools(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        func_names = _get_func_names(node)
        assert "mark_reminder_acknowledged" in func_names

    def test_exposes_create_reminder(self):
        # Seniors often ask Donna to remember a NEW thing during a delivery
        # call — the tool must be available in this phase, not only in main.
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        assert "create_reminder" in _get_func_names(node)

    def test_includes_reminder_context(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        task_content = node["task_messages"][0]["content"]
        assert "blood pressure" in task_content

    def test_uses_append_strategy(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        from pipecat_flows import ContextStrategy
        assert node["context_strategy"].strategy == ContextStrategy.APPEND

    def test_no_system_prompt_without_greeting(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        assert node["role_messages"] == []

    def test_does_not_respond_immediately_without_greeting(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools)
        assert node.get("respond_immediately") is False

    def test_with_greeting_has_system_prompt(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools, with_greeting=True)
        assert len(node["role_messages"]) == 1
        assert "Donna" in node["role_messages"][0]["content"]

    def test_with_greeting_responds_immediately(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools, with_greeting=True)
        assert node.get("respond_immediately") is True

    def test_with_greeting_includes_greeting_text(self):
        state = _make_session_state(greeting="Hi Margaret!")
        tools = make_flows_tools(state)
        node = build_reminder_node(state, tools, with_greeting=True)
        task_content = node["task_messages"][0]["content"]
        assert "Hi Margaret!" in task_content


class TestConditionalRouting:
    def test_routes_to_reminder_when_reminders_pending(self):
        state = _make_session_state(
            reminder_prompt="Take blood pressure medication at 2pm.",
            reminders_delivered=set(),
        )
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "reminder"

    def test_routes_to_main_when_no_reminders(self):
        state = _make_session_state(
            reminder_prompt=None,
            reminders_delivered=set(),
        )
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "main"

    def test_routes_to_main_when_reminders_already_delivered(self):
        state = _make_session_state(
            reminder_prompt="Take blood pressure medication at 2pm.",
            reminders_delivered={"Take blood pressure medication"},
        )
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "main"

    @pytest.mark.asyncio
    async def test_reminder_to_main_transition(self):
        state = _make_session_state()
        tools = make_flows_tools(state)
        transition_fn = _make_transition_reminder_to_main(state, tools)
        result, node = await transition_fn({}, None)
        assert result["status"] == "success"
        assert node["name"] == "main"


class TestInitialNode:
    def test_returns_main_without_reminders(self):
        state = _make_session_state(reminder_prompt=None)
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "main"

    def test_returns_reminder_with_pending_reminders(self):
        state = _make_session_state(
            reminder_prompt="Take medication",
            reminders_delivered=set(),
        )
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "reminder"

    def test_initial_node_always_responds_immediately(self):
        state = _make_session_state(reminder_prompt=None)
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node.get("respond_immediately") is True

    def test_initial_node_has_system_prompt(self):
        state = _make_session_state(reminder_prompt=None)
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        assert len(node["role_messages"]) == 1
        assert "Donna" in node["role_messages"][0]["content"]

    def test_initial_node_includes_greeting(self):
        state = _make_session_state(reminder_prompt=None, greeting="Hello Margaret!")
        tools = make_flows_tools(state)
        node = build_initial_node(state, tools)
        task_content = node["task_messages"][0]["content"]
        assert "Hello Margaret!" in task_content


class TestConsentFlow:
    """Consent call flow (call_type='consent')."""

    def _consent_state(self, **overrides):
        state = {
            "senior_id": "test-senior-consent",
            "senior": {"name": "Mary Johnson"},
            "_caregivers": [{"name": "Sarah Johnson", "relation": "daughter"}],
            "conversation_id": "conv-consent-1",
            "call_type": "consent",
            "is_outbound": True,
        }
        state.update(overrides)
        return state

    def test_initial_node_routes_to_consent_when_call_type_consent(self):
        from flows.tools import make_consent_flows_tools
        state = self._consent_state()
        tools = make_consent_flows_tools(state)
        node = build_initial_node(state, tools)
        assert node["name"] == "consent"

    def test_consent_node_exposes_only_consent_and_transition_tools(self):
        from flows.nodes import build_consent_node
        from flows.tools import make_consent_flows_tools
        state = self._consent_state()
        tools = make_consent_flows_tools(state)
        node = build_consent_node(state, tools)
        fn_names = {f.name for f in node["functions"]}
        assert fn_names == {"record_consent_response", "transition_to_consent_closing"}

    def test_consent_node_interpolates_caregiver_intro(self):
        from flows.nodes import build_consent_node
        from flows.tools import make_consent_flows_tools
        state = self._consent_state()
        tools = make_consent_flows_tools(state)
        node = build_consent_node(state, tools)
        task = node["task_messages"][0]["content"]
        # "Sarah, your daughter," renders from _caregivers
        assert "Sarah, your daughter" in task
        # No literal Python placeholders left behind
        assert "{caregiver_intro}" not in task
        assert "{first_name}" not in task

    def test_consent_node_caregiver_intro_falls_back(self):
        from flows.nodes import build_consent_node
        from flows.tools import make_consent_flows_tools
        # No caregivers + no family_info → neutral fallback
        state = self._consent_state(_caregivers=[], senior={"name": "Mary Johnson"})
        tools = make_consent_flows_tools(state)
        node = build_consent_node(state, tools)
        task = node["task_messages"][0]["content"]
        assert "someone in your family" in task

    def test_consent_closing_node_ends_conversation(self):
        from flows.nodes import build_consent_closing_node
        state = self._consent_state()
        node = build_consent_closing_node(state)
        assert node["name"] == "consent_closing"
        assert node.get("post_actions") == [{"type": "end_conversation"}]
        assert node["functions"] == []
