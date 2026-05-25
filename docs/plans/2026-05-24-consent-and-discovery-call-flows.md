# Consent + Discovery Call Flows — Pipecat Execution Plan

**Created**: 2026-05-24 | **Branch**: `feat/permission-discovery-calls` (off `zuludev`)
**Scope**: Pipecat voice pipeline only. Mobile/dashboard work for consent is owned by [`2026-05-17-senior-consent-verification-flow.md`](2026-05-17-senior-consent-verification-flow.md) (Facundo).

---

## Context

We need two new outbound call types:

1. **`consent`** — Donna calls the senior, identifies as an AI assistant, explains who set the account up, and asks for explicit permission to (a) call them and (b) record the calls. Implements PART 3 of the May 17 spec. The mobile / dashboard work (parts 1 and 2 of that spec) is out of scope here.

2. **`discovery`** — A new flow Nick and I discussed on 2026-05-24. After a senior has granted consent, Donna calls to get a richer picture of them (friends, hobbies, daily routines, family) and lightly explains what Donna can do for them. Output feeds context for every subsequent check-in.

Today, four `call_type` values exist: `check-in` (default), `reminder`, `schedule`, `onboarding`. This plan adds `consent` and `discovery`.

---

## Reference: how `onboarding` is wired today

The codebase already supports per-call-type flows via three pivot points — both new flows follow the same shape:

| Layer | File | Existing pivot |
|---|---|---|
| Outbound trigger | `pipecat/api/routes/telnyx.py` | `TelnyxOutboundCallRequest.call_type` is a free string; metadata carries it through |
| Pipeline assembly | `pipecat/bot.py` (~line 802) | `if call_type == "onboarding": make_onboarding_flows_tools(...)` else default |
| Flow entry | `pipecat/flows/nodes.py:build_initial_node` (line 889) | `if call_type == "onboarding": build_onboarding_node(...)` etc. |
| Prompts | `pipecat/prompts.py` | `ONBOARDING_SYSTEM_PROMPT`, `ONBOARDING_TASK_FIRST_CALL`, ... |
| Tools | `pipecat/flows/tools.py` | `make_onboarding_flows_tools(session_state)` |

The first refactor in this plan turns the two `if` chains into a small dispatch dict so adding more call types stays one-liner-clean.

---

## Decisions locked in for this plan

These came from a 2026-05-24 sync. Calling them out here so reviewers don't relitigate.

1. **Consent storage = `senior_consents` audit table + denormalized `seniors.consentStatus` column.** The audit table is the source of truth; the column is what the call queue gates on (fast index lookup, avoids a join per dispatch).
2. **Two separate consents** captured by the consent call: `call_permission` and `recording_permission`. The May 17 spec proposed a single `consentStatus` value — that doesn't represent "ok to call but not record". The audit table stores each consent as its own row; the denormalized `consentStatus` column rolls them up (`granted` only when both = true; `declined` when either = false; `pending` until both captured).
3. **On decline:** flip a new dedicated `seniors.callable = false` column and enqueue a caregiver notification. Rationale: `isActive` is caregiver-controlled soft-pause; `callable` is consent-driven. Keeping them separate preserves the ability to distinguish "caregiver paused" from "senior declined". Scheduler/queue queries that currently gate on `isActive` must be tightened to also check `callable = true AND consent_status = 'granted'` before consent calls go live. Migration ships the partial index `idx_seniors_dispatchable` covering that triple-predicate.
4. **Discovery output:** every `record_discovery_fact` tool call writes to the `memories` table immediately (high importance). A post-call analyzer builds a structured `profile_suggestions` payload for caregiver review. We do **not** auto-mutate `seniors.interests` or `family_info` — caregivers own the profile; an AI call should propose, not overwrite.

---

## Two new call types

### `consent` — permission + AI disclosure

Goal: get explicit, recorded "yes" or "no" from the senior on two questions, in a stripped-down call.

**Pipeline stripping** (per May 17 spec):
- No web search, no memory write/extraction, no Conversation Director, no predictive prefetch, no caregiver notes injection.
- Keep: Deepgram STT, Claude Haiku, ElevenLabs TTS, single consent tool, Quick Observer for decline-detection only.

**New artifacts:**

