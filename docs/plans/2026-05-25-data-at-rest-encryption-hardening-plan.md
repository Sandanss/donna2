# Data At Rest Encryption Hardening Plan

Date: 2026-05-25
Status: Proposed
Owner: TBD

## Summary

Donna already has meaningful application-level encryption for high-risk content fields, but the stored-data posture is still partial. Neon provides platform storage encryption, and Donna encrypts many new PHI-bearing writes with AES-256-GCM companion columns. The remaining risk is direct identifiers, legacy plaintext fallback columns, embeddings, metadata, logs, and vendor-held copies.

This plan moves Donna from "sensitive content is mostly encrypted on new writes" to "stored sensitive data is minimized, encrypted where practical, auditable by environment, and rotatable without downtime."

## Current State

Implemented:

- Neon PostgreSQL provides storage-layer encryption at rest.
- Node and Pipecat share field-level AES-256-GCM helpers in `lib/encryption.js` and `pipecat/lib/encryption.py`.
- Production startup validation requires a valid 32-byte `FIELD_ENCRYPTION_KEY`.
- New writes encrypt the main PHI content fields for conversations, memories, reminders, call analyses, senior profile PHI, daily context, notifications, waitlist/prospect context, caregiver notes, idempotency responses, shared-state payloads, and post-call payloads.
- Reads and authorized exports prefer encrypted values and fall back to legacy plaintext during the migration window.

Remaining gaps:

- Legacy plaintext columns may still contain historical PHI unless each deployed database has completed backfill and plaintext nulling.
- Senior and caregiver identifiers such as name, phone, city/state/ZIP, caregiver phone, and push tokens remain ordinary plaintext operational fields.
- `memories.embedding` is not encrypted and can leak semantic information even though `memories.content` is encrypted.
- Some JSON metadata fields are plaintext or need proof that encrypted companions are always used.
- The encryption key is still a single raw environment secret, not a versioned keyring with managed rotation.
- Database encryption does not cover Railway logs, Sentry events, Redis/Upstash data, backups, exports, local developer machines, or vendor-side retention after STT/LLM/TTS processing.

## Goals

- Prove, per environment, which sensitive fields are still stored in plaintext.
- Clear legacy plaintext PHI after verified encrypted backfill.
- Encrypt direct identifiers while preserving lookup and dialing behavior.
- Add key versioning and a practical rotation runbook.
- Reduce embedding and metadata leakage.
- Add release gates so future code does not reintroduce plaintext PHI writes.

## Non-Goals

- This plan does not decide whether Donna is legally acting as a covered entity or business associate.
- This plan does not replace BAA/vendor review. Vendors that receive raw audio, transcripts, prompts, or generated text still need separate contractual and retention review.
- This plan does not promise end-to-end encryption where Donna servers cannot decrypt. Donna needs server-side decrypt for calls, caregiver views, exports, and deletion workflows.

## Phase 1: Inventory And Plaintext Audit

Create a stored-data inventory and count-only audit for every deployed environment.

Tasks:

- Build `scripts/audit-sensitive-at-rest.js` or equivalent SQL runbook that prints counts only, never values.
- Inventory sensitive fields from `db/schema.js`, Node migrations, and Pipecat migrations.
- Classify each field as encrypted, minimized plaintext, derived lookup value, operational metadata, legacy fallback, or unknown.
- Verify `FIELD_ENCRYPTION_KEY` is set and valid in every public Node and Pipecat service.
- Verify which storage systems exist in each environment: Neon, Redis/Upstash, Railway logs, Sentry, object storage, backups, export files, local dumps.

Initial audit fields:

