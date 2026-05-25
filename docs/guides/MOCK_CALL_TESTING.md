# Mock Call Testing — LLM-vs-LLM Voice Simulation

Donna can test itself by having one Claude instance play an elderly senior on
the phone while the **real** Donna pipeline (Quick Observer + Conversation
Director + Claude Haiku + Pipecat Flows + DB + tools) responds. No Telnyx,
no real phone, no human listener required. Real bugs surface anyway.

This guide covers what it is, when to use it, how to run it, and how to read
the output.

> **TL;DR.** `cd pipecat && railway run --environment dev --service donna-pipecat -- uv run python scripts/run_simulated_demo.py --scenario web_search --no-post-call` — runs one full LLM-vs-LLM call against the dev DB in ~30s for ~$0.05 and prints the transcript.

---

## When to use it

| Use case | Mock call | Real Telnyx |
|---|---|---|
| Catch conversation regressions ("Donna stopped acknowledging goodbyes") | ✅ | ✅ but expensive |
| Verify a new prompt change doesn't break flow | ✅ | ✗ (overkill) |
| Stampede shape (600 concurrent calls ending at once) | ✅ | ✗ (impossible without real seniors) |
| Treatment-vs-control A/B comparison | ✅ | only at small N |
| Caller-ID answer rate validation | ✗ (no carrier) | ✅ required |
| Audio-quality-at-the-wire (codec, latency, packet loss) | ✗ (limited) | ✅ required |
| Run in CI on every PR | ✅ (sub-set, with mocked LLM) | ✗ |

**Rule of thumb:** mock calls for behavior breadth and concurrency correctness.
Real Telnyx dials only for what only real carriers can prove.

---

## What's in the box

Everything lives under `pipecat/tests/simulation/`.

```
pipecat/tests/simulation/
├── __init__.py        # public exports (see "API quick reference" below)
├── caller.py          # CallerAgent — Haiku-powered senior LLM with persona + goals
├── fixtures.py        # TestSenior dataclass, seed/cleanup DB helpers
├── pipeline.py        # build_live_sim_pipeline — real pipeline; injects TranscriptionFrame directly and mocks TTS
├── transport.py       # TextCallerTransport + AudioCallerTransport + ResponseCollector
├── scenarios.py       # scenario catalog: web_search, memory, reminder, safety, outage cases
├── runner.py          # run_simulated_call — orchestrates one call end-to-end
├── concurrent.py      # run_simulated_calls_concurrent — N calls in parallel
├── cohort.py          # build_cohort_report, compare_cohorts — SLO grading
└── stress.py          # advanced stress suites and stampede spec builders
```

### Anatomy of one call

```
   ┌──────────────────────────┐
   │  CallerAgent (Haiku)     │   plays the senior. Persona = "Margaret, 78,
   │  - persona + goals       │   warm/chatty/uses 'dear'". Goals = scenario-
   │  - 1 LLM call per turn   │   specific things they want to bring up.
   └────────────┬─────────────┘
                │ caller text
                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  TextCallerTransport.send_utterance(text)                │
   │  ─ pushes progressive InterimTranscriptionFrame chunks   │
   │    (3 words at a time, 150ms gap)                        │
   │  ─ 300ms silence (clears Director's 250ms threshold)     │
   │  ─ marks injection_time on ResponseCollector             │
   │  ─ pushes final TranscriptionFrame                       │
   └────────────┬─────────────────────────────────────────────┘
                │
                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  THE REAL DONNA PIPELINE                                 │
   │  ─ Quick Observer (real regex, 0ms)                      │
   │  ─ Conversation Director (real Groq fast path)           │
   │  ─ Claude Haiku 4.5 (real, prompt caching on)            │
   │  ─ Pipecat Flows (4-phase state machine)                 │
   │  ─ Tool handlers: web_search (real Tavily!),             │
   │    mark_reminder_acknowledged, create_reminder           │
   │  ─ Memory / news / context fetchers (real DB + OpenAI)   │
   │                                                          │
   │  Mocked: input audio transport, STT (TranscriptionFrame  │
   │  is injected directly), TTS (MockTTSProcessor captures   │
   │  text instead of generating audio).                      │
   └────────────┬─────────────────────────────────────────────┘
                │ TextFrame stream from Claude
                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  ResponseCollector                                       │
   │  ─ assembles TextFrame chunks into complete responses    │
   │  ─ records tool_use, injected memories, fillers, end     │
   │  ─ measures TTFB from injection_time mark                │
   └────────────┬─────────────────────────────────────────────┘
                │ CallerEvent {text, latency_ms}
                ▼
        Caller LLM next turn …
```

