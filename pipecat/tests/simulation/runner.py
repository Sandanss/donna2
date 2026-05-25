"""CallSimRunner -- orchestration loop for LLM-to-LLM simulation tests.

Connects all simulation components into a working call:
- CallerAgent (Haiku) generates caller speech
- TextCallerTransport injects it into the pipeline with realistic timing
- ResponseCollector captures Donna's output
- LiveSimPipeline provides the real pipeline (Observer, Director, Claude, Flows)
- Scenarios define what should happen
- DB fixtures provide test data

Usage::

    scenario = web_search_scenario()
    senior = await seed_test_senior(scenario.senior)
    result = await run_simulated_call(scenario, senior=senior)
    assert "web_search" in result.tool_calls_made
"""

from __future__ import annotations

import asyncio
import re
import time

from loguru import logger
from pipecat.frames.frames import EndFrame

from services.post_call import run_post_call
from tests.simulation.caller import CallerAgent
from tests.simulation.fixtures import (
    TestSenior,
    build_session_state,
    create_test_conversation,
)
from tests.simulation.pipeline import build_live_sim_pipeline
from tests.simulation.scenarios import LiveSimScenario
from tests.simulation.transport import CallResult


# ---------------------------------------------------------------------------
# Goodbye detection
# ---------------------------------------------------------------------------

_GOODBYE_WORDS = re.compile(
    r"\b(goodbye|bye\b|gotta go|talk to you later|talk to you tomorrow)",
    re.IGNORECASE,
)

