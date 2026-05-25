# Testing Architecture

> Testing infrastructure for Donna's voice pipeline, Node/frontend API clients, and mobile app.

---

## Overview

| Category | Coverage |
|----------|----------|
| Python unit/regression tests | Processors, services, utilities, flows, scenario regressions |
| Python gated tests | Integration, LLM, and simulation tests selected by pytest markers |
| Node tests | Repo-root API/services with Vitest |
| Frontend E2E | Playwright projects for admin, website/consumer, and observability |
| Mobile tests | App-local Vitest checks, auth-guard scan, asset verification, Maestro flows |
| Load tests | DB, WebSocket, and scheduler throughput harnesses |

Avoid hardcoding test counts in docs. The test inventory changes frequently; use the commands below or pytest collect-only when exact counts are needed.

### Quick Start

```bash
# Run all unit tests (no API keys needed)
cd pipecat && uv run python -m pytest tests/ -m "not integration and not llm" -q

# Run with coverage
cd pipecat && uv run python -m pytest tests/ -m "not integration and not llm" --cov=. --cov-report=term-missing

# Run specific test markers
cd pipecat && uv run python -m pytest tests/ -m regression -q

# Collect tests without running them
cd pipecat && uv run python -m pytest tests/ --collect-only -q

# Run mobile release/auth checks
cd apps/mobile && npm run test:unit
cd apps/mobile && npm run test:auth-guard
cd apps/mobile && npm run verify:assets
```

---

## Three Testing Levels

```
Level 3: Call Simulation Tests        ← Full call lifecycle end-to-end
  │  Uses: TestTransport, MockLLM, MockSTT, MockTTS, pipeline_builder
  │  Tests: Complete call lifecycle, phase transitions, goodbye flow, post-call
  │
Level 2: Pipeline Integration Tests   ← Multi-processor frame flow
  │  Uses: Pipeline(), PipelineRunner, mock services
  │  Tests: Frame flow through 2+ processors, context injection, tool calls
  │
Level 1: Processor Frame Tests        ← Single processor as FrameProcessor
  │  Uses: Custom run_processor_test() helper
  │  Tests: Each processor's process_frame() with real Frame objects
  │
Existing: Pure function/unit tests     ← Already covered
```

### Level 1: Processor Frame Tests
Test individual processors in isolation with real Pipecat Frame objects:
- Quick Observer pattern matching
- Conversation Tracker topic extraction
- Guidance Stripper tag removal
- Metrics Logger frame counting

### Level 2: Pipeline Integration Tests
Test frame flow through multiple connected processors:
- Observer → Director guidance injection
- Context aggregation across turns
- Tool call handling through FlowManager

### Level 3: Call Simulation Tests
Full call lifecycle from WebSocket connect to post-call processing:
- Happy path: greeting → conversation → goodbye
- Goodbye detection: various goodbye phrases
- Reminder delivery: reminder acknowledged flow
- Emotional support: crisis detection and response

---

## Test Markers

| Marker | Purpose | When to Use |
|--------|---------|------------|
| `integration` | Requires DATABASE_URL, API keys | CI with secrets configured |
| `llm` | Requires ANTHROPIC_API_KEY | LLM response validation |
| `llm_simulation` | LLM-vs-LLM simulation (slow) | Manual validation |
| `regression` | Full pipeline scenario tests | Before deployment |

Useful filters:

```bash
cd pipecat
uv run python -m pytest tests/ -m "not integration and not llm and not llm_simulation" -q
uv run python -m pytest tests/ -m "regression" -q
uv run python -m pytest tests/ -m "integration" -q
```

The May 5, 2026 audit used static analysis and one pytest collect-only hygiene check. No full unit, integration, E2E, Maestro, deploy, or live-call validation was run for that audit; see [the audit summary](../audits/2026-05-05-codebase-audit.md).

---

## Mobile App Testing

Target surface: `apps/mobile/`. The app talks to Clerk and the repo-root Node API; it does not call Pipecat directly.

### Local Checks

```bash
cd apps/mobile
npx --yes npm@10.9.3 ci --include=dev
npm run test:unit
npm run test:auth-guard
npm run verify:assets
npx tsc --noEmit
```

`npm run test:unit` covers app-local helpers such as runtime config, API behavior, encrypted draft storage, profile session state, and the pending onboarding session marker. `npm run test:auth-guard` scans auth tests for forbidden bypass patterns so Maestro and unit coverage keep exercising visible caregiver paths.

