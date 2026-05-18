# Cartesia TTS Migration Plan

> Historical implementation plan. Do not use this as runtime source of truth.
> Current runtime source of truth is `pipecat/bot.py`, `pipecat/config.py`, and `pipecat/docs/LEARNINGS.md`.
> Superseded detail: Cartesia must output PCM (`pcm_s16le`) and defaults to 48kHz for non-phone output; active Telnyx calls request 16kHz PCM before the serializer. Do not request `pcm_mulaw` from Cartesia for phone calls.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Cartesia Sonic 3 as primary TTS with ElevenLabs as automatic fallback, controlled by a feature flag for safe rollout.

**Architecture:** A `create_tts_service()` factory in `bot.py` selects Cartesia or ElevenLabs based on a GrowthBook feature flag (`tts_provider`). If Cartesia fails to connect or errors mid-call, the factory's error handling logs the failure — but since TTS services in Pipecat don't support hot-swapping mid-pipeline, the fallback is at the flag level (flip the flag to route new calls to ElevenLabs). This gives us safe A/B testing with instant rollback.

**Tech Stack:** Pipecat `CartesiaTTSService` (WebSocket streaming, Sonic 3), GrowthBook feature flags, `pcm_mulaw` encoding at 8kHz for Twilio.

---

## Context for the Implementer

### Current State
- **TTS**: `ElevenLabsTTSService` in `pipecat/bot.py:256-261`, model `eleven_flash_v2_5`, speed 0.9
- **Config**: `elevenlabs_api_key` and `elevenlabs_voice_id` in `pipecat/config.py:43-44`
- **Feature flags**: GrowthBook integration in `pipecat/lib/growthbook.py`, resolved per-call in `bot.py:173-182`
- **Pipeline**: TTS sits at position 10 in the pipeline array (`bot.py:300`), receives TextFrames from GuidanceStripper
- **Tests**: `MockTTSProcessor` in `tests/mocks/mock_tts.py` captures TextFrames — no real audio in tests
- **Pipecat version**: 0.0.101, `CartesiaTTSService` exists at `pipecat.services.cartesia.tts`
- **Audio format**: Twilio requires mulaw 8kHz; Cartesia supports `pcm_mulaw` encoding natively

### Key Decisions
- **No mid-call fallback** — Pipecat pipelines are assembled once per call. Fallback = flag flip for next call.
- **Feature flag controls provider** — `tts_provider` flag returns `"cartesia"` or `"elevenlabs"`, defaulting to `"elevenlabs"` (safe default).
- **Same pipeline position** — Both TTS services produce the same frame types, drop-in swap.
- **Cartesia encoding** — Use `pcm_mulaw` container `raw` at 8kHz to match Twilio's `TwilioFrameSerializer`. No resampling needed.
- **Cartesia model** — `sonic-3` (latest, best quality).
- **Cartesia voice** — Cathy (`e8e5fffb-252c-436d-b842-8879b84445b6`).
- **GenerationConfig** — `speed=0.9` to match current ElevenLabs pacing for elderly users.

### Files You'll Touch
| File | Action |
|------|--------|
| `pipecat/pyproject.toml` | Add `cartesia` extra to pipecat-ai dependency |
| `pipecat/config.py` | Add `cartesia_api_key`, `cartesia_voice_id` settings |
| `pipecat/bot.py` | Add `create_tts_service()` factory, use flag to select provider |
| `pipecat/lib/growthbook.py` | Add `tts_provider` flag with `"elevenlabs"` default |
| `pipecat/tests/test_tts_factory.py` | New — unit tests for TTS provider selection |

---

## Task 1: Add Cartesia dependency

**Files:**
- Modify: `pipecat/pyproject.toml:7`

**Step 1: Update pyproject.toml**

In `pipecat/pyproject.toml`, change the pipecat-ai dependency to include the `cartesia` extra:

```toml
# Before:
"pipecat-ai[anthropic,deepgram,elevenlabs,silero,websocket,runner]>=0.0.101",

# After:
"pipecat-ai[anthropic,cartesia,deepgram,elevenlabs,silero,websocket,runner]>=0.0.101",
```

