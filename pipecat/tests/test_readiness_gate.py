"""Replica readiness gate spec tests (Phase 3 work item 8).

Per `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md` §3 work
item 8, a new Pipecat replica must NOT be marked "available capacity" until
all of the following warmup preconditions are green:

    1. warm Neon pool (min connections established)
    2. GrowthBook client initialized
    3. at least one warm Anthropic prompt-cache primer call completed
    4. Deepgram session creation tested successfully
    5. ElevenLabs / Cartesia TTS session creation tested
    6. all circuit breakers closed

The audit in §8 of that doc explicitly states:

    "the rev-2 readiness gate (warm pool, GrowthBook flags loaded,
     prompt-cache primer call, Deepgram/ElevenLabs/Cartesia session creation
     tested, all breakers closed) is **not** implemented. Phase 3 work item
     8 is open."

These tests are therefore written as a SPEC. They are expected to start
passing automatically when production code lands. Until then, the
`xfail(strict=True)` markers keep them green-but-quarantined in CI.

The expected production composition is something like::

    # pipecat/services/readiness.py (does not exist yet)
    async def compute_warmup_gate() -> WarmupGateResult:
        return WarmupGateResult(
            neon_pool_warm=await _check_neon_pool_min_conns(),
            growthbook_initialized=_check_growthbook(),
            anthropic_primer_complete=await _run_anthropic_primer(),
            deepgram_session_ok=await _test_deepgram_session(),
            tts_session_ok=await _test_tts_session(),
            circuit_breakers_all_closed=_check_all_breakers_closed(),
        )

    # pipecat/services/capacity.py::build_capacity_heartbeat (today)
    # ready = healthy and not draining and active < max_capacity
    #
    # expected:
    # ready = (above) AND warmup_gate.all_green

When that composition lands, remove the `xfail` markers and these tests
become the regression guard.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.capacity import build_capacity_heartbeat


# ---------------------------------------------------------------------------
# Expected-shape helpers (live here until production code lands)
# ---------------------------------------------------------------------------

@dataclass
class WarmupGateResult:
    """Shape the production readiness gate is expected to return.

    Mirrors Phase 3 §8 exactly. When `pipecat/services/readiness.py`
    materializes, replace this local copy with the real import.
    """

    neon_pool_warm: bool = False
    growthbook_initialized: bool = False
    anthropic_primer_complete: bool = False
    deepgram_session_ok: bool = False
    tts_session_ok: bool = False
    circuit_breakers_all_closed: bool = False

    @property
    def all_green(self) -> bool:
        return (
            self.neon_pool_warm
            and self.growthbook_initialized
            and self.anthropic_primer_complete
            and self.deepgram_session_ok
            and self.tts_session_ok
            and self.circuit_breakers_all_closed
        )


@dataclass
class FakeReplicaState:
    """In-test stand-in for the bag of warmup checks main.py would compose."""

    neon_pool_min_conns: int = 0
    neon_pool_min_conns_required: int = 5
    growthbook_initialized: bool = False
    anthropic_primer_calls_completed: int = 0
    deepgram_sessions_opened: int = 0
    tts_sessions_opened: int = 0
    open_circuit_breakers: list[str] = field(default_factory=list)

    def to_warmup_gate(self) -> WarmupGateResult:
        return WarmupGateResult(
            neon_pool_warm=self.neon_pool_min_conns >= self.neon_pool_min_conns_required,
            growthbook_initialized=self.growthbook_initialized,
            anthropic_primer_complete=self.anthropic_primer_calls_completed >= 1,
            deepgram_session_ok=self.deepgram_sessions_opened >= 1,
            tts_session_ok=self.tts_sessions_opened >= 1,
            circuit_breakers_all_closed=len(self.open_circuit_breakers) == 0,
        )


def _fully_warm() -> FakeReplicaState:
    return FakeReplicaState(
        neon_pool_min_conns=5,
        growthbook_initialized=True,
        anthropic_primer_calls_completed=1,
        deepgram_sessions_opened=1,
        tts_sessions_opened=1,
        open_circuit_breakers=[],
    )


@pytest.mark.asyncio
async def test_warmup_gate_helper_self_check_all_green_when_warm():
    """Sanity: the in-test helper itself is correct.

    Not under xfail because this is testing the test scaffolding.
    """
    state = _fully_warm()
    gate = state.to_warmup_gate()
    assert gate.all_green is True
    assert gate.neon_pool_warm is True
    assert gate.growthbook_initialized is True
    assert gate.anthropic_primer_complete is True
    assert gate.deepgram_session_ok is True
    assert gate.tts_session_ok is True
    assert gate.circuit_breakers_all_closed is True


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Phase 3 work item 8 open: build_capacity_heartbeat does not compose "
        "the warmup gate. Plan §8 (Phase 3 exit criteria not yet met) — "
        "expected: ready = healthy and not draining and active < max AND "
        "warmup_gate.all_green. When this passes, remove the xfail."
    ),
)
@pytest.mark.asyncio
async def test_readiness_gate_blocks_traffic_until_all_warmup_steps_complete(monkeypatch):
    """Each warmup precondition independently blocks `ready=True`.

    This is the canonical spec. We fail each of the six preconditions in
    turn and assert the published heartbeat reports `ready=False`. Then we
    flip them all green and assert `ready=True`.

    Production code is expected to integrate `WarmupGateResult` into
    `build_capacity_heartbeat` (or to wrap `publish_capacity_heartbeat`
    behind a gate evaluator). Until then this test stays xfail(strict).
    """

    # Common "happy" heartbeat inputs — process is healthy, not draining,
    # has slots. Only the warmup gate should be the differentiator.
    base_kwargs = dict(
        instance_id="replica-readiness-spec",
        active_calls=0,
        max_calls=75,
        inbound_active_calls=0,
        pending_start_count=0,
        draining=False,
        healthy=True,
    )

    failing_scenarios: list[tuple[str, Callable[[FakeReplicaState], None]]] = [
        ("neon pool below min connections", lambda s: setattr(s, "neon_pool_min_conns", 0)),
        ("GrowthBook not initialized", lambda s: setattr(s, "growthbook_initialized", False)),
        ("Anthropic primer not run", lambda s: setattr(s, "anthropic_primer_calls_completed", 0)),
        ("Deepgram session not tested", lambda s: setattr(s, "deepgram_sessions_opened", 0)),
        ("TTS session not tested", lambda s: setattr(s, "tts_sessions_opened", 0)),
        (
            "circuit breaker open",
            lambda s: s.open_circuit_breakers.append("anthropic_main"),
        ),
    ]

    for label, mutate in failing_scenarios:
        state = _fully_warm()
        mutate(state)
        gate = state.to_warmup_gate()
        assert gate.all_green is False, f"helper bug: {label}"

        # Production should wire the gate into the heartbeat. We pass
        # `circuit_breakers_open` as the cheapest current proxy — but the
        # gate has FIVE more dimensions and `build_capacity_heartbeat`
        # currently ignores all of them.
        heartbeat = build_capacity_heartbeat(
            circuit_breakers_open=len(state.open_circuit_breakers),
            **base_kwargs,
        )
        assert heartbeat["ready"] is False, (
            f"Expected ready=False when '{label}', got ready=True. "
            f"build_capacity_heartbeat does not consult the warmup gate."
        )

    # Now all six green → ready=True.
    warm_state = _fully_warm()
    assert warm_state.to_warmup_gate().all_green is True
    heartbeat = build_capacity_heartbeat(
        circuit_breakers_open=0, **base_kwargs,
    )
    assert heartbeat["ready"] is True


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Phase 3 §8: prompt-cache primer call against a stub senior is not "
        "implemented. Expected: pipecat startup invokes a synthetic "
        "Anthropic call to populate the 5-min cache before flipping ready."
    ),
)
@pytest.mark.asyncio
async def test_anthropic_prompt_cache_primer_runs_at_startup(monkeypatch):
    """Production startup must invoke the Anthropic primer at least once.

    The primer is described in Phase 3 §8: a synthetic call against a stub
    senior that populates the 5-min prompt cache. Without it the first ~10
    real calls on a fresh replica eat the cold-cache penalty.
    """
    primer = AsyncMock(return_value={"cache_creation_input_tokens": 1200})

    try:
        from services import readiness as readiness_module  # noqa: F401
    except ImportError:
        pytest.fail(
            "pipecat/services/readiness.py does not exist. Phase 3 §8 "
            "expects a `run_anthropic_prompt_cache_primer()` here."
        )

    monkeypatch.setattr(
        "services.readiness.run_anthropic_prompt_cache_primer",
        primer,
    )

    from services.readiness import compute_warmup_gate  # type: ignore[attr-defined]
    await compute_warmup_gate()
    primer.assert_awaited()


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Phase 3 §8: Deepgram session creation test is not implemented. "
        "Expected: open + close a websocket against Deepgram before ready."
    ),
)
@pytest.mark.asyncio
async def test_deepgram_session_open_close_runs_at_startup(monkeypatch):
    """Production must open+close a Deepgram session as a warmup check."""
    open_close = AsyncMock(return_value=True)

    try:
        from services import readiness as readiness_module  # noqa: F401
    except ImportError:
        pytest.fail("pipecat/services/readiness.py does not exist")

    monkeypatch.setattr(
        "services.readiness.test_deepgram_session_open_close",
        open_close,
    )
    from services.readiness import compute_warmup_gate  # type: ignore[attr-defined]
    await compute_warmup_gate()
    open_close.assert_awaited()


@pytest.mark.xfail(
    strict=True,
    reason=(
        "Phase 3 §8: TTS session creation test (ElevenLabs/Cartesia) is "
        "not implemented as a warmup precondition."
    ),
)
@pytest.mark.asyncio
async def test_tts_session_creation_runs_at_startup(monkeypatch):
    """Production must successfully open a TTS session as a warmup check."""
    open_session = AsyncMock(return_value=True)

    try:
        from services import readiness as readiness_module  # noqa: F401
    except ImportError:
        pytest.fail("pipecat/services/readiness.py does not exist")

    monkeypatch.setattr(
        "services.readiness.test_tts_session_open",
        open_session,
    )
    from services.readiness import compute_warmup_gate  # type: ignore[attr-defined]
    await compute_warmup_gate()
    open_session.assert_awaited()


@pytest.mark.asyncio
async def test_circuit_breakers_all_closed_is_required_for_ready():
    """Heartbeat must report `ready=False` if any breaker is open at start."""
    from lib.circuit_breaker import CircuitBreaker, get_breaker_states

    # Force a breaker into "open" state.
    cb = CircuitBreaker(name="readiness_spec_cb", failure_threshold=1)
    cb.state = "open"
    try:
        open_count = sum(1 for s in get_breaker_states().values() if s == "open")
        assert open_count >= 1

        heartbeat = build_capacity_heartbeat(
            instance_id="r",
            active_calls=0,
            max_calls=75,
            draining=False,
            healthy=True,
            circuit_breakers_open=open_count,
        )
        assert heartbeat["ready"] is False, (
            "Expected ready=False with an open breaker; "
            "build_capacity_heartbeat ignores circuit_breakers_open."
        )
    finally:
        cb.state = "closed"


@pytest.mark.asyncio
async def test_neon_pool_min_connections_required_for_ready(monkeypatch):
    """Production must require pool size >= configured minimum before ready."""
    fake_get_pool_stats = AsyncMock(return_value={"size": 0, "idle": 0})

    # Simulate a freshly-started pool with zero established connections.
    # The heartbeat should report ready=False until the warm-pool floor is met.
    monkeypatch.setattr("db.client.get_pool_stats", fake_get_pool_stats)

    heartbeat = build_capacity_heartbeat(
        instance_id="r",
        active_calls=0,
        max_calls=75,
        draining=False,
        healthy=True,
        db_pool_size=0,
        db_pool_idle=0,
    )
    assert heartbeat["ready"] is False, (
        "Expected ready=False with empty Neon pool; "
        "build_capacity_heartbeat does not enforce a pool floor."
    )
