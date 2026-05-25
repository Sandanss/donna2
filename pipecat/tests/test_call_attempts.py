"""Tests for the Pipecat-side call_attempts lifecycle writer (Phase 4 §5)."""

from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_mark_call_attempt_answered_idempotent_update():
    from services.call_attempts import mark_call_attempt_answered

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = {"id": "attempt-1", "status": "initiating", "answered_at": None, "ended_at": None}
        await mark_call_attempt_answered("v3:cci-1")

    mock_query.assert_awaited_once()
    mock_exec.assert_awaited_once()
    sql = mock_exec.call_args[0][0]
    assert "answered_at = COALESCE(answered_at, NOW())" in sql
    assert "status = 'answered'" in sql
    assert mock_exec.call_args[0][1] == "v3:cci-1"


@pytest.mark.asyncio
async def test_mark_call_attempt_answered_skips_when_row_missing():
    from services.call_attempts import mark_call_attempt_answered

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = None
        await mark_call_attempt_answered("missing")

    mock_exec.assert_not_called()


@pytest.mark.asyncio
async def test_mark_call_attempt_media_started_sets_timestamp_once():
    from services.call_attempts import mark_call_attempt_media_started

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = {"id": "attempt-2", "status": "answered", "answered_at": "now", "ended_at": None}
        await mark_call_attempt_media_started("v3:cci-2")

    mock_exec.assert_awaited_once()
    sql = mock_exec.call_args[0][0]
    assert "media_started_at = COALESCE(media_started_at, NOW())" in sql


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_marks_failed_for_terminal_error_events():
    from services.call_attempts import mark_call_attempt_ended

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = {"id": "attempt-3", "status": "answered", "answered_at": "now", "ended_at": None}
        await mark_call_attempt_ended("v3:cci-3", "call.no_answer")

    args = mock_exec.call_args[0]
    # signature: (sql, call_control_id, status, provider_error_code, provider_error_class)
    assert args[2] == "failed"
    assert args[3] == "no_answer"
    assert args[4] == "no_answer"


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_marks_completed_for_call_hangup():
    from services.call_attempts import mark_call_attempt_ended

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = {"id": "attempt-4", "status": "answered", "answered_at": "now", "ended_at": None}
        await mark_call_attempt_ended("v3:cci-4", "call.hangup")

    args = mock_exec.call_args[0]
    assert args[2] == "completed"
    assert args[3] is None
    assert args[4] is None


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_uses_explicit_error_reason_over_event():
    from services.call_attempts import mark_call_attempt_ended

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        mock_query.return_value = {"id": "attempt-5", "status": "answered", "answered_at": "now", "ended_at": None}
        await mark_call_attempt_ended("v3:cci-5", "call.hangup", error_reason="machine_voicemail")

    args = mock_exec.call_args[0]
    assert args[2] == "failed"
    assert args[3] == "machine_voicemail"
    assert args[4] == "amd"


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_skips_when_no_call_control_id():
    from services.call_attempts import mark_call_attempt_ended

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        await mark_call_attempt_ended("", "call.hangup")

    mock_query.assert_not_called()
    mock_exec.assert_not_called()


def test_is_terminal_event_covers_completed_and_error_events():
    from services.call_attempts import is_terminal_event

    assert is_terminal_event("call.hangup")
    assert is_terminal_event("call.completed")
    assert is_terminal_event("call.failed")
    assert is_terminal_event("call.no_answer")
    assert is_terminal_event("call.busy")
    assert not is_terminal_event("call.answered")
    assert not is_terminal_event("streaming.started")


