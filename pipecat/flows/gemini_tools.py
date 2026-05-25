"""Gemini Live tool schemas and handler adapters.

Adapts existing flows/tools.py handlers for use with GeminiLiveLLMService.

Two pieces:
1. _build_gemini_tools() - returns list[dict] in Gemini function_declarations format
2. register_gemini_tools() - registers handlers via llm.register_function()
"""

from __future__ import annotations

from datetime import date
from loguru import logger

from pipecat.services.llm_service import FunctionCallParams


def _build_gemini_tools(session_state: dict) -> list[dict]:
    """Build Gemini-format tool schema list."""
    today = date.today().strftime("%B %d, %Y")

    declarations = [
        {
            "name": "search_memories",
            "description": (
                "Search the senior's memory bank for relevant past conversations, "
                "preferences, or details. Use when they mention something you might "
                "have discussed before, or when you need context about their life."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for (e.g., 'gardening', 'grandson birthday', 'local events')",
                    }
                },
                "required": ["query"],
            },
        },
        {
            "name": "web_search",
            "description": (
                f"Search the web for current information. Today is {today}. "
                "Use when the senior asks about news, weather, sports, facts, or "
                "anything you're unsure about. Always say a brief filler aloud "
                "before calling this tool — 'Let me look that up' or 'One moment' — "
                "so the senior hears something while the search runs."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": f"What to search for (include {date.today().year} for recent events)",
                    }
                },
                "required": ["query"],
            },
        },
        {
            "name": "end_call",
            "description": (
                "End the call gracefully. Call this ONLY when the senior says goodbye "
                "and is clearly done — 'goodbye', 'talk to you later', 'I gotta go', etc. "
                "Say your goodbye first, THEN call this tool. The call will end immediately."
            ),
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    ]

    return [{"function_declarations": declarations}]


def _pipecat_adapter(name: str, handler):
    """Wrap handler for GeminiLiveLLMService without a context aggregator.

    Pipecat's normal tool result path requires a context aggregator:
      result_callback → FunctionCallResultFrame → context aggregator → LLMContextFrame
      → _handle_context → _process_completed_function_calls → session.send_tool_response()

    Without a context aggregator the result never reaches Gemini and it waits
    in silence. We bypass this by calling _tool_result() directly on the LLM
    service, while still calling result_callback() to cancel Pipecat's timeout.
    """
    async def adapted(params: FunctionCallParams):
        logger.info("Gemini tool CALL: {name}", name=name)
        try:
            result = await handler(params.arguments or {})
            result_str = result.get("result", "ok") if isinstance(result, dict) else str(result)
        except Exception as e:
            logger.error("Gemini tool ERROR {name}: {err}", name=name, err=str(e))
            result_str = "Tool unavailable. Continue naturally."
        logger.info("Gemini tool RESULT: {name} result_chars={n}", name=name, n=len(result_str))
        await params.result_callback(result_str)  # cancels Pipecat's internal timeout
        await params.llm._tool_result(params.tool_call_id, params.function_name, {"value": result_str})
    return adapted


def register_gemini_tools(llm, session_state: dict, task_ref: list) -> None:
    """Register all tool handlers on a GeminiLiveLLMService instance.

    Args:
        llm: GeminiLiveLLMService instance
        session_state: call session state dict
        task_ref: single-element list holding the PipelineTask (populated after task creation)
    """
    import asyncio
    from pipecat.frames.frames import EndFrame
    from flows.tools import make_tool_handlers

    handlers = make_tool_handlers(session_state)

    # Gemini Live registers search tools only; save/reminder tools stay on Claude flows.
    for name in ("web_search", "search_memories"):
        if name in handlers:
            llm.register_function(name, _pipecat_adapter(name, handlers[name]))

    # Register end_call — triggers EndFrame to terminate the pipeline
    async def handle_end_call(params: FunctionCallParams):
        logger.info("Gemini tool: end_call triggered")
        from services.context_trace import record_context_event
        record_context_event(
            session_state,
            source="end_call",
            action="called",
            label="Gemini end_call tool",
            provider="gemini_live",
        )
        session_state["_end_reason"] = "gemini_end_call_tool"
        await params.result_callback("Call ended.")
        await params.llm._tool_result(params.tool_call_id, params.function_name, {"value": "Call ended."})
        if task_ref[0] is not None:
            await asyncio.sleep(0.5)  # Brief pause so goodbye TTS finishes
            await task_ref[0].queue_frame(EndFrame())

    llm.register_function("end_call", handle_end_call)