The CallerAgent reads Donna's response, decides what to say next, and the
loop continues until: (a) the caller hits a `should_end_call` goal, (b) the
caller says goodbye and Quick Observer fires a programmatic EndFrame, or (c)
`max_turns` is reached.

---

## Quick start

### 1. One call, see the transcript

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  uv run python scripts/run_simulated_demo.py \
    --scenario web_search \
    --no-post-call
```

Output ends with a transcript like this (real run, 2026-05-24):

```
Senior ▶ Well, hello dear! My day's been just lovely, thank you for asking.
         I haven't seen the grandchildren in a couple weeks now, but you
         know, I've been keeping myself busy out in the garden when the
         weather permits.
Donna  ◀ That sounds wonderful, Margaret. The garden must be looking
         beautiful this time of year. What are you growing right now?       [1421ms]

Senior ▶ Oh, I've got tomatoes coming in nicely, and my herbs are doing so
         well too. But dear, I was wondering, what's the weather looking
         like? I need to know if I should cover my tomatoes.
Donna  ◀ Let me check on that for you.                                     [1245ms]

[... web_search tool actually fires against real Tavily here ...]

Donna  ◀ The forecast shows scattered showers possible this morning and
         some more showers returning tonight, but you should have some
         drier time in the afternoon. Since we're already mid-afternoon
         on your end, you might want to cover those tomatoes just to be
         safe for tonight's rain. Are your herbs in a spot where they
         can handle some extra moisture?                                    [244ms]
