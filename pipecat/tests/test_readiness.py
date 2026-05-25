"""Tests for the Phase 3 replica readiness gate.

These tests exercise the orchestration logic with stub check fns; the
individual vendor-touching checks (Anthropic / Deepgram / TTS) are not
exercised against real vendors in unit tests — they're covered by the
``READINESS_REQUIRE_*`` switch-off path here so dev/CI doesn't burn vendor
quota on every test run.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from services import readiness


@pytest.mark.asyncio
async def test_prepare_for_traffic_flips_ready_when_all_required_pass(monkeypatch):
    """Happy path: all required checks pass → set_ready(True), report.ready True."""

    async def ok_check() -> readiness.CheckResult:
        return True, None

    async def ok_pool(_n: int) -> readiness.CheckResult:
        return True, None

    monkeypatch.setattr(readiness, "check_db_pool_warm", ok_pool)
    monkeypatch.setattr(readiness, "check_growthbook_loaded", ok_check)
    monkeypatch.setattr(readiness, "check_anthropic_prompt_cache_primer", ok_check)
    monkeypatch.setattr(readiness, "check_deepgram_session", ok_check)
    monkeypatch.setattr(readiness, "check_tts_session", ok_check)
    monkeypatch.setattr(readiness, "check_circuit_breakers_closed", ok_check)

    captured = {"ready": None, "report": None}

    def set_ready(value: bool) -> None:
        captured["ready"] = value

    def set_report(report: readiness.ReadinessReport) -> None:
        captured["report"] = report

    report = await readiness.prepare_for_traffic(set_ready=set_ready, set_report=set_report)

    assert captured["ready"] is True
    assert report.ready is True
    assert {c.name for c in report.checks} == {
        "db_pool_warm",
        "growthbook_loaded",
        "anthropic_prompt_cache_primer",
        "deepgram_session",
        "tts_session",
        "circuit_breakers_closed",
    }
    assert all(c.ok for c in report.checks)
    assert captured["report"] is report


@pytest.mark.asyncio
async def test_prepare_for_traffic_required_check_failure_blocks_ready(monkeypatch):
    """A failing required check keeps set_ready(False); ready flag is never flipped True."""

    async def ok_check() -> readiness.CheckResult:
        return True, None

    async def ok_pool(_n: int) -> readiness.CheckResult:
        return True, None

    async def failing_check() -> readiness.CheckResult:
        return False, "vendor_unreachable"

    monkeypatch.setattr(readiness, "check_db_pool_warm", ok_pool)
    monkeypatch.setattr(readiness, "check_growthbook_loaded", ok_check)
    monkeypatch.setattr(readiness, "check_anthropic_prompt_cache_primer", failing_check)
    monkeypatch.setattr(readiness, "check_deepgram_session", ok_check)
    monkeypatch.setattr(readiness, "check_tts_session", ok_check)
    monkeypatch.setattr(readiness, "check_circuit_breakers_closed", ok_check)

    captured = {"ready": None}

    def set_ready(value: bool) -> None:
        captured["ready"] = value

    report = await readiness.prepare_for_traffic(
        set_ready=set_ready,
        require_prompt_cache_primer=True,
    )

    assert captured["ready"] is False
    assert report.ready is False
    failing = next(c for c in report.checks if c.name == "anthropic_prompt_cache_primer")
    assert failing.ok is False
    assert failing.error == "vendor_unreachable"


@pytest.mark.asyncio
async def test_prepare_for_traffic_non_required_failure_does_not_block(monkeypatch):
    """A failing non-required check must NOT block the gate."""

    async def ok_check() -> readiness.CheckResult:
        return True, None

    async def ok_pool(_n: int) -> readiness.CheckResult:
        return True, None

    async def failing_check() -> readiness.CheckResult:
        return False, "tts_bad_credentials"

    monkeypatch.setattr(readiness, "check_db_pool_warm", ok_pool)
    monkeypatch.setattr(readiness, "check_growthbook_loaded", ok_check)
    monkeypatch.setattr(readiness, "check_anthropic_prompt_cache_primer", ok_check)
    monkeypatch.setattr(readiness, "check_deepgram_session", ok_check)
    monkeypatch.setattr(readiness, "check_tts_session", failing_check)
    monkeypatch.setattr(readiness, "check_circuit_breakers_closed", ok_check)

    captured = {"ready": None}

    def set_ready(value: bool) -> None:
        captured["ready"] = value

    report = await readiness.prepare_for_traffic(
        set_ready=set_ready,
        require_tts_session=False,
    )

    assert captured["ready"] is True
    assert report.ready is True
    tts = next(c for c in report.checks if c.name == "tts_session")
    assert tts.required is False
    assert tts.ok is False


@pytest.mark.asyncio
async def test_check_timeout_yields_phi_free_error(monkeypatch):
    """A check that exceeds the per-check timeout reports TimeoutError, not the body of the exception."""

    async def slow_check() -> readiness.CheckResult:
        await asyncio.sleep(1.0)
        return True, None

    async def ok_check() -> readiness.CheckResult:
        return True, None

    async def ok_pool(_n: int) -> readiness.CheckResult:
        return True, None

    monkeypatch.setattr(readiness, "check_db_pool_warm", ok_pool)
    monkeypatch.setattr(readiness, "check_growthbook_loaded", ok_check)
    monkeypatch.setattr(readiness, "check_anthropic_prompt_cache_primer", slow_check)
    monkeypatch.setattr(readiness, "check_deepgram_session", ok_check)
    monkeypatch.setattr(readiness, "check_tts_session", ok_check)
    monkeypatch.setattr(readiness, "check_circuit_breakers_closed", ok_check)

    captured = {"ready": None}

    def set_ready(value: bool) -> None:
        captured["ready"] = value

    report = await readiness.prepare_for_traffic(
        set_ready=set_ready,
        timeout_seconds=0.05,
    )

    assert captured["ready"] is False
    primer = next(c for c in report.checks if c.name == "anthropic_prompt_cache_primer")
    assert primer.ok is False
    assert primer.error == "TimeoutError"


@pytest.mark.asyncio
async def test_check_raising_exception_yields_class_name_only(monkeypatch):
    """A check that raises returns the exception class name, never the message."""

    class CredentialsLeak(RuntimeError):
        pass

    async def leaky() -> readiness.CheckResult:
        raise CredentialsLeak("anthropic key sk-ant-xxxxxx invalid for senior 1234")

    async def ok_check() -> readiness.CheckResult:
        return True, None

    async def ok_pool(_n: int) -> readiness.CheckResult:
        return True, None

    monkeypatch.setattr(readiness, "check_db_pool_warm", ok_pool)
    monkeypatch.setattr(readiness, "check_growthbook_loaded", ok_check)
    monkeypatch.setattr(readiness, "check_anthropic_prompt_cache_primer", leaky)
    monkeypatch.setattr(readiness, "check_deepgram_session", ok_check)
    monkeypatch.setattr(readiness, "check_tts_session", ok_check)
    monkeypatch.setattr(readiness, "check_circuit_breakers_closed", ok_check)

    captured = {"ready": None}

    def set_ready(value: bool) -> None:
        captured["ready"] = value

    report = await readiness.prepare_for_traffic(set_ready=set_ready)
    primer = next(c for c in report.checks if c.name == "anthropic_prompt_cache_primer")
    assert primer.ok is False
    assert primer.error == "CredentialsLeak"
    # Critical: the exception message must NOT leak into the result.
    for c in report.checks:
        assert c.error is None or "sk-ant" not in (c.error or "")
        assert c.error is None or "senior" not in (c.error or "")


@pytest.mark.asyncio
async def test_circuit_breaker_check_uses_real_registry():
    """check_circuit_breakers_closed reads the live registry; with no open breakers it passes."""
    # No setup needed — the test process should have no open breakers by default.
    ok, err = await readiness.check_circuit_breakers_closed()
    assert ok is True
    assert err is None


@pytest.mark.asyncio
async def test_growthbook_check_passes_when_not_configured(monkeypatch):
    """If GrowthBook env vars aren't set, the check returns ok=True (dev/CI path)."""
    import lib.growthbook as gb

    monkeypatch.setattr(gb, "is_configured", lambda: False)
    monkeypatch.setattr(gb, "is_loaded", lambda: False)

    ok, err = await readiness.check_growthbook_loaded()
    assert ok is True
    assert err is None


@pytest.mark.asyncio
async def test_report_to_dict_is_serializable():
    """ReadinessReport.to_dict produces a JSON-serializable structure for /health."""
    import json

    report = readiness.ReadinessReport(
        ready=True,
        total_latency_ms=123,
        checks=[
            readiness.ReadinessCheckResult(name="db_pool_warm", ok=True, latency_ms=10),
            readiness.ReadinessCheckResult(
                name="tts_session", ok=False, latency_ms=5, required=False, error="TimeoutError"
            ),
        ],
    )
    payload = report.to_dict()
    serialized = json.dumps(payload)
    parsed = json.loads(serialized)
    assert parsed["ready"] is True
    assert parsed["total_latency_ms"] == 123
    assert parsed["checks"][1]["error"] == "TimeoutError"
    assert parsed["checks"][1]["required"] is False
