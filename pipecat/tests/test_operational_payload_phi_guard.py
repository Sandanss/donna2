"""Category B (PHI shape) test — Pipecat operational payload PHI guard.

The Node side has `assertOperationalPayloadHasNoPlainPhi` in
`services/call-queue.js`, which rejects synthetic PHI sentinels and raw
PHI-shaped fields before any write to `call_queue`, `call_attempts`,
`outbound_call_guards`, or `scheduler_shadow_comparisons`. The Phase 1
audit noted no Pipecat-side equivalent exists.

Empirically (audit confirmed 2026-05): the Pipecat process is read-side
for these tables — it only UPDATEs `call_attempts` (status/timestamps/
provider error codes via `services/call_attempts.py`) and never INSERTs
operational rows. Pipecat does INSERT into `call_metrics` from
`services/post_call.py`, which the Node guard does not cover either.

This file documents that gap with `xfail` tests so it surfaces in CI
without breaking the build, plus a small positive test confirming the
ops `call_attempts` UPDATE paths never pass PHI-shaped values as
SQL parameters.
"""

from __future__ import annotations

import sys
from pathlib import Path
import pytest
from unittest.mock import AsyncMock, patch

# Ensure pipecat/ is on sys.path so `services.call_attempts` resolves like
# the rest of the Pipecat test suite (conftest.py is colocated).
PIPECAT_ROOT = Path(__file__).resolve().parents[1]
if str(PIPECAT_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPECAT_ROOT))


# --- PHI sentinels matching the JS test fixtures -----------------------

PHI_SENTINEL_NAME = "PHI_SENTINEL_NAME_DO_NOT_LOG_Jane_Margaret"
PHI_SENTINEL_PHONE = "+1-555-867-5309"
PHI_SENTINEL_TRANSCRIPT = "PHI_SENTINEL_TRANSCRIPT_DO_NOT_LOG"
PHI_SENTINEL_REMINDER = "PHI_SENTINEL_REMINDER_DO_NOT_LOG"
PHI_SENTINEL_NOTE = "PHI_SENTINEL_NOTE_DO_NOT_LOG"

PHI_VALUE_SUBSTRINGS = (
    "PHI_SENTINEL_",
    PHI_SENTINEL_NAME,
    PHI_SENTINEL_TRANSCRIPT,
    PHI_SENTINEL_REMINDER,
    PHI_SENTINEL_NOTE,
)
PHI_PHONE_FRAGMENTS = ("555-867-5309", "5558675309")


def _stringified_args_contain_phi(args, kwargs) -> bool:
    """Return True if any SQL parameter looks like raw PHI."""
    for value in list(args) + list(kwargs.values()):
        if value is None:
            continue
        text = str(value)
        for sentinel in PHI_VALUE_SUBSTRINGS:
            if sentinel in text:
                return True
        for phone in PHI_PHONE_FRAGMENTS:
            if phone in text:
                return True
    return False


# --- Positive: call_attempts UPDATE paths are PHI-free by construction -


@pytest.mark.asyncio
async def test_mark_call_attempt_answered_only_sends_call_control_id():
    """The Pipecat-side `mark_call_attempt_answered` accepts a
    `call_control_id` only and writes status/timestamps. It must not be
    callable with PHI-bearing positional or keyword args (the signature
    enforces this) and the resulting SQL params must contain only the
    call_control_id."""
    from services.call_attempts import mark_call_attempt_answered

    with patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec, \
         patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_q:
        mock_q.return_value = {"id": "attempt-1", "status": "initiating"}

        await mark_call_attempt_answered("v3:call-control-1234")

        assert mock_exec.await_count == 1
        # The only SQL param is the call_control_id. Plain string, no PHI.
        sent_args = mock_exec.await_args.args[1:]
        sent_kwargs = mock_exec.await_args.kwargs
        assert sent_args == ("v3:call-control-1234",)
        assert not sent_kwargs
        assert not _stringified_args_contain_phi(sent_args, sent_kwargs)


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_only_sends_operational_tags():
    """`mark_call_attempt_ended` accepts call_control_id, event_type,
    and an OPERATIONAL error_reason tag (never PHI). The SQL params must
    be exactly that tuple — no senior name, phone, transcript."""
    from services.call_attempts import mark_call_attempt_ended

    with patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec, \
         patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_q:
        mock_q.return_value = {"id": "attempt-1", "status": "initiating"}

        await mark_call_attempt_ended(
            "v3:call-control-1234",
            "call.failed",
            error_reason="no_answer",
        )

        assert mock_exec.await_count == 1
        sent_args = mock_exec.await_args.args[1:]
        sent_kwargs = mock_exec.await_args.kwargs
        # call_control_id, status, provider_error_code, provider_error_class
        assert sent_args[0] == "v3:call-control-1234"
        assert all(isinstance(a, (str, type(None))) for a in sent_args)
        assert not _stringified_args_contain_phi(sent_args, sent_kwargs)


# --- xfail: there is no `assertOperationalPayloadHasNoPlainPhi` ------