```

The `[1421ms]` is real TTFB — time from caller's TranscriptionFrame to
Donna's first TextFrame chunk. This is the same number the production
metrics logger emits during real calls.

### 2. Available scenarios

| Scenario | What it tests |
|---|---|
| `web_search` | Director-Tavily wiring; Claude using tool results; filler timing |
| `memory_seed` | Donna writing memories during the call |
| `memory_recall` | Director injecting prefetched memories from prior calls |
| `reminder` | Pipecat Flows reminder phase → main transition; `mark_reminder_acknowledged` |
| `multiple_reminders` | Donna brings up multiple everyday reminders in the opening and records each acknowledgement |
| `reminder_overload` | Five non-medical reminders in one call; caller acknowledges only some |
| `ambiguous_reminder_ack` | Caller says "the second one" instead of naming the reminder |
| `reminder_interruption` | Caller interrupts reminder delivery with a new reminder request |
| `similar_reminders` | Similar titles like "Call Eleanor" vs. "Call Eleanor about bridge club" |
| `out_of_order_reminder_ack` | Caller acknowledges reminders in a different order than Donna presented them |
| `unacknowledged_reminder` | Caller dodges the reminder; Donna should not mark it acknowledged prematurely |
| `false_goodbye_reminder_ack` | Caller says goodbye to someone nearby while acknowledging a reminder |
| `cognitive_confusion_reminder` | Caller asks Donna to repeat who she is and what the reminder was |
| `low_engagement_reminder` | Terse caller receives a reminder without over-prompting |
| `embedding_outage` | OpenAI embedding failure/quota exhaustion; memory search degrades without ending the call |
| `false_goodbye` | Senior says a goodbye-like phrase to someone else mid-call; call should continue |
| `low_engagement` | Reserved senior gives short answers; Donna should re-engage without interrogating |
| `health_concern` | Senior mentions lightheadedness/stumble; Donna should respond with calm concern |
| `cognitive_confusion` | Senior repeats and forgets context; Donna should orient patiently |
| `reminder_creation` | Senior asks Donna to create a new reminder; `create_reminder` should fire after confirmation |
| `async_search_overlap` | Senior asks a second current-info question while search is still settling |
| `slow_search_overlap` | Same as overlap, but web search is deliberately delayed |
| `empty_search_result` | Web search returns no useful result; Donna should not retry-loop |
| `search_phi_guard` | Caller includes fake private details in a search request; query should be sanitized |
| `consent_grant` | Clear combined call+recording consent grant |
| `consent_decline` | Clear combined consent decline; scheduler gate should roll up false |
| `consent_ambiguous_then_grant` | Fuzzy consent answer, clarification, then grant |
| `consent_ai_question_then_grant` | AI disclosure and recording-access questions before grant |
| `consent_off_topic_redirect_decline` | Off-topic redirect during consent; no web search; decline captured |
| `consent_boundary_reminder_attempt` | Consent call resists drifting into reminder creation |
| `discovery` | Multi-category discovery: friends, hobby/routine, family |
| `discovery_quiet_routine` | Quiet caller; gentle prompting yields routine and relationship facts |
| `discovery_off_topic_weather` | Discovery plus current-weather lookup (`record_discovery_fact` + `web_search`) |
| `discovery_boundary_redirect` | Senior refuses private topics, then shares safe interests |
| `discovery_early_goodbye` | Partial discovery before an early goodbye |
| `discovery_correction` | Senior corrects a stated discovery fact in-call |
| `discovery_boundary_reminder_attempt` | Discovery call resists drifting into reminder scheduling |

Choose with `--scenario <name>`. To add new scenarios see ["Adding a scenario"](#adding-a-scenario) below.

### 3. Stress Pack

The stress pack is the recommended first pass when you want breadth without
spending money on thousands of live LLM turns. It documents the corner cases
we want to keep exercising:

| Category | Scenario/helper | Failure mode it targets |
|---|---|---|
| Reminder overload | `reminder_overload` | Multi-item greeting loses items or marks the whole batch acknowledged |
| Ambiguous acknowledgement | `ambiguous_reminder_ack` | "The second one" maps to the wrong reminder |
| Reminder interruption | `reminder_interruption` | New reminder request makes Donna forget pending delivered reminders |
| Duplicate/similar titles | `similar_reminders` | Slug/title matching picks the shorter similar reminder |
| Out-of-order acknowledgement | `out_of_order_reminder_ack` | Tool handler assumes presentation order |
| No acknowledgement | `unacknowledged_reminder` | Donna marks a vague topic change as confirmed |
| Tool argument messiness | unit tests in `test_pipeline_tool_calls.py` | UUID/title/slug/ordinal arguments resolve inconsistently |
| Embedding outage | `embedding_outage` | Memory recall fails when OpenAI embedding quota is exhausted |
| Slow search + second turn | `slow_search_overlap` | Duplicate search calls or stale answers while waiting |
| Bad/empty search | `empty_search_result` | Repeated tool calls or awkward failure copy |
| Search PHI guard | `search_phi_guard` + sanitizer tests | Names, phones, or addresses leave Donna in a web query |
| False goodbye under reminder pressure | `false_goodbye_reminder_ack` | Quick Observer ends the call while a reminder ack is happening |
| Cognitive confusion + reminders | `cognitive_confusion_reminder` | Donna marks acknowledgement before the caller understands |
| Low engagement + reminders | `low_engagement_reminder` | Donna over-prompts or misses terse acknowledgement |
| Bilingual reminder creation | `reminder_creation` | Spanish/English confirmation flow fails before `create_reminder` |
| Consent boundary | `consent_boundary_reminder_attempt` | First call drifts into regular reminder workflow |
| Discovery boundary | `discovery_boundary_reminder_attempt` | Profile-building call becomes reminder scheduling |
| Reminder stampede | `build_reminder_stampede_specs(count)` | Concurrent reminder calls collide on state/DB rows |
| Post-call stampede | `build_post_call_stampede_specs(count)` | Many calls end together. This saturates post-call jobs only when `POST_CALL_QUEUE_ENABLED=true`; otherwise Pipecat still runs inline post-call work. Use `npm run phase6:post-call-stampede` for the separate JS worker evidence path. |
| Parallel flake detector | `build_parallel_flake_specs(factory, repetitions=N)` | State leaks and nondeterminism across repeated concurrent runs |
| 2,000-user infra | `scale_2000_load_test_plan()` + Locust | Load balancing/WS/DB pressure without 2,000 LLM calls |

Run a small behavior stress pack:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  uv run python scripts/run_simulated_stress_pack.py \
    --mode stress-pack \
    --max-concurrent 5 \
    --no-post-call
```