**Step 2: Install locally**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && uv sync`

Expected: cartesia package installs successfully.

**Step 3: Verify import**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -c "from pipecat.services.cartesia.tts import CartesiaTTSService; print('OK')"`

Expected: `OK`

**Step 4: Commit**

```bash
git add pipecat/pyproject.toml pipecat/uv.lock
git commit -m "deps: add cartesia TTS extra to pipecat-ai"
```

---

## Task 2: Add Cartesia config settings

**Files:**
- Modify: `pipecat/config.py:43-44` (add after elevenlabs settings)
- Modify: `pipecat/config.py:106` (add to _load_settings)

**Step 1: Add settings fields**

In the `Settings` dataclass (after line 44, the `elevenlabs_voice_id` field), add:

```python
cartesia_api_key: str = ""
cartesia_voice_id: str = "e8e5fffb-252c-436d-b842-8879b84445b6"  # Cathy
```

**Step 2: Add to _load_settings**

In the `_load_settings()` function (after the `elevenlabs_voice_id` line ~106), add:

```python
cartesia_api_key=_env("CARTESIA_API_KEY"),
cartesia_voice_id=_env("CARTESIA_VOICE_ID", "e8e5fffb-252c-436d-b842-8879b84445b6"),
```

**Step 3: Verify**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -c "from config import settings; print(f'cartesia_api_key={repr(settings.cartesia_api_key)}'); print(f'cartesia_voice_id={repr(settings.cartesia_voice_id)}')" `

Expected: Both print empty strings (no env vars set yet).

**Step 4: Commit**

```bash
git add pipecat/config.py
git commit -m "config: add Cartesia API key and voice ID settings"
```

---

## Task 3: Add `tts_provider` feature flag

**Files:**
- Modify: `pipecat/lib/growthbook.py:88-96` (add to defaults dict)

**Step 1: Add the flag**

In `resolve_flags()`, add to the `defaults` dict (after `"tts_fallback": False,` on line ~93):

```python
"tts_provider": "elevenlabs",  # "cartesia" or "elevenlabs"
```

**Step 2: Update the resolver**

The existing resolver loop already handles non-bool defaults via `get_feature_value()` — no changes needed to the loop logic. String flags are resolved by the `else` branch on line ~117.

**Step 3: Verify**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -c "
import asyncio
from lib.growthbook import resolve_flags
flags = asyncio.run(resolve_flags())
print(f'tts_provider={flags[\"tts_provider\"]!r}')
"`

Expected: `tts_provider='elevenlabs'`

**Step 4: Commit**

```bash
git add pipecat/lib/growthbook.py
git commit -m "flags: add tts_provider feature flag (default: elevenlabs)"
```

---

## Task 4: Write failing tests for TTS factory

**Files:**
- Create: `pipecat/tests/test_tts_factory.py`

**Step 1: Write the tests**

Create `pipecat/tests/test_tts_factory.py`:

```python
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
    """Default flag value selects ElevenLabs."""
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


def test_falls_back_to_elevenlabs_when_no_flags():
    """No flags resolved at all defaults to ElevenLabs."""
    from bot import create_tts_service
    from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

    with patch.dict(os.environ, {
        "ELEVENLABS_API_KEY": "test-key",
        "ELEVENLABS_VOICE_ID": "test-voice",
    }):
        session_state = {}  # No _flags key
        tts = create_tts_service(session_state)
        assert isinstance(tts, ElevenLabsTTSService)


def test_cartesia_uses_mulaw_8khz(cartesia_env):
    """Cartesia is configured for Twilio-compatible audio."""
    from bot import create_tts_service
    from pipecat.services.cartesia.tts import CartesiaTTSService

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    assert isinstance(tts, CartesiaTTSService)
    # Check the output format is configured for Twilio
    assert tts._settings["output_format"]["encoding"] == "pcm_mulaw"
    assert tts._settings["output_format"]["container"] == "raw"


def test_cartesia_uses_sonic3_model(cartesia_env):
    """Cartesia uses sonic-3 model."""
    from bot import create_tts_service

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    assert tts.model_name == "sonic-3"


def test_cartesia_speed_configured(cartesia_env):
    """Cartesia generation config has speed=0.9 for elderly pacing."""
    from bot import create_tts_service

    session_state = {"_flags": {"tts_provider": "cartesia"}}
    tts = create_tts_service(session_state)
    gen_config = tts._settings.get("generation_config")
    assert gen_config is not None
    assert gen_config.speed == 0.9
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -m pytest tests/test_tts_factory.py -v --no-header 2>&1 | tail -20`

