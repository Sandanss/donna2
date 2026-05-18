"""VAD profile guardrails for senior-safe call handling."""

from bot import resolve_vad_params


def test_telnyx_senior_calls_use_senior_safe_vad_profile():
    profile = resolve_vad_params("telnyx", "check-in")

    assert profile == {
        "start_secs": 0.3,
        "confidence": 0.68,
        "stop_secs": 1.2,
        "min_volume": 0.5,
    }


def test_onboarding_calls_keep_shorter_pause_window():
    profile = resolve_vad_params("telnyx", "onboarding")

    assert profile == {
        "start_secs": 0.3,
        "confidence": 0.68,
        "stop_secs": 0.8,
        "min_volume": 0.5,
    }