- `seniors.family_info`, `medical_notes`, `preferred_call_times`, `additional_info`, `call_context_snapshot`
- `conversations.summary`, `transcript`, `concerns`
- `memories.content`, `metadata`, `embedding`
- `reminders.title`, `description`
- `reminder_deliveries.user_response`
- `call_analyses.summary`, `topics`, `concerns`, `positive_observations`, `follow_up_suggestions`, `call_quality`
- `daily_call_context.topics_discussed`, `reminders_delivered`, `advice_given`, `key_moments`, `summary`
- `notifications.content`, `metadata`
- `waitlist.name`, `email`, `phone`, `who_for`, `thoughts`
- `caregiver_notes.content` where that table exists
- `post_call_jobs.payload` and any replay/cache payload columns

Acceptance criteria:

- A dated `docs/audits/` audit artifact exists with per-environment counts.
- The audit artifact contains no raw PHI, names, phone numbers, transcripts, reminder text, notes, prompts, or production secrets.
- Every non-zero plaintext count is linked to a follow-up task or a documented "intentionally minimized plaintext" decision.

## Phase 2: Legacy Plaintext Cleanup

Finish the current encrypted companion-column rollout.

Tasks:

- Apply the current encryption migrations to every deployed database.
- Run `node scripts/backfill-encrypted-phi.js --write` against staging first, then production.
- Smoke test admin reads, senior exports, reminder calls, daily context, notifications, onboarding, memory search, and post-call processing.
- Run `node scripts/backfill-encrypted-phi.js --write --null-plaintext` after verification.
- Add or tighten tests proving new writes do not populate legacy plaintext PHI fields.
- Add database constraints where practical to prevent plaintext repopulation for fields that have encrypted companions.

Acceptance criteria:

- Count-only plaintext audit is zero for legacy PHI companion fields, except documented non-PHI placeholders such as `[encrypted]`.
- Authorized exports decrypt server-side and do not return ciphertext blobs.
- Retention and hard-delete paths clear both encrypted and legacy plaintext columns.
- Node and Pipecat tests cover representative encrypted-write paths.

## Phase 3: Encrypt Direct Identifiers

Move name and phone storage away from ordinary plaintext while preserving lookup, uniqueness, and dialing.

Tasks:

- Add encrypted identifier columns:
  - `seniors.name_encrypted`
  - `seniors.phone_encrypted`
  - `caregivers.phone_encrypted`
- Add derived lookup columns:
  - `seniors.phone_hash`
  - `caregivers.phone_hash`
- Use HMAC-SHA256 or an equivalent keyed hash with a separate `PII_LOOKUP_KEY`, not the field encryption key.
- Put a unique index on `seniors.phone_hash`.
- Update inbound lookup, onboarding availability checks, duplicate detection, scheduler dialing, manual calls, exports, admin views, and Pipecat `find_by_phone` to use hashes/decryption at the boundary.
- Backfill encrypted and hashed identifier columns.
- Stop reading/writing raw plaintext phone/name except at integration boundaries that actually need them.

Open decisions:

- Whether `seniors.name` remains as a minimized display placeholder or is nullable after backfill.
- Whether city/state/ZIP should be encrypted, coarse-grained, or kept as minimized operational data.
- Whether caregiver push tokens should be encrypted or moved behind a notification-provider reference.

Acceptance criteria:

- Phone lookup and uniqueness work without querying plaintext phone.
- Telnyx call initiation decrypts phone only at the call boundary.
- Exports include decrypted identifiers only after authorization and audit logging.
- Plaintext name/phone fields are nulled, placeholdered, or explicitly documented as temporary compatibility fields with a removal date.

## Phase 4: Key Management And Rotation

Replace the single raw field encryption secret with versioned, rotatable key management.

Tasks:

- Introduce ciphertext versioning while preserving current `enc:` decrypt compatibility.
- Define a new envelope format such as `enc:v1:<iv>:<tag>:<ciphertext>` or an equivalent key-id-aware format.
- Store encryption material in a managed secrets/KMS path instead of one raw shared environment value.
- Support dual-decrypt and single-encrypt: decrypt older key versions, encrypt new writes with the active key.
- Add a rotation runbook:
  - create new key version
  - deploy dual-decrypt
  - switch active encryption key
  - re-encrypt rows in batches
  - verify counts by key version
  - retire old key after backup/rollback window
