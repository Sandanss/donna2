"""Category B (PHI shape) test — Pipecat senior export route.

Symmetric to `tests/integration/routes/seniors-export-decrypt.test.js` for
the Node side. Asserts that `GET /api/seniors/{senior_id}/export` on the
Pipecat side:

  (a) decrypts `post_call_jobs.payload_encrypted` to a plain `payload` and
      strips the ciphertext from the response (the helper
      `_decrypt_post_call_jobs` in `api/routes/export.py` is the contract
      under test).
  (b) decrypts `call_schedules.context_notes_encrypted` to `context_notes`
      and strips the ciphertext.
  (c) returns 403 to an unauthorized caregiver BEFORE any data is read.

The Pipecat route already implements decryption today
(see `_decrypt_post_call_jobs` and `_decrypt_call_schedules` in
`pipecat/api/routes/export.py`) — this test pins that behavior so a
regression that removes the call surfaces immediately.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Same boot-time env vars the existing test_api_routes.py uses. We use
# direct assignment (not setdefault) for COFOUNDER_API_KEY_1 because the
# auth module reads it at import time — if any earlier test in the suite
# imports auth before this file runs, setdefault would no-op and the list
# below would be empty. Direct assignment + the COFOUNDER_API_KEYS patch
# below survives any test-collection order.
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("TELNYX_API_KEY", "test-telnyx-key")
os.environ.setdefault("TELNYX_PUBLIC_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
os.environ.setdefault("TELNYX_PHONE_NUMBER", "+15551234567")
os.environ.setdefault("TELNYX_CONNECTION_ID", "test-connection")
os.environ.setdefault("ALLOW_UNSIGNED_TELNYX_WEBHOOKS", "true")
os.environ["COFOUNDER_API_KEY_1"] = "test-cofounder-api-key"

PIPECAT_ROOT = Path(__file__).resolve().parents[1]
if str(PIPECAT_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPECAT_ROOT))

from main import app  # noqa: E402
from api.middleware import auth as _auth_module  # noqa: E402

# Auth module may have been imported by an earlier test before our env was
# set; force-refresh COFOUNDER_API_KEYS so the cofounder bypass actually
# matches the header we send in every test below.
if "test-cofounder-api-key" not in _auth_module.COFOUNDER_API_KEYS:
    _auth_module.COFOUNDER_API_KEYS.append("test-cofounder-api-key")


SENIOR_ID = "11111111-1111-4111-8111-111111111111"
POST_CALL_JOB_ID = "22222222-2222-4222-8222-222222222222"
SCHEDULE_ID = "33333333-3333-4333-8333-333333333333"


def _cofounder_headers():
    return {"x-api-key": "test-cofounder-api-key"}


@pytest.fixture
def client():
    return TestClient(app)


def _query_one_responses_for_senior_present():
    """`query_one` is called twice from the export route's auth + senior
    lookup path: once for `caregivers` row lookup (when caller isn't admin/
    cofounder) and once for `seniors` row. With cofounder API key the
    caregivers lookup is skipped, so only the seniors row is fetched."""
    return [{"id": SENIOR_ID, "name": "Test Senior", "phone": "+15551234567"}]


def _query_many_responses(
    *,
    post_call_jobs=None,
    call_schedules=None,
):
    """Build the full ordered list of `query_many` responses matching the
    sequence in `api/routes/export.py` (12 query_many calls):
      conversations, memories, reminders, call_analyses, daily_context,
      caregiver_links, call_schedules, call_queue, call_attempts,
      post_call_jobs, outbound_call_guards, scheduler_shadow_comparisons.
    """
    return [
        [],                                   # conversations
        [],                                   # memories
        [],                                   # reminders
        [],                                   # call_analyses
        [],                                   # daily_context
        [],                                   # caregiver_links
        call_schedules or [],                 # call_schedules
        [],                                   # call_queue
        [],                                   # call_attempts
        post_call_jobs or [],                 # post_call_jobs
        [],                                   # outbound_call_guards
        [],                                   # scheduler_shadow_comparisons
    ]


def _decrypt_passthrough(value):
    """Stand-in for `lib.encryption.decrypt`. Returns a deterministic marker
    that does NOT echo the source ciphertext, so the "ciphertext stripped"
    assertion is meaningful."""
    if not isinstance(value, str):
        return value
    if value.startswith("enc:"):
        return f"DECRYPTED-text-len-{len(value)}"
    return value


def _decrypt_json_passthrough(value):
    """Stand-in for `lib.encryption.decrypt_json`. Returns a deterministic
    structured marker that does NOT echo the source ciphertext."""
    if not isinstance(value, str):
        return value
    if value.startswith("enc:"):
        return {"decrypted_marker": f"plain-payload-len-{len(value)}"}
    return value


class TestPipecatExportDecrypt:
    def test_post_call_jobs_payload_encrypted_is_decrypted_and_ciphertext_stripped(self, client):
        post_call_jobs = [{
            "id": POST_CALL_JOB_ID,
            "conversation_id": "conv-1",
            "call_sid": "CA-pipecat-export-1",
            "senior_id": SENIOR_ID,
            "job_type": "analysis",
            "status": "completed",
            "priority": 1,
            "dedupe_key": "post_call:CA-pipecat-export-1:analysis",
            "payload_encrypted": "enc:rawCiphertextForPipecatJobPayload",
            "depends_on": None,
            "attempt_count": 1,
            "max_attempts": 3,
        }]

        with patch("api.routes.export.query_one", new_callable=AsyncMock) as mock_q1, \
             patch("api.routes.export.query_many", new_callable=AsyncMock) as mock_qm, \
             patch("api.routes.export.write_audit", new_callable=AsyncMock), \
             patch("api.routes.export.decrypt", side_effect=_decrypt_passthrough), \
             patch("api.routes.export.decrypt_json", side_effect=_decrypt_json_passthrough), \
             patch("api.routes.export.decrypt_senior_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_reminder_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_daily_context_phi", side_effect=lambda r: r):
            mock_q1.side_effect = _query_one_responses_for_senior_present()
            mock_qm.side_effect = _query_many_responses(post_call_jobs=post_call_jobs)

            response = client.get(
                f"/api/seniors/{SENIOR_ID}/export",
                headers=_cofounder_headers(),
            )

        assert response.status_code == 200, response.text
        body = response.json()
        assert "post_call_jobs" in body
        assert len(body["post_call_jobs"]) == 1
        job = body["post_call_jobs"][0]

        # (a) decrypted payload appears.
        assert "payload" in job
        assert job["payload"] == {
            "decrypted_marker": f"plain-payload-len-{len('enc:rawCiphertextForPipecatJobPayload')}",
        }

        # (b) ciphertext column is GONE from the response.
        assert "payload_encrypted" not in job
        # Also nowhere else in the response body.
        body_text = response.text
        assert "enc:rawCiphertextForPipecatJobPayload" not in body_text
        assert "payload_encrypted" not in body_text

    def test_call_schedules_context_notes_encrypted_is_decrypted_and_stripped(self, client):
        call_schedules = [{
            "id": SCHEDULE_ID,
            "senior_id": SENIOR_ID,
            "call_type": "check-in",
            "timezone": "America/New_York",
            "target_local_time": "09:00",
            "window_minutes": 30,
            "frequency": "daily",
            "context_notes_encrypted": "enc:rawCiphertextForPipecatScheduleNotes",
            "is_active": True,
        }]

        with patch("api.routes.export.query_one", new_callable=AsyncMock) as mock_q1, \
             patch("api.routes.export.query_many", new_callable=AsyncMock) as mock_qm, \
             patch("api.routes.export.write_audit", new_callable=AsyncMock), \
             patch("api.routes.export.decrypt", side_effect=_decrypt_passthrough), \
             patch("api.routes.export.decrypt_json", side_effect=_decrypt_json_passthrough), \
             patch("api.routes.export.decrypt_senior_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_reminder_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_daily_context_phi", side_effect=lambda r: r):
            mock_q1.side_effect = _query_one_responses_for_senior_present()
            mock_qm.side_effect = _query_many_responses(call_schedules=call_schedules)

            response = client.get(
                f"/api/seniors/{SENIOR_ID}/export",
                headers=_cofounder_headers(),
            )

        assert response.status_code == 200, response.text
        body = response.json()
        assert "call_schedules" in body
        assert len(body["call_schedules"]) == 1
        schedule = body["call_schedules"][0]

        # (a) context_notes plain field present.
        expected_marker = f"DECRYPTED-text-len-{len('enc:rawCiphertextForPipecatScheduleNotes')}"
        assert schedule.get("context_notes") == expected_marker

        # (b) ciphertext column is gone.
        assert "context_notes_encrypted" not in schedule
        assert "enc:rawCiphertextForPipecatScheduleNotes" not in response.text
        assert "context_notes_encrypted" not in response.text

    def test_unauthorized_caregiver_gets_403_before_any_data_read(self, client):
        """A clerk-authed caregiver who is NOT linked to this senior must
        get 403 — and zero `query_many` invocations should run."""
        # Forge a Clerk JWT-shaped header to take the "is not cofounder /
        # admin" branch. The route's _can_access_senior calls query_one on
        # caregivers WHERE clerk_user_id=... — we return None to deny.
        # Easier path: stub require_auth itself.
        from api.middleware.auth import AuthContext

        async def deny_caregiver_auth(*_args, **_kwargs):
            return AuthContext(
                is_cofounder=False,
                is_admin=False,
                user_id="caregiver-not-linked",
                clerk_user_id="caregiver-not-linked",
            )

        with patch("api.routes.export.require_auth", side_effect=deny_caregiver_auth), \
             patch("api.routes.export.query_one", new_callable=AsyncMock) as mock_q1, \
             patch("api.routes.export.query_many", new_callable=AsyncMock) as mock_qm, \
             patch("api.routes.export.write_audit", new_callable=AsyncMock) as mock_audit, \
             patch("api.routes.export.decrypt", side_effect=_decrypt_passthrough) as mock_decrypt, \
             patch("api.routes.export.decrypt_json", side_effect=_decrypt_json_passthrough) as mock_decrypt_json:
            # _can_access_senior calls query_one on caregivers — return None
            # so access is denied.
            mock_q1.return_value = None

            # Real FastAPI dependency stub via app.dependency_overrides.
            from api.middleware.auth import require_auth as real_require_auth
            app.dependency_overrides[real_require_auth] = lambda: AuthContext(
                is_cofounder=False,
                is_admin=False,
                user_id="caregiver-not-linked",
                clerk_user_id="caregiver-not-linked",
            )
            try:
                response = client.get(f"/api/seniors/{SENIOR_ID}/export")
            finally:
                app.dependency_overrides.pop(real_require_auth, None)

            assert response.status_code == 403, response.text
            assert "Access denied" in response.text or "access" in response.text.lower()

            # Critical: no data was read, no audit was written, no decryption ran.
            # query_one MAY be called once (the caregivers lookup) — that's the
            # access check. But NEVER the seniors SELECT, and NEVER query_many.
            assert mock_qm.await_count == 0
            assert mock_audit.await_count == 0
            assert mock_decrypt.call_count == 0
            assert mock_decrypt_json.call_count == 0
            # query_one was called at most once (the caregiver check), never
            # twice (which would mean we proceeded to the senior lookup).
            assert mock_q1.await_count <= 1

    def test_post_call_jobs_row_without_payload_encrypted_has_no_fabricated_payload(self, client):
        post_call_jobs = [{
            "id": POST_CALL_JOB_ID,
            "conversation_id": "conv-2",
            "call_sid": "CA-pipecat-export-2",
            "senior_id": SENIOR_ID,
            "job_type": "summary",
            "status": "pending",
            "priority": 1,
            "dedupe_key": "post_call:CA-pipecat-export-2:summary",
            # No payload_encrypted set.
            "attempt_count": 0,
            "max_attempts": 3,
        }]

        with patch("api.routes.export.query_one", new_callable=AsyncMock) as mock_q1, \
             patch("api.routes.export.query_many", new_callable=AsyncMock) as mock_qm, \
             patch("api.routes.export.write_audit", new_callable=AsyncMock), \
             patch("api.routes.export.decrypt", side_effect=_decrypt_passthrough), \
             patch("api.routes.export.decrypt_json", side_effect=_decrypt_json_passthrough) as mock_decrypt_json, \
             patch("api.routes.export.decrypt_senior_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_reminder_phi", side_effect=lambda r: r), \
             patch("api.routes.export.decrypt_daily_context_phi", side_effect=lambda r: r):
            mock_q1.side_effect = _query_one_responses_for_senior_present()
            mock_qm.side_effect = _query_many_responses(post_call_jobs=post_call_jobs)

            response = client.get(
                f"/api/seniors/{SENIOR_ID}/export",
                headers=_cofounder_headers(),
            )

        assert response.status_code == 200, response.text
        job = response.json()["post_call_jobs"][0]
        # No payload field manufactured from a missing ciphertext.
        assert "payload" not in job
        assert "payload_encrypted" not in job
        # decrypt_json should not have been called for this row.
        # (Other call_analyses decryption may still have run if the route's
        # `_decrypt_call_analyses` path triggers — but post_call_jobs path
        # only invokes decrypt_json when payload_encrypted is truthy.)
        called_with_payload = [
            c for c in mock_decrypt_json.call_args_list
            if any("rawCiphertext" in str(arg) for arg in c.args)
        ]
        assert called_with_payload == []
