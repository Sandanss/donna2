# Security Architecture

> Security measures implemented across the Donna voice pipeline and API layer.

---

## Security Model Overview

Donna uses defense-in-depth with multiple layers:

```
Request → Security Headers → Rate Limiting → Authentication → Input Validation → Handler
                                                                                    │
                                                                                    ▼
                                                                           Error Handler
                                                                        (no internal leaks)
```

---

## Authentication (3-Tier)

**File**: `pipecat/api/middleware/auth.py`

Three authentication methods, checked in priority order:

| Tier | Method | Use Case | Header |
|------|--------|----------|--------|
| 1. Cofounder API Key | Static key (constant-time comparison) | Full access bypass | `X-Api-Key` |
| 2. Admin JWT | HS256 Bearer token | Admin dashboard | `Authorization: Bearer <token>` |
| 3. Clerk Session | RS256 session token | Caregiver website/mobile users | `X-Clerk-Token` or `__session` cookie |

```python
# FastAPI dependency injection
@app.get("/api/seniors")
async def list_seniors(auth: AuthContext = Depends(require_auth)):
    ...
```

**AuthContext** returned for each request:
- `is_cofounder: bool` — full access
- `is_admin: bool` — admin-level access
- `user_id: str` — authenticated user identifier
- `clerk_user_id: str | None` — Clerk-specific ID

### Cofounder API Key Auth (`pipecat/api/middleware/auth.py`)
- `COFOUNDER_API_KEY_1` / `COFOUNDER_API_KEY_2` env vars provide full-access cofounder bypass
- Checked before admin JWT and Clerk session auth
- Use only for trusted operator/service access

### Node API Key Auth (`middleware/api-auth.js`)
- Production uses labeled `DONNA_API_KEYS` entries such as `pipecat:<key>,scheduler:<key>` for service-to-service calls
- `DONNA_API_KEY` is accepted only as a local/test compatibility fallback outside production
- Constant-time comparison via `crypto.timingSafeEqual()`
- Route prefixes that own JWT/Clerk auth are exempt
- Missing service keys fail closed in production

### Node Clerk Caregiver Auth (`middleware/auth.js`, `routes/caregivers.js`)
- Caregiver website and mobile clients authenticate to the repo-root Node API with Clerk session tokens.
- `/api/caregivers/me` returns linked senior profiles only after Clerk auth and caregiver-link lookup.
- A signed-in Clerk user with no Donna profile is not a valid mobile destination. The mobile app calls `DELETE /api/caregivers/me/incomplete-account` for abandoned setup or no-profile sign-in recovery.
- The incomplete-account cleanup route refuses to delete if any caregiver profile exists for the Clerk user, audit-logs the pending account deletion, deletes the Clerk user when possible, and returns a recoverable `202` if Clerk deletion fails after local cleanup can proceed.
- Full account deletion remains separate at `DELETE /api/caregivers/me/account`, with idempotency, senior unlink/delete behavior, and audit logging.

---

## Telnyx Webhook Validation

**File**: `pipecat/api/routes/telnyx.py`

`/telnyx/events` verifies Telnyx Ed25519 webhook signatures:

- Uses `TELNYX_PUBLIC_KEY`, `telnyx-signature-ed25519`, and `telnyx-timestamp`
- Enforces the configured timestamp tolerance (`TELNYX_WEBHOOK_TOLERANCE_SECONDS`)
- **Production**: Rejects unsigned or invalid requests with 403
- **Development/test**: Allows unsigned webhooks only when `ALLOW_UNSIGNED_TELNYX_WEBHOOKS=true`
- Required env vars: `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CONNECTION_ID`, `TELNYX_PHONE_NUMBER`

Telnyx media stream WebSockets are gated separately:

- `/telnyx/events` or `/telnyx/outbound` generates a random single-use `ws_token` and includes it in the Telnyx stream URL
- `/ws` parses the Telnyx start frame with a short timeout and validates `call_control_id` + `ws_token` before consuming active-call capacity
- After capacity is reserved, `/ws` consumes the single-use token before constructing STT/LLM/TTS services
- Tokens expire after five minutes only if unused; active calls are not disconnected by token expiry
- Redis-backed metadata is used when configured so multi-instance Pipecat can validate call state

---

## Rate Limiting

**File**: `pipecat/api/middleware/rate_limit.py`

