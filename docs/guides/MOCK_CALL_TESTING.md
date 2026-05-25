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
├── pipeline.py        # build_live_sim_pipeline — real pipeline with mock STT/TTS
├── transport.py       # TextCallerTransport + AudioCallerTransport + ResponseCollector
├── scenarios.py       # 4 baseline scenarios: web_search, memory_seed, memory_recall, reminder
├── runner.py          # run_simulated_call — orchestrates one call end-to-end
├── concurrent.py      # run_simulated_calls_concurrent — N calls in parallel (PR #262)
└── cohort.py          # build_cohort_report, compare_cohorts — SLO grading (PR #262)
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

Choose with `--scenario <name>`. To add new scenarios see ["Adding a scenario"](#adding-a-scenario) below.

### 3. Concurrent / cohort A/B run

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

### 4. Stampede shape (Phase 6 / 600-call stress)

```python
specs = [ConcurrentCallSpec(scenario=web_search_scenario()) for _ in range(600)]
summary = await run_simulated_calls_concurrent(specs, max_concurrent=600, timeout_per_call=300)
```

`max_concurrent=600` fires them all together. Cost is real but bounded: only
the LLMs are real (~$0.05/call × 600 ≈ $30 per stampede). STT, TTS, and
telephony are mocked. Use it for: post-call queue saturation, DB pool
behavior under spike, Director timing fairness across N calls.

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

    # Aggregate + compare cohorts
    CohortSloReport, CohortSloThresholds, CohortComparison, SloBreach,
    DEFAULT_THRESHOLDS,
    build_cohort_report, compare_cohorts,
)
```

The runner is `run_simulated_call(scenario, senior=None, conversation_id=None, run_post_call_processing=True) -> CallResult`. The full `CallResult` shape is documented in `transport.py` — turns, tool_calls_made, injected_memories, fillers, total_duration_ms, end_reason, post_call_completed.

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

The simulation framework prints all `[EPHEMERAL:]` injections too — useful
when debugging *why* Donna pivoted or responded the way she did. Look for
`[EPHEMERAL: Observer guidance]`, `[EPHEMERAL: Director guidance]`,
`[EPHEMERAL: CONVERSATION TRACKING]`, `[EPHEMERAL: MEMORY]` in the assistant
context.

---

## Real bugs the harness catches

Running the harness against current dev (2026-05-24) immediately surfaced
seven bugs — five product, two harness:

| # | Bug | Severity | Where to fix |
|---|---|---|---|
| 1 | `cleanup_test_senior` silently leaves senior + reminder_delivery rows behind | harness | `pipecat/tests/simulation/fixtures.py` |
| 2 | `end_reason` stays `"unknown"` when caller said goodbye but pipeline didn't fire EndFrame | harness | `pipecat/tests/simulation/runner.py` |
| 3 | Donna called `web_search` twice in a row with the same query | product | `pipecat/flows/tools.py` |
| 4 | Quick Observer false-positive `[SAFETY] scam` on a benign Cowboys conversation | product | `pipecat/processors/patterns.py` |
| 5 | Response-length policy violation — Donna ran 300+ tokens with a 150-token guidance | product | Anthropic `max_tokens` cap in main flow |
| 6 | Quick Observer guidance injected 2× per turn (progressive interim chunks each re-fire patterns) | product | `pipecat/processors/quick_observer.py` |
| 7 | Director pivoted topics while caller's last question was unanswered | product | Director prompt + Director output schema |

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
- **Cleanup is shallow.** Until [bug #1](#real-bugs-the-harness-catches) is
  fixed, the `seniors` row from each demo run persists. Use a unique
  TestSenior per run (the demo script does this automatically).

---

## See also

- `pipecat/tests/test_live_simulation.py` — pytest-driven simulation tests
  (mark `llm_simulation`). Set `ANTHROPIC_API_KEY` and run:
  `cd pipecat && uv run pytest tests/test_live_simulation.py -m llm_simulation -v`
- `pipecat/tests/simulation/__init__.py` — the canonical public API surface.
- `pipecat/tests/test_simulation_concurrent.py`,
  `pipecat/tests/test_simulation_cohort.py`,
  `pipecat/tests/test_simulation_audio_transport.py` — unit tests for the
  PR #262 additions; useful starting points for understanding the API
  shapes.
- Plan reference: `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`
  — Phase 5/6/7 sections describe how this harness slots into the
  scale-to-2000 rollout.
