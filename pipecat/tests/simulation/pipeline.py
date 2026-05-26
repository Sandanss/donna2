"""LiveSimPipeline builder -- real Donna pipeline with test transports.

Assembles the production pipeline from ``bot.py`` but replaces carrier I/O
(Telnyx/WebSocket transport), Deepgram STT, and ElevenLabs/Cartesia TTS with
test doubles. Text-mode simulation injects ``TranscriptionFrame`` directly
and mocks TTS; everything else -- Claude Haiku, Quick Observer, Conversation
Director, FlowManager, tool handlers -- runs for real.

Usage::

    session_state = await build_session_state(senior, conversation_id)
    components = build_live_sim_pipeline(session_state)
    await components.flow_manager.initialize(initial_node)
    # ... inject TranscriptionFrames via components.caller_transport ...
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass

from loguru import logger
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat_flows import FlowManager

from flows.nodes import build_initial_node
from flows.tools import select_flows_tools
from processors.conversation_director import ConversationDirectorProcessor
from processors.conversation_tracker import ConversationState, ConversationTrackerProcessor
from processors.guidance_stripper import GuidanceStripperProcessor
from processors.metrics_logger import MetricsLoggerProcessor
from processors.quick_observer import QuickObserverProcessor

from tests.mocks.mock_tts import MockTTSProcessor
from tests.mocks.mock_transport import TestInputTransport, TestOutputTransport
from tests.simulation.transport import ResponseCollector, TextCallerTransport


# ---------------------------------------------------------------------------
# LiveSimComponents dataclass
# ---------------------------------------------------------------------------


@dataclass
class LiveSimComponents:
    """References to every component in a live-sim pipeline.

    Attributes:
        pipeline: The assembled ``Pipeline`` instance.
        task: The ``PipelineTask`` wrapping the pipeline.
        runner: A ``PipelineRunner`` (``handle_sigint=False``).
        input_transport: ``TestInputTransport`` replacing carrier input.
        output_transport: ``TestOutputTransport`` replacing carrier output.
        response_collector: ``ResponseCollector`` capturing LLM text output.
        caller_transport: ``TextCallerTransport`` for injecting utterances.
        quick_observer: Layer 1 regex observer (268 patterns).
        user_conversation_tracker: User-side transcript/topic tracker.
        conversation_director: Layer 2 Groq speculative analysis.
        conversation_tracker: Assistant-side question/advice tracking.
        flow_manager: 4-phase call state machine.
        llm: Real ``AnthropicLLMService`` (Claude Haiku with prompt caching).
        tts: ``MockTTSProcessor`` that captures text without audio.
        session_state: The shared session dict.
    """

    pipeline: Pipeline
    task: PipelineTask
    runner: PipelineRunner
    input_transport: TestInputTransport
    output_transport: TestOutputTransport
    response_collector: ResponseCollector
    caller_transport: TextCallerTransport
    quick_observer: QuickObserverProcessor
    user_conversation_tracker: ConversationTrackerProcessor
    conversation_director: ConversationDirectorProcessor
    conversation_tracker: ConversationTrackerProcessor
    flow_manager: FlowManager
    llm: AnthropicLLMService
    tts: MockTTSProcessor
    session_state: dict


# ---------------------------------------------------------------------------
# Pipeline builder
# ---------------------------------------------------------------------------


def build_live_sim_pipeline(session_state: dict) -> LiveSimComponents:
    """Build a real Donna pipeline with test transports.

    Mirrors ``bot.py``'s pipeline layout but replaces:
    - ``FastAPIWebsocketTransport`` with ``TestInputTransport`` + ``TestOutputTransport``
    - ``DeepgramSTTService`` with nothing (``TranscriptionFrame`` injected directly)
    - ``ElevenLabs/Cartesia TTS`` with ``MockTTSProcessor`` (captures text)

    Inserts a ``ResponseCollector`` after ``GuidanceStripperProcessor`` and
    before the mock TTS to capture clean text output.

    Args:
        session_state: Pre-populated dict from ``build_session_state()`` or
            equivalent.  Must contain at least ``senior_id`` and ``senior``.

    Returns:
        ``LiveSimComponents`` with references to all pipeline components.

    Raises:
        RuntimeError: If ``ANTHROPIC_API_KEY`` is not set.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "ANTHROPIC_API_KEY environment variable is required for live simulation tests"
        )

    # -----------------------------------------------------------------
    # Session state defaults
    # -----------------------------------------------------------------
    session_state.setdefault("_call_start_time", time.time())
    session_state.setdefault("_transcript", [])
    session_state.setdefault("_flags", {
        "director_enabled": True,
        "post_call_analysis_enabled": True,
        "news_search_enabled": True,
    })

    # -----------------------------------------------------------------
    # Test transports (replace carrier WebSocket I/O)
    # -----------------------------------------------------------------
    input_transport = TestInputTransport()
    output_transport = TestOutputTransport()

    # -----------------------------------------------------------------
    # Real LLM (Claude Haiku with prompt caching)
    # -----------------------------------------------------------------
    llm = AnthropicLLMService(
        api_key=api_key,
        model="claude-haiku-4-5-20251001",
        params=AnthropicLLMService.InputParams(
            enable_prompt_caching=True,
        ),
    )

    # -----------------------------------------------------------------
    # Custom processors (all real)
    # -----------------------------------------------------------------
    quick_observer = QuickObserverProcessor(session_state=session_state)
    conversation_director = ConversationDirectorProcessor(session_state=session_state)
    conversation_state = ConversationState()
    user_conversation_tracker = ConversationTrackerProcessor(
        session_state=session_state,
        state=conversation_state,
        track_assistant=False,
    )
    conversation_tracker = ConversationTrackerProcessor(
        session_state=session_state,
        state=conversation_state,
        track_user=False,
    )
    guidance_stripper = GuidanceStripperProcessor()
    metrics_logger = MetricsLoggerProcessor(session_state=session_state)

    # Store conversation tracker in session_state for Flow nodes to reference
    session_state["_conversation_tracker"] = conversation_tracker

    # -----------------------------------------------------------------
    # Response collector (captures clean text after guidance stripping)
    # -----------------------------------------------------------------
    response_collector = ResponseCollector()

    # -----------------------------------------------------------------
    # Mock TTS (captures text, no audio)
    # -----------------------------------------------------------------
    tts = MockTTSProcessor()

    # -----------------------------------------------------------------
    # Context aggregators (user <-> assistant message pairing)
    # -----------------------------------------------------------------
    context = OpenAILLMContext()
    context_aggregator = llm.create_context_aggregator(context)

    # Expose context for Director's ephemeral message stripping
    session_state["_llm_context"] = context

    # -----------------------------------------------------------------
    # Pipeline assembly (matches bot.py layout)
    #
    # input_transport -> quick_observer -> user_conversation_tracker ->
    # conversation_director -> context_aggregator.user() -> llm -> guidance_stripper ->
    # conversation_tracker -> response_collector -> tts -> output_transport ->
    # context_aggregator.assistant() -> metrics_logger
    # -----------------------------------------------------------------
    pipeline = Pipeline(
        [
            input_transport,
            quick_observer,
            user_conversation_tracker,
            conversation_director,
            context_aggregator.user(),
            llm,
            guidance_stripper,
            conversation_tracker,
            response_collector,
            tts,
            output_transport,
            context_aggregator.assistant(),
            metrics_logger,
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            allow_interruptions=True,
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    # Give processors references to the task so they can force-end calls
    quick_observer.set_pipeline_task(task)
    conversation_director.set_pipeline_task(task)

    # -----------------------------------------------------------------
    # Flow Manager (call phase management)
    # -----------------------------------------------------------------
    # Match bot.py's call_type → tool factory dispatch so mock-call scenarios
    # for consent / discovery / new_customer expose the same tool set Donna
    # would see on a real call.
    flows_tools = select_flows_tools(session_state)
    initial_node = build_initial_node(session_state, flows_tools)

    flow_manager = FlowManager(
        task=task,
        llm=llm,
        context_aggregator=context_aggregator,
    )

    # Store flow_manager and initial node in session state for processors and
    # callers that need them.  The caller must invoke
    #   await flow_manager.initialize(session_state["_initial_node"])
    # to start the call phase state machine.
    session_state["_flow_manager"] = flow_manager
    session_state["_initial_node"] = initial_node

    # -----------------------------------------------------------------
    # Pipeline runner
    # -----------------------------------------------------------------
    runner = PipelineRunner(handle_sigint=False)

    # -----------------------------------------------------------------
    # Caller transport (text-only, injects TranscriptionFrames)
    # -----------------------------------------------------------------
    caller_transport = TextCallerTransport(
        pipeline_task=task,
        response_collector=response_collector,
        user_id=session_state.get("senior_id", "senior-test-001"),
    )

    logger.info(
        "[LiveSim] Pipeline built for senior={sid}, call_type={ct}",
        sid=str(session_state.get("senior_id", "unknown"))[:8],
        ct=session_state.get("call_type", "check-in"),
    )

    return LiveSimComponents(
        pipeline=pipeline,
        task=task,
        runner=runner,
        input_transport=input_transport,
        output_transport=output_transport,
        response_collector=response_collector,
        caller_transport=caller_transport,
        quick_observer=quick_observer,
        user_conversation_tracker=user_conversation_tracker,
        conversation_director=conversation_director,
        conversation_tracker=conversation_tracker,
        flow_manager=flow_manager,
        llm=llm,
        tts=tts,
        session_state=session_state,
    )