Expected: All tests FAIL with `ImportError: cannot import name 'create_tts_service' from 'bot'`

**Step 3: Commit**

```bash
git add pipecat/tests/test_tts_factory.py
git commit -m "test: add failing tests for TTS provider factory"
```

---

## Task 5: Implement `create_tts_service()` in bot.py

**Files:**
- Modify: `pipecat/bot.py:32` (add Cartesia import)
- Modify: `pipecat/bot.py` (add factory function after imports, before `_safe_post_call`)
- Modify: `pipecat/bot.py:256-261` (replace inline ElevenLabs with factory call)

**Step 1: Add Cartesia import**

After the ElevenLabs import (line 32), add:

```python
from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig
```

**Step 2: Add factory function**

After the imports but before `_safe_post_call` (around line 48), add:

```python
def create_tts_service(session_state: dict):
    """Select TTS provider based on feature flag.

    Uses session_state["_flags"]["tts_provider"] to pick Cartesia or ElevenLabs.
    Falls back to ElevenLabs if Cartesia key is missing or flag is unset.
    """
    flags = session_state.get("_flags", {})
    provider = flags.get("tts_provider", "elevenlabs")

    if provider == "cartesia" and os.getenv("CARTESIA_API_KEY"):
        logger.info("TTS provider: Cartesia Sonic 3")
        return CartesiaTTSService(
            api_key=os.getenv("CARTESIA_API_KEY", ""),
            voice_id=os.getenv("CARTESIA_VOICE_ID", "e8e5fffb-252c-436d-b842-8879b84445b6"),
            model="sonic-3",
            encoding="pcm_mulaw",
            container="raw",
            params=CartesiaTTSService.InputParams(
                generation_config=GenerationConfig(speed=0.9),
            ),
        )

    logger.info("TTS provider: ElevenLabs")
    return ElevenLabsTTSService(
        api_key=os.getenv("ELEVENLABS_API_KEY", ""),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
        model="eleven_flash_v2_5",
        params=ElevenLabsTTSService.InputParams(speed=0.9),
    )
```

**Step 3: Replace inline TTS creation**

In `run_bot()`, replace the ElevenLabs block (lines 256-261):

```python
# Before:
        tts = ElevenLabsTTSService(
            api_key=os.getenv("ELEVENLABS_API_KEY", ""),
            voice_id=os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM"),
            model="eleven_flash_v2_5",
            params=ElevenLabsTTSService.InputParams(speed=0.9),
        )

# After:
        tts = create_tts_service(session_state)
```

Note: The `session_state["_flags"]` are resolved at line 173-182 (before line 256), so the flags are available when `create_tts_service` is called.

