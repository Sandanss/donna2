# Audio Mock Call Testing Plan

## Goal

Add an opt-in voice mode to Donna's mock-call harness without weakening the
current text-only path.

The existing LLM-vs-LLM mock calls should remain the default for breadth,
speed, and lower cost. Voice mode should be an additive test mode for the
audio failure classes that text frames cannot catch: STT misrecognition, VAD
timing, sample-rate mistakes, TTS audio generation, pacing, and interruption
behavior.

## Current State

The current live simulation path is text-first:

```text
CallerAgent text
  -> TextCallerTransport
  -> InterimTranscriptionFrame / TranscriptionFrame
  -> Quick Observer
  -> Conversation Director
  -> Claude + Pipecat Flows + tools
  -> ResponseCollector
  -> MockTTSProcessor
  -> TestOutputTransport
```

This is intentionally fast and useful. It exercises Donna's real prompts,
Flow nodes, tool handlers, Director, Observer, DB writes, memory/search paths,
and post-call processing. It does not exercise actual STT or Donna TTS.

We already have the first transport primitive for voice:

- `pipecat/tests/simulation/transport.py`
  - `AudioCallerTransport`
  - `elevenlabs_tts_provider`
  - `cartesia_tts_provider`
  - `silence_tts_provider`

That transport can turn caller text into PCM and push `InputAudioRawFrame`
chunks. The missing piece is an alternate simulation pipeline that wires a
real STT service between test input and the normal Donna processors.

## Design Principle

Use one scenario catalog, one runner shape, and one result schema.

Text and voice modes should differ only at the transport and pipeline I/O
edge. A scenario such as `multiple_reminders` should be runnable as either:

```bash
uv run python scripts/run_simulated_demo.py --scenario multiple_reminders --transport text
uv run python scripts/run_simulated_demo.py --scenario multiple_reminders --transport audio-in
uv run python scripts/run_simulated_demo.py --scenario multiple_reminders --transport full-audio
```

Text mode stays default. Voice modes must require explicit CLI flags or env
vars because they cost more and are naturally slower/flakier.

## Proposed Modes

| Mode | Default? | What It Tests | What Stays Mocked |
|---|---:|---|---|
| `text` | yes | Prompt/flow behavior, tools, Director, Observer, DB, post-call | STT, caller audio, Donna TTS, carrier |
| `audio-in` | no | Caller TTS, audio chunking, real STT, STT finalization, VAD timing, then normal Donna behavior | Donna TTS, carrier |
| `full-audio` | no | Everything in `audio-in` plus Donna's real TTS output frames, output sample rate, generated audio duration | Carrier |
| `telnyx-wire` | later | Telnyx serializer/WebSocket framing and Railway routing with synthetic audio | Real carrier answer behavior |

Do not jump straight to `telnyx-wire`. The highest value next step is
`audio-in`, because it catches STT and VAD bugs while preserving the existing
assertion model.

## Target Architecture

### Text Mode

```text
CallerAgent text
  -> TextCallerTransport
  -> TranscriptionFrame
  -> Donna pipeline
  -> ResponseCollector text
  -> MockTTSProcessor
```

### Audio-In Mode

```text
CallerAgent text
  -> caller-side TTS provider
  -> AudioCallerTransport
  -> InputAudioRawFrame chunks, 16 kHz mono PCM
  -> DeepgramSTTService
  -> TranscriptionFrame
  -> Donna pipeline
  -> ResponseCollector text
  -> MockTTSProcessor
```

The caller still reasons from Donna's text response captured by
`ResponseCollector`. We do not need to transcribe Donna's audio for the caller
agent to continue the test.

### Full-Audio Mode

```text
CallerAgent text
  -> caller-side TTS provider
  -> AudioCallerTransport
  -> DeepgramSTTService
  -> Donna pipeline
  -> ResponseCollector text, for caller-agent continuation
  -> real Donna TTS service
  -> OutputAudioRawFrame capture
  -> TestOutputTransport
```

`ResponseCollector` remains before TTS so existing scenario assertions still
work. `TestOutputTransport` captures output audio for audio-specific
assertions.

## Implementation Plan

### Phase 1: Mode Selection, No Behavior Change

Add explicit mode plumbing while keeping `text` as the default.

Files:

