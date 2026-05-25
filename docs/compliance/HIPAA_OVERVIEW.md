# HIPAA Compliance Overview

> Status: **Pre-Compliance** -- Technical safeguards partially implemented, administrative and organizational safeguards not yet in place.

| Field | Value |
|-------|-------|
| Last Updated | May 5, 2026 |
| Owner | TBD |
| Review Cadence | Quarterly |
| Related Docs | [BAA Tracker](BAA_TRACKER.md), [Breach Notification](BREACH_NOTIFICATION.md), [Data Retention](DATA_RETENTION_POLICY.md), [Vendor Security](VENDOR_SECURITY_EVALUATION.md), [Data-at-rest hardening plan](../plans/2026-05-25-data-at-rest-encryption-hardening-plan.md), [May 5 Audit](../audits/2026-05-05-codebase-audit.md) |

---

## Table of Contents

1. [Why HIPAA Applies to Donna](#why-hipaa-applies-to-donna)
2. [Covered Entity vs Business Associate Analysis](#covered-entity-vs-business-associate-analysis)
3. [What Constitutes PHI in Donna](#what-constitutes-phi-in-donna)
4. [Current Compliance Status](#current-compliance-status)
5. [Technical Safeguards (HIPAA SS 164.312)](#technical-safeguards-hipaa--164312)
6. [Administrative Safeguards (HIPAA SS 164.308)](#administrative-safeguards-hipaa--164308)
7. [Physical Safeguards (HIPAA SS 164.310)](#physical-safeguards-hipaa--164310)
8. [Organizational Requirements (HIPAA SS 164.314)](#organizational-requirements-hipaa--164314)
9. [Risk Assessment Summary](#risk-assessment-summary)
10. [Remediation Roadmap](#remediation-roadmap)
11. [Next Steps](#next-steps)

---

## Why HIPAA Applies to Donna

The Health Insurance Portability and Accountability Act (HIPAA) establishes national standards for protecting individuals' medical records and personal health information. HIPAA applies when an entity creates, receives, maintains, or transmits **Protected Health Information (PHI)** in the course of providing healthcare-related services.

Donna is an AI companion that makes phone calls to elderly individuals. Donna no longer offers medical notes, medication reminder types, or concern-alert workflows. During calls and in free-text fields, users may still share health information, so Donna must treat those records conservatively:

- **Conducts companion calls** -- conversations may include user-disclosed health conditions, symptoms, doctor visits, or medical concerns
- **Stores user-provided context** -- free-text profile, reminder, memory, and transcript fields can contain health details even when Donna does not request them
- **Generates call summaries** -- post-call AI analysis summarizes engagement and conversation context without creating health/care alerts
- **Sends caregiver notifications** -- email/in-app summaries may contain health details if they came from a conversation or user-entered content. SMS is inactive for now.

Even though Donna is not a healthcare provider, health discussions or user-entered health details linked to identifiable individuals (name + phone number) can constitute PHI or sensitive health data when Donna receives, stores, or transmits them.

**Key legal question:** Whether Donna is a "covered entity" or a "business associate" depends on the business model (see analysis below). Regardless of classification, handling PHI without proper safeguards creates legal and ethical risk.

---

## Covered Entity vs Business Associate Analysis

### Definitions

- **Covered Entity**: A health plan, healthcare clearinghouse, or healthcare provider that transmits health information electronically in connection with a HIPAA-covered transaction.
- **Business Associate**: A person or organization that performs functions or activities on behalf of, or provides services to, a covered entity that involve access to PHI.

### Donna's Classification

| Scenario | Classification | Implication |
|----------|---------------|-------------|
| Donna operates independently, selling directly to caregivers/seniors | **Likely NOT a covered entity** (not a health plan, clearinghouse, or provider billing electronically) | HIPAA may not technically apply, but FTC Act Section 5 (unfair/deceptive practices), state health privacy laws, and best practice still demand PHI-level protection |
| Donna partners with a healthcare provider, health plan, or senior living facility | **Business Associate** | Must sign BAAs with covered entity partners AND with all Donna's subcontractors (downstream BAAs) |
| Donna bills insurance for its services or is classified as a telehealth provider | **Covered Entity** | Full HIPAA compliance required: Privacy Rule, Security Rule, Breach Notification Rule |

### Recommendation

**Treat Donna as if HIPAA applies regardless of current classification.** Reasons:

1. **Future-proofing**: Any partnership with a healthcare provider or senior living facility will require HIPAA compliance as a condition of the contract.
2. **State laws**: Many states (California CCPA/CMIA, New York SHIELD Act, Texas HB 300) have health data protection laws that apply even to non-covered entities.
3. **FTC enforcement**: The FTC has taken action against companies handling health data without adequate safeguards, regardless of HIPAA status.
4. **Trust**: Caregivers entrusting their loved ones to Donna expect healthcare-grade data protection.
5. **Investor/enterprise readiness**: HIPAA compliance is a prerequisite for B2B healthcare partnerships and fundraising in the health-tech space.

---

## What Constitutes PHI in Donna

PHI is any individually identifiable health information. In Donna's system, the following data elements are PHI when combined with identifying information (name, phone number, senior ID):

| Data Element | Location | PHI? | Sensitivity |
|-------------|----------|------|-------------|
| Senior name + phone number | `seniors` table | Yes (identifiers) | High |
| Reminder text containing health details (for example, legacy medication reminders or user-entered drug names) | `reminders.title_encrypted`, `description_encrypted`; legacy title/description fallback | Yes | High |
| Conversation transcripts mentioning health | `conversations.transcript_encrypted`, `transcript_text_encrypted`; legacy `conversations.transcript` read fallback | Yes | High |
| Profile notes and legacy medical-note migration residue | `seniors.profile_notes` / `profile_notes_encrypted`; historical `medical_notes` columns if present in older environments | Yes if health details are present | High |
| Family/profile context (relationship, Donna language, date of birth, interest details, topics to avoid) | `seniors.family_info_encrypted`; legacy `family_info` read fallback | Yes when tied to the senior | High |
| Additional caregiver context | `seniors.additional_info_encrypted`; legacy `additional_info` read fallback | Yes when it references health, family, or care needs | High |
| User-entered or transcript-derived memories about health conditions | `memories.content_encrypted`; legacy `memories.content` fallback | Yes | High |
| Call summaries/analyses mentioning health details from the transcript | `call_analyses.analysis_encrypted`; legacy structured columns fallback | Yes | High |
| Caregiver notifications containing health details | `notifications.content_encrypted`, `metadata_encrypted`; legacy `notifications.content` fallback | Yes | Medium |
| Daily call context (topics discussed) | `daily_call_context` | Yes (if health topics) | Medium |
| Call summaries | `conversations.summary_encrypted`; legacy `conversations.summary` read fallback | Yes (if health topics) | Medium |
| Sentiment/engagement scores | `call_analyses` | Low risk alone | Low |
| Interests (e.g., "gardening") | `seniors.interests` | No (unless health-related) | Low |
| City/state/zip | `seniors` table | Yes (geographic identifiers) | Medium |

**Key insight**: Nearly all conversation data is potentially PHI because seniors routinely discuss health during calls. The system cannot reliably distinguish health-related conversation content from non-health content, so all conversation data should be treated as PHI.

---

## Current Compliance Status

### What Is Implemented

| Safeguard | Status | Details |
|-----------|--------|---------|
| Access controls (authentication) | Implemented | 3-tier auth: API key, JWT, Clerk session |
| Access controls (authorization) | Partial | Admin vs. caregiver roles exist, but no granular per-senior access control for admin users |
| Encryption in transit | Implemented | TLS everywhere: Railway (HTTPS), Neon (SSL), Telnyx webhook/media paths, Resend email API, and all AI/vendor API calls over HTTPS/WSS where applicable |
| Encryption at rest | Partial | Neon PostgreSQL encrypts at rest (AES-256); application-level encryption is implemented for new PHI writes across conversations, memories, analyses, senior profile PHI, reminders, daily context, notifications, waitlist/prospect context, and caregiver notes. Legacy plaintext backfill/nulling must still be run per environment. |
| Audit logging | Partial | Structured `audit_logs` table plus Node/Pipecat audit services exist for PHI access paths. Coverage should still be verified before production PHI launch. |
| PII/PHI sanitization in logs | Partial | Sanitizers exist and Node structured logger metadata is sanitized, but direct `console.*` and Python `loguru` paths still require review. Production PHI launch requires log cleanup and Railway/Sentry review. |
| Input validation | Partial | Pydantic/Zod schemas exist for many API inputs. Memory search now validates/clamps query parameters and minimizes audit metadata, but route-level validation coverage still needs periodic review. |
| Rate limiting | Implemented | 5-tier rate limiting on all API endpoints |
| Security headers | Implemented | HSTS, X-Frame-Options, CSP-adjacent headers |
| Telnyx webhook validation | Implemented | Ed25519 Telnyx signature verification on `/telnyx/events`, plus single-use `ws_token` validation for Telnyx media WebSocket startup |
| Error handling (no data leakage) | Implemented | Global error handler strips internal details from API responses |
| Environment isolation | Implemented | dev/staging/production with separate databases and phone numbers |
| Sentry PII controls | Implemented | `send_default_pii=False` configured |

### What Is NOT Implemented (Gaps)

| Safeguard | Status | Priority | Effort |
|-----------|--------|----------|--------|
| Business Associate Agreements (BAAs) | **Not signed with any vendor** | CRITICAL | Medium (sales outreach) |
| Resend BAA/minimized email path | Not verified | CRITICAL | Low/Medium (vendor/legal decision plus email minimization if needed) |
| Complete application-level encryption of PHI | Partial | HIGH | Low/Medium (new writes are covered; run SQL migration plus encrypted backfill/nulling in every deployed database, then test exports and calls) |
| HIPAA audit trail coverage verification | Partial | HIGH | Low/Medium (confirm every PHI read/write path writes `audit_logs`) |
| Data retention operational verification | Partial | HIGH | Low/Medium (Node owns the broader daily purge; verify per environment, Pipecat parity, legal holds, senior profile deletion, converted-onboarding residue, and idempotency replay rows) |
| Client-side plaintext onboarding storage | Not remediated | HIGH | Medium (remove credentials/PHI from website `localStorage` or replace with encrypted/minimized short-lived storage) |
| Test/prod API separation | Not verified | HIGH | Low/Medium (remove hardcoded production Railway URLs from website/consumer E2E clients) |
| Token revocation fail-closed behavior | Mostly implemented | MEDIUM | Low (production fails closed when revocation state is unavailable; non-production keeps compatibility fallback, so tests/runbooks must preserve that split) |
| Formal risk assessment | Not performed | HIGH | Medium (documented risk analysis per 45 CFR 164.308(a)(1)) |
| Workforce training | Not performed | MEDIUM | Low (document policies, train team) |
| Breach notification tabletop/testing | Documented, not tested | HIGH | Low (see [Breach Notification](BREACH_NOTIFICATION.md)) |
| Backup and disaster recovery plan | Partial (Neon has backups) | MEDIUM | Low (document and test) |
| Minimum necessary standard | Not enforced | MEDIUM | Medium (limit PHI in API responses to what's needed) |
| De-identification for analytics | Not implemented | MEDIUM | Medium (strip identifiers for aggregated metrics) |
| Physical safeguard documentation | Not documented | LOW | Low (Railway/Neon/Vercel handle physical security) |
| Contingency plan (emergency mode) | Not documented | MEDIUM | Low |
| Unique user identification | Partial | LOW | Low (admin JWT and Clerk IDs exist; verify coverage for shared/cofounder service access) |

---

## Technical Safeguards (HIPAA SS 164.312)

### (a)(1) Access Control -- Required

| Requirement | Status | Implementation |
|------------|--------|----------------|
| Unique user identification | Partial | Admin JWT has `adminId`; Clerk has `userId`; audit events record actor IDs where middleware context is available. Verify coverage for shared/cofounder service access. |
| Emergency access procedure | Not implemented | No documented procedure for emergency PHI access. |
| Automatic logoff | Partial | JWT tokens expire (configurable). No forced session termination. |
| Encryption and decryption | Partial | TLS in transit. Neon AES-256 at rest. New PHI writes use app-level field encryption for the main PHI tables; legacy plaintext rows remain until the per-environment migration/backfill/nulling runbook is completed. |

**Gap: complete application-level encryption rollout.** The code now writes encrypted companion columns for high-risk PHI fields and reads prefer encrypted data with plaintext fallbacks for legacy rows. The remaining rollout work is operational: apply the migration, run the encrypted backfill, verify application behavior, and then clear legacy plaintext columns in every deployed database. The broader follow-up plan for plaintext cleanup, direct identifier encryption, key rotation, embedding/metadata handling, and release gates is tracked in [Data At Rest Encryption Hardening Plan](../plans/2026-05-25-data-at-rest-encryption-hardening-plan.md).

**Remediation:**
1. Apply `db/migrations/002_encrypt_remaining_phi.sql` or `pipecat/db/migrations/009_encrypt_remaining_phi.sql`, then run `node scripts/backfill-encrypted-phi.js --write` followed by `--write --null-plaintext` after verification.
2. Store encryption keys in a secrets manager (e.g., AWS KMS, HashiCorp Vault), NOT in environment variables alongside database credentials.
3. Implement key rotation procedures.

### (b) Audit Controls -- Required

| Requirement | Status |
|------------|--------|
| Hardware/software/procedural mechanisms to record and examine access to PHI | Partial |

**Implemented baseline:** Donna has an `audit_logs` table plus Node (`services/audit.js`) and Pipecat (`pipecat/services/audit.py`) audit helpers. PHI-heavy routes such as seniors, conversations, memories, reminders, call analyses, observability reads, exports, and Pipecat call/metrics routes write audit events.

**Remaining gap:** Audit logging is not yet proven complete or tamper-evident. Before real PHI launch, verify:
- Every PHI read/write path emits an audit event
- Notification reads and schedule reads/writes emit audit events
- Memory search audit metadata is minimized and does not store raw query text unnecessarily
- High-risk exports fail closed if audit persistence fails
- Audit logs are retained for 6 years
- Audit logs are append-only or protected from normal application updates/deletes
- Operational review procedures exist for querying audit events during an incident

**Remediation:**
1. Add or update tests that assert audit writes on every PHI route in Node and Pipecat.
2. Make export and hard-delete paths fail closed when audit persistence fails.
3. Retain audit logs for minimum 6 years (HIPAA requirement).
4. Restrict update/delete privileges for `audit_logs` outside the retention worker and administrative break-glass process.

### (c)(1) Integrity -- Addressable

| Requirement | Status |
|------------|--------|
| Mechanisms to authenticate ePHI | Partial (DB constraints, input validation) |

### (d) Person or Entity Authentication -- Required

| Requirement | Status |
|------------|--------|
| Verify identity of persons seeking access to ePHI | Implemented (3-tier auth) |

### (e)(1) Transmission Security -- Required

| Requirement | Status |
|------------|--------|
| Integrity controls | Partial (HTTPS/TLS) |
| Encryption | Implemented (TLS on all connections) |

---

## Administrative Safeguards (HIPAA SS 164.308)

| Requirement | Status | Action Needed |
|------------|--------|---------------|
| (a)(1) Security management process | Not implemented | Conduct formal risk analysis, implement risk management policies |
| (a)(2) Assigned security responsibility | Not assigned | Designate a HIPAA Security Officer |
| (a)(3) Workforce security | Not implemented | Background checks, access termination procedures |
| (a)(4) Information access management | Partial | Need role-based access policies, access review procedures |
| (a)(5) Security awareness and training | Not implemented | Develop and deliver HIPAA training to all team members |
| (a)(6) Security incident procedures | Not documented | See [Breach Notification Runbook](BREACH_NOTIFICATION.md) |
| (a)(7) Contingency plan | Not documented | Disaster recovery, emergency mode, data backup procedures |
| (a)(8) Evaluation | Not performed | Annual security evaluation |
| (b)(1) Business associate contracts | **Not signed** | See [BAA Tracker](BAA_TRACKER.md) -- all PHI vendors need evaluation, including newly tracked Resend |

---

## Physical Safeguards (HIPAA SS 164.310)

Since Donna runs entirely on cloud infrastructure, physical safeguards are largely delegated to infrastructure providers:

| Requirement | Provider | Status |
|------------|----------|--------|
| Facility access controls | Railway, Neon, Vercel | Covered by provider SOC 2 / physical security programs |
| Workstation use | N/A (no on-site PHI processing) | Developer machines access PHI via production database -- policy needed |
| Workstation security | N/A | Need policy: full-disk encryption, screen lock, no PHI on local machines |
| Device and media controls | N/A | Need policy: how to handle data on developer machines, disposal procedures |

**Gap: Developer access to production data.** The development workflow documents that `make deploy-dev` uses Neon branch copies of production data. This means developer machines indirectly access production PHI. Policy needed:
- Developers should not have direct SQL access to production database
- Dev/staging environments should use synthetic data, not production copies
- If production data copies are necessary, they should be de-identified first

---

## Organizational Requirements (HIPAA SS 164.314)

| Requirement | Status | Action Needed |
|------------|--------|---------------|
| (a) Business associate contracts | Not signed | Execute BAAs with all vendors processing PHI (see [BAA Tracker](BAA_TRACKER.md)) |
| (b) Group health plan requirements | N/A | Donna is not a group health plan |

---

## Risk Assessment Summary

A formal risk assessment per 45 CFR 164.308(a)(1)(ii)(A) has not yet been conducted. Below is a preliminary assessment:

| Risk Area | Likelihood | Impact | Risk Level | Mitigation |
|-----------|-----------|--------|------------|------------|
| Third-party vendor breach (no BAAs) | High | High | **CRITICAL** | Sign BAAs with all vendors processing PHI |
| PHI-bearing email without tracked BAA/minimization | High | High | **CRITICAL** | Add Resend to vendor controls, sign BAA or remove PHI from email payloads |
| Database credential compromise | Medium | High | **HIGH** | App-level field encryption, key rotation, least-privilege DB users |
| Audit trail coverage not fully verified | High | Medium | **HIGH** | Verify audit logging coverage and harden append-only controls |
| Conversation data in 12+ vendor systems | High | High | **CRITICAL** | Minimize data sent to vendors, sign BAAs, evaluate vendor alternatives |
| Website onboarding PHI/credentials in plaintext localStorage | High | High | **HIGH** | Remove credentials/PHI from client storage; use minimized server-side or encrypted short-lived state |
| Test/prod contamination from hardcoded production API URLs | Medium | High | **HIGH** | Keep tests and local clients on mocks or non-production endpoints by default |
| Raw PHI in debug logs | Medium | High | **HIGH** | Sanitize/remove schedule, onboarding, caregiver, news, cache, prompt, transcript, WebSocket token, and memory query logs |
| Developer access to production data | Medium | Medium | **MEDIUM** | Synthetic data for dev, restrict production access |
| Data retention purge not yet operationally verified in every environment | High | Medium | **HIGH** | Verify the Node-owned daily purge and document purge history (see [Data Retention](DATA_RETENTION_POLICY.md)) |
| Breach notification procedures not drilled | Medium | High | **HIGH** | Run tabletop exercises and update [Breach Notification](BREACH_NOTIFICATION.md) from findings |
| No workforce training | High | Medium | **MEDIUM** | Develop and deliver HIPAA training |
| Clerk JWKS configuration drift | Low | High | **MEDIUM** | Python auth now verifies Clerk RS256 tokens with JWKS when `CLERK_JWKS_URL` or `CLERK_PUBLISHABLE_KEY` is configured; monitor env coverage in all deployments |

---

## Remediation Roadmap

### Phase 1: Foundation (Weeks 1-4) -- CRITICAL

1. **Sign BAAs with tier-1 vendors** (Telnyx, Anthropic, Neon, Deepgram, Google, OpenAI, Sentry, and Resend if email carries PHI) -- these all offer, advertise, or require verification of BAA paths on business/enterprise plans. Keep Twilio out of active PHI flows while SMS remains disabled.
2. **Designate a HIPAA Security Officer** (can be a co-founder initially).
3. **Document breach notification procedures** -- see [Breach Notification](BREACH_NOTIFICATION.md).
4. **Verify HIPAA audit logging coverage** across Node and Pipecat routes (`audit_logs` table exists; confirm every PHI access path writes an audit event, and document which latency-sensitive paths are best-effort).
5. **Verify Clerk JWKS env configuration** in every deployment. `pipecat/api/middleware/auth.py` now verifies Clerk JWT signatures, but it rejects Clerk tokens if JWKS cannot be derived from env.
6. **Remove high-risk client/log exposures** from website onboarding storage, mobile schedule logging, and server/client debug logs before PHI launch.

### Phase 2: Data Protection (Weeks 5-8) -- HIGH

7. **Complete field-level encryption rollout** for PHI columns by running the migration/backfill/nulling sequence in every environment and verifying encrypted export/read behavior.
8. **Operationally verify data retention policies** with automated purge jobs and durable evidence where required -- see [Data Retention](DATA_RETENTION_POLICY.md).
9. **Evaluate and replace non-compliant vendors** (Groq, Cartesia, Tavily; Cerebras is legacy/not active in current Director code) -- see [Vendor Security](VENDOR_SECURITY_EVALUATION.md).
10. **Restrict developer access to production data** -- synthetic data for dev/staging environments.

### Phase 3: Organizational (Weeks 9-12) -- MEDIUM

11. **Conduct formal risk assessment** per 45 CFR 164.308(a)(1)(ii)(A).
12. **Develop and deliver workforce HIPAA training**.
13. **Document contingency/disaster recovery plan**.
14. **Implement minimum necessary standard** -- limit PHI in API responses.
15. **Annual evaluation schedule** -- establish quarterly review cadence.

### Phase 4: Ongoing -- CONTINUOUS

16. **Annual risk assessment** and policy review.
17. **Quarterly access reviews** -- who has access to what.
18. **Annual workforce re-training**.
19. **Vendor re-evaluation** -- annually review all vendor BAA and security status.
20. **Penetration testing** -- annual third-party security assessment.

---

## Next Steps

1. **Immediately**: Read the [BAA Tracker](BAA_TRACKER.md) and begin vendor outreach for BAA signing.
2. **This week**: Designate a HIPAA Security Officer and begin Phase 1.
3. **This month**: Complete the [Breach Notification](BREACH_NOTIFICATION.md) runbook and conduct a tabletop exercise.
4. **This quarter**: Complete Phases 1-2 of the remediation roadmap.

---

*This document is a living compliance guide. Update it as safeguards are implemented and gaps are closed. Target: full HIPAA compliance readiness by Q3 2026.*
