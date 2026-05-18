# Voice Pipeline Important TODOs

> Historical follow-up list. Current live-call source of truth is Telnyx L16/16k in `pipecat/api/routes/telnyx.py`, `pipecat/main.py`, `pipecat/bot.py`, and `pipecat/docs/ARCHITECTURE.md`. Twilio-specific wording below describes the old carrier path and should not be copied into new work.

Captured after the April 14, 2026 voice pipeline audit. The timezone fallback bug was fixed separately; the remaining items below should be treated as prioritized follow-up work.

## Implementation Status

Fixed on branch `codex/voice-pipeline-todos`:

- Inactive senior phone matches now take a no-PHI hangup path.
- Manual and welfare outbound calls are hydrated in Pipecat, so they no longer depend on Node process memory.
- Reminder acknowledgments keep the low-latency async DB write, but post-call waits briefly and re-reads delivery status before retry decisions.
- WebSocket start-frame auth now happens before consuming an active-call slot, with a short handshake timeout.
- Caregiver notes are marked delivered only after assistant transcript evidence.
- Caregiver notification triggers now raise on non-2xx responses and high-severity concerns send Node's expected `data.concern` string.
- Assistant transcript tracking now receives guidance-stripped text.
- Gemini Live now schedules and awaits post-call processing on both disconnect and normal pipeline end.
- General in-call web search no longer caches arbitrary live-query results.
- Node-scheduled reminder calls now include a reminder call hint, and Pipecat waits briefly for the `reminder_deliveries.call_sid` row before falling back to generic outbound handling.

## High Priority

### 1. Block inactive senior matches in Pipecat phone lookup

- **Status**: Fixed. `find_by_phone()` is active-only by default; inactive matches return safe hangup TwiML without loading senior context or creating a conversation.
- **Why it matters**: `pipecat/services/seniors.py::find_by_phone()` returns seniors by phone regardless of `is_active`. `pipecat/api/routes/voice.py` then treats any match as a real senior and can load PHI context.
- **Risk**: A deactivated or soft-deleted senior can still be recognized on inbound calls and get conversation records/context.
- **Fix direction**: Make phone lookup active-only by default, add an explicit inactive lookup only where needed, and have `/voice/answer` take a no-PHI path for inactive matches.

### 2. Persist Node-created outbound call context across the Node to Pipecat boundary

- **Status**: Fixed by Pipecat-side hydration. Redis reminder context remains in place; generic manual/welfare outbound calls hydrate memory, snapshot, notes, news, greeting, and settings inside `/voice/answer`.
- **Why it matters**: Node creates manual and welfare calls, then stores prefetch context only in local Maps. The telephony callback lands on Pipecat, which cannot read Node process memory.
- **Risk**: Manual/welfare calls can start without the memory context, snapshot, caregiver notes, news, greeting, and call settings that Node just prepared.
- **Fix direction**: Either hydrate full context in Pipecat for every known outbound senior, or persist Node prefetch by `CallSid` in shared Redis/DB and have Pipecat consume it.

### 3. Make reminder acknowledgment persistence reliable

- **Status**: Fixed with async write plus post-call verification. The tool still returns immediately, but post-call waits briefly for the ack task and re-reads `reminder_deliveries.status`; local `reminders_delivered` no longer suppresses retry cleanup by itself.
- **Why it matters**: The reminder tool marks local `reminders_delivered` before the DB update completes, then post-call skips retry cleanup when that local set is non-empty.
- **Risk**: If the DB acknowledgement write fails, a medication reminder may remain `delivered` rather than `acknowledged` or `retry_pending`.
- **Fix direction**: Track DB ack success, await the ack write in the tool, or have post-call re-read `reminder_deliveries.status` before deciding no retry is needed.

### 4. Authenticate WebSockets before consuming active-call capacity