- `pipecat/tests/simulation/modes.py`
  - `SimulationTransportMode = Literal["text", "audio-in", "full-audio"]`
  - `AudioSimulationConfig`
    - `caller_tts_provider`
    - `caller_voice_id`
    - `sample_rate=16000`
    - `chunk_duration_ms=100`
    - `trailing_silence_ms=1500`
    - `realtime=True`
    - `audio_cache_dir`
    - `capture_audio_artifacts=False`
- `pipecat/tests/simulation/runner.py`
  - `run_simulated_call(..., transport_mode="text", audio_config=None)`
- `pipecat/tests/simulation/concurrent.py`
  - extend `ConcurrentCallSpec` with `transport_mode` and `audio_config`
- `pipecat/scripts/run_simulated_demo.py`
  - add `--transport text|audio-in|full-audio`
- `pipecat/scripts/run_simulated_stress_pack.py`
  - add the same flag, but default to `text`

Validation:

- Existing text-mode tests must pass unchanged.
- Add unit tests proving default behavior is `text`.
- Add unit tests proving audio modes are rejected unless required env/config is
  present.

### Phase 2: Audio-In Pipeline Builder

Add an alternate pipeline builder instead of mutating the current text builder
too much at once.

Files:

- `pipecat/tests/simulation/audio_pipeline.py`
  - `build_audio_in_sim_pipeline(session_state, audio_config)`
- or, if duplication gets too high, refactor shared assembly out of
  `pipeline.py` after the audio path is proven.

Pipeline:

```text
TestInputTransport
  -> DeepgramSTTService
  -> QuickObserverProcessor
  -> ConversationTrackerProcessor(user)
  -> ConversationDirectorProcessor
  -> context_aggregator.user()
  -> AnthropicLLMService
  -> GuidanceStripperProcessor
  -> ConversationTrackerProcessor(assistant)
  -> ResponseCollector
  -> MockTTSProcessor
  -> TestOutputTransport
  -> context_aggregator.assistant()
  -> MetricsLoggerProcessor
```

Use `DeepgramSTTService` with the same basic settings as `bot.py`:

- model: `nova-3-general`
- encoding: `linear16`
- channels: `1`
- sample rate: `16000`
- interim results: `true`
- smart format: `true`
- punctuate: `true`

Why start at 16 kHz L16:

- It matches Donna's active Telnyx profile.
- It avoids testing resampling and STT at the same time in the first pass.
- It lets failures point to STT/VAD/utterance timing rather than codec glue.

Validation:

- Add `tests/test_live_audio_simulation.py` behind:
  - `pytest.mark.audio_simulation`
  - `pytest.mark.llm_simulation`
  - `RUN_AUDIO_SIMULATION=true`
  - `DEEPGRAM_API_KEY`
  - one caller TTS provider key
- First live test: `reminder` or `multiple_reminders`, no post-call.
- Assert:
  - setup succeeds
  - no `no_greeting` / hard `timeout`
  - at least two turns
  - expected tool calls still happen
  - Deepgram produced a final transcript for each caller utterance

### Phase 3: Transcript Capture and STT Quality Metrics

Add an input transcript collector between STT and Quick Observer.

New result fields:

- `audio_mode`
- `caller_expected_transcripts`
- `caller_observed_transcripts`
- `caller_transcript_word_error_rates`
- `caller_transcript_keyword_hits`
- `audio_input_bytes`
- `audio_input_duration_ms`

Pass/fail should not depend on exact transcript equality. Use scenario-level
critical tokens instead:

| Scenario | Critical STT Tokens |
|---|---|
| `reminder` | `plants`, `water` |
| `multiple_reminders` | `plants`, `bridge`, `Eleanor`, `tomorrow` |
| `ambiguous_reminder_ack` | `second`, `handled` |
| `false_goodbye` | `bye Helen`, `still here` |
| `reminder_creation` | `remind`, requested title, requested time |
| `consent_grant` | `yes`, `record`, `call` |
| `consent_decline` | `no`, `record` |

Suggested thresholds:

- critical keyword hit rate: `1.0` for small smoke scenarios
- normalized WER: warn above `0.25`, fail above `0.40` unless scenario is
  deliberately noisy
- STT finalization latency: warn above `3s`
- end-of-speech to Donna first text: warn above `6s` in audio mode

Keep WER advisory at first. STT output changes with vendor model updates, and
we do not want flaky tests blocking prompt work.

### Phase 4: Full-Audio Mode

Replace `MockTTSProcessor` with Donna's real TTS service while keeping
`ResponseCollector` before TTS.

Assertions:

