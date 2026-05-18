"""Tests for TTS provider selection via feature flags."""

from __future__ import annotations

import os
from unittest.mock import patch

import pytest


@pytest.fixture
def cartesia_env():
    """Set up env vars for Cartesia."""
    with patch.dict(os.environ, {
        "CARTESIA_API_KEY": "test-cartesia-key",
        "CARTESIA_VOICE_ID": "test-voice-id",
        "ELEVENLABS_API_KEY": "test-elevenlabs-key",
        "ELEVENLABS_VOICE_ID": "test-elevenlabs-voice",
    }):
        yield


def test_returns_elevenlabs_when_flag_is_elevenlabs(cartesia_env):
    """Flag set to elevenlabs selects ElevenLabs."""
    from bot import create_tts_service
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

    session_state = {"_flags": {"tts_provider": "elevenlabs"}}
    tts = create_tts_service(session_state)
    assert isinstance(tts, ElevenLabsTTSService)


def test_returns_cartesia_when_flag_is_cartesia(cartesia_env):
    """Flag set to cartesia selects Cartesia."""
    from bot import create_tts_service
    from pipecat.services.cartesia.tts import CartesiaTTSService

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    assert isinstance(tts, CartesiaTTSService)


def test_falls_back_to_elevenlabs_when_no_cartesia_key(cartesia_env):
    """Missing Cartesia API key falls back to ElevenLabs."""
    from bot import create_tts_service
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

    with patch.dict(os.environ, {"CARTESIA_API_KEY": ""}):
        session_state = {"_flags": {"tts_provider": "cartesia"}}
        tts = create_tts_service(session_state)
        assert isinstance(tts, ElevenLabsTTSService)


def test_defaults_to_elevenlabs_when_no_flags(cartesia_env):
    """No flags resolved defaults to ElevenLabs (default provider)."""
    from bot import create_tts_service
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

    session_state = {}  # No _flags key
    tts = create_tts_service(session_state)
    assert isinstance(tts, ElevenLabsTTSService)
    assert tts._init_sample_rate == 44100
    assert tts.model_name == "eleven_flash_v2_5"


def test_blank_elevenlabs_model_uses_flash_default(cartesia_env):
    """Blank ELEVENLABS_MODEL keeps the Flash v2.5 default."""
    from bot import create_tts_service

    with patch.dict(os.environ, {"ELEVENLABS_MODEL": ""}):
        session_state = {"_flags": {"tts_provider": "elevenlabs"}}
        tts = create_tts_service(session_state)

    assert tts.model_name == "eleven_flash_v2_5"


def test_cartesia_uses_default_encoding(cartesia_env):
    """Cartesia uses pcm_s16le encoding so the serializer owns final telephony framing."""
    from bot import create_tts_service
    from pipecat.services.cartesia.tts import CartesiaTTSService

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    assert isinstance(tts, CartesiaTTSService)
    assert tts._settings["output_format"]["encoding"] == "pcm_s16le"
    assert tts._init_sample_rate == 48000


def test_cartesia_uses_sonic3_model(cartesia_env):
    """Cartesia uses sonic-3 model."""
    from bot import create_tts_service

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    assert tts.model_name == "sonic-3"


def test_cartesia_speed_configured(cartesia_env):
    """Cartesia generation config keeps non-phone calls slightly faster."""
    from bot import create_tts_service

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    gen_config = tts._settings.get("generation_config")
    assert gen_config is not None
    assert gen_config.speed == 1.05


def test_elevenlabs_speed_configured_for_senior_pacing(cartesia_env):
    """ElevenLabs uses slower pacing for senior calls."""
    from bot import create_tts_service

    session_state = {"_flags": {"tts_provider": "elevenlabs"}}
    tts = create_tts_service(session_state)

    assert tts._settings["speed"] == 0.85


def test_audio_profile_prefers_cartesia_48k_and_16k_input(cartesia_env):
    """Cartesia keeps 48kHz audio internally and uses 16kHz for telephony/STT input."""
    from bot import get_audio_profile

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    profile = get_audio_profile(session_state)

    assert profile["tts_provider"] == "cartesia"
    assert profile["audio_in_sample_rate"] == 16000
    assert profile["audio_out_sample_rate"] == 48000


def test_audio_profile_uses_telnyx_native_rate_for_cartesia_phone_calls(cartesia_env):
    """Telnyx phone calls request native 16k TTS to keep output frames stable."""
    from bot import get_audio_profile

    with patch.dict(os.environ, {"TELNYX_STREAM_CODEC": "L16", "TELNYX_STREAM_SAMPLE_RATE": "16000"}):
        session_state = {
            "_flags": {"tts_provider": "cartesia"},
            "_transport_type": "telnyx",
        }
        profile = get_audio_profile(session_state)

    assert profile["tts_provider"] == "cartesia"
    assert profile["audio_in_sample_rate"] == 16000
    assert profile["audio_out_sample_rate"] == 16000


def test_cartesia_uses_lower_volume_for_telnyx(cartesia_env):
    """Telnyx phone output uses a less aggressive TTS level to avoid clipping."""
    from bot import create_tts_service

    with patch.dict(os.environ, {"TELNYX_STREAM_CODEC": "L16", "TELNYX_STREAM_SAMPLE_RATE": "16000"}):
        session_state = {
            "_flags": {"tts_provider": "cartesia"},
            "_transport_type": "telnyx",
        }
        tts = create_tts_service(session_state)
    gen_config = tts._settings.get("generation_config")

    assert tts._init_sample_rate == 16000
    assert gen_config.speed == 0.94
    assert gen_config.volume == 0.9


def test_cartesia_uses_16k_for_telnyx_l16(cartesia_env):
    """Cartesia uses the Telnyx native rate for phone calls."""
    from bot import create_tts_service

    with patch.dict(os.environ, {"TELNYX_STREAM_CODEC": "L16", "TELNYX_STREAM_SAMPLE_RATE": "16000"}):
        session_state = {
            "_flags": {"tts_provider": "cartesia"},
            "_transport_type": "telnyx",
        }
        tts = create_tts_service(session_state)

    assert tts._init_sample_rate == 16000


def test_audio_profile_falls_back_to_elevenlabs_when_cartesia_unavailable(cartesia_env):
    """Missing Cartesia credentials fall back to the ElevenLabs audio profile."""
    from bot import get_audio_profile

    with patch.dict(os.environ, {"CARTESIA_API_KEY": ""}):
        session_state = {"_flags": {"tts_provider": "cartesia"}}
        profile = get_audio_profile(session_state)

    assert profile["tts_provider"] == "elevenlabs"
    assert profile["audio_in_sample_rate"] == 16000
    assert profile["audio_out_sample_rate"] == 44100