- **Status**: Fixed. The Telnyx media-stream start frame and `ws_token` are validated before semaphore acquisition; token consumption happens only after capacity is reserved.
- **Why it matters**: `/ws` accepts a WebSocket and consumes the call semaphore before the Telnyx start frame is parsed and the `ws_token` is validated.
- **Risk**: A client can connect and stall before auth, tying up active-call capacity without starting AI services.
- **Fix direction**: Add a short handshake/auth timeout and only count calls as active after the Telnyx start frame is received and the token validates.

### 4.5. Avoid the Node reminder delivery row race

- **Status**: Fixed. Node and Pipecat reminder schedulers pass reminder call context to Pipecat; Pipecat uses that context to retry the DB lookup briefly before treating the call as generic outbound.
- **Why it matters**: Telephony callbacks can arrive before Node has committed the `reminder_deliveries` row containing the new call identifier.
- **Risk**: A medication or appointment reminder can hydrate as a generic outbound check-in and skip the reminder prompt/acknowledgment tracking.
- **Fix direction**: Keep the retry path scoped to tagged reminder calls so manual and welfare calls do not pay the delay.

## Medium Priority

### 5. Mark caregiver notes delivered only after actual delivery

- **Status**: Fixed conservatively. Notes are marked delivered post-call only when Donna's assistant transcript contains enough matching content. Uncertain delivery remains undelivered so it can be retried later.
- **Why it matters**: Caregiver notes are marked delivered on client connect, while the prompt only asks Donna to share them naturally.
- **Risk**: A note can be marked delivered even if Donna never says it.
- **Fix direction**: Mark notes delivered based on explicit delivery evidence, transcript confirmation, or a dedicated delivery tool/event.

### 6. Harden caregiver notification delivery and concern payload shape

- **Status**: Fixed. Notification POSTs now call `raise_for_status()` and concern alerts send `data.concern` plus structured metadata.
- **Why it matters**: Pipecat posts caregiver notifications without checking non-2xx HTTP status. High-severity concern notifications send the raw concern object, while Node expects `data.concern`.
- **Risk**: Bad API keys, validation errors, or server errors can silently drop caregiver alerts; concern alerts can send generic text instead of the real concern summary.
- **Fix direction**: Call `response.raise_for_status()`, log response status safely, retry if appropriate, and send a privacy-safe `concern` string in the shape Node expects.

### 7. Store only guidance-stripped assistant transcript text

- **Status**: Fixed. `GuidanceStripperProcessor` now runs before assistant transcript tracking.
- **Why it matters**: The pipeline records assistant text before `GuidanceStripperProcessor` removes internal guidance/bracketed directives.
- **Risk**: Internal tags or model-spoken guidance can be persisted in encrypted transcripts and post-call analysis input.
- **Fix direction**: Move assistant transcript tracking after guidance stripping or apply the same stripping before recording assistant turns.

### 8. Mirror Claude post-call lifecycle in Gemini Live

- **Status**: Fixed. Gemini Live now uses a start-once post-call task and awaits it after pipeline end.
- **Why it matters**: The Claude path starts post-call once and awaits it after pipeline end. The Gemini Live path only starts post-call on client disconnect and does not await/track it.
- **Risk**: Gemini calls ended by the `end_call` tool may skip post-call processing.
- **Fix direction**: Reuse the Claude `_start_post_call_once` pattern for Gemini Live and ensure post-call runs on both disconnect and normal pipeline end.

## Lower Priority

### 9. Remove general live web-search result caching

- **Status**: Fixed. Daily senior-interest news caching remains; arbitrary `web_search_query()` results are no longer cached.
- **Why it matters**: The learnings doc says general web-search caching was removed, but `pipecat/services/news.py::web_search_query()` still caches arbitrary live-query results for one hour.
- **Risk**: A stale or wrong result can be reused for later questions.
- **Fix direction**: Keep daily senior-interest news caching, but remove or sharply limit general in-call web-search result caching. In-flight dedup is safer than reuse.