- output audio frames are produced for every non-empty Donna response
- output frame sample rates match the selected provider profile
- total output audio duration is within a sane range for the response length
- TTS failures bubble into the run summary as `tts_provider_error`, not a
  vague timeout
- no audio bytes are logged

Optional later assertion:

- transcribe Donna's output audio with a second STT pass and compare it to
  `ResponseCollector` text. This is useful for pronunciation/regression
  checks, but it doubles STT work and should not be part of the first
  full-audio smoke.

### Phase 5: Audio Perturbation Scenarios

Once basic audio-in is stable, add deterministic PCM transforms around the
caller-side TTS output:

- `gain_db=-12`: quiet caller
- `gain_db=+6`: loud caller / clipping guard
- `white_noise_snr_db=20`: light noise
- `white_noise_snr_db=10`: noisy environment
- `speed=0.9` and `speed=1.15`: slower/faster speaking
- `leading_silence_ms` and `mid_utterance_pause_ms`: hesitant caller

These should be transforms applied after TTS generation so they do not add
more vendor calls. Start with one or two transforms, not a full matrix.

## Test Matrix

| Run Type | Transport | Count | When | Purpose |
|---|---|---:|---|---|
| Unit CI | text + stub audio frame tests | many | every PR | fast regression, no vendor spend |
| Live text smoke | text | 2-5 | manual / pre-merge | prompt/tool behavior through real LLM |
| Audio-in smoke | audio-in | 1-3 | manual / nightly | STT/VAD coverage on critical flows |
| Full-audio smoke | full-audio | 1-2 | manual before voice releases | Donna TTS output sanity |
| Text stress pack | text | 15-50 | weekly / release | behavior breadth and concurrency |
| Audio perturbation | audio-in | 3-5 | before audio/STT changes | noisy/quiet/slow speech regressions |
| Real Telnyx smoke | real carrier | 1-2 | release gate | provider, websocket, caller-ID, wire audio |

Audio mode should never replace text mode. The useful operating model is:

- Text mode catches most logic regressions cheaply.
- Audio-in catches caller speech recognition and timing failures.
- Full-audio catches Donna TTS and output audio regressions.
- Real Telnyx catches carrier and wire behavior.

## CLI and Env Shape

Example one-call audio-in run:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  env RUN_AUDIO_SIMULATION=true \
      SIM_AUDIO_CALLER_TTS_PROVIDER=elevenlabs \
      SIM_AUDIO_CALLER_VOICE_ID="$SIM_AUDIO_ELEVENLABS_VOICE_ID" \
      uv run python scripts/run_simulated_demo.py \
        --scenario multiple_reminders \
        --transport audio-in \
        --no-post-call
```

Example full-audio run:

```bash
cd pipecat
railway run --environment dev --service donna-pipecat -- \
  env RUN_AUDIO_SIMULATION=true \
      SIM_AUDIO_CALLER_TTS_PROVIDER=cartesia \
      SIM_AUDIO_CALLER_VOICE_ID="$SIM_AUDIO_CARTESIA_VOICE_ID" \
      uv run python scripts/run_simulated_demo.py \
        --scenario false_goodbye_reminder_ack \
        --transport full-audio \
        --no-post-call
```

Required env for `audio-in`:

- `RUN_AUDIO_SIMULATION=true`
- `DEEPGRAM_API_KEY`
- `ANTHROPIC_API_KEY`
- `DATABASE_URL`
- one caller-side TTS provider:
  - `ELEVENLABS_API_KEY` + `SIM_AUDIO_ELEVENLABS_VOICE_ID`, or
  - `CARTESIA_API_KEY` + `SIM_AUDIO_CARTESIA_VOICE_ID`

Additional env for `full-audio`:

- Donna's normal TTS provider env, already used by `bot.py`

## Audio Caching

Add a local cache for caller-side TTS output:

```text
.cache/donna-sim-audio/
  provider/
    model/
      voice_id/
        sample_rate/
          sha256(normalized_text).pcm
