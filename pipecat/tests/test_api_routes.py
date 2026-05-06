"""Tests for API routes using FastAPI TestClient."""

import base64
import os
import time
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

# Set required env vars before importing app
os.environ.setdefault("JWT_SECRET", "test-secret")
os.environ.setdefault("TELNYX_API_KEY", "test-telnyx-key")
os.environ.setdefault("TELNYX_PUBLIC_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")
os.environ.setdefault("TELNYX_PHONE_NUMBER", "+15551234567")
os.environ.setdefault("TELNYX_CONNECTION_ID", "test-connection")
os.environ.setdefault("ALLOW_UNSIGNED_TELNYX_WEBHOOKS", "true")

from main import app


class FakeSharedState:
    is_shared = True

    def __init__(self):
        self.data = {}
        self.ttls = {}
        self.deleted = []

    async def set(self, key, value, ttl=None):
        self.data[key] = value
        self.ttls[key] = ttl

    async def get(self, key):
        return self.data.get(key)

    async def delete(self, key):
        self.deleted.append(key)
        self.data.pop(key, None)


def enable_test_encryption(monkeypatch):
    from lib import encryption

    key = base64.urlsafe_b64encode(b"m" * 32).decode().rstrip("=")
    monkeypatch.setenv("FIELD_ENCRYPTION_KEY", key)
    monkeypatch.setattr(encryption, "_KEY", None)
    monkeypatch.setattr(encryption, "_aes", None)


@pytest.fixture
def client():
    return TestClient(app)


class TestHealthEndpoint:
    @patch("db.check_health", side_effect=AssertionError("/live must not call database readiness"))
    def test_live_returns_ok_without_database_check(self, mock_db_health, client):
        response = client.get("/live")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["service"] == "donna-pipecat"
        assert "active_calls" in data
        assert "database" not in data
        mock_db_health.assert_not_called()

    @patch("db.check_health", new_callable=AsyncMock, return_value=True)
    @patch("db.client.get_pool_stats", new_callable=AsyncMock, return_value={"size": 5, "idle": 3, "max": 50, "min": 5})
    def test_health_returns_ok(self, mock_pool_stats, mock_db_health, client):
        response = client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert data["service"] == "donna-pipecat"
        assert "active_calls" in data
        assert data["database"] == "ok"
        assert "pool" in data
        assert "circuit_breakers" in data

    @patch("db.check_health", new_callable=AsyncMock, return_value=False)
    @patch("db.client.get_pool_stats", new_callable=AsyncMock, return_value={})
    def test_health_degraded_when_db_down(self, mock_pool_stats, mock_db_health, client):
        response = client.get("/health")
        assert response.status_code == 503
        data = response.json()
        assert data["status"] == "degraded"
        assert data["database"] == "error"


