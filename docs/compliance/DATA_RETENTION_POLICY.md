# Data Retention & Destruction Policy

> Defines how long Donna retains each category of data, why, and how data is destroyed when retention periods expire.

| Field | Value |
|-------|-------|
| Last Updated | May 5, 2026 |
| Owner | TBD (HIPAA Security Officer) |
| Review Cadence | Annually |
| Related Docs | [HIPAA Overview](HIPAA_OVERVIEW.md), [BAA Tracker](BAA_TRACKER.md), [Breach Notification](BREACH_NOTIFICATION.md), [May 5 Audit](../audits/2026-05-05-codebase-audit.md) |

---

## Table of Contents

1. [Purpose](#purpose)
2. [Scope](#scope)
3. [Retention Schedule](#retention-schedule)
4. [Retention Period Justifications](#retention-period-justifications)
5. [Automated Purge Implementation](#automated-purge-implementation)
6. [Legal Hold Procedures](#legal-hold-procedures)
7. [Data Subject Rights](#data-subject-rights)
8. [Deletion Request Process](#deletion-request-process)
9. [Third-Party Vendor Data Retention](#third-party-vendor-data-retention)
10. [Annual Review](#annual-review)

---

## Purpose

This policy establishes retention periods for all data categories in the Donna system, balancing:

1. **Care continuity** -- retaining enough data for Donna to provide meaningful, personalized calls
2. **Compliance** -- meeting HIPAA retention requirements (6 years for policies/procedures; state laws may require longer for clinical records)
3. **Privacy** -- minimizing the amount of PHI stored at any time (data minimization principle)
4. **Operational needs** -- maintaining data needed for system monitoring, quality improvement, and debugging

HIPAA does not prescribe specific retention periods for PHI itself, but requires that **policies and procedures** (including this document) and **documentation of compliance actions** be retained for 6 years. State laws vary -- some require medical records be retained for 7-10 years. This policy uses conservative retention periods that can be shortened once legal review confirms minimum requirements.

---

## Scope

This policy applies to all data stored in:
- **Neon PostgreSQL database** (all environments: production, staging, dev)
- **Application logs** (Railway, Sentry)
- **Third-party vendor systems** (Telnyx, Anthropic, Deepgram, etc. -- see [Vendor Data Retention](#third-party-vendor-data-retention))
- **Developer machines** (if any PHI is present locally)
- **Backups** (Neon point-in-time recovery)

---

## Retention Schedule

### Current Implementation Status

The schedule below is the policy target. Current code has materially more retention coverage than the May 5 static audit snapshot, but operational proof is still required per environment before claiming automated retention compliance.

Current runtime summary:

- The Node retention service covers conversation transcript/summary nulling, old conversation rows, memories, call analyses, daily context, reminder deliveries, inactive reminders, expired one-time reminders, caregiver notes, prospects, waitlist, notifications, idempotency keys, queue tables, audit logs, and legal-hold exclusions where supported.
- The Pipecat retention service has similar core coverage but is disabled by default and does not currently cover every Node-only table such as idempotency keys or expired one-time reminders.
- Senior profile purge remains a separate right-to-delete/hard-delete workflow rather than a routine automated retention purge.
- Legal holds are documented as a requirement, but the required legal-hold table/checks are not complete.
- Hard delete/account deletion avoids caching deletion responses in the Node idempotency middleware and deletes recent related keys, but residual replay/cache rows must still be verified during deletion drills.
- Local/shared PHI-bearing call metadata needs TTL cleanup guarantees if terminal Telnyx webhook or WebSocket cleanup is missed.
- Retention worker audit evidence is currently application logs/counts, not necessarily durable `audit_logs` rows for every purge batch. Treat persistent audit-log evidence as an open requirement if policy requires it.

### Database Records

| Data Type | Table(s) | Contains PHI? | Retention Period | Trigger | Destruction Method |
|-----------|----------|---------------|-----------------|---------|-------------------|
| **Conversation transcripts and summaries** | `conversations.transcript_encrypted`, `transcript_text_encrypted`, `summary_encrypted`; legacy `conversations.transcript` / `.summary` read fallback | Yes (HIGH) | 1 year from call date | `conversations.started_at` | Automated purge job: set transcript/summary fields to NULL, retain metadata |
| **Conversation metadata** | `conversations` (non-PHI fields: id, senior_id, started_at, ended_at, duration, status, sentiment) | Low | 3 years from call date | `conversations.started_at` | Automated purge job: DELETE row |
| **Semantic memories** | `memories.content_encrypted`; legacy `memories.content` placeholder/fallback | Yes (HIGH) | 2 years from creation OR 1 year after senior becomes inactive | `memories.created_at` or `seniors.is_active` + last call date | Automated purge job: DELETE row (including embedding vector) |
| **Call analyses** | `call_analyses.analysis_encrypted`; legacy structured columns fallback | Yes (MEDIUM) | 1 year from creation | `call_analyses.created_at` | Automated purge job: DELETE row |
| **Daily call context** | `daily_call_context.context_encrypted`; legacy structured columns fallback | Yes (MEDIUM) | 90 days from call date | `daily_call_context.call_date` | Automated purge job: DELETE row |
| **Reminder definitions** | `reminders.title_encrypted`, `description_encrypted`; legacy title/description fallback | Possible/Yes if user-entered text contains health details | Retained while active + 1 year after deactivation | `reminders.is_active` = false date | Automated purge job: DELETE row + associated deliveries |
| **Reminder deliveries** | `reminder_deliveries.user_response_encrypted`; legacy `user_response` fallback | Yes (LOW) | 90 days from delivery date | `reminder_deliveries.created_at` | Automated purge job: DELETE row |
| **Senior profiles** | `seniors` | Yes (HIGH) | Retained while active + 1 year after last call | `seniors.is_active` + last `conversations.started_at` | Manual review + DELETE row (cascades to all related data) |
| **Deprecated senior medical notes** | `seniors.medical_notes_encrypted`; legacy `medical_notes` fallback | Yes (CRITICAL) if legacy data exists | Deprecated; migration 014/026 nulls existing values | Migration deployment | Set both columns to NULL; new writes are stripped |
| **Senior family/additional profile context** | `seniors.family_info_encrypted`, `additional_info_encrypted`; legacy `family_info` / `additional_info` fallback | Yes (HIGH) | Same as senior profile | Same as senior profile | Cleared when senior is purged |
| **Caregiver relationships** | `caregivers` | Low | Retained while linked + 90 days after unlinking | Manual unlinking date | Manual review + DELETE row |
| **Caregiver notes** | `caregiver_notes.content_encrypted`; legacy/plaintext fallback if present | Yes (MEDIUM/HIGH) | Retained while active + 1 year after note deactivation/deletion or senior inactivity | Note status/date or senior inactivity | Node automated purge target; verify Pipecat parity before relying on Python retention |
| **Prospect/onboarding records** | `prospects.details_encrypted`, onboarding/session state, waitlist payloads where applicable | Possible/Yes | 90 days after abandoned onboarding; 1 year for waitlist unless converted | Created/updated date and conversion status | Node automated purge target for prospects/waitlist; verify converted-onboarding residue during deletion drills |
| **Caregiver notifications** | `notifications.content_encrypted`, `metadata_encrypted`; legacy content/metadata fallback | Yes (MEDIUM) | 180 days from send date | `notifications.sent_at` | Automated purge job: DELETE row |
| **Notification preferences** | `notification_preferences` | No | Retained while caregiver exists | Cascade from caregiver deletion | CASCADE DELETE |
| **Call context snapshot** | `seniors.call_context_snapshot_encrypted`; legacy `call_context_snapshot` fallback | Yes (HIGH) | Overwritten on each call; set to NULL when senior is purged | N/A (ephemeral by design) | Set to NULL on senior purge |
| **Cached news** | `seniors.cached_news` | No | Overwritten daily at 5 AM; set to NULL on senior purge | N/A (ephemeral) | Set to NULL on senior purge |
| **Admin users** | `admin_users` | No (email/password hash) | Retained while active | Manual deactivation | DELETE row |
| **Waitlist signups** | `waitlist.payload_encrypted`; legacy contact columns fallback | Possible (name, email, phone) | 1 year from signup | `waitlist.created_at` | Automated purge job: DELETE row |
| **Audit logs** | `audit_logs` | Yes (references PHI) | **6 years** (HIPAA minimum) | `audit_logs.created_at` | Automated purge job: DELETE row after retention period |
| **Idempotency replay rows** | Idempotency/replay storage for non-delete operations | Possible/Yes (encrypted response payloads) | 24 hours max, or immediate cleanup on hard delete/account delete where feasible | Row creation and related deletion request | Node hard-delete/account-delete skips response caching and deletes recent related keys; verify residual rows during drills |

### Non-Database Data

| Data Type | Location | Contains PHI? | Retention Period | Destruction Method |
|-----------|----------|---------------|-----------------|-------------------|
| **Application logs** | Railway | Possible (despite sanitization) | Railway default (7 days) + explicit export for incidents | Railway auto-purges; exported logs follow incident retention (6 years) |
| **Error traces** | Sentry | Possible (error context) | 90 days (Sentry default) | Sentry auto-purges; adjust in Sentry settings |
| **Database backups** | Neon (PITR) | Yes (full database) | Neon plan default (7 days PITR for Pro) | Neon auto-manages; ensure PITR window does not exceed retention policy |
| **Call recordings** | Telnyx (if enabled) | Yes (CRITICAL) | **Do not enable call recording** unless required; if enabled, 30 days max | Telnyx auto-delete or API deletion |
| **Voice audio (real-time)** | Deepgram (transient) | Yes | Not retained by Deepgram (streaming STT) | Verify with Deepgram BAA; ensure no log retention |
| **TTS requests** | ElevenLabs / Cartesia | Yes (text content) | Verify vendor policy | Request deletion or confirm no-retention via BAA |
| **LLM request logs** | Anthropic, Google, Groq (Cerebras legacy/not active) | Yes (conversation content) | Verify vendor policy (Anthropic: 30 days default) | Opt out of training data retention; confirm via BAA |
| **Search queries** | Tavily, OpenAI | Possible | Verify vendor policy | Confirm via BAA or remove vendor |
| **Email delivery requests** | Resend | Possible/Yes | Verify vendor policy | Confirm BAA/compliant no-PHI path or remove PHI from email body/metadata |
| **Dev/staging databases** | Neon (branches) | Yes (copies of production) | Refresh quarterly; purge unused branches | `neonctl branches delete` |

---

## Retention Period Justifications

### Conversations (1 year transcript, 3 years metadata)

- **Transcript and summary (1 year)**: Conversation content is the most sensitive PHI. One year provides adequate time for quality review, dispute resolution, and caregiver inquiries about past calls. New transcript writes use encrypted-only fields (`transcript_encrypted`, `transcript_text_encrypted`) and summary writes prefer `summary_encrypted`; legacy plaintext columns are read fallbacks for existing rows during migration. After 1 year, transcript and summary fields are NULLed but metadata (date, duration, sentiment) is retained for longitudinal analysis.
- **Caregiver call summaries**: Caregiver-facing APIs decrypt summaries server-side only after authentication and per-senior authorization, then return summary-only call records. Transcript fields and encryption keys are not returned to caregiver clients.
- **Metadata (3 years)**: Non-PHI call metadata (when calls happened, duration, sentiment score) supports operational analytics and care pattern tracking without retaining sensitive content.

### Memories (2 years)

- Semantic memories are the foundation of Donna's personalization. They contain facts about a senior's life, preferences, and health that enable meaningful conversations across calls.
- Two years balances personalization value against data minimization. Memories older than 2 years are unlikely to be relevant (interests change, health conditions evolve).
- Memory decay (existing feature) naturally reduces the retrieval score of older memories, making them less likely to surface in conversations before the hard purge.

### Senior Profile Context

- Caregiver-provided profile context includes `familyInfo` values such as relationship, Donna language, date of birth, interest detail text, and topics to avoid, plus `additionalInfo`.
- New writes use encrypted companion columns (`family_info_encrypted`, `additional_info_encrypted`) with legacy plaintext read fallback during migration.
- Date of birth and topics to avoid should be retained only while the senior profile is active and needed for personalization/safety; they are included in senior export and deletion workflows.

### Call Analyses (1 year)

- Post-call analyses summarize companion-call engagement and conversation context. Donna no longer creates health/care concern alerts.
- After 1 year, the raw analysis data is no longer actionable and should be purged.

### Daily Call Context (90 days)

- Daily context is operational data used for same-day cross-call continuity. It has no long-term value.
- 90 days provides a safety margin for debugging and operational review.

### Reminder Deliveries (90 days)

- Delivery tracking records (when a reminder was delivered, whether acknowledged) are operational.
- 90 days is sufficient for debugging delivery failures and reviewing adherence patterns.

### Reminder Definitions (active + 1 year after deactivation)

- Reminder definitions can contain user-entered routines, schedules, caregiver-provided context, and possible health details if a user puts them in free text. Donna no longer offers a medication reminder type.
- Policy target: retain active reminders while needed for care continuity, then purge inactive definitions and associated deliveries after the retention window.
- Current status: Node retention covers inactive reminders and expired one-time reminders; verify Pipecat parity before relying on Python retention in isolation.

### Audit Logs (6 years)

- HIPAA requires that compliance documentation, including audit trails, be retained for 6 years from the date of creation or the date when the document was last in effect, whichever is later (45 CFR 164.530(j)).
- This is a legal minimum, not a recommendation. Some organizations retain audit logs for 7-10 years.

### Senior Profiles (active + 1 year)

- Senior profiles are retained as long as the senior is active (receiving calls).
- After the last call, a 1-year grace period allows for service resumption without data loss.
- After 1 year of inactivity, a manual review determines whether to purge or extend (e.g., if a caregiver requests continued retention).
- Current status: profile purge is policy-scoped, but routine retention does not automatically delete active senior profiles. Use the hard-delete/account-delete workflow for verified deletion requests and keep legal-hold review in the process.

### Caregiver Notes And Prospects

- Caregiver notes can include sensitive family, care, schedule, or medical context intended for Donna calls.
- Prospect/onboarding records can include senior-linked contact details and care context before full account creation.
- Current status: Node retention covers caregiver notes and prospects, but deletion drills should still verify converted onboarding rows and Python parity where Pipecat-created records are involved.

---

## Automated Purge Implementation

### Architecture

Implement a scheduled purge job that runs daily during off-peak hours (e.g., 3:00 AM UTC). The job should:

1. Query for records past their retention period
2. Log what will be purged (counts, not content); if durable compliance evidence is required, persist counts to `audit_logs` rather than only application logs
3. Execute deletions in batches to avoid database performance impact
4. Report results (records purged per table)

### Recommended Implementation

```sql
-- Example: Purge conversation transcripts older than 1 year
-- Phase 1: NULL out PHI fields (retain metadata)
UPDATE conversations
SET transcript = NULL,
    transcript_encrypted = NULL,
    transcript_text_encrypted = NULL,
    summary = NULL,
    summary_encrypted = NULL
WHERE started_at < NOW() - INTERVAL '1 year'
  AND (transcript IS NOT NULL OR transcript_encrypted IS NOT NULL OR transcript_text_encrypted IS NOT NULL OR summary IS NOT NULL OR summary_encrypted IS NOT NULL)
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'conversation');

-- Phase 2: Delete full conversation records older than 3 years
DELETE FROM conversations
WHERE started_at < NOW() - INTERVAL '3 years'
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'conversation');

-- Purge memories older than 2 years
DELETE FROM memories
WHERE created_at < NOW() - INTERVAL '2 years'
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'memory');

-- Purge call analyses older than 1 year
DELETE FROM call_analyses
WHERE created_at < NOW() - INTERVAL '1 year'
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'call_analysis');

-- Purge daily call context older than 90 days
DELETE FROM daily_call_context
WHERE call_date < NOW() - INTERVAL '90 days';

-- Purge reminder deliveries older than 90 days
DELETE FROM reminder_deliveries
WHERE created_at < NOW() - INTERVAL '90 days';

-- Purge notifications older than 180 days
DELETE FROM notifications
WHERE sent_at < NOW() - INTERVAL '180 days';

-- Purge waitlist signups older than 1 year
DELETE FROM waitlist
WHERE created_at < NOW() - INTERVAL '1 year';

-- Purge abandoned prospects/onboarding records after 90 days.
-- Exact predicates should match runtime schema fields for conversion/status.
DELETE FROM prospects
WHERE created_at < NOW() - INTERVAL '90 days'
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'prospect');

-- Purge inactive caregiver notes after the approved retention window.
-- Exact predicates should match runtime schema fields for active/deleted status.
DELETE FROM caregiver_notes
WHERE updated_at < NOW() - INTERVAL '1 year'
  AND id NOT IN (SELECT resource_id FROM legal_holds WHERE resource_type = 'caregiver_note');

-- Purge audit logs older than 6 years
DELETE FROM audit_logs
WHERE created_at < NOW() - INTERVAL '6 years';
```

### Implementation Checklist

- [ ] Create `legal_holds` table for litigation hold exemptions
- [ ] Implement purge job as a scheduled task (cron or application scheduler)
- [ ] Add dry-run mode (log what would be purged without executing)
- [ ] Add batch processing (process 1000 records at a time to avoid long locks)
- [ ] Log purge actions to audit log (counts per table, not content)
- [ ] Alert if purge job fails or does not run within expected window
- [ ] Test purge job on dev/staging environments with production data copies
- [ ] Add purge job to monitoring dashboard
- [ ] Verify retention coverage for inactive reminders, expired one-time reminders, senior profiles, caregiver notes, prospects/onboarding residue, notifications, queue/job tables, and idempotency replay rows
- [ ] Ensure hard-delete flows remove or expire encrypted replay/cache rows within the deletion SLA
- [ ] Ensure shared call metadata has TTL cleanup even if terminal webhook/WebSocket cleanup is missed

---

## Legal Hold Procedures

A **legal hold** (also called litigation hold) suspends normal data destruction when litigation, investigation, or regulatory action is anticipated or ongoing.

### When to Initiate a Legal Hold

- Receipt of a litigation notice, subpoena, or government investigation
- Anticipation of litigation (even before formal notice)
- Regulatory audit notification from HHS OCR
- Internal investigation into a potential breach

### How to Implement

1. **HIPAA Security Officer** or **legal counsel** issues a legal hold notice.
2. Create records in the `legal_holds` table:

```sql
CREATE TABLE legal_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type VARCHAR(50) NOT NULL,  -- 'conversation', 'memory', 'senior', etc.
  resource_id UUID NOT NULL,           -- ID of the held record
  hold_reason TEXT NOT NULL,           -- Why the hold was placed
  placed_by VARCHAR(255) NOT NULL,     -- Who placed the hold
  placed_at TIMESTAMP DEFAULT NOW(),
  released_at TIMESTAMP,              -- NULL = still active
  released_by VARCHAR(255)
);
```

3. All automated purge jobs check for active legal holds before deleting.
4. Manual deletion requests are also blocked for held records.

**Current gap:** This section is a policy requirement. The May 5 audit found legal-hold support is not complete in runtime retention/deletion services. Until implemented, deletion and purge procedures require manual legal review before execution.

### Releasing a Legal Hold

- Only **legal counsel** or **HIPAA Security Officer** can release a legal hold.
- Document the release reason and date.
- Records resume normal retention schedule from the release date (not from their original creation date).

---

## Data Subject Rights

Under HIPAA (and potentially state privacy laws like CCPA), individuals have rights regarding their PHI:

### Right to Access (45 CFR 164.524)

- Individuals (seniors and caregivers) have the right to request access to their PHI.
- Donna must provide the requested PHI within **30 days** (one 30-day extension permitted).
- PHI must be provided in the format requested by the individual if readily producible.
- A reasonable, cost-based fee may be charged.

**Implementation**: Build an admin tool or API endpoint that exports all PHI for a given senior in a machine-readable format (JSON or CSV).

### Right to Amendment (45 CFR 164.526)

- Individuals have the right to request amendment of their PHI if they believe it is incorrect or incomplete.
- Donna must act on the request within **60 days** (one 30-day extension permitted).
- Amendments may be denied if the PHI is accurate, was not created by Donna, or is not available for access.

**Implementation**: Admin dashboard should support editing senior profiles and memories with audit logging of all changes. Deprecated medical notes are not editable and are nulled by migration 014/026.

### Right to an Accounting of Disclosures (45 CFR 164.528)

- Individuals have the right to know who has accessed their PHI in the past **6 years**.
- Exceptions: disclosures for treatment, payment, healthcare operations, and certain other purposes.

**Implementation**: The audit log (once implemented) must track all disclosures of PHI, including to vendors (via API calls), to caregivers (via notifications), and to admin users (via dashboard access).

### Right to Request Restrictions (45 CFR 164.522)

- Individuals can request restrictions on how their PHI is used or disclosed.
- Donna is not required to agree to restrictions, except when disclosure is to a health plan for payment purposes (not applicable to Donna).

### Right to Request Confidential Communications

- Individuals can request that Donna communicate with them in a certain way (e.g., only at a specific phone number).

**Implementation**: The existing `preferred_call_times` and per-senior `call_settings` partially address this. Extend to support additional communication preferences.

---

## Deletion Request Process

When a caregiver or senior requests deletion of their data:

### Step 1: Verify Identity

- Confirm the requestor's identity (caregiver via Clerk session, senior via phone verification with admin assistance).
- Confirm the requestor has authority over the data (caregiver must be linked to the senior in the `caregivers` table).

### Step 2: Check for Legal Holds

- Query `legal_holds` for any active holds on the senior's data.
- If a legal hold exists, inform the requestor that deletion is temporarily suspended and provide the reason (without disclosing confidential investigation details).

### Step 3: Execute Deletion

1. **Export data first** (for the requestor if requested, and for compliance records).
2. Delete in this order (respecting foreign key constraints):
   - `daily_call_context` (by senior_id)
   - `reminder_deliveries` (by reminder_id, where reminder.senior_id matches)
   - `reminders` (by senior_id)
   - `call_analyses` (by senior_id)
   - `notifications` (by senior_id)
   - `memories` (by senior_id)
   - `conversations` (by senior_id)
   - `notification_preferences` (by caregiver_id, for linked caregivers)
   - `caregivers` (by senior_id)
   - prospect/onboarding rows linked to the senior/caregiver where applicable
   - idempotency/replay rows for the deletion/account operation where feasible
   - `seniors` (the profile itself)
3. Log the deletion action to the audit log (record THAT a deletion occurred, not the deleted content).

**Known deletion completeness gap:** hard-delete/account deletion may leave encrypted idempotency replay rows until their 24-hour TTL. This is safer than raw replay storage, but it is still not a complete immediate deletion.

### Step 4: Vendor Data Deletion

- Request deletion from third-party vendors where Donna has sent the senior's data (per BAA terms).
- This is difficult to enforce without BAAs -- another reason BAAs are critical.
- At minimum, document which vendors received the senior's data and when deletion was requested.

### Step 5: Confirm Deletion

- Notify the requestor that deletion is complete.
- Retain the audit log entry documenting the deletion (this is retained for 6 years per HIPAA).
- **Timeline**: Complete deletion within **30 days** of receiving the verified request.

---

## Third-Party Vendor Data Retention

Donna sends PHI to multiple vendors. Each vendor's data retention policy must be understood and documented.

| Vendor | Data Sent | Vendor Retention Policy | Action Needed |
|--------|-----------|------------------------|---------------|
| **Anthropic** | Conversation messages | 30-day default; opt out of training | Confirm via BAA; opt out of data retention for training |
| **Google (Gemini)** | Transcripts for analysis | Varies by API (typically no retention for API calls with data processing agreement) | Confirm via GCP data processing terms |
| **Deepgram** | Audio stream | Streaming (not retained); confirm no log retention | Confirm via BAA |
| **ElevenLabs** | TTS text input | Check vendor policy | Confirm via BAA or vendor inquiry |
| **Cartesia** | TTS text input | Check vendor policy | Confirm via BAA or vendor inquiry |
| **Groq** | Conversation turns | Check vendor policy | Confirm via vendor inquiry/BAA |
| **Cerebras** | Legacy/not active; conversation turns only if re-enabled | Check vendor policy before any re-enable | Keep disabled/remove stale env references unless BAA is signed |
| **OpenAI** | Memory text, search queries | API: not used for training (opt-out); check retention | Confirm via BAA |
| **Tavily** | Search queries | Check vendor policy | Confirm via vendor inquiry |
| **Resend** | Caregiver email notification and weekly report payloads | Check vendor policy | Confirm BAA/compliant terms or remove PHI from email content and metadata |
| **Telnyx** | Voice audio/media streaming, phone numbers, call metadata, optional recordings if enabled | Configurable; default varies | Configure retention limits in Telnyx Mission Control; keep recording disabled; confirm BAA/conduit-exception posture |
| **Twilio** | No active data flow while SMS remains disabled and Twilio voice stays archived | N/A while inactive | Reassess retention and BAA needs before reintroducing SMS or Twilio voice |
| **Neon** | All database data | Customer-controlled (PITR 7 days on Pro) | Managed by this retention policy |
| **Sentry** | Error traces | 90 days default; configurable | Set appropriate retention in Sentry settings |
| **Railway** | Application logs | 7 days default | Acceptable; export incident-relevant logs before expiry |

**Action**: For each vendor, confirm retention policies as part of BAA negotiation. Include data deletion/return provisions in all BAAs.

---

## Annual Review

This policy must be reviewed annually and updated when:

1. **Regulatory changes**: New HIPAA guidance, state law changes, or FTC enforcement actions that affect retention requirements.
2. **Business changes**: New data types collected, new vendors added, new features that generate PHI.
3. **Incident findings**: Post-incident reviews may reveal that retention periods need adjustment.
4. **Legal review**: Annual legal review of retention periods against applicable state and federal requirements.

### Review Checklist

- [ ] Verify all retention periods against current legal requirements
- [ ] Confirm automated purge jobs are running and reporting correctly
- [ ] Review and close any expired legal holds
- [ ] Verify vendor data retention policies have not changed
- [ ] Confirm dev/staging databases do not retain production data beyond policy
- [ ] Update this document with any changes
- [ ] HIPAA Security Officer sign-off

### Review Log

| Review Date | Reviewer | Changes Made |
|-------------|----------|--------------|
| April 4, 2026 | Initial creation | N/A |

---

*This policy is a living document. It must be reviewed annually and updated whenever data handling practices change. Retain this document and all prior versions for 6 years per HIPAA requirements.*