### EAS Environment Verification

Before any development, preview, or production EAS build, verify that the selected build profile resolves the public runtime config from the matching EAS environment:

```bash
cd apps/mobile
for env in development preview production; do
  echo "== $env =="
  npx eas env:exec "$env" 'node -e "const c=require(\"./app.config.js\")(); const e=c.extra||{}; const ok=Boolean(e.apiUrl)&&Boolean(e.clerkPublishableKey)&&e.apiUrl.startsWith(\"https://\")&&/^pk_(test|live)_/.test(e.clerkPublishableKey); console.log({apiUrlPresent:Boolean(e.apiUrl),clerkKeyPresent:Boolean(e.clerkPublishableKey),ok}); process.exit(ok?0:1)"'
done
```

This command intentionally prints booleans only. If any environment reports `ok: false`, update the EAS environment, rebuild, and retest; OTA JavaScript cannot fix a binary built with missing public config.

### Maestro Coverage

Maestro flows must use visible user input paths. For iOS `phone-pad` and `number-pad` fields, use `.maestro/subflows/tap_digits.yaml` instead of `inputText`.

```bash
cd apps/mobile
npm run test:e2e:onboarding
maestro test .maestro/flows/12_incomplete_account_cleanup.yaml
maestro test .maestro/flows/13_leave_setup_cleanup.yaml
```

Fresh onboarding starts from the visible Create Account screen. Do not sign in with a no-profile Clerk user to start setup; the app now treats that as an incomplete account, calls `DELETE /api/caregivers/me/incomplete-account`, clears local onboarding state, signs out, and returns to landing.

---

## Mock Infrastructure

**Directory**: `pipecat/tests/mocks/`

| Mock | File | Purpose |
|------|------|---------|
| `MockSTTProcessor` | `mocks/mock_stt.py` | Emits TranscriptionFrames from scripted text |
| `MockLLMProcessor` | `mocks/mock_llm.py` | Returns configurable responses, tracks tool calls |
| `MockTTSProcessor` | `mocks/mock_tts.py` | Passes through text as audio frames |
| `TestTransport` | `mocks/test_transport.py` | Simulates telephony WebSocket transport |
| `FakeDBPool` | `conftest.py` | In-memory database mock |

### LOAD_TEST_MODE

**File**: `pipecat/bot.py`

Set `LOAD_TEST_MODE=true` to swap real services for mocks in the pipeline:
- Deepgram STT → MockSTTProcessor
- Claude Haiku → MockLLMProcessor (returns canned responses)
- TTS service → MockTTSProcessor

This isolates pipeline/transport/DB performance from external API latency during load tests.

---

## Regression Scenarios

**Directory**: `pipecat/tests/scenarios/`

YAML-based conversation scripts that simulate full calls:

| Scenario | Tests |
|----------|-------|
| Happy path | Greeting → topics → natural goodbye |
| Strong goodbye | "I gotta go" → goodbye response, minimum call-age guard, then delayed EndFrame |
| Reminder delivery | Medication reminder → acknowledged |
| Emotional support | Distress signals → empathetic response |
| Multiple topics | Topic switching during conversation |
| News discussion | web_search tool call → discussion |

---

## Load Testing Infrastructure

**Directory**: `pipecat/tests/load/`

Built on Locust (Python-native, supports WebSocket via custom client). These load tests are useful historical harnesses, but some still simulate the legacy Twilio protocol. Do not treat them as proof of current Telnyx/queue capacity without updating the transport and comparing against the scale rollout scripts below.

### Test Files

| File | Tests | Duration |
|------|-------|----------|
| `locustfile_db.py` | Database query performance (search, store, summaries) | Configurable |
| `locustfile_ws.py` | Legacy WebSocket pipeline load test (mock Twilio protocol) | 30s-10min per call |
| `locustfile_scheduler.py` | Scheduler throughput (reminder initiation) | Single run |
| `twilio_mock.py` | Legacy mock Twilio Media Stream WebSocket protocol | Utility |
| `conftest.py` | Shared load test configuration | N/A |

### Runner Scripts

| Script | Purpose |
|--------|---------|
| `tests/load/run_load_tests.sh` | Comprehensive runner with predefined scenarios |
| `tests/load/monitor_health.sh` | Continuous health monitoring to CSV |