| File | Addition |
|---|---|
| `pipecat/prompts.py` | `CONSENT_SYSTEM_PROMPT` (warm, short, no other agenda — identifies as AI up front, names the caregiver) + `CONSENT_TASK` (script: greet → identify as AI → name caregiver → explain what Donna does → ask call permission → ask recording permission → confirm + close) |
| `pipecat/flows/nodes.py` | `build_consent_node()` + `build_consent_closing_node()`; add `consent` to the dispatch in `build_initial_node` |
| `pipecat/flows/tools.py` | `RECORD_CONSENT_RESPONSE_SCHEMA` + handler; `make_consent_flows_tools()` exposing only this one tool. Args: `{ consent_type: "call_permission" | "recording_permission", granted: bool, senior_quote?: string }` |
| `pipecat/services/seniors.py` | `record_consent(senior_id, conversation_id, consent_type, granted, quote)` — inserts into `senior_consents`, then re-computes and writes `seniors.consentStatus` + `seniors.consentDate`; if rolled-up status is `declined`, also sets `isActive = false` |
| `pipecat/processors/patterns.py` (optional) | Add a "clear decline" pattern (e.g. "no", "I don't want", "please don't call") so Quick Observer can fast-track winding down if Claude doesn't react |
| `pipecat/bot.py` | Branch in pipeline construction: when `call_type == "consent"`, skip Director, prefetch, caregiver-notes prefetch (those processors get conditionally added) |
| `pipecat/api/routes/telnyx.py` | No schema change (call_type is already free-form); just make sure the prewarmed-context validator accepts `consent` |
| `db/schema.js` | Add `senior_consents` table + `consentStatus` (enum: `pending` / `granted` / `declined`) + `consentDate` on `seniors` |
| `pipecat/db/migrations/026_senior_consents.sql` | The actual migration |

**`senior_consents` schema:**

```sql
CREATE TABLE senior_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  consent_type VARCHAR(50) NOT NULL,  -- 'call_permission' | 'recording_permission'
  granted BOOLEAN NOT NULL,
  senior_quote_encrypted TEXT,        -- verbatim, PHI-encrypted
  captured_by VARCHAR(50) NOT NULL,   -- 'donna_tool' | 'manual'
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT senior_consents_unique_latest UNIQUE (senior_id, consent_type, captured_at)
);
CREATE INDEX senior_consents_senior_idx ON senior_consents(senior_id, consent_type, captured_at DESC);

ALTER TABLE seniors ADD COLUMN consent_status VARCHAR(20) NOT NULL DEFAULT 'pending';
ALTER TABLE seniors ADD COLUMN consent_date TIMESTAMPTZ;
```

Roll-up rule (computed in `record_consent` after each insert):
- Both consents have a most-recent row with `granted = true` → `consent_status = 'granted'`, `consent_date = max(captured_at)`, `callable = true`.
- Any most-recent row has `granted = false` → `consent_status = 'declined'`, `callable = false`.
- Otherwise → `consent_status = 'pending'`, `callable` unchanged.

**Post-call hook:** A lightweight check that verifies both consent rows landed in `senior_consents` for this conversation. If only one was captured, dead-letter the call and surface to caregivers — re-consent attempt rather than silently moving on.

---

### `discovery` — friends, hobbies, interests + light Donna intro

Goal: warm, curious conversation that fills out the senior's profile and primes them on what Donna can do. Runs after consent has been granted.

**Pipeline configuration:** full stack (Director on, memories on, web search on so Donna can riff on news/weather they mention).

**New artifacts:**