```

Rules:

- Cache only synthetic test persona text, never real senior audio.
- Include provider, model, voice, sample rate, and normalized text in the key.
- Default cache enabled locally and in Railway dev.
- Allow `--no-audio-cache` for debugging provider changes.
- Do not commit generated PCM files.

This keeps repeated audio-in runs from paying TTS cost for the same caller
utterances.

## Artifacts and Privacy

Default behavior:

- Do not persist raw audio.
- Do not log audio bytes.
- Do not log raw exception bodies from provider SDKs if they may contain
  request payloads.
- Store only aggregate metrics and synthetic scenario names in cohort reports.

Optional debug artifacts:

```bash
--audio-artifact-dir artifacts/audio-sim/<run-id>
```

If enabled, write:

- caller input PCM or WAV per turn
- Donna output PCM or WAV per response in `full-audio`
- PHI-free JSON manifest:
  - scenario name
  - provider names
  - sample rates
  - durations
  - transcript quality metrics

Because these are synthetic fixtures, they are not real PHI, but still treat
them as internal test artifacts and keep them out of Git.

## Scenario Priorities

Start with flows where STT mistakes can cause real product bugs:

1. `reminder`
   - simple baseline; plants/water tokens should survive STT.
2. `multiple_reminders`
   - multiple entities and a time phrase in one greeting.
3. `ambiguous_reminder_ack`
   - ordinal words like "second" must transcribe correctly enough for tool use.
4. `false_goodbye_reminder_ack`
   - goodbye-like phrase must not end the call incorrectly.
5. `reminder_creation`
   - title/time extraction from spoken request.
6. `consent_grant` and `consent_decline`
   - yes/no capture must be robust.
7. `cognitive_confusion`
   - repeated questions and short utterances.
8. `low_engagement`
   - terse one-word answers.

Do not start with the full stress pack in audio mode. Run a small curated set
until the path is stable.

## Failure Classification

Add explicit failure classes so audio failures are actionable:

- `caller_tts_error`
- `audio_frame_error`
- `stt_no_final_transcript`
- `stt_low_keyword_hit_rate`
- `stt_timeout`
- `pipeline_no_greeting`
- `pipeline_response_timeout`
- `donna_tts_error`
- `output_audio_missing`
- `post_call_error`

The concurrent runner should report these classes in the existing
PHI-free cohort report.

## Cost Controls

Voice mode costs more because every caller turn uses TTS, and every audio-in
turn uses real STT.

Controls:

- Keep audio-in smoke to 1-3 scenarios by default.
- Keep full-audio smoke to 1-2 scenarios.
- Cache caller-side TTS.
- Use text mode for large stress packs.
- Use `--max-concurrent` conservatively for audio mode; start at `1`, then
  test `2-3`.
- Add dry-run planning for audio mode showing estimated TTS turns, STT audio
  minutes, and whether cache hits are expected.

## Risks

- STT vendor nondeterminism can make exact-text assertions flaky.
  - Mitigation: use critical tokens and advisory WER first.
- Audio mode can obscure prompt regressions with STT noise.
  - Mitigation: always run corresponding text scenario first when debugging.
- Full-audio mode can become expensive if used like the text stress pack.
  - Mitigation: explicit opt-in env and small default counts.
- Pipeline duplication can drift from production.
  - Mitigation: keep audio builder close to `bot.py`, share helper functions
    where practical, and add a structural test comparing processor order.
- Raw audio artifacts can create operational hygiene problems.
  - Mitigation: off by default, synthetic-only, ignored by Git, short-lived.

## Acceptance Criteria

The first complete audio-in milestone is done when:

- `run_simulated_call(..., transport_mode="text")` remains default and all
  existing text tests pass.
- `run_simulated_call(..., transport_mode="audio-in")` runs at least
  `reminder` through real Deepgram STT.
- The result includes observed STT transcripts and audio metrics.
- The test asserts expected tool calls using the same scenario definitions.
- Audio mode is skipped unless `RUN_AUDIO_SIMULATION=true`.
- No raw audio is written unless an explicit artifact directory is passed.

The first complete full-audio milestone is done when:

- `full-audio` uses Donna's real TTS service.
- Output audio frames are captured and counted.
- Missing output audio is reported as `output_audio_missing`, not a generic
  timeout.
- One reminder scenario passes in Railway dev.

## Recommended Next Ticket

Implement Phase 1 and Phase 2 only:

1. Add mode/config plumbing with `text` default.
2. Add `build_audio_in_sim_pipeline`.
3. Add one opt-in test:
   - `tests/test_live_audio_simulation.py::test_audio_in_reminder_smoke`
4. Add CLI flag:
   - `scripts/run_simulated_demo.py --transport audio-in`
5. Run once in Railway dev with `reminder --no-post-call`.

Stop there before adding full-audio or noise transforms. That keeps the first
change reviewable and gives us a clear signal on whether Deepgram STT behaves
well with generated senior speech.
