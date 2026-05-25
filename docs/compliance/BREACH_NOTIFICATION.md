# Incident Response & Breach Notification Runbook

> Procedures for detecting, assessing, containing, and reporting breaches of Protected Health Information (PHI) in compliance with the HIPAA Breach Notification Rule (45 CFR 164.400-414).

| Field | Value |
|-------|-------|
| Last Updated | April 4, 2026 |
| Owner | TBD (HIPAA Security Officer) |
| Review Cadence | Annually + after every incident |
| Related Docs | [HIPAA Overview](HIPAA_OVERVIEW.md), [BAA Tracker](BAA_TRACKER.md), [Data Retention](DATA_RETENTION_POLICY.md) |

---

## Table of Contents

1. [Key Definitions](#key-definitions)
2. [HIPAA Breach Notification Requirements](#hipaa-breach-notification-requirements)
3. [Phase 1: Discovery](#phase-1-discovery)
4. [Phase 2: Assessment](#phase-2-assessment)
5. [Phase 3: Containment](#phase-3-containment)
6. [Phase 4: Notification](#phase-4-notification)
7. [Phase 5: Documentation](#phase-5-documentation)
8. [Phase 6: Post-Incident Review](#phase-6-post-incident-review)
9. [Templates](#templates)
10. [Contact List](#contact-list)
11. [Drill Schedule](#drill-schedule)

---

## Key Definitions

- **Breach**: The acquisition, access, use, or disclosure of PHI in a manner not permitted by the HIPAA Privacy Rule that compromises the security or privacy of the PHI. (45 CFR 164.402)
- **Unsecured PHI**: PHI that is not rendered unusable, unreadable, or indecipherable to unauthorized persons through encryption or destruction methods specified by HHS guidance.
- **Discovery date**: The first day the breach is known to any member of the workforce, or the date it would have been known by exercising reasonable diligence.
- **Security Incident**: The attempted or successful unauthorized access, use, disclosure, modification, or destruction of information or interference with system operations.

### Breach Presumption

Under HIPAA, any impermissible use or disclosure of PHI is **presumed to be a breach** unless the organization demonstrates a low probability that PHI was compromised, based on a four-factor risk assessment (see Phase 2).

### Exceptions (NOT Considered Breaches)

1. **Unintentional access** by a workforce member acting in good faith, within their scope, with no further disclosure.
2. **Inadvertent disclosure** between authorized persons at the same organization.
3. **Good faith belief** that the recipient could not reasonably retain the information.

---

## HIPAA Breach Notification Requirements

### Timeline Summary

| Condition | Notification To | Deadline |
|-----------|----------------|----------|
| Any breach of unsecured PHI | **Affected individuals** | Within 60 calendar days of discovery |
| Breach affecting 500+ individuals in a single state/jurisdiction | **Prominent media outlets** in that state | Within 60 calendar days of discovery |
| Breach affecting 500+ individuals | **HHS Secretary** | Within 60 calendar days of discovery |
| Breach affecting fewer than 500 individuals | **HHS Secretary** | Within 60 calendar days of end of calendar year in which breach was discovered (annual log submission) |

**Discovery date starts the clock.** If a breach is discovered on March 15, notifications to individuals must be sent by May 14.

---

## Phase 1: Discovery

### How Breaches May Be Detected

| Detection Method | Source | Responsibility |
|-----------------|--------|----------------|
| Sentry error alerts | Unexpected data exposure in error traces | On-call engineer |
| Railway log anomalies | Unusual access patterns, failed auth spikes | On-call engineer |
| Vendor notification | A third-party vendor reports a security incident | HIPAA Security Officer |
| Customer/caregiver report | A caregiver or senior reports receiving unexpected information | Support team |
| Internal discovery | Employee discovers unauthorized access or misconfiguration | Any team member |
| Penetration test findings | Third-party security assessment discovers vulnerability | Security team |
| Neon audit logs | Unusual database queries or access patterns | On-call engineer |
| Automated monitoring | Database query volume spikes, unusual API access patterns | Monitoring systems |

### Immediate Actions Upon Detection

1. **Record the exact date and time of discovery** -- this is the legal discovery date.
2. **Notify the HIPAA Security Officer** immediately (within 1 hour of discovery).
3. **Do NOT attempt to cover up or delay reporting** -- this is a separate HIPAA violation.
4. **Preserve all evidence** -- do not delete logs, rotate keys, or make changes until evidence is preserved.
5. **Open an incident channel** (e.g., dedicated Slack channel or incident management tool).
6. **Begin the Breach Assessment Form** (see [Templates](#breach-assessment-form)).

---

## Phase 2: Assessment

### Four-Factor Risk Assessment

HIPAA requires a risk assessment to determine whether a breach must be reported. Evaluate these four factors:

#### Factor 1: Nature and Extent of PHI Involved

| Question | Considerations for Donna |
|----------|-------------------------|
| What types of PHI were involved? | Conversation transcripts, user-entered health details, legacy medical notes if any remain, senior names/phones, call analyses, caregiver notifications |
| Does the PHI include clinical data? | Possibly -- health discussions or user-entered reminder/profile text can include clinical details |
| Does it include financial identifiers? | No (Donna does not process SSNs, financial data) |
| Does it include direct identifiers? | Yes -- names, phone numbers, addresses |
| How many data elements were exposed? | Count specific fields and records affected |

**Donna-specific sensitivity tiers:**

| Tier | Data | Risk if Exposed |
|------|------|-----------------|
| CRITICAL | `conversations.transcript`, deprecated `seniors.medical_notes` if legacy values remain, `memories.content` (health-related) | Health conversation history with identifiers |
| HIGH | `reminders` containing user-entered health details, `call_analyses.analysis_encrypted`, `notifications.content` | Health details tied to an identified senior |
| MEDIUM | `seniors` (name, phone, city/state), `call_analyses.summary` | Personal identifiers + general health status |
| LOW | `daily_call_context`, `conversations.sentiment`, engagement scores | Behavioral data without specific health detail |

#### Factor 2: Unauthorized Person Who Used or Received the PHI

| Question | Considerations |
|----------|---------------|
| Was the recipient a covered entity or business associate? | If yes, lower risk (they have HIPAA obligations too) |
| Was the recipient a workforce member acting in good faith? | If yes, may qualify for exception |
| Was the recipient a malicious actor? | If yes, higher risk |
| Does the recipient have the ability to re-identify de-identified data? | Relevant if only partial data was exposed |

#### Factor 3: Was PHI Actually Acquired or Viewed?

| Question | Considerations |
|----------|---------------|
| Is there evidence the data was actually accessed (not just exposed)? | Check access logs, Sentry traces, vendor logs |
| Was the exposure a technical vulnerability or actual exploitation? | Vulnerability without evidence of access = lower risk |
| Can you determine with certainty that data was NOT accessed? | If uncertain, assume it was accessed |

#### Factor 4: Extent of Mitigation

| Question | Considerations |
|----------|---------------|
| Has the unauthorized recipient returned or destroyed the PHI? | Get written confirmation |
| Has the vulnerability been patched? | Verify before considering mitigated |
| Were affected credentials rotated? | Passwords, API keys, database credentials |
| Was the exposure window limited? | Shorter window = lower risk |

### Assessment Decision

If the four-factor analysis demonstrates a **low probability** that PHI was compromised, the incident is NOT a reportable breach. Document this determination thoroughly.

If there is **any doubt**, treat it as a reportable breach and proceed to Phase 4.

---

## Phase 3: Containment

### Immediate Technical Actions

Perform these in order. **Preserve evidence before making changes.**

#### 1. Evidence Preservation (FIRST)

```bash
# Export Railway logs for the affected time period
railway logs --service donna-pipecat --environment production --since "2026-01-01T00:00:00Z" > incident_logs_pipecat.txt
railway logs --service donna-api --environment production --since "2026-01-01T00:00:00Z" > incident_logs_api.txt

# Export Sentry events for the time period
# (Use Sentry API or dashboard export)

# Screenshot/export Neon query logs if available
# (Neon dashboard > Monitoring > Query logs)
```

#### 2. Access Revocation

| Action | Command/Location | When |
|--------|-----------------|------|
| Rotate database credentials | Neon dashboard > Connection settings > Reset password | If DB credentials compromised |
| Rotate API keys | Railway dashboard > Environment variables | If any API key compromised |
| Rotate JWT secret | Update `JWT_SECRET` in Railway env vars (all environments) | If JWT secret compromised |
| Revoke Clerk sessions | Clerk dashboard > Sessions > Revoke all | If Clerk tokens compromised |
| Rotate Telnyx API key / public-key configuration | Telnyx Mission Control + Railway env vars | If Telnyx credentials or webhook configuration are compromised |
| Rotate Twilio auth token | Twilio console > Account > Auth Token > Rotate | Only if archived Twilio credentials are still present or Twilio is reintroduced |
| Disable compromised admin accounts | Database: `UPDATE admin_users SET ...` or delete account | If admin account compromised |

#### 3. System Isolation

| Action | When |
|--------|------|
| Disable public API access (emergency) | If active exploitation is ongoing |
| Enable maintenance mode | If system integrity is uncertain |
| Disable outbound calls | If call system is compromised (prevents further PHI exposure) |
| Block suspicious IP addresses | If attack source is identified |

#### 4. Vulnerability Remediation

- Patch the vulnerability that caused the breach
- Deploy fix to all environments (dev, staging, production)
- Verify fix with testing before restoring service

### Containment Checklist

- [ ] Evidence preserved (logs, screenshots, Sentry exports)
- [ ] Compromised credentials rotated
- [ ] Affected systems isolated (if needed)
- [ ] Vulnerability identified and patched
- [ ] Fix deployed and verified
- [ ] Services restored
- [ ] Monitoring enhanced for recurrence

---

## Phase 4: Notification

### Individual Notification (All Breaches of Unsecured PHI)

**Deadline**: Within 60 calendar days of discovery date.

**Method**: Written notification via first-class mail to the last known address. Email is permitted ONLY if the individual has previously agreed to electronic communication.

For Donna, notification should be sent to:
- The **caregiver** (as the account holder and family contact)
- The **senior** (as the affected individual)

**Content requirements** (45 CFR 164.404(c)):
1. Brief description of what happened, including dates
2. Description of the types of unsecured PHI involved
3. Steps individuals should take to protect themselves
4. Brief description of what Donna is doing to investigate, mitigate harm, and prevent recurrence
5. Contact information for questions (toll-free number, email, website, or postal address)

See [Individual Notification Letter Template](#individual-notification-letter-template) below.

### HHS Notification

**If 500+ individuals affected**: Submit to HHS within 60 days via the HHS Breach Reporting Portal: https://ocrportal.hhs.gov/ocr/breach/wizard_breach.jsf

**If fewer than 500 individuals affected**: Log the breach and submit to HHS within 60 days of the end of the calendar year.

**HHS notification content:**
- Name and contact info of the entity
- Date(s) of the breach and discovery
- Type of unsecured PHI involved
- Number of individuals affected
- Description of the breach
- Actions taken in response

See [HHS Notification Checklist](#hhs-notification-checklist) below.

### Media Notification

**Required only if 500+ individuals in a single state or jurisdiction are affected.**

- Contact prominent media outlets (local TV, newspapers) in the affected state
- Within 60 calendar days of discovery
- Same content as individual notification

### Vendor Notification

If the breach originated at a vendor (business associate), the vendor must notify Donna within the timeframe specified in the BAA (typically 30-60 days). Donna is then responsible for individual and HHS notifications.

If Donna's systems caused a breach affecting a vendor's data, notify the vendor per the BAA terms.

---

## Phase 5: Documentation

### What Must Be Documented

HIPAA requires documentation of all breach investigations, even if the four-factor assessment determines the incident is NOT a reportable breach. Retain for **6 years**.

Create an incident report containing:

1. **Incident summary**: What happened, when discovered, who discovered it
2. **Timeline**: Chronological sequence of events from first indicator to resolution
3. **Affected data**: What PHI was involved, how many records, how many individuals
4. **Root cause**: Technical root cause analysis
5. **Four-factor risk assessment**: Documented analysis and determination
6. **Containment actions**: What was done to stop the breach
7. **Remediation actions**: What was done to prevent recurrence
8. **Notifications sent**: Copies of all notifications (individual, HHS, media, vendor)
9. **Lessons learned**: What went wrong, what went right, process improvements

### Storage

- Store incident reports in an access-controlled location (not in the git repository)
- Encrypt incident reports at rest
- Limit access to HIPAA Security Officer and legal counsel
- Retain for minimum 6 years from date of creation

---

## Phase 6: Post-Incident Review

### Within 30 Days of Resolution

1. **Root cause analysis (RCA)**: Conduct a thorough technical investigation.
2. **Lessons learned meeting**: All involved parties review what happened and what could be improved.
3. **Process improvements**: Update runbooks, monitoring, and procedures based on findings.
4. **Remediation verification**: Confirm all fixes are in place and effective.
5. **Training update**: If the breach revealed a training gap, update workforce training materials.

### Post-Incident Checklist

- [ ] Incident report completed and filed
- [ ] Root cause analysis documented
- [ ] Lessons learned meeting held
- [ ] All notifications sent within required timelines
- [ ] Vulnerabilities patched and verified
- [ ] Monitoring enhanced to detect similar incidents
- [ ] Policies/procedures updated if needed
- [ ] HIPAA Security Officer sign-off
- [ ] Legal counsel review (if applicable)
- [ ] BAA Tracker updated if vendor was involved
- [ ] This runbook updated with any process improvements

---

## Templates

### Breach Assessment Form

Complete this form for every security incident that may involve PHI.

```
=== DONNA BREACH ASSESSMENT FORM ===

Incident ID:        ____________________
Discovery Date:     ____________________
Discovery Time:     ____________________
Reported By:        ____________________
HIPAA Officer:      ____________________

--- INCIDENT DESCRIPTION ---

What happened:
________________________________________________________________________
________________________________________________________________________

When did it happen (or estimated window):
  Start: ____________________
  End:   ____________________

How was it discovered:
________________________________________________________________________

--- DATA INVOLVED ---

PHI types affected (check all that apply):
  [ ] Senior names
  [ ] Phone numbers
  [ ] Addresses (city/state/zip)
  [ ] Conversation transcripts
  [ ] Deprecated medical notes, if legacy values remain
  [ ] Reminder information
  [ ] Call analyses / summaries
  [ ] Memory records (semantic memories)
  [ ] Caregiver information
  [ ] Caregiver notifications
  [ ] Other: ____________________

Number of individuals affected:
  [ ] Unknown (estimated range: ________)
  [ ] 1-10
  [ ] 11-499
  [ ] 500+

Database tables affected:
  [ ] seniors
  [ ] conversations
  [ ] memories
  [ ] reminders
  [ ] reminder_deliveries
  [ ] call_analyses
  [ ] daily_call_context
  [ ] caregivers
  [ ] notifications
  [ ] admin_users
  [ ] Other: ____________________

--- FOUR-FACTOR RISK ASSESSMENT ---

Factor 1 - Nature and extent of PHI:
________________________________________________________________________
________________________________________________________________________
Risk: [ ] Low  [ ] Medium  [ ] High

Factor 2 - Who accessed/received the PHI:
________________________________________________________________________
________________________________________________________________________
Risk: [ ] Low  [ ] Medium  [ ] High

Factor 3 - Was PHI actually acquired or viewed:
________________________________________________________________________
________________________________________________________________________
Evidence: [ ] Confirmed accessed  [ ] Likely accessed  [ ] No evidence of access

Factor 4 - Extent of mitigation:
________________________________________________________________________
________________________________________________________________________
Mitigated: [ ] Fully  [ ] Partially  [ ] Not yet

--- DETERMINATION ---

  [ ] REPORTABLE BREACH - Proceed to notification (Phase 4)
  [ ] NOT A REPORTABLE BREACH - Document reasoning below
  [ ] EXCEPTION APPLIES - Specify: ____________________

Reasoning:
________________________________________________________________________
________________________________________________________________________

Determined by:      ____________________
Date:               ____________________

--- CONTAINMENT ACTIONS TAKEN ---

________________________________________________________________________
________________________________________________________________________
________________________________________________________________________
```

### Individual Notification Letter Template

```
[DONNA LETTERHEAD]

[Date]

[Recipient Name]
[Recipient Address]

Dear [Recipient Name],

We are writing to inform you of a security incident that may have affected
the privacy of [your / your loved one's] personal health information.

WHAT HAPPENED

On [discovery date], we discovered that [brief, plain-language description
of what happened -- e.g., "an unauthorized party may have accessed
conversation records from our system"]. The incident occurred between
[start date] and [end date].

WHAT INFORMATION WAS INVOLVED

The types of information that may have been affected include:
- [List specific types, e.g., "name and phone number"]
- [e.g., "conversation summaries from phone calls"]
- [e.g., "reminder information"]

Please note: [No financial information such as Social Security numbers,
credit card numbers, or bank account information was involved in this
incident. / Adjust as appropriate.]

WHAT WE ARE DOING

Upon discovering this incident, we immediately:
- [Specific action, e.g., "secured the affected system and rotated all
  access credentials"]
- [e.g., "engaged a cybersecurity firm to investigate the incident"]
- [e.g., "implemented additional security measures to prevent recurrence"]
- [e.g., "reported this incident to the U.S. Department of Health and
  Human Services"]

WHAT YOU CAN DO

While we have no evidence that your information has been misused, we
recommend the following precautions:
- Monitor any health-related accounts for unusual activity
- Be cautious of unsolicited communications referencing your health
  information or medications
- Report any suspicious activity to us immediately

FOR MORE INFORMATION

If you have questions or concerns, please contact us at:

  Email: [privacy@calldonna.co]
  Phone: [toll-free number]
  Mail:  [postal address]

We sincerely apologize for this incident and any concern it may cause.
Protecting the privacy of the individuals we serve is of the utmost
importance to us.

Sincerely,

[Name]
[Title]
Donna Health, Inc.
```

### HHS Notification Checklist

Use this checklist when submitting a breach report to HHS via https://ocrportal.hhs.gov/ocr/breach/wizard_breach.jsf

```
=== HHS BREACH NOTIFICATION CHECKLIST ===

Filing deadline: ____________________
  (60 days from discovery for 500+; end of calendar year for <500)

Required information:

  [ ] Entity name: Donna Health, Inc. (or current legal entity name)
  [ ] Entity type: [ ] Covered Entity  [ ] Business Associate
  [ ] Contact person name: ____________________
  [ ] Contact person title: ____________________
  [ ] Contact phone: ____________________
  [ ] Contact email: ____________________
  [ ] Contact address: ____________________

  [ ] Breach date(s): ____________________
  [ ] Discovery date: ____________________
  [ ] Number of individuals affected: ____________________

  [ ] Type of breach:
      [ ] Hacking/IT Incident
      [ ] Unauthorized Access/Disclosure
      [ ] Theft
      [ ] Loss
      [ ] Improper Disposal
      [ ] Other: ____________________

  [ ] Location of breached information:
      [ ] Network Server
      [ ] Email
      [ ] Electronic Medical Record
      [ ] Paper/Films
      [ ] Other: ____________________

  [ ] Type of PHI involved:
      [ ] Demographic information
      [ ] Clinical information
      [ ] Financial information
      [ ] Other: ____________________

  [ ] Safeguards in place before the breach:
      ____________________________________________________________

  [ ] Actions taken in response:
      ____________________________________________________________

  [ ] Whether individuals were notified: [ ] Yes  [ ] No
      If yes, date notified: ____________________
      Method: [ ] Written  [ ] Email  [ ] Substitute notice

  [ ] Whether media was notified: [ ] Yes  [ ] No  [ ] N/A (<500)
      If yes, date notified: ____________________

Filed by: ____________________
Date filed: ____________________
HHS confirmation number: ____________________
```

---

## Contact List

Maintain an up-to-date contact list for incident response. Update this section when roles change.

| Role | Name | Phone | Email | Backup |
|------|------|-------|-------|--------|
| HIPAA Security Officer | TBD | TBD | TBD | TBD |
| CTO / Technical Lead | TBD | TBD | TBD | TBD |
| CEO | TBD | TBD | TBD | TBD |
| Legal Counsel | TBD | TBD | TBD | TBD |
| Cyber Insurance Provider | TBD | TBD | TBD | TBD |
| Telnyx Account Manager | TBD | TBD | TBD | TBD |
| Neon Account Manager | TBD | TBD | TBD | TBD |

### External Resources

| Resource | Contact |
|----------|---------|
| HHS Breach Portal | https://ocrportal.hhs.gov/ocr/breach/wizard_breach.jsf |
| HHS OCR Hotline | 1-800-368-1019 |
| FBI Cyber Division | https://www.ic3.gov (Internet Crime Complaint Center) |

---

## Drill Schedule

Conduct tabletop exercises to practice breach response procedures. These drills are NOT optional -- they ensure the team can execute this runbook under pressure.

| Drill Type | Frequency | Last Conducted | Next Scheduled |
|------------|-----------|----------------|----------------|
| Tabletop exercise (full scenario) | Biannually | Never | TBD (schedule within 30 days) |
| Notification procedure walkthrough | Annually | Never | TBD |
| Credential rotation drill | Quarterly | Never | TBD |
| Vendor breach notification test | Annually | Never | TBD |

### Suggested Drill Scenarios

1. **Database credential leaked in a public GitHub commit** -- tests credential rotation, evidence preservation, scope assessment.
2. **Vendor (e.g., Deepgram) reports a breach affecting their STT service** -- tests vendor notification chain, four-factor assessment, downstream notification.
3. **Sentry alert reveals conversation transcripts in error traces** -- tests log review, scope assessment, determination of whether PHI was actually exposed.
4. **Former employee retains database access** -- tests access revocation procedures, audit log review.
5. **Railway infrastructure compromise** -- tests full incident response including system isolation, data assessment, and recovery.

---

*This runbook must be reviewed and updated annually, after every security incident, and after every tabletop drill. All team members with access to PHI must know how to reach the HIPAA Security Officer and initiate this process.*
