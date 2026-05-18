# Post-Call Analysis and Observability Plan

> Historical plan. SMS-specific wording is superseded: current caregiver notifications are email/in-app only, and active live calls use Telnyx rather than Twilio.

Date: 2026-04-15

## Context

This plan follows the April 15 post-call analysis pass after a live dev call confirmed that calls complete, summaries persist encrypted, call analyses are saved, daily context is written, caregiver notifications are triggered, and call snapshots are rebuilt.

The current merge already fixes several concrete issues:

- Post-call summaries are now prompted for caregiver usefulness instead of internal operator phrasing.
- Call analysis now produces and normalizes an explicit `sentiment` value: `positive`, `neutral`, `concerned`, `worried`, or `distressed`.
- Conversation summaries now persist the derived sentiment onto `conversations.sentiment`.
- Node call-analysis normalization exposes encrypted analysis fields such as `sentiment`, `mood`, caregiver takeaways, and recommended caregiver action.
- Observability active calls no longer always returns an empty list; it reads recent `in_progress` calls.
- Per-call observability metrics now read from the active `call_metrics` table instead of only legacy `conversations.call_metrics`.
- Post-call `error_count` now reflects failed post-call steps instead of always writing zero.
- Pipecat caregiver notification delivery no longer falls back to a production Node URL when `NODE_API_URL` is missing.
- Interest scoring now reads encrypted call analysis payloads, preserving scoring after PHI encryption removed plaintext topic writes.
- Post-call interest discovery logging no longer prints discovered interest labels.

## Remaining Findings

### 1. Live Observability Is Still Database-Polling, Not a True Live Stream

Current state:

- Node `/api/observability/active` can now show active calls by reading `conversations.status = 'in_progress'`.
- The live timeline still depends on transcript snapshots being persisted to Postgres.
- Pipecat already knows true live state in memory and exposes aggregate active call count on `/health`, but Node and the observability UI do not receive a structured active-call event feed.

Risk:

- During a call, observability can lag behind reality.
- A call can be active in Pipecat but invisible in Node if the conversation row is delayed or stale.
- Operators cannot reliably distinguish "no active call" from "active call but no transcript snapshot yet."

Plan:

1. Add a Pipecat admin endpoint for live active call metadata, guarded by existing admin/service auth.
2. Return only PHI-minimized metadata: call SID, conversation ID, senior ID, masked phone, call type, start time, active duration, turn count, and coarse pipeline state.
3. Prefer Redis shared state when available so multi-instance Pipecat deployments can report active calls consistently.
4. Add a Node proxy endpoint under `/api/observability/active` that merges Pipecat live state with DB senior/conversation metadata.
5. Update `apps/observability` to poll the merged endpoint and show whether data is live Pipecat state, DB state, or both.
6. Validate with a Railway dev call and verify that active state appears before the first transcript draft.

### 2. Per-Turn Metrics Are Not Persisted as First-Class Data

Current state:

- The active pipeline writes aggregate rows to `call_metrics`.
- The old observability panel still expects per-turn metric objects inside transcript turns.
- The patch now displays aggregate metrics, but per-turn charts remain empty for normal calls.

Risk:

- Latency regressions are harder to diagnose.
- We cannot tell which turn, provider, tool call, or TTS segment caused a slow call.
- Investor and operational cost reporting remain coarse.

Plan:

1. Add a `call_turn_metrics` table with no transcript content:
   - `call_sid`
   - `conversation_id`
   - `turn_index`
   - `role`
   - `provider`
   - `model`
   - `llm_ttfb_ms`
   - `tts_ttfb_ms`
   - `turn_latency_ms`
   - `prompt_tokens`
   - `completion_tokens`
   - `cache_read_tokens`
   - `tts_characters`
   - `tools_used`
   - `created_at`
2. Update `MetricsLoggerProcessor` to maintain a current turn accumulator and flush per-turn metrics when the next user turn starts or the call ends.
3. Keep aggregate `call_metrics` as the rollup table.
4. Update Node observability APIs to return real per-turn metrics from `call_turn_metrics`.
5. Update the metrics panel to show aggregate metrics and per-turn metrics from the new table.
6. Add tests that verify per-turn rows contain no transcript text or raw PHI.

### 3. Call Metrics Need Better Semantics

Current state:

- `call_metrics.turn_count` is effectively LLM/assistant response count, not total conversation turns.
- `error_count` now reflects post-call step failures, but it does not preserve which steps failed.
- `end_reason` values are useful but not yet normalized into a clear taxonomy.

Risk:

- Dashboards can mislead operators.
- A call with successful audio but failed analysis can still look successful unless the operator drills in.
- "Turn count" can mean different things in different screens.

Plan:

1. Add explicit fields to `call_metrics`:
   - `user_turn_count`
   - `assistant_turn_count`
   - `llm_turn_count`
   - `post_call_error_steps`
   - `analysis_status`
   - `notification_status`