### Historical Predefined Scenarios

```bash
# Baseline: 50 concurrent, 2 minutes
bash tests/load/run_load_tests.sh baseline

# Target: 500 concurrent, 10 minutes
bash tests/load/run_load_tests.sh target

# Stress: 2,000 concurrent, 10 minutes
bash tests/load/run_load_tests.sh stress

# Soak: variable load, 8 hours
bash tests/load/run_load_tests.sh soak

# Morning spike: 4,800 reminders in 2-hour window
bash tests/load/run_load_tests.sh spike

# Database only
bash tests/load/run_load_tests.sh db
```

### Current Scale-Rollout Evidence Scripts

| Script | Purpose |
|---|---|
| `scripts/collect-phase0-scaling-baseline.js` | PHI-free Phase 0 baseline metrics |
| `scripts/generate-phase0-cost-model.js` | 2,000-user cost projection from baseline + assumptions |
| `scripts/validate-call-rollout-config.js` | Validate `CALL_ARCHITECTURE_MODE` and queue flags before a flip |
| `scripts/phase5-live-ab-report.js` | Live A/B aggregate checks for legacy vs queue treatment |
| `scripts/phase7-canary-report.js` | Daily Phase 7 canary report and 7-day SLO evidence |
| `scripts/phase8-capacity-plan.js` | PHI-free pre-window capacity plan |
| `scripts/run-phase8-autoscaler-once.js` | One-shot capacity actuation driver, dry-run unless confirmed |
| `scripts/run-post-call-worker-once.js` | Phase 6 post-call worker shadow/evidence runner |

The 10,000-user path does not have a single "run this load test" proof. It is a trigger-based roadmap: prove 2,000 first, then add partitioning/ops tables, HA Redis, caller-ID pool strategy, provider sharding, and workflow-engine post-call execution when the scale plan's thresholds fire.

### Legacy Mock Twilio WebSocket Protocol (`twilio_mock.py`)
Kept for historical load testing coverage. The active voice carrier is Telnyx; update this load test before using it for current production capacity planning. It simulates Twilio Media Stream messages:
1. `connected` — WebSocket established
2. `start` — Stream started (includes streamSid)
3. `media` — Base64 audio frames (8kHz mulaw, every 20ms)
4. `stop` — Stream ended

### Technical Note: Locust + asyncio
Locust uses gevent (greenlets) which conflicts with `asyncio.run_until_complete()`. Solution: run asyncio event loop in a dedicated thread with `asyncio.run_coroutine_threadsafe()`.

---

## Key Test Files

```
pipecat/tests/
├── conftest.py                      ← Shared fixtures, session_state factory
├── TESTING_DESIGN.md                ← Detailed test architecture document
│
├── mocks/
│   ├── mock_stt.py                  ← MockSTTProcessor
│   ├── mock_llm.py                  ← MockLLMProcessor
│   └── mock_tts.py                  ← MockTTSProcessor
│
├── scenarios/                       ← YAML regression scenarios
│
├── load/
│   ├── locustfile_db.py             ← Database load tests
│   ├── locustfile_ws.py             ← WebSocket load tests
│   ├── locustfile_scheduler.py      ← Scheduler throughput tests
│   ├── twilio_mock.py               ← Legacy mock Twilio protocol
│   ├── run_load_tests.sh            ← Test runner with scenarios
│   └── monitor_health.sh            ← Health monitoring to CSV
│
├── test_quick_observer.py           ← Observer pattern matching
├── test_conversation_tracker.py     ← Topic/question extraction
├── test_guidance_stripper.py        ← Tag stripping
├── test_memory.py                   ← Memory search, store, decay
├── test_greetings.py                ← Greeting rotation
├── test_scheduler.py                ← Reminder scheduling
├── test_context_cache.py            ← Pre-caching logic
├── test_post_call.py                ← Post-call processing
├── test_flows.py                    ← Phase transitions
└── ... (50+ additional test files)
```

---

## CI Integration

Tests run automatically before each commit (pre-commit hook):

```bash
cd pipecat && uv run python -m pytest tests/ -m "not integration and not llm" -q --tb=short
```

For full validation before deployment, also run:
```bash
cd pipecat && uv run python -m pytest tests/ -m regression -q
```