_FALSE_GOODBYE_CONTINUATION = re.compile(
    r"\b(still here|sorry donna|that was my|my neighbor|hold on|one second)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# run_simulated_call
# ---------------------------------------------------------------------------


async def run_simulated_call(
    scenario: LiveSimScenario,
    senior: TestSenior | None = None,
    conversation_id: str | None = None,
    run_post_call_processing: bool = True,
) -> CallResult:
    """Run a full simulated call with any scenario-level fault injection."""
    fault_patches = _start_scenario_faults(scenario)
    try:
        return await _run_simulated_call_inner(
            scenario,
            senior=senior,
            conversation_id=conversation_id,
            run_post_call_processing=run_post_call_processing,
        )
    finally:
        _stop_scenario_faults(fault_patches)


async def _run_simulated_call_inner(
    scenario: LiveSimScenario,
    senior: TestSenior | None = None,
    conversation_id: str | None = None,
    run_post_call_processing: bool = True,
) -> CallResult:
    """Run a full simulated call between a CallerAgent and the real Donna pipeline.

    Args:
        scenario: Defines the caller persona, goals, expected outcomes, and
            call parameters.
        senior: Pre-seeded test senior.  Falls back to ``scenario.senior``
            if not provided.
        conversation_id: Existing conversation record.  A new one is created
            via ``create_test_conversation()`` if not provided.
        run_post_call_processing: Whether to run post-call analysis, memory
            extraction, and DB updates after the call ends.

    Returns:
        A ``CallResult`` with turns, tool calls, latencies, and post-call
        status.
    """
    wall_start = time.monotonic()
    result = CallResult()
    pipeline_ended = False

    # -----------------------------------------------------------------
    # 1. Setup
    # -----------------------------------------------------------------
    senior = senior or scenario.senior
    call_type = scenario.call_type

    if conversation_id is None:
        conversation_id = await create_test_conversation(
            senior.id, call_type=call_type
        )
    result.conversation_id = conversation_id

    session_state = await build_session_state(
        senior, conversation_id, call_type=call_type
    )

    # Set up reminder context if the scenario specifies reminders.
    reminders = _scenario_reminders(scenario)
    if reminders:
        deliveries = [_reminder_delivery(reminder) for reminder in reminders]
        session_state["reminder_prompt"] = _format_reminders_prompt(reminders)
        session_state["reminder_delivery"] = deliveries[0]
        session_state["reminder_deliveries"] = deliveries
        session_state["_pending_reminders"] = reminders

    components = build_live_sim_pipeline(session_state)
    caller = CallerAgent(
        persona=scenario.persona,
        goals=list(scenario.goals),  # copy so we don't mutate the scenario
    )

    collector = components.caller_transport.collector

    logger.info(
        "[SimRunner] Starting scenario={name} senior={sid} call_type={ct} max_turns={mt}",
        name=scenario.name,
        sid=str(senior.id)[:8],
        ct=call_type,
        mt=scenario.max_turns,
    )

    # -----------------------------------------------------------------
    # 2. Start pipeline in background
    # -----------------------------------------------------------------
    pipeline_task = asyncio.create_task(
        asyncio.wait_for(
            components.runner.run(components.task),
            timeout=300,
        )
    )

    # Give the pipeline a moment to start processing frames
    await asyncio.sleep(0.5)

    # Initialize FlowManager — this pushes frames that trigger the greeting
    await components.flow_manager.initialize(session_state["_initial_node"])

    # -----------------------------------------------------------------
    # 3. Wait for Donna's greeting
    # -----------------------------------------------------------------
    try:
        greeting_event = await components.caller_transport.receive_response(timeout=30)
    except asyncio.TimeoutError:
        logger.warning("[SimRunner] Timed out waiting for greeting")
        result.end_reason = "no_greeting"
        result.total_duration_ms = (time.monotonic() - wall_start) * 1000
        _cancel_task(pipeline_task)
        return result

    if greeting_event.type == "end":
        logger.warning("[SimRunner] Pipeline ended before greeting")
        result.end_reason = "no_greeting"
        result.total_duration_ms = (time.monotonic() - wall_start) * 1000
        _cancel_task(pipeline_task)
        return result

    donna_text = greeting_event.text or ""
    result.initial_donna_text = donna_text
    logger.info("[SimRunner] Donna greeting: {}", donna_text[:100])

    # -----------------------------------------------------------------
    # 4. Conversation loop
    # -----------------------------------------------------------------
    turn_num = 0
    for turn_num in range(1, scenario.max_turns + 1):
        # --- Caller generates a response to what Donna said ---
        caller_text = caller.generate_response(donna_text)
        logger.info("[SimRunner] Turn {}: Caller: {}", turn_num, caller_text[:100])

        # Check if the caller's response is a true goodbye. The caller may
        # say a goodbye-like phrase to someone else mid-call; that should not
        # make the harness stop before the scenario continues.
        caller_is_goodbye = _caller_intends_goodbye(
            caller_text,
            should_end_call=caller.should_end_call,
        )

        # --- Inject caller utterance into the pipeline ---
        await components.caller_transport.send_utterance(caller_text)

        # --- Wait for Donna's response ---
        try:
            donna_event = await components.caller_transport.receive_response(timeout=60)
        except asyncio.TimeoutError:
            logger.warning("[SimRunner] Timed out waiting for Donna response at turn {}", turn_num)
            result.end_reason = _end_reason_after_response_timeout(caller_is_goodbye)
            if result.end_reason == "caller_goodbye":
                # A no-response timeout after the caller clearly wrapped up is
                # a normal simulation ending. Quick Observer may not emit an
                # EndFrame in short calls because of the min-call-age guard.
                result.turns.append({
                    "turn": turn_num,
                    "caller": caller_text,
                    "donna": None,
                    "latency_ms": None,
                })
            break

        if donna_event.type == "end":
            pipeline_ended = True
            result.end_reason = session_state.get("_end_reason", "pipeline_ended")
            # Record the turn even though Donna didn't produce text
            result.turns.append({
                "turn": turn_num,
                "caller": caller_text,
                "donna": None,
                "latency_ms": None,
            })
            logger.info("[SimRunner] Pipeline ended at turn {} (reason={})", turn_num, result.end_reason)
            break

        donna_text = donna_event.text or ""
        latency = donna_event.latency_ms

        result.turns.append({
            "turn": turn_num,
            "caller": caller_text,
            "donna": donna_text,
            "latency_ms": latency,
        })
        logger.info(
            "[SimRunner] Turn {}: Donna ({:.0f}ms): {}",
            turn_num,
            latency or 0,
            donna_text[:100],
        )

        # --- Check if caller wants to end ---
        if caller.should_end_call and not caller_is_goodbye:
            # Generate one more response (the goodbye) before ending
            goodbye_text = caller.generate_response(donna_text)
            logger.info("[SimRunner] Caller goodbye: {}", goodbye_text[:100])

            await components.caller_transport.send_utterance(goodbye_text)

            try:
                final_event = await components.caller_transport.receive_response(timeout=60)
                if final_event.type == "end":
                    pipeline_ended = True
                    result.end_reason = session_state.get("_end_reason", "goodbye")
                elif final_event.text:
                    result.turns.append({
                        "turn": turn_num + 1,
                        "caller": goodbye_text,
                        "donna": final_event.text,
                        "latency_ms": final_event.latency_ms,
                    })
            except asyncio.TimeoutError:
                pass

            if not pipeline_ended:
                result.end_reason = "caller_goodbye"
            break

        # If the caller already said goodbye, wait for pipeline to detect it.
        # Default end_reason to "caller_goodbye" unconditionally — previously
        # this only got set on TimeoutError, so when Quick Observer didn't
        # fire EndFrame (call too short for the min-call-age guard, or Donna
        # kept responding) the run finished with `end_reason="unknown"`.
        if caller_is_goodbye:
            result.end_reason = "caller_goodbye"
            try:
                end_event = await components.caller_transport.receive_response(timeout=10)
                if end_event.type == "end":
                    pipeline_ended = True
                    result.end_reason = session_state.get("_end_reason", "goodbye_endframe")
                # Else: another response came back; we still asked for goodbye
                # so end_reason stays "caller_goodbye". Quick Observer may not
                # have flipped to EndFrame because of the min-call-age guard
                # or because Donna chose to keep talking.
            except asyncio.TimeoutError:
                # Default already set; keep "caller_goodbye".
                pass
            break
    else:
        # max_turns exhausted
        result.end_reason = "max_turns"

    # -----------------------------------------------------------------
    # 5. Collect metrics from the pipeline
    # -----------------------------------------------------------------
    result.tool_calls_made = list(session_state.get("_tools_used", []))
    result.tool_call_details = _collect_tool_call_details(session_state, collector)
    result.injected_memories = _collect_injected_memories(session_state, collector)
    result.web_search_results = list(collector.web_results)
    result.fillers = list(collector.fillers)
    result.total_duration_ms = (time.monotonic() - wall_start) * 1000

    # -----------------------------------------------------------------
    # 6. End pipeline if it hasn't ended naturally
    # -----------------------------------------------------------------
    if not pipeline_ended and not collector.ended:
        try:
            await components.task.queue_frame(EndFrame())
            await asyncio.sleep(1.0)  # Let EndFrame propagate
        except Exception as exc:
            logger.debug("[SimRunner] EndFrame queue error (likely already ended): {}", exc)

    # -----------------------------------------------------------------
    # 7. Drain fire-and-forget tool work
    # -----------------------------------------------------------------
    await _drain_tool_background_tasks(session_state)

    # -----------------------------------------------------------------
    # 8. Post-call processing
    # -----------------------------------------------------------------
    if run_post_call_processing:
        try:
            components.conversation_tracker.flush()
            session_state.setdefault("_end_reason", "simulation_complete")
            elapsed = int((time.monotonic() - wall_start))
            await run_post_call(session_state, components.conversation_tracker, elapsed)
            result.post_call_completed = True
            logger.info("[SimRunner] Post-call processing completed")
        except Exception as exc:
            result.post_call_completed = False
            logger.warning("[SimRunner] Post-call processing failed: {}", exc)

    # -----------------------------------------------------------------
    # 9. Cleanup
    # -----------------------------------------------------------------
    _cancel_task(pipeline_task)

    logger.info(
        "[SimRunner] Scenario={name} finished: {turns} turns, {dur:.1f}s, end_reason={er}, post_call={pc}",
        name=scenario.name,
        turns=len(result.turns),
        dur=result.total_duration_ms / 1000,
        er=result.end_reason,
        pc=result.post_call_completed,
    )

    return result


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _scenario_reminders(scenario: LiveSimScenario) -> list[dict]:
    """Return normalized reminder fixtures for a scenario."""
    if scenario.reminders:
        source = scenario.reminders
    elif scenario.reminder_title:
        source = [
            {
                "title": scenario.reminder_title,
                "description": scenario.reminder_description or "",
                "type": scenario.reminder_type,
            }
        ]
    else:
        return []

    reminders: list[dict] = []
    for index, reminder in enumerate(source, start=1):
        reminder_id = reminder.get("id") or (
            f"00000000-0000-0000-0000-{index:012d}"
        )
        reminders.append({
            "id": reminder_id,
            "title": reminder.get("title", ""),
            "description": reminder.get("description", ""),
            "type": reminder.get("type", scenario.reminder_type),
        })
    return reminders


def _reminder_delivery(reminder: dict) -> dict:
    """Build a reminder_delivery-shaped session entry for simulations."""
    reminder_id = reminder.get("id", "")
    return {
        "id": reminder_id,
        "reminder_id": reminder_id,
        "title": reminder.get("title", ""),
        "description": reminder.get("description", ""),
        "type": reminder.get("type", "generic"),
    }


def _format_reminders_prompt(reminders: list[dict]) -> str:
    """Format one or more reminders for the live simulated session."""
    from services.reminder_delivery import format_reminder_prompt

    if len(reminders) == 1:
        return format_reminder_prompt(reminders[0])

    lines = [
        "\n\nIMPORTANT REMINDERS TO DELIVER:",
        (
            "You are calling to remind them about ALL of these items. "
            "Include every pending reminder naturally in the opening "
            "hello/introduction."
        ),
    ]
    for index, reminder in enumerate(reminders, start=1):
        lines.append(f'{index}. "{reminder.get("title", "")}"')
        if reminder.get("description"):
            lines.append(f"   Details: {reminder['description']}")
        if reminder.get("type"):
            lines.append(f"   Type: {reminder['type']}")
    lines.append(
        "Deliver these reminders conversationally, not like a notification list."
    )
    lines.append(
        "After they respond, call mark_reminder_acknowledged for each reminder."
    )
    return "\n".join(lines)


def _cancel_task(task: asyncio.Task) -> None:
    """Cancel a background asyncio task if it's still running."""
    if task.done():
        return
    task.cancel()
    # Don't await -- let it cancel in the background.  The caller's event
    # loop will clean it up.


def _start_scenario_faults(scenario: LiveSimScenario) -> list:
    """Start fault-injection patches requested by a simulation scenario."""
    patches = []
    if getattr(scenario, "force_embedding_outage", False):
        from unittest.mock import AsyncMock, patch

        embedding_patch = patch(
            "services.memory.generate_embedding",
            new=AsyncMock(return_value=None),
        )
        embedding_patch.start()
        patches.append(embedding_patch)
    if getattr(scenario, "force_empty_web_search", False):
        from unittest.mock import AsyncMock, patch

        web_search_patch = patch(
            "services.news.web_search_query",
            new=AsyncMock(return_value=""),
        )
        web_search_patch.start()
        patches.append(web_search_patch)
    slow_search_seconds = float(getattr(scenario, "force_slow_web_search_seconds", 0.0) or 0.0)
    if slow_search_seconds > 0:
        from unittest.mock import patch

        async def _slow_web_search(query: str) -> str:
            await asyncio.sleep(slow_search_seconds)
            return f"Delayed search result for: {query}"

        web_search_patch = patch(
            "services.news.web_search_query",
            new=_slow_web_search,
        )
        web_search_patch.start()
        patches.append(web_search_patch)
    return patches


def _stop_scenario_faults(patches: list) -> None:
    """Stop scenario fault-injection patches in reverse order."""
    for patcher in reversed(patches):
        patcher.stop()


def _caller_intends_goodbye(caller_text: str, *, should_end_call: bool) -> bool:
    """Return true for real farewells while ignoring obvious false goodbyes."""
    text = caller_text or ""
    if not _GOODBYE_WORDS.search(text):
        return False
    if _FALSE_GOODBYE_CONTINUATION.search(text):
        return should_end_call
    return True


def _end_reason_after_response_timeout(caller_is_goodbye: bool) -> str:
    """Classify a no-response wait after one caller turn."""
    if caller_is_goodbye:
        return "caller_goodbye"
    return "timeout"


def _collect_injected_memories(session_state: dict, collector) -> list[str]:
    """Collect memory injections from frame capture and context trace events.

    In the live pipeline, ``LLMMessagesAppendFrame`` memory injections are
    consumed by the user context aggregator before the downstream
    ``ResponseCollector`` can see them. The Director also records these
    injections into ``_context_trace_events``, so use that trace to keep the
    simulation summary honest.
    """
    memories: list[str] = []

    def add(text: str | None) -> None:
        if text and text not in memories:
            memories.append(text)

    for text in getattr(collector, "injected_memories", []):
        add(text)

    for event in session_state.get("_context_trace_events") or []:
        if (
            event.get("source") == "memory_context"
            and event.get("action") == "injected"
        ):
            add(event.get("content"))

    return memories


def _collect_tool_call_details(session_state: dict, collector) -> list[dict]:
    """Collect tool calls from frames and context trace events.

    Pipecat Flows tool calls are not always visible as FunctionCallFromLLM
    frames after aggregation, but every tool handler records a context trace
    event. Include those trace events so assertions can inspect repeated calls
    and arguments.
    """
    details: list[dict] = []

    def add(name: str | None, args: dict | None) -> None:
        if not name:
            return
        item = {"name": name, "args": dict(args or {})}
        if item not in details:
            details.append(item)

    for tool_call in getattr(collector, "tool_calls", []):
        add(tool_call.get("name"), tool_call.get("args"))

    for event in session_state.get("_context_trace_events") or []:
        if event.get("source") == "tool" and event.get("action") == "called":
            metadata = event.get("metadata") or {}
            add(metadata.get("tool"), metadata.get("arguments"))

    return details


async def _drain_tool_background_tasks(session_state: dict) -> None:
    """Wait briefly for tool side-effect tasks spawned during simulation."""
    tasks = [
        task for task in session_state.get("_tool_background_tasks", [])
        if isinstance(task, asyncio.Task)
    ]
    if not tasks:
        return
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*tasks, return_exceptions=True),
            timeout=10,
        )
    except asyncio.TimeoutError:
        logger.warning("[SimRunner] Timed out waiting for tool background tasks")
        return

    for result in results:
        if isinstance(result, Exception):
            logger.warning(
                "[SimRunner] Tool background task failed: {err}",
                err=str(result),
            )