Preview the exact call list without spending LLM tokens:

```bash
cd pipecat
uv run python scripts/run_simulated_stress_pack.py \
  --mode stress-pack \
  --dry-run \
  --json
```

```python
from tests.simulation import build_stress_pack_specs, run_simulated_calls_concurrent

specs = build_stress_pack_specs(repetitions=1)
summary = await run_simulated_calls_concurrent(
    specs,
    max_concurrent=5,
    run_post_call_processing=False,
)
print(summary)
```

Run a targeted reminder stampede:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  uv run python scripts/run_simulated_stress_pack.py \
    --mode reminder-stampede \
    --count 50 \
    --max-concurrent 25 \
    --no-post-call
```

```python
from tests.simulation import build_reminder_stampede_specs, run_simulated_calls_concurrent

specs = build_reminder_stampede_specs(50)
summary = await run_simulated_calls_concurrent(
    specs,
    max_concurrent=25,
    run_post_call_processing=False,
)
```

Run a parallel flake detector:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  uv run python scripts/run_simulated_stress_pack.py \
    --mode flake \
    --scenario multiple_reminders \
    --count 20 \
    --max-concurrent 10 \
    --no-post-call
```

```python
from tests.simulation import build_parallel_flake_specs, multiple_reminders_scenario

specs = build_parallel_flake_specs(multiple_reminders_scenario, repetitions=20)
```

Run a post-call stampede with post-call processing enabled:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  uv run python scripts/run_simulated_stress_pack.py \
    --mode post-call-stampede \
    --count 25 \
    --max-concurrent 10
```

Print the 2,000-user load-test plan:

```bash
cd pipecat
uv run python scripts/run_simulated_stress_pack.py \
  --mode scale-2000-plan \
  --json
```

The pytest wrapper for real LLM stress calls is opt-in:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  env RUN_LIVE_STRESS_SIMULATION=true \
      LIVE_STRESS_SCENARIOS=ambiguous_reminder_ack,similar_reminders,empty_search_result \
      LIVE_STRESS_MAX_CONCURRENT=3 \
      uv run pytest tests/test_live_stress_simulation.py -m "llm_simulation and stress" -q
```

### 4. Concurrent / cohort A/B run

Build a Python script (or inline in an `ipython`/`uv run python`):

```python
from tests.simulation import (
    ConcurrentCallSpec,
    build_cohort_report,
    compare_cohorts,
    memory_recall_scenario,
    run_simulated_calls_concurrent,
    web_search_scenario,
)

specs = (
    [ConcurrentCallSpec(scenario=web_search_scenario(), label="control") for _ in range(10)]
    + [ConcurrentCallSpec(scenario=memory_recall_scenario(), label="treatment") for _ in range(10)]
)

summary = await run_simulated_calls_concurrent(specs, max_concurrent=5)

control = build_cohort_report("control", summary.by_label("control"))
treatment = build_cohort_report("treatment", summary.by_label("treatment"))
comparison = compare_cohorts(control, treatment)

print(comparison.to_dict())
# {
#   "passed": true,
#   "control":   {"setup_success_rate": 1.0, "first_response_p95_ms": 1500, ...},
#   "treatment": {"setup_success_rate": 1.0, "first_response_p95_ms": 1400, ...},
#   "breaches": []
# }
```