Five rate limit tiers using `slowapi` (backed by in-memory storage, keyed by remote address):

| Tier | Limit | Applies To |
|------|-------|-----------|
| API General | 100/minute | All `/api/*` routes |
| Call Initiation | 5/minute | `POST /api/call` |
| Write Operations | 30/minute | POST/PUT/DELETE |
| Auth Endpoints | 10/minute | Login/token endpoints |
| Webhooks | 500/minute | Telnyx callbacks |

---

## Security Headers

**File**: `pipecat/api/middleware/security.py`

Applied to all responses via `SecurityHeadersMiddleware`:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME sniffing |
| `X-Frame-Options` | `DENY` | Prevent clickjacking |
| `X-XSS-Protection` | `1; mode=block` | XSS filter |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Force HTTPS |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer info |
| `X-Request-Id` | UUID (from request or generated) | Request tracing |

---

## Input Validation

**Files**: `pipecat/api/validators/schemas.py`, `validators/schemas.js`

Pipecat API inputs are validated via Pydantic models before reaching handlers:

| Schema | Validates |
|--------|----------|
| `CreateSeniorRequest` | name (1-255 chars), phone (E.164), timezone, interests, `family_info`, `medical_notes`, `preferred_call_times` |
| `UpdateSeniorRequest` | Same fields, all optional |
| `CreateMemoryRequest` | type (10 allowed values), content (1-5000 chars), importance (0-100) |
| `CreateReminderRequest` | type (5 allowed values), title (1-255), scheduled_time, cron |
| `InitiateCallRequest` | seniorId/senior_id; server resolves phone after authorization |
| `AdminLoginRequest` | email, password |

Node/frontend API inputs are validated through Zod. Senior create/update accepts timezone, interests, `familyInfo`, medical notes, preferred call times, city/state/zip, and `additionalInfo`. Onboarding additionally validates Donna language, interest detail text, reminders, call schedule, and `topicsToAvoid`.

Caregiver/admin call initiation does not accept arbitrary client-supplied phone numbers. The API accepts a senior ID, checks authorization, then resolves the stored senior phone number server-side.

---

## PII Protection

**File**: `pipecat/lib/sanitize.py`

All log output passes through sanitization:

| Function | Input | Output |
|----------|-------|--------|
| `mask_phone("+15551234567")` | Full phone | `***4567` |
| `mask_name("David Zuluaga")` | Full name | `David Z.` |
| `truncate("long content", 30)` | Full text | `long content...` (truncated) |

Used across all service modules for Railway log output.

---

## Field-Level PHI Encryption

**Files**: `pipecat/lib/encryption.py`, `lib/encryption.js`

Donna stores newly persisted conversation transcripts and call summaries in AES-256-GCM encrypted companion columns:

- `conversations.transcript_encrypted` stores the structured turn list for authorized admin/export/post-call use. Assistant turns are recorded after internal guidance stripping so `<guidance>` tags and bracketed directives are not persisted.
- `conversations.transcript_text_encrypted` stores a plain-text transcript rendering for future retrieval and analysis.
- `conversations.summary_encrypted` stores call summaries used by caregiver and admin views.

The legacy plaintext `conversations.transcript`, `conversations.summary`, and `conversations.concerns` columns remain read fallbacks for rows created before the encrypted migration and are included in retention purges. New transcript, summary, and concern writes should not populate those plaintext columns.

New semantic memory writes store the memory body in `memories.content_encrypted` and use a non-PHI placeholder in the legacy non-null `memories.content` column. New call analysis writes store PHI-bearing analysis details in `call_analyses.analysis_encrypted`; legacy plaintext analysis columns remain read fallbacks for older rows.

Redis/shared-state call payloads are also treated as PHI. Pipecat writes `call_metadata:{call_sid}` and `reminder_ctx:{call_sid}` through `pipecat/lib/shared_state_phi.py`, storing encrypted strings in Redis with short TTLs while preserving read compatibility for legacy raw dict entries during deployment.

The remaining high-risk PHI fields now follow the same companion-column pattern:

- Senior profile PHI: `family_info_encrypted` (relationship, Donna language, date of birth, interest detail text, topics to avoid), `medical_notes_encrypted`, `preferred_call_times_encrypted`, `additional_info_encrypted`, and `call_context_snapshot_encrypted`.
- Reminders: `title_encrypted`, `description_encrypted`, and `reminder_deliveries.user_response_encrypted`.
- Daily call context: `daily_call_context.context_encrypted`.
- Notifications: `content_encrypted` and `metadata_encrypted`.
- Waitlist/prospect/caregiver-note data: `waitlist.payload_encrypted`, `prospects.details_encrypted`, and `caregiver_notes.content_encrypted`.

New Node and Pipecat writes populate these encrypted columns and keep legacy PHI columns blank or set to the non-PHI placeholder `[encrypted]` where a `NOT NULL` constraint still exists. Reads and exports decrypt server-side only after authentication/authorization and fall back to legacy plaintext during the migration window.

Caregiver clients do not receive encrypted blobs or decryption keys. The Node API authenticates the caregiver, verifies per-senior access, decrypts the summary server-side, and returns summary-only call records via `/api/seniors/:id/calls`. Admin conversation routes may return decrypted transcripts for the admin transcript viewer.

---

## Error Handling

**File**: `pipecat/api/middleware/error_handler.py`

Global exception handlers prevent internal details from leaking:

- **Unhandled exceptions** → `500 {"error": "An internal error occurred"}` (no stack trace)
- **ValueError** → `400 {"error": "<message>"}` (safe validation errors)
- All errors logged with `X-Request-Id` for correlation
- Sentry integration captures full error context server-side

---

## CORS Policy

**File**: `pipecat/main.py` (lines 101-115)

| Environment | Allowed Origins |
|-------------|----------------|
| Production | `https://admin-v2-liart.vercel.app`, `ADMIN_URL` env var |
| Development | Above + `http://localhost:5173`, `http://localhost:3000` |

---

## Environment Variable Security

**File**: `pipecat/config.py`

- All env vars centralized in a `frozen=True` dataclass (immutable after load)
- `lru_cache(maxsize=1)` ensures single-load behavior
- `ENVIRONMENT=production` or `RAILWAY_PUBLIC_DOMAIN` enables production fail-closed behavior. This applies to Railway staging too, because staging has a public Railway domain.
- `JWT_SECRET`, `DONNA_API_KEYS`, `FIELD_ENCRYPTION_KEY`, `PIPECAT_PUBLIC_URL`, `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_PHONE_NUMBER`, and `TELNYX_CONNECTION_ID` are required in production
- Node also requires `CLERK_SECRET_KEY` for Clerk-authenticated routes in production
- `PIPECAT_REQUIRE_REDIS=true` requires `REDIS_URL` before horizontal scaling
- API keys stored as env vars, never committed to code
- Sentry configured with `send_default_pii=False`

### Mobile Public Build Environment

`apps/mobile/app.config.js` resolves public mobile runtime config from the selected EAS environment into Expo `extra`.

- `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` are required for local Expo and every EAS build profile.
- `apps/mobile/eas.json` maps `development`, `preview`, and `production` build profiles to matching EAS environments.
- Publishable Clerk keys are not secrets, but logs and docs should still print only variable names/presence, never full values.
- The mobile bundle does not fall back to production when either value is missing; the app throws a clear runtime config error instead.
- Native Apple auth requires the checked-in iOS entitlement plus Clerk/Apple Developer configuration for bundle ID `com.donna.caregiver`. A stale dev-client binary can load fresh JS while missing the entitlement, so rebuild before debugging Apple auth failures.

### Deployment Checklist

Before deploying any public Railway environment, including staging and production:

- Set `ENVIRONMENT=production` on Railway services.
- Set `PIPECAT_PUBLIC_URL=https://...` to the public Pipecat service URL.
- Set labeled `DONNA_API_KEYS`; do not rely on legacy `DONNA_API_KEY` in production.
- Verify `FIELD_ENCRYPTION_KEY` decodes to 32 bytes.
- Verify Telnyx credentials exist on Pipecat and the Node service can reach Pipecat's `/telnyx/outbound` route.
- Verify `CLERK_SECRET_KEY` exists on Node.
- Verify the EAS `development`, `preview`, and `production` environments include `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` before building mobile binaries.
- Set `REDIS_URL` before running more than one Pipecat instance.
- Set Pipecat `LOG_LEVEL=INFO` for Railway dev/staging/prod before smoke testing or promotion.
- Verify Railway logs do not contain prompt context, transcripts, medical notes, caregiver notes, raw WebSocket parameters, or `ws_token` values.
- Smoke test real Telnyx webhook signatures, `/ws` token rejection/reuse, inbound audio, outbound audio, and a call longer than five minutes.

