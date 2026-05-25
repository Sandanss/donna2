"""Pipecat-side call_attempts lifecycle writer (Phase 4 §5).

When a queue-dispatched call lands on Pipecat, the Telnyx webhook stream is the
source of truth for dial answered / media started / terminal state. This module
updates the matching ops `call_attempts` row by `call_control_id` so the
dispatcher's audit/duplicate-detection queries can see the full lifecycle
without the Node side having to ingest every webhook.

PHI-free by construction — only operational columns (status, timestamps,
provider error code, provider error class) are written.
"""

from __future__ import annotations

import re
from typing import Any

from loguru import logger

from db import execute, query_one


# ---------------------------------------------------------------------------
# Operational PHI guard — Pipecat parity with Node `assertOperationalPayloadHasNoPlainPhi`.
#
# Today Pipecat is read-side / status-update-only for the ops.* tables, so
# this guard isn't called on any current INSERT path. It exists so that any
# future Pipecat-side write to call_queue / call_attempts / outbound_call_guards
# / scheduler_shadow_comparisons can defend against PHI accidentally leaking
# into operational rows. Mirrors the Node guard in services/call-queue.js.
# ---------------------------------------------------------------------------

_PHI_SENTINEL_PATTERN = re.compile(r"Donna Phi Sentinel|PHI_SENTINEL_[A-Z_]+")

_ALLOWED_ENCRYPTED_KEYS = frozenset({"contextnotesencrypted", "payloadencrypted"})

_DISALLOWED_OPERATIONAL_KEYS = (
    "name",
    "phone",
    "title",
    "description",
    "medical",
    "family",
    "additionalinfo",
    "transcript",
    "summary",
    "content",
    "contextnotes",
    "caregivernote",
    "userresponse",
    "prompt",
)


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key).lower())


def assert_operational_payload_has_no_plain_phi(value: Any, path: list[str] | None = None) -> None:
    """Raise ValueError if `value` looks like it could be PHI in an ops.* write.

    Walks the value recursively. Strings matching the PHI_SENTINEL pattern,
    and dict keys whose normalized form contains any disallowed substring
    (name, phone, transcript, etc.), are rejected. Encrypted ciphertext keys
    (`*_encrypted` shapes) are explicitly allowed. Mirrors the Node guard in
    `services/call-queue.js::assertOperationalPayloadHasNoPlainPhi`.
    """
    path = list(path or [])

    if value is None:
        return
    if isinstance(value, str):
        if _PHI_SENTINEL_PATTERN.search(value):
            where = ".".join(path) or "<root>"
            raise ValueError(
                f"Plain PHI sentinel is not allowed in call queue operational data at {where}"
            )
        return
    if isinstance(value, (int, float, bool)):
        return
    if isinstance(value, (bytes, bytearray)):
        return
    # Pure-date-like opaque types (datetime, UUID) — let them through.
    if not isinstance(value, (dict, list, tuple, set, frozenset)):
        return

    if isinstance(value, (list, tuple, set, frozenset)):
        for index, item in enumerate(value):
            assert_operational_payload_has_no_plain_phi(item, [*path, str(index)])
        return

    for key, nested in value.items():
        normalized = _normalize_key(key)
        if normalized in _ALLOWED_ENCRYPTED_KEYS:
            # Encrypted-payload keys are permitted; recurse only for
            # consistency (the ciphertext itself is a plain string and won't
            # match the sentinel pattern).
            assert_operational_payload_has_no_plain_phi(nested, [*path, str(key)])
            continue
        if any(disallowed in normalized for disallowed in _DISALLOWED_OPERATIONAL_KEYS):
            raise ValueError(
                f'PHI-bearing field "{key}" is not allowed in call queue operational data'
            )
        assert_operational_payload_has_no_plain_phi(nested, [*path, str(key)])


_TERMINAL_ERROR_EVENTS = {
    "call.failed": "call_failed",
    "call.no_answer": "no_answer",
    "call.busy": "busy",
}
_TERMINAL_OK_EVENTS = {"call.hangup", "call.completed"}
_NON_PHI_ERROR_CLASSES = {
    "call_failed": "provider_error",
    "no_answer": "no_answer",
    "busy": "busy",
    "machine_voicemail": "amd",
    "machine_hangup": "amd",
}


async def _existing_attempt(call_control_id: str) -> dict[str, Any] | None:
    if not call_control_id:
        return None
    return await query_one(
        "SELECT id, status, answered_at, ended_at FROM call_attempts WHERE call_control_id = $1",
        call_control_id,
    )


async def mark_call_attempt_answered(call_control_id: str) -> None:
    """Set call_attempts.answered_at + status='answered' for the attempt.

    Idempotent: if the row already has answered_at, only the timestamp is
    refreshed on retry (so duplicate webhook events don't double-advance).
    """
    if not call_control_id:
        return
    attempt = await _existing_attempt(call_control_id)
    if not attempt:
        return
    try:
        await execute(
            """
            UPDATE call_attempts
               SET status = 'answered',
                   answered_at = COALESCE(answered_at, NOW()),
                   updated_at = NOW()
             WHERE call_control_id = $1
            """,
            call_control_id,
        )
    except Exception as exc:
        logger.warning(
            "[{cid}] call_attempts answered update failed: {err}",
            cid=call_control_id,
            err=str(exc),
        )


async def mark_call_attempt_media_started(call_control_id: str) -> None:
    """Set call_attempts.media_started_at when Telnyx confirms the WS stream."""
    if not call_control_id:
        return
    attempt = await _existing_attempt(call_control_id)
    if not attempt:
        return
    try:
        await execute(
            """
            UPDATE call_attempts
               SET media_started_at = COALESCE(media_started_at, NOW()),
                   updated_at = NOW()
             WHERE call_control_id = $1
            """,
            call_control_id,
        )
    except Exception as exc:
        logger.warning(
            "[{cid}] call_attempts media_started update failed: {err}",
            cid=call_control_id,
            err=str(exc),
        )


async def mark_call_attempt_ended(
    call_control_id: str,
    event_type: str,
    *,
    error_reason: str | None = None,
) -> None:
    """Set call_attempts.ended_at + terminal status.

    `event_type` is the Telnyx event name (call.hangup / call.failed / etc).
    `error_reason` is an operational tag (never PHI) such as "no_answer",
    "machine_voicemail", "carrier_unreachable", "provider_5xx".
    """
    if not call_control_id:
        return
    attempt = await _existing_attempt(call_control_id)
    if not attempt:
        return

    is_error = event_type in _TERMINAL_ERROR_EVENTS or bool(error_reason)
    status = "failed" if is_error else "completed"
    provider_error_code = error_reason or _TERMINAL_ERROR_EVENTS.get(event_type)
    provider_error_class = (
        _NON_PHI_ERROR_CLASSES.get(provider_error_code or "", "provider_error")
        if is_error
        else None
    )

    try:
        await execute(
            """
            UPDATE call_attempts
               SET status = $2,
                   ended_at = COALESCE(ended_at, NOW()),
                   provider_error_code = COALESCE(provider_error_code, $3),
                   provider_error_class = COALESCE(provider_error_class, $4),
                   updated_at = NOW()
             WHERE call_control_id = $1
            """,
            call_control_id,
            status,
            provider_error_code,
            provider_error_class,
        )
    except Exception as exc:
        logger.warning(
            "[{cid}] call_attempts ended update failed: {err}",
            cid=call_control_id,
            err=str(exc),
        )


def is_terminal_event(event_type: str) -> bool:
    return event_type in _TERMINAL_OK_EVENTS or event_type in _TERMINAL_ERROR_EVENTS
