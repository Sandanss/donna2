# Security Remediation Action Plan

> Historical remediation plan. Current voice ingress uses Telnyx Ed25519 webhook verification plus single-use WebSocket tokens; Twilio-specific findings below describe the old archived voice path.

Date: 2026-04-13
Branch: `security`

This plan is based on the OpenAI security report plus a targeted runtime review of the active Donna surfaces. The highest priority is preventing unauthorized or abusive call pipeline access, then closing PHI-at-rest and service-to-service fail-open gaps.

## Runtime Findings

### P0: Pipecat voice ingress is not actually protected

Impact: anyone who can reach Pipecat can post to `/voice/answer` or connect to `/ws`, causing STT/LLM/TTS spend and possible crafted audio injection. `/voice/status` can also be spoofed to force metadata cleanup.

Evidence:
- `pipecat/api/middleware/twilio.py` defines `verify_twilio_signature`, but `pipecat/api/routes/voice.py` mounts `/voice/answer` and `/voice/status` without `Depends(verify_twilio_signature)`.
- `pipecat/main.py` accepts `/ws` before any call token or metadata check.
- `pipecat/bot.py` has a `ws_token` check, but no `ws_token` is generated in `call_metadata` or included in the TwiML `<Stream>`. The check only fails if an expected token exists, so it is currently inert.
- `docs/architecture/SECURITY.md` says Twilio webhook validation is implemented for `/voice/*`; runtime code disagrees.

Remediation:
- Wire `verify_twilio_signature` onto `/voice/answer` and `/voice/status`.
- Fail closed in production if `TWILIO_AUTH_TOKEN` is missing, instead of warning and allowing unsigned webhooks.
- Generate a per-call random `ws_token` in `/voice/answer`, store only with `call_metadata`, and include it as a TwiML `<Parameter>`.
- Before starting the pipeline, reject any `/ws` connection whose `call_sid` has no metadata or whose `ws_token` does not match.
- Make `/ws` cleanup token-aware so a spoofed status callback cannot remove an active call's metadata.
- Add targeted tests for missing signature, invalid signature, valid signature, missing `ws_token`, invalid `ws_token`, and unknown `call_sid`.

Validation:
- `make test-python`
- Add Pipecat route/middleware unit tests for webhook and WebSocket admission.

### P0: Authenticated users can initiate calls to arbitrary numbers

Impact: any authenticated caregiver can trigger outbound Twilio calls to a phone number that is not a known senior, creating toll-fraud/cost-abuse risk. This is not an unauthenticated bypass, but it violates the report's goal that caregivers can only initiate calls for authorized seniors.

Evidence:
- `routes/calls.js` checks `canAccessSenior` only when `seniorService.findByPhone(phoneNumber)` returns a senior. If no senior is found, it still calls `twilioClient.calls.create`.
- `pipecat/api/routes/calls.py` mirrors the same behavior: access is checked only when `find_by_phone(phone)` returns a senior, then Twilio is called regardless.

Remediation:
- Change call initiation to require a `seniorId` or require that the supplied phone resolves to an active senior.
- For caregivers, reject calls unless `canAccessSenior` passes for that senior.
- For admins/cofounders, decide whether arbitrary-number calls are allowed. If yes, require an explicit override field, stricter rate limit, and audit metadata.
- Add per-user and per-senior daily call budgets.
- Add regression tests for caregiver calling assigned senior, caregiver calling unassigned senior, caregiver calling unknown phone, admin behavior, and rate limits.

Validation:
- `npm test`
- `make test-python`

### P0: Production secrets and internal API keys still fail open in places

Impact: a missing or legacy-only service API key configuration can disable service-to-service auth for Node `/api` middleware and `/api/notifications/trigger`; a missing `FIELD_ENCRYPTION_KEY` silently stores plaintext in fields that are supposed to be encrypted.

Evidence:
- `middleware/api-auth.js` skipped API key auth when `DONNA_API_KEY` was unset.
- `routes/notifications.js` allowed `/api/notifications/trigger` without `X-API-Key` when `DONNA_API_KEY` was unset.
- `lib/encryption.js` and `pipecat/lib/encryption.py` return plaintext when `FIELD_ENCRYPTION_KEY` is unset.
- `pipecat/api/middleware/twilio.py` warns but allows unsigned webhooks when `TWILIO_AUTH_TOKEN` is missing.