Each slot gets a **unique TestSenior** (UUID + phone) so concurrent DB writes
don't collide. The comparator grades against plan §1.3 SLOs (setup p95 ≤
1.5s, success rate ≥ 0.95, post-call completion ≥ 0.95). Thresholds are
overridable for relaxed canary policies.

### 5. Stampede shape (Phase 6 / 600-call stress)

```python
specs = [ConcurrentCallSpec(scenario=web_search_scenario()) for _ in range(600)]
summary = await run_simulated_calls_concurrent(specs, max_concurrent=600, timeout_per_call=300)
```

`max_concurrent=600` fires them all together. Cost is real but bounded: only
the LLMs are real (~$0.05/call × 600 ≈ $30 per stampede). STT, TTS, and
telephony are mocked. Use it for: post-call queue saturation, DB pool
behavior under spike, Director timing fairness across N calls.

### 6. 2,000-user infra/load-balancer stress

Do not use 2,000 full LLM-vs-LLM calls as the default load-balancer test.
That mostly stress-tests Anthropic/OpenAI quotas and cost, not Railway routing.

For the 2,000-user infrastructure target, use the load-test harness:

```bash
cd pipecat
export LOAD_TEST_HOST=https://<pipecat-staging-or-dev-host>
export LOAD_TEST_DB_URL=postgresql://<staging-neon-branch>
bash tests/load/run_load_tests.sh stress
```

The load runner already has a `stress` target for 2,000 concurrent users, but
verify the WebSocket locust file matches the active telephony provider before
using the result as a release gate. The current active production path is
Telnyx (`/telnyx/*` + `/ws?ws_token=...`), while older load scripts may still
use the retired Twilio `/voice/answer` shape.

The target Pipecat service must be deployed with `LOAD_TEST_MODE=true` so the
WebSocket path exercises HTTP routing, WebSocket connection handling, Railway
load balancing, replica capacity, health checks, and DB pressure without
calling real STT/LLM/TTS for every synthetic call.

Use both tracks together:

- **Mock-call simulation:** behavior correctness, tool use, memory injection,
  goodbye handling, post-call processing, and moderate concurrent pipeline
  safety.
- **Locust WebSocket load:** 500/2,000-user infra validation, load balancer
  behavior, connection churn, DB pool pressure, and scheduler throughput.

---

## API quick reference

```python
from tests.simulation import (
    # Personas + scenarios
    CallerAgent, CallerPersona, CallerGoal,
    LiveSimScenario,
    web_search_scenario, memory_seed_scenario,
    memory_recall_scenario, reminder_scenario,

    # DB fixtures
    TestSenior,
    seed_test_senior, cleanup_test_senior,
    create_test_conversation, build_session_state,

    # Pipeline assembly
    build_live_sim_pipeline, LiveSimComponents,

    # Transports
    TextCallerTransport,
    AudioCallerTransport,  # see "Audio mode" below
    silence_tts_provider, elevenlabs_tts_provider, cartesia_tts_provider,

    # Per-call helpers
    ResponseCollector,
    CallerEvent, CallResult,

    # Run one call
    run_simulated_call,

    # Run many calls
    ConcurrentCallSpec, ConcurrentCallOutcome, ConcurrentRunSummary,
    run_simulated_calls_concurrent,

    # Stress pack helpers
    STRESS_SCENARIO_FACTORIES,
    build_stress_pack_specs, build_reminder_stampede_specs,
    build_post_call_stampede_specs, build_parallel_flake_specs,
    scale_2000_load_test_plan,

    # Consent/discovery suites
    consent_mock_call_scenarios, discovery_mock_call_scenarios,

    # Aggregate + compare cohorts
    CohortSloReport, CohortSloThresholds, CohortComparison, SloBreach,
    DEFAULT_THRESHOLDS,
    build_cohort_report, compare_cohorts,
)
```

The runner is `run_simulated_call(scenario, senior=None, conversation_id=None, run_post_call_processing=True) -> CallResult`. The full `CallResult` shape is documented in `transport.py` — turns, tool_calls_made, injected_memories, fillers, total_duration_ms, end_reason, post_call_completed, plus PHI-safe post-call metrics fields for whether `call_metrics` logged, which tool names were written, whether encrypted context trace was included, and `post_call_error_count`.