# ---------------------------------------------------------------------------
# Category F: lifecycle idempotency (scale-2000 backfill)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_mark_call_attempt_answered_idempotent_on_duplicate_webhook():
    """Duplicate `call.answered` webhooks must not advance answered_at.

    The UPDATE statement uses COALESCE(answered_at, NOW()) so a second call
    against an already-answered row keeps the original answered_at timestamp.
    """
    from services.call_attempts import mark_call_attempt_answered

    with (
        patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
        patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
    ):
        # First call: row is still in 'initiating', answered_at is null.
        # Second call: simulates the duplicate webhook landing after the row
        # has already been advanced to 'answered'.
        mock_query.side_effect = [
            {"id": "attempt-dup", "status": "initiating", "answered_at": None, "ended_at": None},
            {"id": "attempt-dup", "status": "answered", "answered_at": "2035-03-11T13:30:00Z", "ended_at": None},
        ]

        await mark_call_attempt_answered("v3:cci-dup")
        await mark_call_attempt_answered("v3:cci-dup")

    assert mock_exec.await_count == 2

    # Both UPDATEs must rely on COALESCE so the second call does NOT
    # overwrite the first answered_at with a later NOW().
    for call in mock_exec.await_args_list:
        sql_text = call.args[0]
        assert "answered_at = COALESCE(answered_at, NOW())" in sql_text
        assert "status = 'answered'" in sql_text
        # The only positional arg should be the call_control_id.
        assert call.args[1] == "v3:cci-dup"