Remediation:
- Add production startup validation in both Node and Pipecat for `DONNA_API_KEYS`, `FIELD_ENCRYPTION_KEY`, `JWT_SECRET`, `TWILIO_AUTH_TOKEN`, `PIPECAT_PUBLIC_URL`, and Clerk configuration where applicable.
- Keep local/dev bypasses explicit with dev/test environment flags only.
- Use constant-time comparison for cofounder API keys too.
- Add a boot-time security health check that reports configuration categories without exposing secret values.

Validation:
- Unit tests for production boot failure when required secrets are absent.
- Smoke test both services with production-like env flags.

## P1: PHI field encryption is partial and still dual-writes plaintext

Impact: a database compromise still exposes substantial PHI. Current encryption covers some encrypted companion columns, but sensitive legacy/plain columns are still written and many PHI fields do not have encrypted companions.

Evidence:
- `conversations.summary`, `conversations.transcript`, `memories.content`, and `call_analyses.*` are still written in plaintext alongside encrypted companion columns.
- `seniors.medical_notes`, `seniors.family_info`, `seniors.additional_info`, `reminders.title`, `reminders.description`, `daily_call_context.*`, `notifications.content`, `notifications.metadata`, `caregiver_notes`, and `seniors.call_context_snapshot` have no encrypted companion in the inspected schema/code paths.
- `routes/seniors.js` and `pipecat/api/routes/export.py` export plaintext columns and do not use decrypt helpers for encrypted-only data.
- `docs/compliance/HIPAA_OVERVIEW.md` says application-level PHI encryption is not implemented, while runtime code shows partial implementation. The doc is stale and should be reconciled after the code plan is settled.

Remediation:
- Define the PHI field inventory and classify each field as encrypted, derived/minimized, or intentionally plaintext.
- Add encrypted columns for missing high-risk fields, starting with `seniors.medical_notes`, reminders, notifications, caregiver notes, daily context, and call snapshots.
- Backfill encrypted columns in batches.
- Stop writing plaintext for high-risk fields after backfill, or null plaintext after verified encrypted write.
- Update Node and Pipecat exports/read paths to prefer encrypted columns and decrypt only at the authorized boundary.
- Add operational key rotation and recovery runbook.

Validation:
- Migration/backfill tests on a scrubbed dev database.
- Export tests proving encrypted-only rows remain readable by authorized users.
- Tests proving missing `FIELD_ENCRYPTION_KEY` fails closed in production.

## P1: Prompt and third-party PHI exposure need tighter controls

Impact: caller speech and caregiver/senior context can expose PHI to external AI/search vendors and can be manipulated by prompt injection. This is a privacy and vendor-compliance risk even if app-layer auth is correct.

Evidence:
- Call prompts include senior profile, medical notes, memory context, recent turns, daily context, and caregiver notes.
- Web search can use conversation-derived queries via `pipecat/services/news.py`.
- The BAA tracker says no BAAs are signed and flags Cerebras, Cartesia, and Tavily as high-risk alternatives.

Remediation:
- Add a PHI minimization pass before every third-party request: remove names, phone numbers, raw caregiver notes, and unnecessary summaries where possible.
- For caregiver notes, store and inject only call-safe note content, not admin/caregiver-only private notes.
- Disable Tavily-backed web search in production until a BAA-compliant provider path is confirmed.
- Gate Cerebras/Cartesia behind production denylist flags unless BAAs are in place.
- Add prompt-injection regression scenarios around requests to reveal system prompts, caregiver notes, medical notes, and prior summaries.
- Track BAAs as a launch blocker for vendors receiving PHI: Neon, Twilio, Anthropic, Google, Deepgram, OpenAI, Sentry first; then Railway/ElevenLabs/Groq or replacements.

Validation:
- Prompt-injection simulation tests.
- Vendor allowlist test in production config.
- BAA tracker updated with signed dates or replacement decisions.