---

## Required environment

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Real Claude Haiku for both Donna *and* the CallerAgent |
| `DATABASE_URL` | yes | Seeding test seniors, persisting conversations |
| `OPENAI_API_KEY` | recommended | Memory embeddings (memory_recall scenario degrades without it) |
| `GROQ_API_KEY` | recommended | Real Director fast path |
| `TAVILY_API_KEY` | for web_search | Without it the `web_search` tool fails-soft |

The simplest way: run via Railway dev env so all keys + DATABASE_URL flow
through without local secrets:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- uv run python scripts/run_simulated_demo.py
```

---

## How to read the output

Each turn record is `{turn, caller, donna, latency_ms}`. The summary is:

```
Summary
─────────
  turns           : 8           # how many caller-Donna exchanges
  end_reason      : caller_goodbye   # how the call ended
  total duration  : 34.2s       # wall clock
  tool calls      : web_search  # which Claude tools fired
  memories injected: 0          # Director memory injections
  fillers spoken  : 0           # Director TTS fillers ("let me check")
  post-call done  : True        # post-call analysis ran to completion
```

The simulation framework captures `[EPHEMERAL:]` injections in `CallResult`
and the encrypted context trace. The demo CLI prints transcript and summary
counts by default; inspect the result object or trace when debugging *why*
Donna pivoted or responded the way she did. Look for `[EPHEMERAL: Observer
guidance]`, `[EPHEMERAL: Director guidance]`, `[EPHEMERAL: CONVERSATION
TRACKING]`, and `[EPHEMERAL: MEMORY]` in the captured assistant context.

---

## Real bugs the harness catches

Running the harness against dev on 2026-05-24 surfaced a historical bug set
that drove the current regression coverage:

| # | Bug | Status | Where fixed/tracked |
|---|---|---|---|
| 1 | `cleanup_test_senior` silently left senior + reminder_delivery rows behind | fixed | `pipecat/tests/simulation/fixtures.py` |
| 2 | `end_reason` stayed `"unknown"` when caller said goodbye but pipeline did not fire EndFrame | fixed | `pipecat/tests/simulation/runner.py` |
| 3 | Donna called `web_search` twice in a row with the same query | regression-covered | `pipecat/flows/tools.py` |
| 4 | Quick Observer false-positive guidance on a benign sports conversation | regression-covered | `pipecat/processors/patterns.py` |
| 5 | Response-length policy violation — Donna ran 300+ tokens with a 150-token guidance | regression-covered | Anthropic `max_tokens` cap in main flow |
| 6 | Quick Observer guidance injected 2× per turn because progressive interim chunks re-fired patterns | fixed | `pipecat/processors/quick_observer.py` |
| 7 | Director pivoted topics while caller's last question was unanswered | regression-covered | Director prompt + Director output schema |

That's the value of the harness: every one of these is a real production
issue that wouldn't show up in unit tests. The simulation harness reproduces
them deterministically (same persona, same seeded memories, same scenario)
which means we can bisect each one without booking a test phone slot.

---

## Adding a scenario

A scenario is just a `LiveSimScenario`:

```python
# pipecat/tests/simulation/scenarios.py

from tests.simulation.caller import CallerAgent, CallerGoal, CallerPersona
from tests.simulation.fixtures import TestSenior

def your_new_scenario() -> LiveSimScenario:
    return LiveSimScenario(
        name="your_new_thing",
        senior=TestSenior(
            name="Margaret Garden",
            interests=["gardening", "grandchildren"],
            ...
        ),
        persona=CallerPersona(
            name="Margaret",
            age=78,
            speech_style="warm, uses 'dear', short sentences",
        ),
        goals=[
            CallerGoal(description="Mention a specific health concern in passing"),
            CallerGoal(description="Ask Donna about today's weather"),
            CallerGoal(description="Wrap up with a warm goodbye", ends_call=True),
        ],
        call_type="check-in",
        max_turns=10,
    )