**Step 4: Run the tests**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -m pytest tests/test_tts_factory.py -v --no-header 2>&1 | tail -20`

Expected: All 7 tests PASS.

**Step 5: Run full test suite**

Run: `cd /Users/davidzuluaga/code/donna2/pipecat && .venv/bin/python -m pytest tests/ -v --no-header -x --ignore=tests/llm_simulation 2>&1 | tail -30`

Expected: All existing tests still pass (MockTTSProcessor is unaffected).

**Step 6: Commit**

```bash
git add pipecat/bot.py
git commit -m "feat: add Cartesia TTS with feature flag selection and ElevenLabs fallback"
```

---

## Task 6: Manual voice testing on dev

This task is manual — deploy to dev and make test calls.

**Step 1: Get a Cartesia API key**

1. Sign up at https://cartesia.ai (free tier includes testing credits)
2. Copy the API key

**Step 2: Pick a voice**

Browse https://cartesia.ai/voices — look for a warm, friendly female voice. Good candidates for elderly companion calls:
- Look for voices described as "warm", "friendly", "calm", "maternal"
- Test a few with sample text like: "Good morning, Margaret! How did you sleep last night?"
- Copy the voice ID of your favorite

**Step 3: Set env vars in Railway dev**

```bash
railway variables set CARTESIA_API_KEY=<your-key> --environment dev
railway variables set CARTESIA_VOICE_ID=<your-voice-id> --environment dev
```

**Step 4: Deploy to dev with ElevenLabs (baseline)**

```bash
make deploy-dev-pipecat
```

Make 2-3 test calls to dev number (+19789235477). Note voice quality, latency, naturalness.

**Step 5: Enable Cartesia via GrowthBook**

In GrowthBook dashboard, set `tts_provider` = `"cartesia"` for the dev environment (or for a specific senior_id). If GrowthBook is not set up for this flag yet, temporarily hardcode in bot.py for dev testing:

```python
# TEMPORARY for dev testing — remove before PR
provider = flags.get("tts_provider", "cartesia")  # force cartesia
```

**Step 6: Make test calls with Cartesia**

Make 2-3 test calls. Evaluate:
- [ ] Voice warmth and tone — does it sound like a caring companion?
- [ ] Latency — is time-to-first-audio noticeably faster?
- [ ] Interruption handling — does it stop cleanly when user speaks?
- [ ] Audio quality — any artifacts, clicks, or distortion over phone?
- [ ] Speed — does 0.9x feel right for elderly users?
- [ ] Emotion — does the voice naturally vary tone, or is it flat?

**Step 7: Compare and decide**

If Cartesia sounds good: proceed to Task 7 (rollout).
If issues: adjust voice ID, speed, or emotion settings and retest.

---

## Task 7: Production rollout

**Step 1: Set production env vars**

```bash
railway variables set CARTESIA_API_KEY=<your-key> --environment production
railway variables set CARTESIA_VOICE_ID=<your-voice-id> --environment production
```

**Step 2: Deploy to production**

```bash
make deploy-prod
```

At this point, the flag defaults to `"elevenlabs"` — no calls use Cartesia yet.

**Step 3: Gradual rollout via GrowthBook**

1. Create `tts_provider` feature in GrowthBook with values `"cartesia"` / `"elevenlabs"`
2. Start with 10% of calls → Cartesia, 90% → ElevenLabs
3. Monitor for 24-48 hours: check logs for Cartesia errors, listen to call recordings
4. If clean: ramp to 25% → 50% → 100%
5. If issues at any stage: set to 100% ElevenLabs (instant rollback)

**Step 4: Monitor metrics**

Check Pipecat metrics for:
- TTS TTFB (time to first byte) — Cartesia should be ~40ms vs ElevenLabs ~75ms
- Error rates per provider
- Call completion rates

**Step 5: Cleanup (after full rollout)**

Once Cartesia is 100% for 1+ week with no issues:
- Remove `tts_fallback` flag from defaults (legacy)
- Consider removing ElevenLabs dependency if no longer needed
- Update CLAUDE.md to reflect Cartesia as primary TTS

---

## Summary

| Task | What | Est. |
|------|------|------|
| 1 | Add Cartesia dependency | 2 min |
| 2 | Add config settings | 3 min |
| 3 | Add feature flag | 2 min |
| 4 | Write failing tests | 5 min |
| 5 | Implement factory + pass tests | 10 min |
| 6 | Manual voice testing on dev | 30 min |
| 7 | Production rollout | 1 hr (spread over days) |

Tasks 1-5 are code changes (automatable). Task 6 requires human ears on a phone. Task 7 is operational.