| File | Addition |
|---|---|
| `pipecat/prompts.py` | `DISCOVERY_SYSTEM_PROMPT` (warm + curious + light on Donna's capabilities) + `DISCOVERY_TASK` (loose 3-beat script: greet → discover with example-driven prompts → tee up what Donna can do, naming 1-2 capabilities tied to what they shared → warm close) |
| `pipecat/flows/nodes.py` | `build_discovery_node()`; reuse `build_closing_node`. Add `discovery` to dispatch. |
| `pipecat/flows/tools.py` | `RECORD_DISCOVERY_FACT_SCHEMA` + handler. Args: `{ category: "friend" | "hobby" | "interest" | "routine" | "family", content: string, confidence: "stated" | "inferred" }`. Handler stores into `memories` via `services.memory.store()` with `type=preference` (mapped from category) and `importance=80`. Plus existing `web_search`. Wrapped in `make_discovery_flows_tools()`. |
| `pipecat/services/call_analysis.py` | New analyzer mode for discovery calls: extracts structured `profile_suggestions` payload (proposed adds to `interests`, `family_info.interestDetails`, `family_info.friends`) — saved to a new `profile_suggestions` JSONB column on `conversations` (or a separate `profile_suggestions` table; will pick during implementation based on review surface) |
| `apps/admin-v2/...` (later, out of scope here) | Caregiver-review surface to accept/reject suggestions — Pipecat side just produces the payload |

The post-call extractor for discovery should be **conservative**: only include suggestions where the senior stated something explicitly. Inferred items get downweighted or filtered.

---

## Cross-cutting scaffolding (done once)

1. **Dispatch refactor** — `pipecat/flows/nodes.py:build_initial_node` becomes:
   ```python
   CALL_TYPE_INITIAL_NODES = {
       "onboarding": build_onboarding_node,
       "consent": build_consent_node,
       "discovery": build_discovery_node,
   }
   def build_initial_node(session_state, flows_tools):
       call_type = session_state.get("call_type", "")
       builder = CALL_TYPE_INITIAL_NODES.get(call_type)
       if builder:
           _record_phase_transition(session_state, call_type)
           return builder(session_state, flows_tools)
       # ...existing reminder / schedule / main fallback
   ```
   Same shape for `pipecat/bot.py` tool-factory selection.

2. **Director awareness** — `pipecat/services/director_llm.py:138` already mentions `onboarding`. Add brief lines for `consent` ("script-driven, do not improvise; capture both consents before closing") and `discovery` ("explore friends/hobbies/family; one question per turn; reference what they say"). For consent we'll likely skip the Director entirely; for discovery it stays on.

3. **Manual trigger** — `routes/calls.js` already proxies to Pipecat's `/telnyx/outbound`. The new call types pass through with no API change. Admin-v2 button and mobile dashboard CTA are downstream work (see May 17 spec part 2).

4. **Mock-call simulator** — `pipecat/tests/simulation/` gets two scenarios: `consent_grant`, `consent_decline`, and `discovery_chatty`. Critical for iterating on prompts before burning real Telnyx minutes — consent calls especially need to be tight.

---

## Files touched (summary)

| File | Change |
|---|---|
| `db/schema.js` | + `senior_consents` table, + `consentStatus`/`consentDate` on `seniors` |
| `pipecat/db/migrations/026_senior_consents.sql` | New migration |
| `pipecat/prompts.py` | + `CONSENT_SYSTEM_PROMPT`, `CONSENT_TASK`, `DISCOVERY_SYSTEM_PROMPT`, `DISCOVERY_TASK` |
| `pipecat/flows/nodes.py` | + dispatch dict; + `build_consent_node`, `build_consent_closing_node`, `build_discovery_node` |
| `pipecat/flows/tools.py` | + `RECORD_CONSENT_RESPONSE_SCHEMA`/handler, + `RECORD_DISCOVERY_FACT_SCHEMA`/handler, + `make_consent_flows_tools`, `make_discovery_flows_tools` |
| `pipecat/bot.py` | Dispatch tool factory by call_type; conditionally skip Director/prefetch for consent calls |
| `pipecat/services/seniors.py` | + `record_consent()` (insert + roll-up + isActive flip) |
| `pipecat/services/call_analysis.py` | + discovery-mode analyzer that emits `profile_suggestions` |
| `pipecat/services/director_llm.py` | + call-type guidance lines for `consent` and `discovery` |
| `pipecat/processors/patterns.py` | (optional) + decline pattern for Quick Observer fast-track |
| `pipecat/api/routes/telnyx.py` | Allow new call types in prewarmed-context validation |
| `pipecat/tests/simulation/` | + `consent_grant`, `consent_decline`, `discovery_chatty` scenarios |
| `DIRECTORY.md` | Updated lookup table entries |
| `CLAUDE.md` | Brief mention of new call types under "voice pipeline at a glance" |

---

## Execution order

1. **Plan + scaffolding refactor** — this doc + dispatch dicts in `bot.py` and `build_initial_node`. No behavior change yet.
2. **DB migration + Drizzle schema + `record_consent()` service.** Land independently; carries compliance weight.
3. **Consent call end-to-end:** prompts → node → tool → wire through `bot.py` → mock-call scenarios for grant + decline.
4. **Discovery call end-to-end:** prompts → node → tool → mock-call scenario.
5. **Post-call:** consent verification check; discovery profile-suggestions extractor.
6. **Docs:** update `DIRECTORY.md` + `CLAUDE.md` after the above lands.

Steps 3 and 4 are independent — could be parallelized across two PRs. I'll squash the scaffolding (1+2) into a foundation PR and split consent (3) and discovery (4) into separate PRs so consent (which has legal/compliance review needs) can ship on its own timeline.

---

## Out of scope

- Mobile "Let your loved one know" screen — owned by Facundo per May 17 spec.
- Dashboard consent-status banner / "schedule consent call" CTA — owned by Facundo per May 17 spec.
- Caregiver-review UI for `profile_suggestions` from discovery calls — Pipecat side just produces the payload.
- Scheduler integration to auto-trigger discovery as a follow-up to a granted consent call. Manual trigger first; auto-scheduling lands in a follow-up once we've watched a few real discovery calls.
- Re-consent flows, consent expiration, SMS-based consent — same as May 17 spec, deferred.

---

## Open questions for follow-up

- Should discovery be eligible for inbound calls (senior calls back after a consent call)? Currently designed outbound-only; inbound would route to the existing onboarding flow.
- Recording-permission UX: if the senior says yes to calls but no to recording, do we keep calling without recording? That requires Telnyx-side changes and a meaningful product decision (the analyzer + memory features all depend on transcripts). Out of scope here — for v1, recording decline → full decline.