def test_pipecat_has_operational_phi_guard_function():
    """Pipecat exposes a callable analogous to the Node
    `assertOperationalPayloadHasNoPlainPhi`. Today it lives in
    `services.call_attempts.assert_operational_payload_has_no_plain_phi`.

    The function is forward-compat scaffolding: no current Pipecat write
    path INSERTs into ops.* tables, but if/when one lands, it must consult
    this guard before passing user-shaped data into the SQL.
    """
    import importlib
    import pkgutil

    candidate_modules = []
    for module_info in pkgutil.walk_packages([str(PIPECAT_ROOT / "services")]):
        try:
            mod = importlib.import_module(f"services.{module_info.name}")
        except Exception:
            continue
        for attr_name in dir(mod):
            if "operational_payload" in attr_name.lower() and "phi" in attr_name.lower():
                candidate_modules.append(f"services.{module_info.name}.{attr_name}")

    assert candidate_modules, (
        "no Pipecat-side equivalent of assertOperationalPayloadHasNoPlainPhi "
        "found in services/"
    )


def test_pipecat_operational_phi_guard_rejects_sentinel_strings():
    """The guard MUST raise when it sees a known PHI sentinel string."""
    from services.call_attempts import assert_operational_payload_has_no_plain_phi

    with pytest.raises(ValueError, match="PHI sentinel"):
        assert_operational_payload_has_no_plain_phi(PHI_SENTINEL_NAME)

    with pytest.raises(ValueError, match="PHI sentinel"):
        assert_operational_payload_has_no_plain_phi({
            "lease_owner": "worker-1",
            "metadata": {"nested": PHI_SENTINEL_TRANSCRIPT},
        })


def test_pipecat_operational_phi_guard_rejects_phi_shaped_keys():
    """The guard MUST raise on dict keys like name/phone/transcript/etc."""
    from services.call_attempts import assert_operational_payload_has_no_plain_phi

    for forbidden_key in ("name", "phone", "transcript", "reminder_title",
                          "caregiver_note", "medical_notes", "summary"):
        with pytest.raises(ValueError, match=r"PHI-bearing field"):
            assert_operational_payload_has_no_plain_phi({forbidden_key: "anything"})


def test_pipecat_operational_phi_guard_allows_encrypted_ciphertext_keys():
    """Encrypted-payload columns (payload_encrypted, context_notes_encrypted)
    are the one carve-out — the guard must NOT reject them.
    """
    from services.call_attempts import assert_operational_payload_has_no_plain_phi

    assert_operational_payload_has_no_plain_phi({
        "payload_encrypted": "enc:ciphertext-bytes",
        "context_notes_encrypted": "enc:more-ciphertext",
    })
    # Sanity: also accepts pure operational shapes.
    assert_operational_payload_has_no_plain_phi({
        "queue_id": "q-1",
        "senior_id": "s-1",
        "status": "initiating",
        "attempt_number": 3,
    })


# --- Tight-API tripwire (inverse assertion) -----------------------------
#
# The three Pipecat-side call_attempts writers (`mark_call_attempt_answered`,
# `mark_call_attempt_media_started`, `mark_call_attempt_ended`) accept ONLY
# operational identifiers + tags today: call_control_id, event_type,
# error_reason. They must NOT grow a generic `payload=` / `metadata=` kwarg
# (or any kwarg whose normalized form looks like PHI) without ALSO routing
# the new input through `assert_operational_payload_has_no_plain_phi`.
#
# Rather than wait for a future xfail flip, this test asserts the tight API
# directly: it PASSES today and FAILS the moment such a kwarg lands. The
# failure message tells the next reviewer what to do.


_TIGHT_API_FUNCTIONS = (
    "mark_call_attempt_answered",
    "mark_call_attempt_media_started",
    "mark_call_attempt_ended",
)

_PHI_SHAPE_KWARGS = frozenset({
    "name",
    "phone",
    "transcript",
    "reminder_title",
    "reminder_description",
    "caregiver_note",
    "medical_notes",
    "summary",
    "content",
    "payload",
    "metadata",
})


def test_pipecat_call_attempts_writers_have_tight_phi_free_api():
    """mark_call_attempt_* must not accept PHI-shape-able kwargs.

    If you intentionally need to extend one of these writers with a
    payload-like input, route it through
    `services.call_attempts.assert_operational_payload_has_no_plain_phi`
    BEFORE the SQL runs, then add an explicit test that proves PHI is
    rejected at that boundary — and update this allowlist.
    """
    import inspect
    from services import call_attempts

    offenders = {}
    for fn_name in _TIGHT_API_FUNCTIONS:
        fn = getattr(call_attempts, fn_name)
        params = set(inspect.signature(fn).parameters.keys())
        bad = _PHI_SHAPE_KWARGS.intersection(params)
        if bad:
            offenders[fn_name] = sorted(bad)

    assert not offenders, (
        "Pipecat call_attempts writers grew PHI-shape-able kwargs without "
        "an accompanying PHI guard:\n"
        + "\n".join(f"  - {fn}: {kw}" for fn, kw in offenders.items())
        + "\nIf this is intentional, route the new input through "
        "services.call_attempts.assert_operational_payload_has_no_plain_phi "
        "BEFORE the SQL and add a test asserting it rejects PHI."
    )
