from types import SimpleNamespace

from tests.simulation.fixtures import _pick_profile_notes_column
from tests.simulation.runner import (
    _apply_post_call_metrics_summary,
    _caller_intends_goodbye,
    _collect_injected_memories,
    _collect_tool_call_details,
    _end_reason_after_response_timeout,
    _format_reminders_prompt,
    _scenario_reminders,
    _start_scenario_faults,
    _stop_scenario_faults,
)
from tests.simulation.transport import CallResult
from tests.simulation.scenarios import (
    empty_search_result_scenario,
    multiple_reminders_scenario,
    slow_search_overlap_scenario,
)
from tests.simulation.stress import (
    build_parallel_flake_specs,
    build_post_call_stampede_specs,
    build_reminder_stampede_specs,
    build_stress_pack_specs,
    scale_2000_load_test_plan,
)


def test_collect_injected_memories_includes_context_trace_events():
    session_state = {
        "_context_trace_events": [
            {
                "source": "memory_context",
                "action": "injected",
                "content": "- Her grandson Jake plays baseball",
            },
            {
                "source": "conversation_tracking",
                "action": "injected",
                "content": "Topics discussed: family",
            },
        ]
    }
    collector = SimpleNamespace(injected_memories=[])

    assert _collect_injected_memories(session_state, collector) == [
        "- Her grandson Jake plays baseball"
    ]


def test_collect_injected_memories_deduplicates_frame_and_trace_sources():
    collector = SimpleNamespace(injected_memories=["- Lisa visits on Sundays"])
    session_state = {
        "_context_trace_events": [
            {
                "source": "memory_context",
                "action": "injected",
                "content": "- Lisa visits on Sundays",
            }
        ]
    }

    assert _collect_injected_memories(session_state, collector) == [
        "- Lisa visits on Sundays"
    ]


def test_caller_goodbye_ignores_explicit_false_goodbyes():
    assert not _caller_intends_goodbye(
        "Bye Helen, take care getting home. Sorry Donna, I'm still here.",
        should_end_call=False,
    )
    assert _caller_intends_goodbye(
        "Bye Donna, talk to you tomorrow.",
        should_end_call=False,
    )
    assert _caller_intends_goodbye(
        "Thanks dear, bye bye.",
        should_end_call=True,
    )


def test_response_timeout_after_caller_goodbye_is_not_a_failed_timeout():
    assert _end_reason_after_response_timeout(caller_is_goodbye=True) == "caller_goodbye"
    assert _end_reason_after_response_timeout(caller_is_goodbye=False) == "timeout"


def test_pick_profile_notes_column_handles_rename_window():
    assert _pick_profile_notes_column({"profile_notes"}) == "profile_notes"
    assert _pick_profile_notes_column({"medical_notes"}) == "medical_notes"
    assert _pick_profile_notes_column({"profile_notes", "medical_notes"}) == "profile_notes"


def test_multiple_reminder_prompt_includes_every_item_in_opening_instruction():
    reminders = _scenario_reminders(multiple_reminders_scenario())
    prompt = _format_reminders_prompt(reminders).lower()

    assert len(reminders) == 2
    assert "include every pending reminder" in prompt
    assert "porch plants" in prompt
    assert "bridge club" in prompt
    assert "tomorrow at 9 am" in prompt


def test_collect_tool_call_details_includes_context_trace_repeated_calls():
    session_state = {
        "_context_trace_events": [
            {
                "source": "tool",
                "action": "called",
                "metadata": {
                    "tool": "mark_reminder_acknowledged",
                    "arguments": {"reminder_id": "rem-001"},
                },
            },
            {
                "source": "tool",
                "action": "called",
                "metadata": {
                    "tool": "mark_reminder_acknowledged",
                    "arguments": {"reminder_id": "rem-002"},
                },
            },
        ]
    }
    collector = SimpleNamespace(tool_calls=[])

    assert _collect_tool_call_details(session_state, collector) == [
        {
            "name": "mark_reminder_acknowledged",
            "args": {"reminder_id": "rem-001"},
        },
        {
            "name": "mark_reminder_acknowledged",
            "args": {"reminder_id": "rem-002"},
        },
    ]


def test_post_call_metrics_summary_is_exposed_without_tool_arguments():
    result = CallResult()
    session_state = {
        "_post_call_metrics_persisted": {
            "persisted": True,
            "tools_used": ["web_search", "create_reminder"],
            "context_event_count": 3,
            "context_trace_encrypted": True,
            "error_count": 0,
        },
        "_context_trace_events": [
            {
                "source": "tool",
                "action": "called",
                "metadata": {
                    "tool": "web_search",
                    "arguments": {"query": "local library events"},
                },
            }
        ],
    }

    _apply_post_call_metrics_summary(result, session_state)

    assert result.post_call_metrics_logged is True
    assert result.post_call_logged_tools == ["web_search", "create_reminder"]
    assert result.post_call_context_event_count == 3
    assert result.post_call_context_trace_encrypted is True
    assert result.post_call_error_count == 0
    assert "local library events" not in str(result.__dict__)


def test_web_search_fault_flags_patch_runner_services():
    empty = empty_search_result_scenario()
    patches = _start_scenario_faults(empty)
    try:
        assert patches
    finally:
        _stop_scenario_faults(patches)

    slow = slow_search_overlap_scenario()
    patches = _start_scenario_faults(slow)
    try:
        assert patches
    finally:
        _stop_scenario_faults(patches)


def test_stress_spec_builders_label_distinct_concurrent_slots():
    stress_specs = build_stress_pack_specs(repetitions=2)
    reminder_specs = build_reminder_stampede_specs(12)
    post_call_specs = build_post_call_stampede_specs(8)
    flake_specs = build_parallel_flake_specs(
        multiple_reminders_scenario,
        repetitions=5,
    )

    assert len({spec.label for spec in stress_specs}) == len(stress_specs)
    assert len(reminder_specs) == 12
    assert len({spec.label for spec in reminder_specs}) == 12
    assert len(post_call_specs) == 8
    assert all(spec.label.startswith("post-call-stampede-") for spec in post_call_specs)
    assert [spec.scenario.name for spec in flake_specs] == ["multiple_reminders"] * 5


def test_scale_2000_plan_uses_load_harness_not_full_llm_stampede():
    plan = scale_2000_load_test_plan()

    assert plan["primary_track"] == "locust_websocket_load"
    assert plan["target_concurrent_users"] == 2000
    assert plan["requires_load_test_mode"] is True
    assert plan["mock_call_sample_size"] < plan["target_concurrent_users"]