@pytest.mark.asyncio
async def test_telnyx_events_terminal_hook_returns_200_when_writer_raises(monkeypatch):
    """If `mark_call_attempt_ended` raises, the webhook still responds 200.

    The lifecycle writer is fire-and-forget — Telnyx must not see a 5xx for
    an internal bookkeeping failure or it will retry the terminal event.
    """
    import os

    # Set required env vars before importing app
    os.environ.setdefault("JWT_SECRET", "test-secret")
    os.environ.setdefault("TELNYX_API_KEY", "test-telnyx-key")
    os.environ.setdefault("TELNYX_PUBLIC_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
    os.environ.setdefault("TELNYX_PHONE_NUMBER", "+15551234567")
    os.environ.setdefault("TELNYX_CONNECTION_ID", "test-connection")
    monkeypatch.setenv("ALLOW_UNSIGNED_TELNYX_WEBHOOKS", "true")

    from fastapi.testclient import TestClient
    from main import app
    from api.routes import call_context, telnyx as telnyx_route

    # Seed metadata so the terminal handler reaches the queue_id branch.
    cci = "v3:cci-writer-raises"
    call_context.call_metadata[cci] = {
        "queue_id": "queue-001",
        "reservation_id": None,
    }

    captured = {}

    async def boom(*args, **kwargs):
        captured["called"] = True
        raise RuntimeError("intentional bookkeeping failure")

    payload = {
        "data": {
            "id": "evt-writer-raises",
            "event_type": "call.hangup",
            "payload": {"call_control_id": cci},
        }
    }

    # Patch the lifecycle writer + dedupe to force the bookkeeping path.
    async def not_duplicate(_event_id):
        return False

    with (
        patch("services.call_attempts.mark_call_attempt_ended", side_effect=boom),
        patch.object(telnyx_route, "_mark_telnyx_event_seen", side_effect=not_duplicate),
    ):
        client = TestClient(app)
        response = client.post("/telnyx/events", json=payload)

    # The webhook MUST still return 200 even though the writer raised.
    assert response.status_code == 200
    assert response.json().get("received") is True
    assert captured.get("called") is True

    # Cleanup
    call_context.call_metadata.pop(cci, None)


@pytest.mark.asyncio
async def test_create_telnyx_outbound_call_response_includes_instanceId_when_resolve_returns(monkeypatch):
    """When capacity registry resolves an instance, the response carries it."""
    import os

    os.environ.setdefault("JWT_SECRET", "test-secret")
    monkeypatch.setenv("TELNYX_API_KEY", "test-telnyx-key")
    monkeypatch.setenv("TELNYX_PHONE_NUMBER", "+15551234567")
    monkeypatch.setenv("TELNYX_CONNECTION_ID", "test-connection-id")
    monkeypatch.setenv("PIPECAT_PUBLIC_URL", "https://pipecat.test")

    from api.routes import telnyx as telnyx_route

    senior = {
        "id": "senior-replica-a",
        "phone": "+15555550123",
        "name": "Margaret",
        "is_active": True,
        "timezone": "America/New_York",
        "call_settings": {},
    }

    async def fake_post(endpoint, payload=None):
        if endpoint.endswith("/v2/calls"):
            return {"data": {"call_control_id": "cci-replica-a"}}
        return {}

    async def fake_seed(*args, **kwargs):
        return {}

    async def fake_store(*args, **kwargs):
        return {}

    body = telnyx_route.TelnyxOutboundCallRequest(
        seniorId="senior-replica-a",
        callType="check-in",
        queueId="queue-001",
        reservationId="res-001",
    )

    with (
        patch("services.seniors.get_by_id", new_callable=AsyncMock, return_value=senior),
        patch.object(telnyx_route, "_senior_is_inactive", return_value=False),
        patch.object(telnyx_route, "_telnyx_post", side_effect=fake_post),
        patch.object(telnyx_route, "_seed_outbound_call_metadata", side_effect=fake_seed),
        patch.object(telnyx_route, "_store_senior_metadata", side_effect=fake_store),
        patch.object(telnyx_route, "_prepare_reminder_context", new_callable=AsyncMock, return_value=(None, None)),
        patch.object(telnyx_route, "_cached_senior_context_seed", return_value=({}, False)),
        patch("services.capacity.resolve_instance_id", return_value="replica-a"),
    ):
        result = await telnyx_route.create_telnyx_outbound_call(body)

    assert result["instanceId"] == "replica-a"
    assert result["callControlId"] == "cci-replica-a"
    assert result["queueId"] == "queue-001"


@pytest.mark.asyncio
async def test_mark_call_attempt_ended_provider_error_class_mapping_full():
    """Drive `mark_call_attempt_ended` across the full Telnyx event taxonomy.

    Asserts (status, provider_error_code, provider_error_class) is what the
    queue-side accounting expects for each event_type + error_reason combo.
    """
    from services.call_attempts import mark_call_attempt_ended

    cases = [
        # (event_type, error_reason, expected_status, expected_error_code, expected_error_class)
        ("call.busy", None, "failed", "busy", "busy"),
        ("call.failed", None, "failed", "call_failed", "provider_error"),
        ("call.completed", None, "completed", None, None),
        ("call.no_answer", None, "failed", "no_answer", "no_answer"),
        ("call.hangup", None, "completed", None, None),
        ("call.hangup", "machine_voicemail", "failed", "machine_voicemail", "amd"),
    ]

    for event_type, error_reason, exp_status, exp_code, exp_class in cases:
        with (
            patch("services.call_attempts.query_one", new_callable=AsyncMock) as mock_query,
            patch("services.call_attempts.execute", new_callable=AsyncMock) as mock_exec,
        ):
            mock_query.return_value = {
                "id": f"attempt-{event_type}",
                "status": "answered",
                "answered_at": "now",
                "ended_at": None,
            }

            kwargs = {"error_reason": error_reason} if error_reason is not None else {}
            await mark_call_attempt_ended(f"cci-{event_type}", event_type, **kwargs)

        args = mock_exec.await_args.args
        # signature: (sql, call_control_id, status, provider_error_code, provider_error_class)
        assert args[1] == f"cci-{event_type}", f"failed cci for {event_type}"
        assert args[2] == exp_status, f"failed status for {event_type}/{error_reason}"
        assert args[3] == exp_code, f"failed code for {event_type}/{error_reason}"
        assert args[4] == exp_class, f"failed class for {event_type}/{error_reason}"


@pytest.mark.asyncio
async def test_handle_call_answered_skips_call_attempts_for_legacy_calls(monkeypatch):
    """`_handle_call_answered` must NOT write call_attempts for legacy (non-queue) calls.

    Spurious rows in `call_attempts` would corrupt the A/B accounting that
    the Phase 5 live report uses to count canary cohort answered/attempts.
    """
    import os

    os.environ.setdefault("JWT_SECRET", "test-secret")
    os.environ.setdefault("TELNYX_API_KEY", "test-telnyx-key")

    from api.routes import call_context, telnyx as telnyx_route

    cci = "v3:cci-legacy"
    # Legacy metadata: NO queue_id present.
    call_context.call_metadata[cci] = {
        "telnyx_answered": False,
        "telnyx_context_ready": True,
    }

    with (
        patch("services.call_attempts.mark_call_attempt_answered", new_callable=AsyncMock) as mock_answered,
        patch.object(telnyx_route, "_maybe_start_telnyx_stream", new_callable=AsyncMock),
        patch.object(telnyx_route, "_persist_metadata", new_callable=AsyncMock),
    ):
        await telnyx_route._handle_call_answered(cci)

    mock_answered.assert_not_called()

    # Cleanup
    call_context.call_metadata.pop(cci, None)
