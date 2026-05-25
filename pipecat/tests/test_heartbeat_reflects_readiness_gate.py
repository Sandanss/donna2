"""Spec test: capacity heartbeat must reflect the Phase 3 warmup gate.

Currently `pipecat/services/capacity.py::build_capacity_heartbeat`
computes::

    ready = healthy and not draining and active < max_capacity

(line ~85). Per the Phase 3 audit in
`docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md` §8
(line 919-922):

    "'Replica readiness gate verified' — code exists in `pipecat/main.py`
     for the basic `_is_draining()` flag, but the rev-2 readiness gate
     (warm pool, GrowthBook flags loaded, prompt-cache primer call,
     Deepgram/ElevenLabs/Cartesia session creation tested, all breakers
     closed) is **not** implemented. Phase 3 work item 8 is open."

The expected production behaviour is::

    ready = (healthy and not draining and active < max_capacity)
            AND warmup_gate_green

Drive `build_capacity_heartbeat` with a freshly-started replica state
(warmup not complete) and assert `ready=False`. Today it returns True →
this is `xfail(strict=True)`. When production composes the gate, the
strict-xfail will fail and force re-enabling the test.
"""

from __future__ import annotations

import pytest

from services.capacity import build_capacity_heartbeat


def test_heartbeat_ready_false_until_warmup_gate_green():
    """A freshly-started replica with warmup incomplete must publish ready=False.

    Inputs simulate a healthy, undraining process with capacity headroom
    but warmup preconditions still pending:
        - DB pool empty (no Neon connections established yet)
        - Anthropic prompt-cache primer not yet completed
        - circuit breakers not yet probed
        - GrowthBook init still in flight

    Today `build_capacity_heartbeat` only consults healthy/draining/active.
    None of the warmup signals influence `ready`. Expected: ready=False
    when ANY warmup precondition is incomplete.
    """
    heartbeat = build_capacity_heartbeat(
        instance_id="freshly-started-replica",
        active_calls=0,
        max_calls=75,
        inbound_active_calls=0,
        pending_start_count=0,
        draining=False,
        healthy=True,
        # Warmup-state signals — production should consult these. None
        # do today. We pass the strongest possible "not warm yet" signal
        # by using db_pool_size=0 (Neon pool not yet established) and a
        # non-zero open-breaker count.
        db_pool_size=0,
        db_pool_idle=0,
        circuit_breakers_open=1,
    )

    # Today: heartbeat["ready"] is True (healthy + not draining + 0 < 75).
    # Expected: False until the warmup gate is green.
    assert heartbeat["ready"] is False, (
        "Heartbeat reports ready=True even though warmup is incomplete "
        "(db_pool_size=0, circuit_breakers_open=1). "
        "build_capacity_heartbeat must AND in the warmup gate."
    )


def test_heartbeat_ready_true_when_warm_and_capacity_headroom():
    """Sanity: under fully-warm conditions today, ready=True (regression
    pin so the spec change above does not break the happy path).

    NOT under xfail — this passes today and must keep passing after the
    gate is composed.
    """
    heartbeat = build_capacity_heartbeat(
        instance_id="warm-replica",
        active_calls=10,
        max_calls=75,
        inbound_active_calls=2,
        pending_start_count=1,
        draining=False,
        healthy=True,
        db_pool_size=20,
        db_pool_idle=15,
        circuit_breakers_open=0,
    )
    assert heartbeat["ready"] is True


def test_heartbeat_ready_false_when_draining_today():
    """Pin existing behaviour: draining → ready=False.

    NOT under xfail. Confirms the gate change does not regress drain.
    """
    heartbeat = build_capacity_heartbeat(
        instance_id="draining-replica",
        active_calls=0,
        max_calls=75,
        draining=True,
        healthy=True,
        db_pool_size=20,
        db_pool_idle=15,
        circuit_breakers_open=0,
    )
    assert heartbeat["ready"] is False


def test_heartbeat_ready_false_at_capacity_today():
    """Pin existing behaviour: active >= max → ready=False.

    NOT under xfail. Confirms the gate change does not regress capacity.
    """
    heartbeat = build_capacity_heartbeat(
        instance_id="full-replica",
        active_calls=75,
        max_calls=75,
        draining=False,
        healthy=True,
        db_pool_size=20,
        db_pool_idle=0,
        circuit_breakers_open=0,
    )
    assert heartbeat["ready"] is False


def test_heartbeat_ready_false_when_unhealthy_today():
    """Pin existing behaviour: healthy=False → ready=False.

    NOT under xfail. Confirms the gate change does not regress health.
    """
    heartbeat = build_capacity_heartbeat(
        instance_id="unhealthy-replica",
        active_calls=0,
        max_calls=75,
        draining=False,
        healthy=False,
        db_pool_size=20,
        db_pool_idle=20,
        circuit_breakers_open=0,
    )
    assert heartbeat["ready"] is False