- Split dev, staging, and production encryption and lookup keys.

Acceptance criteria:

- A key rotation can be tested on staging without downtime.
- The app reports redacted encryption readiness and active key version in health/readiness output.
- Lost or invalid key behavior fails closed in public environments.
- Rotation and emergency key-compromise procedures are documented.

## Phase 5: Embeddings And Metadata

Treat embeddings and metadata as sensitive, even when they are not plain English.

Tasks:

- Classify `memories.embedding` as sensitive derived data.
- Minimize what gets embedded. Avoid embedding health details, medication-like content, credentials, or unnecessary family details.
- Add retention for embeddings and memory metadata.
- Encrypt plaintext metadata fields that can contain PHI, or prove they only contain non-PHI operational tags.
- Consider per-environment or per-tenant isolation for vector data if memory search remains central.
- Document why any unencrypted embeddings are still acceptable, including compensating controls.

Acceptance criteria:

- Memory extraction rules avoid known high-risk content.
- Embedding retention is documented and enforced.
- Plaintext metadata audit is zero or every remaining field has a documented minimized purpose.

## Phase 6: Edges, Vendors, And Release Gates

Verify that encrypted storage is not undercut by logs, exports, caches, or vendor copies.

Tasks:

- Recheck export routes: decrypt only after auth and per-resource authorization; fail closed where audit logging is required.
- Recheck hard delete and retention: cover encrypted columns, lookup hashes, Redis/shared-state payloads, idempotency/replay rows, post-call jobs, prospects, caregiver notes, and canary membership.
- Review Railway logs, Sentry events, local scripts, and generated reports for PHI leakage.
- Verify log retention and debug-log controls in every public Railway environment.
- Confirm vendor retention/security settings for STT, LLM, TTS, telephony, email, hosting, database, error monitoring, and Redis providers.
- Add a recurring privacy smoke test with dummy sentinel data:
  - create dummy sensitive fields
  - verify DB plaintext counts
  - verify export/deletion behavior
  - verify logs and Sentry do not contain sentinels

Acceptance criteria:

- A release gate blocks production promotion when plaintext audit, log sentinel scan, export smoke test, or retention/delete smoke test fails.
- Vendor-side data exposure is tracked in `docs/compliance/BAA_TRACKER.md` and `docs/compliance/VENDOR_SECURITY_EVALUATION.md`.
- Debug logging in public environments requires explicit short-lived approval and post-incident log review.

## Suggested PR Sequence

1. Audit script and dated audit artifact.
2. Legacy plaintext cleanup verification and tests.
3. Identifier encryption schema and lookup hash migration.
4. Identifier read/write path migration.
5. Key versioning and staging rotation runbook.
6. Embedding/metadata minimization and retention.
7. Release gates for plaintext counts, sentinels, exports, and deletion.

## Risk Notes

- Storage-layer encryption protects against storage media exposure, but it does not protect against database credentials, application bugs, overbroad admin access, or vendor retention.
- Application-level encryption protects database rows only if keys are protected separately from the database and application logs.
- Lookup hashes are sensitive. A keyed HMAC is required; an unsalted hash of a phone number is too easy to enumerate.
- Embeddings should not be treated as anonymous. They can preserve enough semantic information to require PHI-grade handling.
- Backups and point-in-time recovery can retain old plaintext rows after cleanup. Retention and restore procedures need to account for that.

## References

- `docs/architecture/SECURITY.md`
- `docs/compliance/HIPAA_OVERVIEW.md`
- `docs/compliance/DATA_RETENTION_POLICY.md`
- `docs/compliance/BAA_TRACKER.md`
- `docs/compliance/VENDOR_SECURITY_EVALUATION.md`
- `lib/encryption.js`
- `pipecat/lib/encryption.py`
- `scripts/backfill-encrypted-phi.js`