## P2: Retention and audit controls need correctness work

Impact: audit and retention controls exist but are not yet strong enough for the compliance risk described in the report.

Evidence:
- `services/data-retention.js` and `pipecat/services/data_retention.py` attempt batched `DELETE ... LIMIT`, which PostgreSQL does not support in that form.
- Audit log retention defaults are `730` days in Node and Pipecat, not the six-year retention described in the compliance docs.
- Retention purges do not cover several PHI-bearing tables or fields, including notifications, caregiver notes, waitlist, senior snapshots, and reminders.

Remediation:
- Fix retention SQL to delete by primary-key batches via CTE/subquery.
- Set audit log retention to six years by default.
- Add legal hold support before destructive purges.
- Extend retention coverage to all PHI tables and encrypted companion fields.
- Add a scheduled-purge health metric and alert when the purge fails or has not run.
- Keep audit logs append-only at the application layer.

Validation:
- Unit tests against a local Postgres-compatible database.
- Dry-run purge report with counts only, no content.

## P2: Frontend XSS risk appears lower, but should be locked down

Impact: stored XSS would be high-impact because transcripts, summaries, reminders, and notes are untrusted content. The quick scan did not find `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, DOMPurify bypasses, or markdown rendering in `apps/admin-v2`, `apps/consumer`, or `apps/observability`.

Remediation:
- Add an ESLint rule or CI grep preventing `dangerouslySetInnerHTML` and direct DOM HTML insertion in frontend apps unless explicitly security-reviewed.
- Keep transcript/note rendering as plain React text.
- Add frontend tests with transcript/note payloads containing `<script>`, event-handler attributes, and SVG payloads.
- Review CSP/security headers for the deployed frontend/API boundary.

Validation:
- `npm run test:e2e:admin`
- `npm run test:e2e:consumer`
- `npm run test:e2e:observability`

## Execution Order

1. Hotfix Pipecat voice ingress: Twilio signatures, production fail-closed behavior, WebSocket token admission.
2. Hotfix call initiation: require known authorized senior for caregiver calls; define admin override if needed.
3. Add production config guards for `DONNA_API_KEYS`, `FIELD_ENCRYPTION_KEY`, `TWILIO_AUTH_TOKEN`, `PIPECAT_PUBLIC_URL`, and Clerk configuration.
4. Add regression tests for P0 fixes and deploy Pipecat/Node dev services.
5. Implement PHI encryption backfill and stop plaintext dual-writes for the highest-risk fields as a separate PR/action item.
6. Restrict or replace non-BAA vendor paths and add third-party request minimization.
7. Repair retention/audit controls and reconcile compliance docs with runtime behavior.
8. Add frontend XSS guardrails and E2E malicious-content tests.

## Implementation Details

### P0 Build Scope: Pipecat Voice Ingress

Target files:
- `pipecat/api/routes/voice.py`
- `pipecat/api/middleware/twilio.py`
- `pipecat/main.py`
- `pipecat/bot.py`
- `pipecat/lib/redis_client.py`, if multi-instance metadata lookup needs a helper
- `pipecat/tests/`, for route and WebSocket admission tests

Implementation shape:
- Add `Depends(verify_twilio_signature)` to both `/voice/answer` and `/voice/status`.
- Change Twilio validation to fail closed whenever `RAILWAY_PUBLIC_DOMAIN` is set and `SKIP_TWILIO_VALIDATION` is not explicitly enabled for a non-production environment.
- Generate `ws_token = secrets.token_urlsafe(32)` in `/voice/answer`.
- Store `ws_token` in `call_metadata[call_sid]` and Redis metadata.
- Add `<Parameter name="ws_token" value="...">` to the TwiML `<Stream>`.
- Move WebSocket admission into a helper that:
  - reads the Twilio start frame via `parse_telephony_websocket`,
  - extracts `call_sid` and `ws_token`,
  - loads metadata from in-memory `call_metadata`, then Redis fallback,
  - rejects the connection before constructing STT/LLM/TTS services if metadata is missing or token mismatch occurs.
- Treat missing expected token as a hard failure in production. The current behavior only fails if an expected token exists.
- Ensure cleanup only removes metadata for the authenticated `call_sid`; do not let a spoofed `/voice/status` delete arbitrary metadata once webhook signatures are enforced.

Tests to add:
- `/voice/answer` without `X-Twilio-Signature` rejects in production mode.
- `/voice/status` without `X-Twilio-Signature` rejects in production mode.
- valid signed `/voice/answer` returns TwiML with `call_sid`, `conversation_id`, `call_type`, and `ws_token`.
- WebSocket start frame with unknown `call_sid` closes before pipeline setup.
- WebSocket start frame with missing or invalid `ws_token` closes before pipeline setup.
- WebSocket start frame with valid `call_sid` and token proceeds.

Questions before implementation:
- Is production detection always `RAILWAY_PUBLIC_DOMAIN`, or should `NODE_ENV=production` / an explicit `ENVIRONMENT=production` also fail closed?
- Do dev Railway environments need to accept unsigned Twilio webhooks, or can they use real Twilio signatures too?
- Is Redis enabled in production or can Pipecat run multiple instances without Redis? This determines whether unknown in-memory `call_sid` should check Redis before rejecting.
- Is `BASE_URL` always the public Pipecat URL that Twilio uses for signature validation and WebSocket URL generation?

### P0 Build Scope: Outbound Call Authorization

Target files:
- `routes/calls.js`
- `validators/schemas.js`
- `pipecat/api/routes/calls.py`
- `pipecat/api/validators/schemas.py`
- relevant Node and Pipecat tests

Implementation shape:
- Prefer changing manual call initiation to require `seniorId` instead of raw `phoneNumber` for caregiver-triggered calls.
- Resolve the senior by ID server-side, check `canAccessSenior`, then call the senior's stored phone number.
- Keep admin/cofounder arbitrary-number calling only if explicitly approved; if kept, require a separate field such as `allowUnknownNumber: true`, stricter rate limit, and audit metadata.
- Return `403` for assigned-senior failures and `404` or `400` for unknown senior/phone, without disclosing whether another caregiver owns the phone number.
- Keep Node and Pipecat behavior aligned, even if frontends normally call Node.

Tests to add:
- caregiver can call assigned active senior.
- caregiver cannot call unassigned senior.
- caregiver cannot call unknown phone number.
- caregiver cannot call inactive senior.
- admin/cofounder behavior matches the product decision.
- audit log records the call attempt with phone last four only.

Questions before implementation:
- Should the API change from `phoneNumber` to `seniorId`, or should it accept both during a transition?
- Should admins/cofounders be allowed to call arbitrary numbers at all?
- Should inactive seniors be callable by admins for support/testing, or rejected for everyone?
- What daily call cap should apply per caregiver and per senior?

### P0 Build Scope: Production Config Fail-Closed

Target files:
- `index.js`
- `middleware/api-auth.js`
- `routes/notifications.js`
- `middleware/auth.js`
- `pipecat/config.py`
- `pipecat/api/middleware/auth.py`
- `pipecat/api/middleware/twilio.py`
- `lib/encryption.js`
- `pipecat/lib/encryption.py`

Implementation shape:
- Add a single Node startup validation helper for required production secrets.
- Add a single Pipecat startup validation helper for required production secrets.
- Required in production:
  - `JWT_SECRET` not default
  - labeled `DONNA_API_KEYS`
  - `FIELD_ENCRYPTION_KEY` decodes to 32 bytes
  - `TWILIO_AUTH_TOKEN`
  - `PIPECAT_PUBLIC_URL` is an `https://` URL
  - Clerk JWKS config for Clerk-authenticated routes
