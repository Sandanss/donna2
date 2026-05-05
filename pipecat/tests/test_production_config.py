"""Production security configuration tests."""

import base64

from config import Settings, validate_production_config


def _valid_field_key() -> str:
    return base64.urlsafe_b64encode(b"k" * 32).decode().rstrip("=")


def _set_valid_production_env(monkeypatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("JWT_SECRET", "not-the-default-secret")
    monkeypatch.setenv("DONNA_API_KEYS", "node:test-node-key")
    monkeypatch.setenv("FIELD_ENCRYPTION_KEY", _valid_field_key())
    monkeypatch.setenv("TELEPHONY_PROVIDER", "telnyx")
    monkeypatch.setenv("TELNYX_STREAM_CODEC", "L16")
    monkeypatch.setenv("TELNYX_STREAM_SAMPLE_RATE", "16000")
    monkeypatch.setenv("TELNYX_API_KEY", "test-telnyx-key")
    monkeypatch.setenv("TELNYX_PUBLIC_KEY", "test-public-key")
    monkeypatch.setenv("TELNYX_PHONE_NUMBER", "+15551234567")
    monkeypatch.setenv("TELNYX_CONNECTION_ID", "test-connection")
    monkeypatch.setenv("PIPECAT_PUBLIC_URL", "https://pipecat.example.test")
    monkeypatch.setenv("TTS_PROVIDER", "elevenlabs")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-key")
    monkeypatch.setenv("DEEPGRAM_API_KEY", "deepgram-key")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "elevenlabs-key")
    monkeypatch.setenv("GOOGLE_API_KEY", "google-key")


def test_production_config_blocks_gemini_live_backend(monkeypatch):
    _set_valid_production_env(monkeypatch)
    monkeypatch.setenv("VOICE_BACKEND", "gemini_live")

    errors = validate_production_config()

    assert "VOICE_BACKEND=gemini_live is not allowed in production" in errors


def test_production_config_requires_selected_cartesia_key(monkeypatch):
    _set_valid_production_env(monkeypatch)
    monkeypatch.setenv("TTS_PROVIDER", "cartesia")
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)

    errors = validate_production_config()

    assert "CARTESIA_API_KEY is required when TTS_PROVIDER=cartesia" in errors


def test_production_voice_backend_flag_falls_back_to_claude(monkeypatch):
    from bot import resolve_voice_backend

    monkeypatch.setenv("ENVIRONMENT", "production")
    cfg = Settings(voice_backend="")

    backend = resolve_voice_backend(cfg, {"_flags": {"voice_backend": "gemini_live"}})

    assert backend == "claude"


def test_non_production_can_select_gemini_live(monkeypatch):
    from bot import resolve_voice_backend

    monkeypatch.delenv("ENVIRONMENT", raising=False)
    monkeypatch.delenv("RAILWAY_PUBLIC_DOMAIN", raising=False)
    cfg = Settings(voice_backend="gemini_live")

    backend = resolve_voice_backend(cfg, {"_flags": {"voice_backend": "claude"}})

    assert backend == "gemini_live"
