"""LLM-to-LLM voice simulation test infrastructure.

This package provides a framework for end-to-end simulation testing of the
Donna voice pipeline.  A "caller" LLM plays the role of an elderly senior
while the real pipeline (Observer -> Director -> Claude -> TTS) responds.

Key components:
- CallerAgent / CallerPersona / CallerGoal: Haiku-powered caller simulation
- CallerEvent / CallResult: structured output from a simulated call
- ResponseCollector: FrameProcessor that captures pipeline output
- CallerTransport: protocol for injecting speech and receiving responses
- TestSenior / seed_test_senior / cleanup_test_senior: DB fixtures for integration tests
"""

from tests.simulation.caller import (
    CallerAgent,
    CallerGoal,
    CallerPersona,
)
from tests.simulation.fixtures import (
    TestSenior,
    build_session_state,
    cleanup_test_senior,
    create_test_conversation,
    seed_test_senior,
)
from tests.simulation.scenarios import (
    LiveSimScenario,
    memory_recall_scenario,
    memory_seed_scenario,
    reminder_scenario,
    web_search_scenario,
)
from tests.simulation.pipeline import (
    LiveSimComponents,
    build_live_sim_pipeline,
)
from tests.simulation.runner import run_simulated_call
from tests.simulation.concurrent import (
    ConcurrentCallOutcome,
    ConcurrentCallSpec,
    ConcurrentRunSummary,
    run_simulated_calls_concurrent,
)
from tests.simulation.cohort import (
    DEFAULT_THRESHOLDS,
    CohortComparison,
    CohortSloReport,
    CohortSloThresholds,
    SloBreach,
    build_cohort_report,
    compare_cohorts,
)
from tests.simulation.transport import (
    AudioCallerTransport,
    CallerEvent,
    CallerTransport,
    CallResult,
    ResponseCollector,
    TextCallerTransport,
    TtsProvider,
    cartesia_tts_provider,
    elevenlabs_tts_provider,
    silence_tts_provider,
)

__all__ = [
    "AudioCallerTransport",
    "CallerAgent",
    "CallerGoal",
    "CallerPersona",
    "CallerEvent",
    "CallerTransport",
    "CallResult",
    "CohortComparison",
    "CohortSloReport",
    "CohortSloThresholds",
    "ConcurrentCallOutcome",
    "ConcurrentCallSpec",
    "ConcurrentRunSummary",
    "DEFAULT_THRESHOLDS",
    "LiveSimComponents",
    "LiveSimScenario",
    "ResponseCollector",
    "SloBreach",
    "TestSenior",
    "TextCallerTransport",
    "TtsProvider",
    "build_cohort_report",
    "cartesia_tts_provider",
    "elevenlabs_tts_provider",
    "silence_tts_provider",
    "build_live_sim_pipeline",
    "build_session_state",
    "cleanup_test_senior",
    "compare_cohorts",
    "create_test_conversation",
    "run_simulated_call",
    "run_simulated_calls_concurrent",
    "seed_test_senior",
    "memory_recall_scenario",
    "memory_seed_scenario",
    "reminder_scenario",
    "web_search_scenario",
]