### PHI Encryption Migration Runbook

The code and schema support encrypted-only new writes, but each deployed database still needs the migration/backfill sequence:

1. Apply `db/migrations/002_encrypt_remaining_phi.sql` or `pipecat/db/migrations/009_encrypt_remaining_phi.sql` to the target Neon database.
2. Deploy Node and Pipecat with the same 32-byte `FIELD_ENCRYPTION_KEY`.
3. Run `node scripts/backfill-encrypted-phi.js --write` against the target database. The script logs counts only and does not print PHI.
4. Verify admin reads, senior export, reminder calls, daily context, notifications, and onboarding still work.
5. Run `node scripts/backfill-encrypted-phi.js --write --null-plaintext` to clear legacy PHI columns after verification.
6. Re-run export and reminder-call smoke tests, then review Railway logs for PHI leakage.

Operational lookup/display fields such as senior name, phone, timezone, city/state/ZIP, and interests remain plaintext for now. Treat them as minimized PII/operational data, not as a substitute for the encrypted PHI fields.

### Current Security Gaps From May 5 Audit

These are known gaps, not implemented safeguards:

- Website onboarding stores credentials and PHI-bearing onboarding data in plaintext `localStorage` under `donna_onboarding`. This should be removed or replaced with minimized, encrypted, short-lived state.
- Website and consumer E2E clients contain hardcoded production Railway API URLs in several places. Tests and local clients should default to mocks or non-production endpoints to avoid test/prod contamination.
- PHI-bearing payloads or raw inputs are still logged in mobile schedule save and debug paths including caregiver, news, context-cache, website intake, and onboarding flows. Production logs must not include schedules, reminders, profile context, memory/search queries, or onboarding payloads.
- Memory search audit metadata stores raw query text, and `q`/`limit` need validation and clamping. Audit logs are long-lived, so metadata must follow minimum-necessary rules.
- Notification reads and schedule reads/writes lack audit events. Audit coverage remains partial until these paths are covered and tested.
- Token revocation fails open on storage errors. High-risk auth/session checks should fail closed when revocation state cannot be checked.
- WebSocket `ws_token` consumption is not atomic, so concurrent duplicate pipelines may be possible during races.
- Gemini Live remains an evaluation path unless it gains equivalent Quick Observer, Director, ephemeral stripping, and programmatic goodbye safeguards.
- Hard delete can leave encrypted idempotency replay rows for up to 24 hours. This is a deletion completeness gap even though replay payloads are encrypted.

---

## Security Audit Summary

9 findings from the February 2026 security audit — all resolved:

| # | Finding | Severity | Resolution |
|---|---------|----------|------------|
| 1 | No authentication on API routes | CRITICAL | 3-tier auth middleware |
| 2 | No voice webhook validation | HIGH | Telnyx Ed25519 webhook verification |
| 3 | No input validation | HIGH | Pydantic schemas on all endpoints |
| 4 | No rate limiting | HIGH | 5-tier slowapi rate limiting |
| 5 | No security headers | MEDIUM | SecurityHeadersMiddleware |
| 6 | Sensitive data in logs | MEDIUM | PII sanitization (sanitize.py) |
| 7 | Error messages leak internals | MEDIUM | Global error handler |
| 8 | No audit trail | MEDIUM | Sentry + request ID tracking |
| 9 | No request body size limits | LOW | FastAPI default + Pydantic max_length |

---

## Key Files

| File | Purpose |
|------|---------|
| `pipecat/api/middleware/auth.py` | 3-tier authentication |
| `middleware/api-auth.js` | Node service API key auth with constant-time comparison |
| `pipecat/api/routes/telnyx.py` | Telnyx webhook signature validation and outbound call setup |
| `pipecat/api/middleware/rate_limit.py` | 5-tier rate limiting config |
| `pipecat/api/middleware/security.py` | Security headers |
| `pipecat/api/middleware/error_handler.py` | Safe error responses |
| `pipecat/api/validators/schemas.py` | Pydantic input schemas |
| `pipecat/lib/sanitize.py` | PII masking utilities |
| `pipecat/config.py` | Centralized env vars |