class TestTelnyxAndCallContext:
    def test_cached_news_requires_fresh_timestamp(self):
        from api.routes.call_context import _cached_news_context_from_senior

        senior = {
            "id": "senior-1",
            "cached_news": "- Fresh gardening story",
            "cached_news_updated_at": datetime.now(timezone.utc) - timedelta(hours=48),
        }

        assert _cached_news_context_from_senior(senior) is None

    def test_cached_news_selects_fresh_stories(self):
        from api.routes.call_context import _cached_news_context_from_senior

        senior = {
            "id": "senior-1",
            "cached_news": "- Fresh gardening story",
            "cached_news_updated_at": datetime.now(timezone.utc),
            "interests": ["gardening"],
            "interest_scores": {"gardening": 5},
        }

        with patch("services.news.select_stories_for_call", return_value="selected news") as mock_select:
            assert _cached_news_context_from_senior(senior) == "selected news"

        mock_select.assert_called_once()

    def test_cached_news_must_be_from_senior_local_today(self):
        from api.routes.call_context import _cached_news_context_from_senior

        senior = {
            "id": "senior-1",
            "timezone": "America/New_York",
            "cached_news": "- Yesterday's gardening story",
            "cached_news_updated_at": datetime.now(timezone.utc) - timedelta(days=1),
        }

        assert _cached_news_context_from_senior(senior) is None

    def test_archived_twilio_voice_answer_is_not_mounted(self, client):
        response = client.post("/voice/answer", data={})
        assert response.status_code == 404

    def test_telnyx_events_accepts_unsigned_webhook_in_test_mode(self, client):
        response = client.post(
            "/telnyx/events",
            json={
                "data": {
                    "event_type": "call.initiated",
                    "payload": {},
                }
            },
        )
        assert response.status_code == 200
        assert response.json() == {"received": True}

    def test_telnyx_events_deduplicate_event_ids(self, client):
        from api.routes import telnyx

        telnyx._recent_telnyx_event_ids.clear()
        payload = {
            "data": {
                "id": "evt-duplicate",
                "event_type": "call.answered",
                "payload": {"call_control_id": "v3:test-call"},
            }
        }

        try:
            with patch.object(telnyx, "_handle_call_answered", new=AsyncMock()) as mock_answered:
                first = client.post("/telnyx/events", json=payload)
                second = client.post("/telnyx/events", json=payload)

            assert first.status_code == 200
            assert second.status_code == 200
            assert second.json() == {"received": True, "duplicate": True}
            assert mock_answered.await_count == 1
        finally:
            telnyx._recent_telnyx_event_ids.clear()

    @pytest.mark.asyncio
    async def test_bot_loads_metadata_from_local_state_first(self):
        """WebSocket setup should use local metadata before shared state."""
        from bot import _load_call_metadata

        metadata = {"ws_token": "local-token", "call_type": "check-in"}
        session_state = {"_call_metadata": {"CAlocal": metadata}}

        with patch("lib.redis_client.get_shared_state") as mock_shared:
            loaded = await _load_call_metadata("CAlocal", session_state)

        assert loaded is metadata
        mock_shared.assert_not_called()

    @pytest.mark.asyncio
    async def test_bot_loads_metadata_from_encrypted_shared_state(self, monkeypatch):
        """WebSocket setup should recover metadata when local call map misses."""
        from bot import _load_call_metadata
        from lib.shared_state_phi import encode_phi_payload

        enable_test_encryption(monkeypatch)
        payload = encode_phi_payload({"ws_token": "token-123", "call_type": "check-in"})

        class FakeRedisState:
            async def get(self, key):
                assert key == "call_metadata:CAredis"
                return payload

            is_shared = True

        session_state = {"_call_metadata": {}}
        with patch("lib.redis_client.get_shared_state", return_value=FakeRedisState()):
            metadata = await _load_call_metadata("CAredis", session_state)

        assert metadata["ws_token"] == "token-123"
        assert session_state["_call_metadata"]["CAredis"] == metadata

    @pytest.mark.asyncio
    async def test_voice_metadata_persisted_encrypted_and_recovered_from_shared_state(self, monkeypatch):
        """Call metadata written for multi-instance routing should be encrypted."""
        from api.routes import call_context
        from lib.encryption import decrypt_json

        enable_test_encryption(monkeypatch)
        state = FakeSharedState()
        metadata = {
            "senior": {"id": "senior-1"},
            "memory_context": "Known routine context.",
            "call_type": "check-in",
            "ws_token": "token-abc",
        }

        call_context.call_metadata.clear()
        try:
            with patch("lib.redis_client.get_shared_state", return_value=state):
                await call_context._persist_metadata("CAencrypted", metadata)

                encrypted = state.data["call_metadata:CAencrypted"]
                assert isinstance(encrypted, str)
                assert encrypted.startswith("enc:")
                assert decrypt_json(encrypted)["memory_context"] == "Known routine context."

                loaded = await call_context.get_call_metadata("CAencrypted")

            assert loaded["senior"]["id"] == "senior-1"
            assert loaded["memory_context"] == "Known routine context."
            assert call_context.call_metadata["CAencrypted"] == loaded
        finally:
            call_context.call_metadata.clear()

    def test_call_metadata_cleanup_removes_expired_local_entries(self):
        from api.routes import call_context

        now = time.time()
        call_context.call_metadata.clear()
        try:
            call_context.call_metadata["expired"] = {"call_metadata_expires_at": now - 1}
            call_context.call_metadata["active"] = {"call_metadata_expires_at": now + 60}

            cleaned = call_context.cleanup_expired_call_metadata(now)

            assert cleaned == 1
            assert "expired" not in call_context.call_metadata
            assert "active" in call_context.call_metadata
        finally:
            call_context.call_metadata.clear()

    @pytest.mark.asyncio
    async def test_bot_metadata_missing_without_shared_state(self):
        """Missing metadata should stay missing when Redis is not configured."""
        from bot import _load_call_metadata

        class FakeInMemoryState:
            pass

        session_state = {"_call_metadata": {}}
        with patch("lib.redis_client.get_shared_state", return_value=FakeInMemoryState()):
            metadata = await _load_call_metadata("CAmissing", session_state)

        assert metadata == {}

    @pytest.mark.asyncio
    async def test_inbound_unknown_telnyx_caller_uses_onboarding_and_starts_stream(self):
        """Unknown inbound callers should answer as onboarding prospects and start media."""
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        prospect = {"id": "prospect-1", "phone": "4078856316", "call_count": 0}
        call_metadata.clear()

        try:
            with patch("services.seniors.find_by_phone", new=AsyncMock(return_value=None)), \
                 patch("services.seniors.find_any_by_phone", new=AsyncMock(return_value=None)), \
                 patch("services.prospects.find_by_phone", new=AsyncMock(return_value=None)), \
                 patch("services.prospects.create", new=AsyncMock(return_value=prospect)) as mock_create_prospect, \
                 patch("services.conversations.create", new=AsyncMock(return_value={"id": "conv-1"})) as mock_create_conversation, \
                 patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_telnyx_post", new=AsyncMock(return_value={})) as mock_post, \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start_stream:
                await telnyx._handle_call_initiated(
                    {
                        "call_control_id": "v3:unknown-caller",
                        "from": "+14078856316",
                        "to": "+15551234567",
                    }
                )

                metadata = call_metadata["v3:unknown-caller"]
                assert metadata["senior"] is None
                assert metadata["call_type"] == "onboarding"
                assert metadata["prospect_id"] == "prospect-1"
                assert metadata["conversation_id"] == "conv-1"
                assert metadata["telnyx_context_ready"] is True
                assert mock_post.await_args.args[0].endswith("/actions/answer")

                await telnyx._handle_call_answered("v3:unknown-caller")

            mock_create_prospect.assert_awaited_once_with("+14078856316")
            mock_create_conversation.assert_awaited_once_with(None, "v3:unknown-caller", prospect_id="prospect-1", direction="inbound")
            mock_start_stream.assert_awaited_once_with("v3:unknown-caller", metadata["ws_token"])
            assert call_metadata["v3:unknown-caller"]["telnyx_stream_started"] is True
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_inbound_inactive_telnyx_senior_hangs_up_without_onboarding(self):
        """Inactive known seniors should not be treated as new prospects."""
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        inactive_senior = {"id": "senior-inactive", "phone": "4078856316", "is_active": False}
        call_metadata.clear()

        try:
            with patch("services.seniors.find_by_phone", new=AsyncMock(return_value=None)), \
                 patch("services.seniors.find_any_by_phone", new=AsyncMock(return_value=inactive_senior)), \
                 patch("services.prospects.create", new=AsyncMock()) as mock_create_prospect, \
                 patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_telnyx_post", new=AsyncMock(return_value={})) as mock_post:
                await telnyx._handle_call_initiated(
                    {
                        "call_control_id": "v3:inactive-caller",
                        "from": "+14078856316",
                        "to": "+15551234567",
                    }
                )

            assert "v3:inactive-caller" not in call_metadata
            assert mock_post.await_args.args[0].endswith("/actions/hangup")
            mock_create_prospect.assert_not_awaited()
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_outbound_call_seeds_metadata_before_context_hydration(self, monkeypatch):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        monkeypatch.setenv("TELNYX_ANSWERING_MACHINE_DETECTION", "premium")
        senior = {
            "id": "senior-1",
            "name": "Test Senior",
            "phone": "+15557654321",
            "timezone": "America/Chicago",
            "call_settings": {},
        }
        call_metadata.clear()

        try:
            with patch("services.seniors.get_by_id", new=AsyncMock(return_value=senior)), \
                 patch.object(telnyx, "_telnyx_event_url", return_value="https://pipecat.example.test/telnyx/events"), \
                 patch.object(telnyx, "_telnyx_post", new=AsyncMock(return_value={"data": {"call_control_id": "v3:test-call"}})) as mock_post, \
                 patch.object(telnyx, "_prepare_reminder_context", new=AsyncMock(return_value=(None, None))), \
                 patch.object(telnyx, "_store_senior_metadata", new=AsyncMock(return_value={})) as mock_store:
                result = await telnyx.create_telnyx_outbound_call(
                    telnyx.TelnyxOutboundCallRequest(seniorId="senior-1", callType="check-in")
                )

            dial_payload = mock_post.await_args.args[1]
            metadata = call_metadata["v3:test-call"]

            assert result["callSid"] == "v3:test-call"
            assert "stream_url" not in dial_payload
            assert "stream_auth_token" not in dial_payload
            assert dial_payload["answering_machine_detection"] == "premium"
            assert metadata["telnyx_start_stream_after_answer"] is True
            assert metadata["telnyx_context_ready"] is False
            assert metadata["telnyx_answered"] is False
            assert metadata["telnyx_amd_enabled"] is True
            assert metadata["telnyx_amd_mode"] == "premium"
            assert metadata["telnyx_amd_status"] == "pending"
            assert metadata["telnyx_voicemail_detected"] is False
            assert metadata["senior"]["id"] == "senior-1"
            mock_store.assert_awaited_once()
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_prewarm_telnyx_outbound_context_returns_hydrated_payload(self):
        from api.routes import telnyx

        senior = {
            "id": "senior-1",
            "name": "Test Senior",
            "phone": "+15557654321",
            "timezone": "America/Chicago",
            "call_settings": {},
        }
        seed = {
            "memory_context": "Warm memory",
            "pre_generated_greeting": "Hi there",
            "previous_calls_summary": "Previous summary",
            "recent_turns": "Recent turns",
            "news_context": "Fresh news",
        }
        hydrated = {
            "memory_context": "Warm memory",
            "pre_generated_greeting": "Hi there",
            "news_context": "Fresh news",
            "recent_turns": "Recent turns",
            "previous_calls_summary": "Previous summary",
            "todays_context": "Today",
            "last_call_analysis": {"summary": "Yesterday"},
            "call_settings": {"preferred_call_window": "morning"},
            "has_caregiver_notes": True,
            "caregiver_notes_content": [{"note": "Bring water"}],
        }

        with patch("services.seniors.get_by_id", new=AsyncMock(return_value=senior)), \
             patch.object(telnyx, "_cached_senior_context_seed", return_value=(seed, True)), \
             patch.object(telnyx, "_hydrate_senior_call_context", new=AsyncMock(return_value=hydrated)):
            payload = await telnyx.prewarm_telnyx_outbound_context(
                telnyx.TelnyxOutboundCallRequest(
                    seniorId="senior-1",
                    callType="reminder",
                    reminderId="reminder-1",
                    scheduledFor=datetime.now(timezone.utc),
                )
            )

        assert payload["seniorId"] == "senior-1"
        assert payload["callType"] == "reminder"
        assert payload["contextSeedSource"] == "context_cache"
        assert payload["hydratedContext"]["memoryContext"] == "Warm memory"
        assert payload["hydratedContext"]["todaysContext"] == "Today"
        assert payload["hydratedContext"]["caregiverNotesContent"] == [{"note": "Bring water"}]

    @pytest.mark.asyncio
    async def test_outbound_call_uses_valid_prewarmed_context(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        senior = {
            "id": "senior-1",
            "name": "Test Senior",
            "phone": "+15557654321",
            "timezone": "America/Chicago",
            "call_settings": {},
        }
        scheduled_for = datetime.now(timezone.utc)
        prewarmed_context = {
            "version": 1,
            "seniorId": "senior-1",
            "callType": "reminder",
            "reminderId": "reminder-1",
            "scheduledFor": scheduled_for.isoformat(),
            "warmedAt": scheduled_for.isoformat(),
            "expiresAt": (scheduled_for + timedelta(minutes=5)).isoformat(),
            "contextSeedSource": "context_cache",
            "hydratedContext": {
                "memoryContext": "Warm memory",
                "preGeneratedGreeting": "Hi there",
                "newsContext": "Fresh news",
                "recentTurns": "Recent turns",
                "previousCallsSummary": "Previous summary",
                "todaysContext": "Today",
                "lastCallAnalysis": {"summary": "Yesterday"},
                "callSettings": {"preferred_call_window": "morning"},
                "caregiverNotesContent": [],
            },
        }
        call_metadata.clear()

        try:
            with patch("services.seniors.get_by_id", new=AsyncMock(return_value=senior)), \
                 patch.object(telnyx, "_telnyx_event_url", return_value="https://pipecat.example.test/telnyx/events"), \
                 patch.object(telnyx, "_telnyx_post", new=AsyncMock(return_value={"data": {"call_control_id": "v3:test-call"}})), \
                 patch.object(telnyx, "_prepare_reminder_context", new=AsyncMock(return_value=(None, None))), \
                 patch.object(telnyx, "_store_senior_metadata", new=AsyncMock(return_value={})) as mock_store:
                await telnyx.create_telnyx_outbound_call(
                    telnyx.TelnyxOutboundCallRequest(
                        seniorId="senior-1",
                        callType="reminder",
                        reminderId="reminder-1",
                        scheduledFor=scheduled_for,
                        prewarmedContext=prewarmed_context,
                    )
                )

            metadata = call_metadata["v3:test-call"]
            assert metadata["memory_context"] == "Warm memory"
            assert metadata["telnyx_context_seed_source"] == "prewarmed:context_cache"
            assert mock_store.await_args.kwargs["prewarmed_hydrated_context"]["todays_context"] == "Today"
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_handle_call_answered_waits_for_context_before_starting_stream(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": False,
            "telnyx_context_ready": False,
            "telnyx_stream_started": False,
        }

        try:
            with patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start:
                await telnyx._handle_call_answered("v3:test-call")

            assert call_metadata["v3:test-call"]["telnyx_answered"] is True
            assert call_metadata["v3:test-call"]["telnyx_stream_started"] is False
            mock_start.assert_not_awaited()
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_handle_call_answered_waits_for_amd_before_starting_stream(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": False,
            "telnyx_context_ready": True,
            "telnyx_stream_started": False,
            "telnyx_amd_enabled": True,
            "telnyx_amd_status": "pending",
        }

        try:
            with patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start:
                await telnyx._handle_call_answered("v3:test-call")

            assert call_metadata["v3:test-call"]["telnyx_answered"] is True
            assert call_metadata["v3:test-call"]["telnyx_stream_started"] is False
            mock_start.assert_not_awaited()
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_machine_detection_human_result_starts_stream(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": True,
            "telnyx_context_ready": True,
            "telnyx_stream_started": False,
            "telnyx_amd_enabled": True,
            "telnyx_amd_status": "pending",
        }

        try:
            with patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start:
                await telnyx._handle_machine_detection_event(
                    "v3:test-call",
                    "call.machine.premium.detection.ended",
                    {"result": "human_residence"},
                )

            metadata = call_metadata["v3:test-call"]
            assert metadata["telnyx_amd_status"] == "human"
            assert metadata["telnyx_stream_started"] is True
            mock_start.assert_awaited_once_with("v3:test-call", "token-123")
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_machine_detection_leaves_short_voicemail_without_starting_stream(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": True,
            "telnyx_context_ready": True,
            "telnyx_stream_started": False,
            "telnyx_amd_enabled": True,
            "telnyx_amd_status": "pending",
        }

        try:
            with patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start, \
                 patch.object(telnyx, "_speak_telnyx_voicemail", new=AsyncMock()) as mock_speak:
                await telnyx._handle_machine_detection_event(
                    "v3:test-call",
                    "call.machine.premium.greeting.ended",
                    {"result": "beep_detected"},
                )

            metadata = call_metadata["v3:test-call"]
            assert metadata["telnyx_amd_status"] == "machine"
            assert metadata["telnyx_voicemail_detected"] is True
            assert metadata["telnyx_start_stream_after_answer"] is False
            assert metadata["telnyx_voicemail_message_started"] is True
            mock_start.assert_not_awaited()
            mock_speak.assert_awaited_once_with("v3:test-call")
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_voicemail_speak_ended_hangs_up(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "telephony_provider": "telnyx",
            "telnyx_voicemail_detected": True,
            "telnyx_voicemail_message_started": True,
        }

        try:
            with patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_hangup_telnyx_call", new=AsyncMock()) as mock_hangup:
                await telnyx._handle_speak_ended("v3:test-call", {"result": "ok"})

            assert call_metadata["v3:test-call"]["telnyx_voicemail_hangup_started"] is True
            mock_hangup.assert_awaited_once_with("v3:test-call")
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_store_senior_metadata_starts_stream_when_answer_already_received(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        senior = {
            "id": "senior-1",
            "name": "Test Senior",
            "phone": "+15557654321",
            "timezone": "America/Chicago",
            "call_settings": {},
        }
        hydrated = {
            "memory_context": "Known routine context",
            "pre_generated_greeting": "Hi there",
            "news_context": "Fresh news",
            "recent_turns": "Recent turns",
            "previous_calls_summary": "Previous summary",
            "todays_context": "Today",
            "last_call_analysis": {"summary": "Yesterday"},
            "call_settings": {"preferred_call_window": "morning"},
            "has_caregiver_notes": False,
            "caregiver_notes_content": [],
        }

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "senior": senior,
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": True,
            "telnyx_context_ready": False,
            "telnyx_stream_started": False,
            "telnyx_outbound_seeded_at": time.time(),
        }

        try:
            with patch.object(telnyx, "_hydrate_senior_call_context", new=AsyncMock(return_value=hydrated)), \
                 patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start, \
                 patch("services.conversations.create", new=AsyncMock(return_value={"id": "conv-1"})):
                metadata = await telnyx._store_senior_metadata(
                    call_control_id="v3:test-call",
                    senior=senior,
                    is_outbound=True,
                    call_type="check-in",
                    target_phone="+15557654321",
                    ws_token="token-123",
                    start_stream_after_answer=True,
                )

            assert metadata["telnyx_context_ready"] is True
            assert metadata["conversation_id"] == "conv-1"
            assert call_metadata["v3:test-call"]["telnyx_stream_started"] is True
            mock_start.assert_awaited_once_with("v3:test-call", "token-123")
        finally:
            call_metadata.clear()

    @pytest.mark.asyncio
    async def test_store_senior_metadata_uses_prewarmed_context_without_live_hydration(self):
        from api.routes import telnyx
        from api.routes.call_context import call_metadata

        senior = {
            "id": "senior-1",
            "name": "Test Senior",
            "phone": "+15557654321",
            "timezone": "America/Chicago",
            "call_settings": {},
        }
        hydrated = {
            "memory_context": "Warm memory",
            "pre_generated_greeting": "Hi there",
            "news_context": "Fresh news",
            "recent_turns": "Recent turns",
            "previous_calls_summary": "Previous summary",
            "todays_context": "Today",
            "last_call_analysis": {"summary": "Yesterday"},
            "call_settings": {"preferred_call_window": "morning"},
            "has_caregiver_notes": False,
            "caregiver_notes_content": [],
        }

        call_metadata.clear()
        call_metadata["v3:test-call"] = {
            "senior": senior,
            "ws_token": "token-123",
            "ws_token_expires_at": time.time() + 300,
            "ws_token_consumed": False,
            "telephony_provider": "telnyx",
            "telnyx_start_stream_after_answer": True,
            "telnyx_answered": True,
            "telnyx_context_ready": False,
            "telnyx_stream_started": False,
            "telnyx_outbound_seeded_at": time.time(),
        }

        try:
            with patch.object(telnyx, "_hydrate_senior_call_context", new=AsyncMock()) as mock_hydrate, \
                 patch.object(telnyx, "_persist_metadata", new=AsyncMock()), \
                 patch.object(telnyx, "_start_telnyx_stream", new=AsyncMock()) as mock_start, \
                 patch("services.conversations.create", new=AsyncMock(return_value={"id": "conv-1"})):
                metadata = await telnyx._store_senior_metadata(
                    call_control_id="v3:test-call",
                    senior=senior,
                    is_outbound=True,
                    call_type="reminder",
                    target_phone="+15557654321",
                    ws_token="token-123",
                    start_stream_after_answer=True,
                    prewarmed_hydrated_context=hydrated,
                )

            assert metadata["memory_context"] == "Warm memory"
            assert metadata["conversation_id"] == "conv-1"
            mock_hydrate.assert_not_awaited()
            mock_start.assert_awaited_once_with("v3:test-call", "token-123")
        finally:
            call_metadata.clear()



class TestCallsEndpointAuth:
    def test_list_calls_requires_auth(self, client):
        """GET /api/calls should require admin auth."""
        response = client.get("/api/calls")
        assert response.status_code == 401

    def test_initiate_call_requires_auth(self, client):
        """POST /api/call should require auth."""
        response = client.post(
            "/api/call",
            json={"seniorId": "senior-test"},
        )
        assert response.status_code == 401

    def test_end_call_requires_auth(self, client):
        """POST /api/calls/:sid/end should require admin auth."""
        response = client.post("/api/calls/CA123/end")
        assert response.status_code == 401