```

Export it from `__init__.py` and add it to `SCENARIOS` in
`scripts/run_simulated_demo.py` and you're done. The CallerAgent will turn
goals into natural utterances; you don't write the dialogue.

---

## Audio mode (limited; see follow-up)

`AudioCallerTransport` exists (PR #262) and pushes real `InputAudioRawFrame`
chunks into a pipeline. Built-in TTS providers: `silence_tts_provider`
(silence for frame-mechanics tests), `elevenlabs_tts_provider`,
`cartesia_tts_provider`.

**Caveat:** the default `build_live_sim_pipeline` skips real STT (it injects
`TranscriptionFrame` directly). Real audio-loop testing needs an alternate
pipeline that wires in real Deepgram STT. That alternate builder is a
small follow-up (~half day). Until it lands, `AudioCallerTransport` is
useful for testing frame-push mechanics and for future audio-loop work, but
not yet end-to-end audio.

When it lands, audio mode will catch a new class of bugs the text mode
cannot: STT misrecognition, codec mismatches, sample-rate drift, VAD
boundary issues. Use audio mode for a **small** number of calls in
addition to text-mode breadth.

Implementation plan: `docs/plans/2026-05-25-audio-mock-call-testing-plan.md`.

---

## Cost

Per simulated call (text mode), real vendor cost roughly:

| Vendor | Per call (approx) |
|---|---|
| Anthropic (Donna) | $0.02–0.05 (one Claude call per turn × ~8 turns) |
| Anthropic (CallerAgent) | $0.02–0.05 (same shape) |
| Groq (Director) | $0.001 |
| OpenAI (embeddings, memory) | < $0.005 |
| Tavily (web_search, if scenario uses it) | $0.005 per search |
| **Total** | **~$0.05–0.15 per call** |

A 600-call stampede ≈ $30–90 of real vendor spend. Not free, but cheap
enough to run weekly.

For zero-cost runs, vendor stubs are possible but not currently wired in
to the live-sim pipeline. The framework structure (`MockTTSProcessor`,
`TestInputTransport`) is ready for a future "stub-LLM mode" that lets
huge stampedes run for $0.

---

## Limitations

- **No carrier behavior.** No phone ringing, no answer-machine vs human, no
  network jitter, no L16-mu-law transcoding artifacts. Real Telnyx test
  dials remain irreplaceable for caller-ID + audio quality validation.
- **CallerAgent is one Claude instance with a persona.** Real seniors are
  more varied. Add new personas + scenarios to widen coverage.
- **DB is your DB.** Currently runs against dev Neon. For CI use, a fresh
  Postgres container per run is recommended (not yet wired into the
  pytest config).
- **Cleanup is still dev-DB dependent.** Test seniors are deleted after runs,
  and each run uses a unique UUID + fake phone, but interrupted live runs can
  still leave stale rows. Prefer a staging Neon branch for large runs.

---

## See also

- `pipecat/tests/test_live_simulation.py` — pytest-driven simulation tests
  (mark `llm_simulation`). Set `ANTHROPIC_API_KEY` and run:
  `cd pipecat && uv run pytest tests/test_live_simulation.py -m llm_simulation -v`
- `pipecat/tests/test_live_stress_simulation.py` — opt-in advanced stress
  subsets and reminder stampedes (marks `llm_simulation` + `stress`).
- `pipecat/scripts/run_simulated_stress_pack.py` — operator CLI for stress
  packs, stampedes, flake detection, dry-run plans, and the 2,000-user plan.
- `pipecat/tests/simulation/__init__.py` — the canonical public API surface.
- `pipecat/tests/test_simulation_concurrent.py`,
  `pipecat/tests/test_simulation_cohort.py`,
  `pipecat/tests/test_simulation_audio_transport.py` — unit tests for the
  PR #262 additions; useful starting points for understanding the API
  shapes.
- Plan reference: `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`
  — Phase 5/6/7 sections describe how this harness slots into the
  scale-to-2000 rollout.
