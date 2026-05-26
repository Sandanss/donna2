"""One-shot LLM-vs-LLM simulated call. Prints the transcript.

Picks a scenario via --scenario (default: web_search), seeds a fresh test
senior, runs the full pipeline (real Claude Haiku + real Director + real
DB), prints each turn with latency, then cleans up the senior.

Requires ANTHROPIC_API_KEY + DATABASE_URL. Optional: GROQ_API_KEY,
OPENAI_API_KEY for the Director / memory paths.

Run via Railway dev env (which has all the keys):
    railway run --environment dev --service donna-pipecat -- uv run python scripts/run_simulated_demo.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

# Add the pipecat package root so `tests.simulation` imports resolve.
PKG_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PKG_ROOT))

# Suppress the pipecat audio deprecation warning so the transcript output is clean.
import warnings
warnings.filterwarnings("ignore", category=DeprecationWarning, module="pipecat.audio.utils")

from tests.simulation import (  # noqa: E402
    TestSenior,
    ambiguous_reminder_ack_scenario,
    async_search_overlap_scenario,
    cognitive_confusion_reminder_scenario,
    cleanup_test_senior,
    consent_ai_question_then_grant_scenario,
    consent_ambiguous_then_grant_scenario,
    consent_boundary_reminder_attempt_scenario,
    consent_decline_scenario,
    consent_grant_scenario,
    consent_off_topic_redirect_decline_scenario,
    cognitive_confusion_scenario,
    discovery_boundary_redirect_scenario,
    discovery_correction_scenario,
    discovery_early_goodbye_scenario,
    discovery_off_topic_weather_scenario,
    discovery_quiet_routine_scenario,
    discovery_scenario,
    discovery_boundary_reminder_attempt_scenario,
    embedding_outage_scenario,
    empty_search_result_scenario,
    false_goodbye_scenario,
    false_goodbye_reminder_ack_scenario,
    health_concern_scenario,
    low_engagement_scenario,
    low_engagement_reminder_scenario,
    memory_recall_scenario,
    memory_seed_scenario,
    multiple_reminders_scenario,
    out_of_order_reminder_ack_scenario,
    reminder_interruption_scenario,
    reminder_overload_scenario,
    reminder_scenario,
    reminder_creation_scenario,
    run_simulated_call,
    search_phi_guard_scenario,
    seed_test_senior,
    discovery_first_call_correction_scenario,
    discovery_first_call_early_goodbye_scenario,
    discovery_first_call_quiet_preferences_scenario,
    discovery_first_call_scenario,
    discovery_first_call_weather_scenario,
    discovery_no_more_calls_scenario,
    discovery_not_good_time_scenario,
    similar_reminders_scenario,
    slow_search_overlap_scenario,
    unacknowledged_reminder_scenario,
    web_search_scenario,
)

SCENARIOS = {
    "ambiguous_reminder_ack": ambiguous_reminder_ack_scenario,
    "async_search_overlap": async_search_overlap_scenario,
    "cognitive_confusion_reminder": cognitive_confusion_reminder_scenario,
    "consent_boundary_reminder_attempt": consent_boundary_reminder_attempt_scenario,
    "consent_decline": consent_decline_scenario,
    "consent_grant": consent_grant_scenario,
    "consent_ambiguous_then_grant": consent_ambiguous_then_grant_scenario,
    "consent_ai_question_then_grant": consent_ai_question_then_grant_scenario,
    "consent_off_topic_redirect_decline": consent_off_topic_redirect_decline_scenario,
    "cognitive_confusion": cognitive_confusion_scenario,
    "discovery": discovery_scenario,
    "discovery_boundary_redirect": discovery_boundary_redirect_scenario,
    "discovery_boundary_reminder_attempt": discovery_boundary_reminder_attempt_scenario,
    "discovery_correction": discovery_correction_scenario,
    "discovery_early_goodbye": discovery_early_goodbye_scenario,
    "discovery_off_topic_weather": discovery_off_topic_weather_scenario,
    "discovery_quiet_routine": discovery_quiet_routine_scenario,
    "embedding_outage": embedding_outage_scenario,
    "empty_search_result": empty_search_result_scenario,
    "false_goodbye": false_goodbye_scenario,
    "false_goodbye_reminder_ack": false_goodbye_reminder_ack_scenario,
    "health_concern": health_concern_scenario,
    "low_engagement": low_engagement_scenario,
    "low_engagement_reminder": low_engagement_reminder_scenario,
    "web_search": web_search_scenario,
    "memory_seed": memory_seed_scenario,
    "memory_recall": memory_recall_scenario,
    "multiple_reminders": multiple_reminders_scenario,
    "out_of_order_reminder_ack": out_of_order_reminder_ack_scenario,
    "reminder": reminder_scenario,
    "reminder_creation": reminder_creation_scenario,
    "reminder_interruption": reminder_interruption_scenario,
    "reminder_overload": reminder_overload_scenario,
    "search_phi_guard": search_phi_guard_scenario,
    "discovery_first_call_happy_path": discovery_first_call_scenario,
    "discovery_not_good_time": discovery_not_good_time_scenario,
    "discovery_no_more_calls": discovery_no_more_calls_scenario,
    "discovery_first_call_quiet_preferences": discovery_first_call_quiet_preferences_scenario,
    "discovery_first_call_weather": discovery_first_call_weather_scenario,
    "discovery_first_call_early_goodbye": discovery_first_call_early_goodbye_scenario,
    "discovery_first_call_correction": discovery_first_call_correction_scenario,
    "similar_reminders": similar_reminders_scenario,
    "slow_search_overlap": slow_search_overlap_scenario,
    "unacknowledged_reminder": unacknowledged_reminder_scenario,
}


def parse_args():
    p = argparse.ArgumentParser(description="One-shot LLM-vs-LLM simulated call demo")
    p.add_argument(
        "--scenario",
        choices=sorted(SCENARIOS.keys()),
        default="web_search",
        help="Scenario name (default: web_search)",
    )
    p.add_argument(
        "--no-post-call",
        action="store_true",
        help="Skip post-call analysis to speed up the demo",
    )
    p.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Skip cleanup_test_senior at the end (leaves the test senior in the DB)",
    )
    return p.parse_args()


def format_turn(turn: dict) -> str:
    """Render one turn for human reading. Caller line, then Donna line + latency."""
    caller = (turn.get("caller") or "").strip()
    donna = (turn.get("donna") or "").strip() or "(no response — pipeline ended)"
    latency = turn.get("latency_ms")
    latency_str = f"  [{round(latency)}ms]" if latency is not None else "  [no latency captured]"
    return (
        f"  Senior ▶ {caller}\n"
        f"  Donna  ◀ {donna}{latency_str}"
    )


def print_banner(title: str) -> None:
    bar = "─" * max(8, len(title))
    print(f"\n{bar}\n{title}\n{bar}")


async def main():
    args = parse_args()

    for required in ("ANTHROPIC_API_KEY", "DATABASE_URL"):
        if not os.getenv(required):
            print(f"ERROR: ${required} is required.", file=sys.stderr)
            sys.exit(2)

    scenario = SCENARIOS[args.scenario]()

    print_banner(f"LLM-vs-LLM simulated call: scenario={args.scenario}")
    print(f"  senior persona  : {scenario.persona.name} (age {scenario.persona.age})")
    print(f"  speech style    : {scenario.persona.speech_style[:80]}…")
    print(f"  caller goals    : {len(scenario.goals)}")
    print(f"  call_type       : {scenario.call_type}")
    print(f"  max_turns       : {scenario.max_turns}")

    # Each demo run gets a fresh senior with a unique UUID + phone so
    # repeated runs don't trip the `seniors_phone_unique` constraint.
    # (The default scenario senior is shared across all scenarios and
    # would collide with a leftover row from a previous demo run.)
    import uuid as _uuid
    template = scenario.senior
    unique_suffix = str(_uuid.uuid4()).replace('-', '')[:6]
    fresh_senior = TestSenior(
        id=str(_uuid.uuid4()),
        name=f"{template.name.split()[0]} Demo-{unique_suffix}",
        phone=f"55599{unique_suffix[:5]}",
        timezone=template.timezone,
        interests=list(template.interests),
        profile_notes=template.profile_notes,
        city=template.city,
        state=template.state,
    )

    print_banner("Seeding test senior + pipeline...")
    senior = await seed_test_senior(fresh_senior)
    print(f"  senior_id       : {senior.id[:8]}…")
    print(f"  name (test)     : {senior.name}")

    try:
        print_banner("Conversation")
        result = await run_simulated_call(
            scenario,
            senior=senior,
            run_post_call_processing=not args.no_post_call,
        )
        for turn in result.turns:
            print(format_turn(turn))
            print()

        print_banner("Summary")
        print(f"  turns           : {len(result.turns)}")
        print(f"  end_reason      : {result.end_reason}")
        print(f"  total duration  : {result.total_duration_ms / 1000:.1f}s")
        print(f"  tool calls      : {', '.join(result.tool_calls_made) or '(none)'}")
        print(f"  memories injected: {len(result.injected_memories)}")
        print(f"  fillers spoken  : {len(result.fillers)}")
        print(f"  post-call done  : {result.post_call_completed}")
    finally:
        if not args.no_cleanup:
            await cleanup_test_senior(senior.id)
            print("\n(test senior cleaned up)")


if __name__ == "__main__":
    asyncio.run(main())