2. Backfill these fields opportunistically where transcripts and metrics are available.
3. Update observability labels so "turns" has a precise meaning.
4. Add dashboard cards for "analysis succeeded", "summary persisted", "notification sent", and "snapshot rebuilt."

### 4. Onboarding Post-Call Analysis Uses a Separate Older Path

Current state:

- Subscriber post-call analysis uses `google-genai`, the `gemini_analysis` circuit breaker, encrypted analysis storage, and normalized JSON.
- Onboarding summary generation still uses the older `google.generativeai` path and a freeform summary.

Risk:

- Onboarding calls have different failure behavior, timeout behavior, and model configuration.
- Prospect summaries are harder to validate and cannot share the same schema normalization.

Plan:

1. Move onboarding summarization to the same `google-genai` client style used by subscriber analysis.
2. Put onboarding analysis behind its own circuit breaker or reuse a clearly named shared analysis breaker.
3. Return structured JSON with prospect-specific fields instead of freeform-only summaries.
4. Normalize and validate the onboarding output before writing it into prospect context.
5. Add tests for missing API key, malformed JSON repair, timeout fallback, and no-PHI logging.

### 5. Post-Call Processing Needs Durable Job State

Current state:

- Post-call processing runs as a background task after the pipeline ends.
- It has step-level error handling, but there is no durable job row or retry queue.
- If the process exits during post-call work, partial results can remain without a retry marker.

Risk:

- A call can complete but miss analysis, notification, snapshot rebuild, or daily context without a durable retry path.
- Debugging partial failures requires manual log and DB inspection.

Plan:

1. Add a `post_call_jobs` or `post_call_events` table:
   - `call_sid`
   - `conversation_id`
   - status per step
   - attempts
   - last_error_class
   - timestamps
2. Write job state before starting post-call work.
3. Mark each step complete or failed as it runs.
4. Add an idempotent retry command for failed post-call jobs.
5. Keep raw PHI out of job error fields; store categories and sanitized messages only.

### 6. Notification Delivery Needs Stronger Auditability

Current state:

- Pipecat sends a service-authenticated request to Node for caregiver notifications.
- Node returns HTTP status, and Pipecat logs only the status.
- Notification preference and delivery behavior exists in Node, but post-call success does not clearly report "caregiver notification stored/sent/skipped."

Risk:

- A `200` from the trigger endpoint may not mean email/in-app delivery succeeded.
- Operators cannot easily answer whether a caregiver actually got the summary.

Plan:

1. Make Node notification trigger responses include delivery result counts by channel and caregiver.
2. Store sanitized notification delivery metadata that can be shown in observability.
3. Include notification delivery status in `call_metrics` or the new post-call job state.
4. Add a smoke test that validates call completion produces a notification record or an explicit skipped reason.

### 7. Summary Quality Needs Regression Evaluations

Current state:

- The summary prompt is improved, but quality is still LLM-dependent.
- Tests validate schema normalization, not whether summaries are actually useful to caregivers.

Risk:

- Summaries can drift back toward generic internal summaries.
- Caregiver notifications may over-share sensitive content or fail to mention actionable concerns.

Plan:

1. Add a small golden transcript set covering:
   - normal positive check-in
   - low engagement
   - medication reminder
   - emotional concern
   - cognitive/safety concern
   - web-search-heavy conversation
2. Add evaluator checks for:
   - caregiver usefulness
   - explicit sentiment
   - actionable follow-up when needed
   - no raw quotes
   - no unsupported medical or financial advice
   - no over-sharing in caregiver notifications
3. Run the evaluator locally against mocked or recorded model outputs first, then wire it into a lightweight CI job when stable.

### 8. Privacy and Log Hygiene Should Become a Post-Call Smoke Test

Current state:

- PHI-bearing post-call fields are encrypted.
- The recent pass removed one interest-label log line.
- Log review is still manual after live calls.

Risk:

- Future post-call changes can accidentally log sensitive summary, concerns, caregiver notes, or raw transcript snippets.

Plan:

1. Add a PHI-log smoke script that scans recent Railway logs for forbidden patterns after live dev calls.
2. Include post-call-specific patterns:
   - raw summary text
   - raw concern descriptions
   - transcript snippets
   - caregiver note content
   - reminder title/description
3. Document the smoke command in the Pipecat debug skill or production readiness doc.
4. Keep this as a pre-prod deployment checklist item.

## Execution Order

1. Implement real live active-call observability and verify with a dev call.
2. Add per-turn metrics persistence and update the observability metrics UI.
3. Clarify metrics semantics and add post-call step statuses.
4. Add durable post-call job state and a retry command.
5. Migrate onboarding post-call analysis to the shared structured analysis path.
6. Improve notification auditability.
7. Add summary quality evaluations.
8. Automate post-call log hygiene smoke checks.

## Validation Strategy

Each implementation slice should include:

- Targeted unit tests for changed service logic.
- Node API tests for observability route output shape.
- Observability frontend build.
- `make test-regression` for voice invariants.
- One Railway dev live call when the change touches live call state, Telnyx timing, or post-call background execution.
- A PHI-safe log review after live testing.
