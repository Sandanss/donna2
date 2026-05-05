"""Production security configuration tests."""

import base64
import os

from config import (
    get_pipecat_public_url,
    get_service_api_key,
    is_valid_field_encryption_key,
    parse_service_api_keys,
    validate_production_config,
)


def _field_key() -> str:
    return base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")


def test_service_api_keys_ignore_legacy_in_production(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("DONNA_API_KEY", "legacy-key")
    monkeypatch.delenv("DONNA_API_KEYS", raising=False)

    assert parse_service_api_keys() == {}


def test_service_api_keys_allow_legacy_outside_production(monkeypatch):
    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_PUBLIC_DOMAIN", raising=False)
    monkeypatch.setenv("DONNA_API_KEY", "legacy-key")
    monkeypatch.delenv("DONNA_API_KEYS", raising=False)

    assert get_service_api_key("legacy") == "legacy-key"


def test_validate_production_config_requires_security_secrets(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("TELEPHONY_PROVIDER", "telnyx")
    for key in [
        "JWT_SECRET",
        "DONNA_API_KEYS",
        "FIELD_ENCRYPTION_KEY",
        "TELNYX_API_KEY",
        "TELNYX_PUBLIC_KEY",
        "TELNYX_PHONE_NUMBER",
        "TELNYX_CONNECTION_ID",
        "PIPECAT_PUBLIC_URL",
        "ANTHROPIC_API_KEY",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "GOOGLE_API_KEY",
    ]:
        monkeypatch.delenv(key, raising=False)

    errors = validate_production_config()

    assert any("JWT_SECRET" in err for err in errors)
    assert any("DONNA_API_KEYS" in err for err in errors)
    assert any("FIELD_ENCRYPTION_KEY" in err for err in errors)
    assert any("TELNYX_API_KEY" in err for err in errors)
    assert any("TELNYX_PUBLIC_KEY" in err for err in errors)
    assert any("TELNYX_PHONE_NUMBER" in err for err in errors)
    assert any("TELNYX_CONNECTION_ID" in err for err in errors)
    assert any("PIPECAT_PUBLIC_URL" in err for err in errors)
    assert any("ANTHROPIC_API_KEY" in err for err in errors)
    assert any("DEEPGRAM_API_KEY" in err for err in errors)
    assert any("ELEVENLABS_API_KEY" in err for err in errors)
    assert any("GOOGLE_API_KEY" in err for err in errors)


def test_validate_production_config_accepts_required_values(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("TELEPHONY_PROVIDER", "telnyx")
    monkeypatch.setenv("JWT_SECRET", "not-the-default-secret")
    monkeypatch.setenv("DONNA_API_KEYS", "pipecat:service-key")
    monkeypatch.setenv("FIELD_ENCRYPTION_KEY", _field_key())
    monkeypatch.setenv("TELNYX_API_KEY", "telnyx-token")
    monkeypatch.setenv("TELNYX_PUBLIC_KEY", "telnyx-public-key")
    monkeypatch.setenv("TELNYX_PHONE_NUMBER", "+15551234567")
    monkeypatch.setenv("TELNYX_CONNECTION_ID", "telnyx-connection")
    monkeypatch.setenv("PIPECAT_PUBLIC_URL", "https://pipecat.example.com")
    monkeypatch.setenv("TTS_PROVIDER", "elevenlabs")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "elevenlabs-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "google-key")

    assert validate_production_config() == []


def test_validate_production_config_rejects_narrowband_telnyx(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("TELEPHONY_PROVIDER", "telnyx")
    monkeypatch.setenv("JWT_SECRET", "not-the-default-secret")
    monkeypatch.setenv("DONNA_API_KEYS", "pipecat:service-key")
    monkeypatch.setenv("FIELD_ENCRYPTION_KEY", _field_key())
    monkeypatch.setenv("TELNYX_API_KEY", "telnyx-token")
    monkeypatch.setenv("TELNYX_PUBLIC_KEY", "telnyx-public-key")
    monkeypatch.setenv("TELNYX_PHONE_NUMBER", "+15551234567")
    monkeypatch.setenv("TELNYX_CONNECTION_ID", "telnyx-connection")
    monkeypatch.setenv("TELNYX_STREAM_CODEC", "PCMU")
    monkeypatch.setenv("TELNYX_STREAM_SAMPLE_RATE", "8000")
    monkeypatch.setenv("PIPECAT_PUBLIC_URL", "https://pipecat.example.com")
    monkeypatch.setenv("TTS_PROVIDER", "elevenlabs")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "elevenlabs-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "google-key")

    errors = validate_production_config()

    assert any("TELNYX_STREAM_CODEC" in err for err in errors)
    assert any("TELNYX_STREAM_SAMPLE_RATE" in err for err in errors)


def test_field_encryption_key_accepts_unpadded_base64url():
    assert is_valid_field_encryption_key(_field_key()) is True


def test_pipecat_public_url_prefers_explicit_value(monkeypatch):
    monkeypatch.setenv("PIPECAT_PUBLIC_URL", "https://pipecat.example.com/")
    monkeypatch.setenv("BASE_URL", "https://legacy.example.com")

    assert get_pipecat_public_url() == "https://pipecat.example.com"