- Keep local/test behavior explicit. For example, fail-open encryption can remain in unit tests only when production detection is false.
- Change `routes/notifications.js` so `/api/notifications/trigger` never skips auth in production when labeled service keys are missing.
- Change cofounder API key checks to use constant-time comparison.

Tests to add:
- Node boot/config validation fails in production when each required secret is missing.
- Pipecat boot/config validation fails in production when each required secret is missing.
- encryption helper returns plaintext in local dev but fails or refuses PHI writes in production without a key.
- notification trigger rejects missing `X-API-Key` in production.

Questions before implementation:
- Should `DONNA_API_KEYS` protect only service-to-service endpoints, or should the current broad `/api` middleware behavior stay as-is?
- Do we have a formal environment variable for staging/dev/prod, or should the implementation introduce one?
- Should missing encryption key crash the whole service in production, or only block routes/jobs that write PHI?

### P1 Build Scope: PHI Encryption Backfill

Status: **separate action item, not part of the current ingress/auth hardening PR.**

Reason: this needs schema changes, coordinated Node/Pipecat read/write updates, export behavior, and a backfill/release window. Keeping it separate makes the current P0/P2 security patch easier to review and safer to deploy.

Target files:
- `db/schema.js`
- `pipecat/db/migrations/`
- `lib/encryption.js`
- `pipecat/lib/encryption.py`
- Node services that write/read seniors, reminders, conversations, memories, analyses, notifications, daily context, and exports
- Pipecat services that write/read the same tables

