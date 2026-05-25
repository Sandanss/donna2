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


# ---------------------------------------------------------------------------
# run_simulated_call
# ---------------------------------------------------------------------------


async def run_simulated_call(
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

    session_state = await build_session_state(
        senior, conversation_id, call_type=call_type
    )

    # Set up reminder context if the scenario specifies one
    if scenario.reminder_title:
        session_state["reminder_prompt"] = (
            f"Reminder: {scenario.reminder_title}"
            + (f" — {scenario.reminder_description}" if scenario.reminder_description else "")
        )
        session_state["reminder_delivery"] = {
            "id": "sim-reminder-001",
            "reminder_id": "sim-reminder-001",
            "title": scenario.reminder_title,
            "description": scenario.reminder_description or "",
        }

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
    logger.info("[SimRunner] Donna greeting: {}", donna_text[:100])

    # -----------------------------------------------------------------
    # 4. Conversation loop
    # -----------------------------------------------------------------
    turn_num = 0
    for turn_num in range(1, scenario.max_turns + 1):
        # --- Caller generates a response to what Donna said ---
        caller_text = caller.generate_response(donna_text)
        logger.info("[SimRunner] Turn {}: Caller: {}", turn_num, caller_text[:100])

        # Check if the caller's response is a goodbye
        caller_is_goodbye = bool(_GOODBYE_WORDS.search(caller_text))

        # --- Inject caller utterance into the pipeline ---
        await components.caller_transport.send_utterance(caller_text)

        # --- Wait for Donna's response ---
        try:
            donna_event = await components.caller_transport.receive_response(timeout=60)
        except asyncio.TimeoutError:
            logger.warning("[SimRunner] Timed out waiting for Donna response at turn {}", turn_num)
            result.end_reason = "timeout"
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
    result.injected_memories = list(collector.injected_memories)
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
    # 7. Post-call processing
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
    # 8. Cleanup
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


def _cancel_task(task: asyncio.Task) -> None:
    """Cancel a background asyncio task if it's still running."""
    if task.done():
        return
    task.cancel()
    # Don't await -- let it cancel in the background.  The caller's event
    # loop will clean it up.