Implementation shape:
- Start with a PHI inventory migration plan rather than changing all fields in one risky patch.
- Add encrypted companion columns for the highest-risk unencrypted fields: `seniors.medical_notes`, `seniors.family_info`, `seniors.additional_info`, `seniors.call_context_snapshot`, reminders, daily context, notifications, and caregiver notes.
- Backfill encrypted values in batches, logging counts only.
- Update reads to prefer encrypted columns and fall back to plaintext only during the migration window.
- Update writes to write encrypted columns first.
- Update export routes to decrypt at the authorized boundary and fail on decryption errors rather than silently using stale plaintext.
- After backfill verification, stop writing plaintext or null the plaintext columns for selected fields.
- Plan key rotation and recovery runbook after encrypted-first reads are deployed.

Questions before implementation:
- Are we allowed to add companion encrypted columns now, or do you want a separate schema design review first?
- Can we run a one-time backfill job against production, and who will hold the deployment window?
- Should encrypted companion columns live alongside plaintext for a transition period, or should plaintext be nulled immediately after backfill?
- Do we need key rotation support in this pass, or only key validation and encrypted writes?

### P1/P2 Build Scope: Vendor, Retention, Audit, and XSS Guardrails

Implementation shape:
- Vendor controls: add a production vendor allowlist and deny non-BAA providers for PHI paths.
- Retention: replace unsupported `DELETE ... LIMIT` with a supported primary-key batch delete pattern.
- Audit: set audit log default retention to six years and verify PHI read/write routes emit structured audit records.
- XSS: add a CI guard for `dangerouslySetInnerHTML`, `innerHTML`, and `insertAdjacentHTML` under frontend app source directories.

Questions before implementation:
- Which vendors currently have signed BAAs, if any?
- Should Tavily/Cerebras/Cartesia be disabled immediately in production while BAA status is unresolved?
- Do you want retention fixes in the same security PR series as ingress/auth, or as a follow-up PR?
- Should frontend XSS guardrails use ESLint, a small script in `package.json`, or both?

## Open Questions

- Should admins/cofounders be allowed to place arbitrary phone calls, or should all calls require a known senior?
- Is `BASE_URL` guaranteed to be Pipecat's public URL in every Pipecat deployment? If not, WebSocket token fixes should also harden URL construction.
- Which vendors have current signed BAAs as of the production environment, if any? The docs currently say none.

## Operational Lesson From Security Dev Smoke

Railway dev validation on April 14, 2026 proved the security + Redis call path worked end to end, but also showed that Pipecat `LOG_LEVEL=DEBUG` can emit sensitive prompt context and Twilio WebSocket parameters, including one-time `ws_token` values.

Before promoting security work to `main` or production:

- Set Pipecat `LOG_LEVEL=INFO` in Railway dev/staging/prod unless a short-lived incident explicitly requires debug logs.
- Treat any debug log mode on Pipecat as PHI-bearing and time-bound.
- Verify smoke-call logs do not include prompt context, transcripts, medical notes, caregiver notes, raw WebSocket parameters, or `ws_token` values.
- Patch or suppress third-party/Pipecat debug emitters before relying on `DEBUG` in a shared Railway environment.
