# Third-Party Vendor Security Evaluation

> Evaluates the security posture, HIPAA readiness, and data handling practices of every third-party vendor in the Donna system. Identifies high-risk vendors and recommends alternatives.

| Field | Value |
|-------|-------|
| Last Updated | April 22, 2026 |
| Owner | TBD (HIPAA Security Officer) |
| Review Cadence | Annually + before adding any new vendor |
| Related Docs | [HIPAA Overview](HIPAA_OVERVIEW.md), [BAA Tracker](BAA_TRACKER.md), [Data Retention](DATA_RETENTION_POLICY.md) |

---

## Table of Contents

1. [Evaluation Framework](#evaluation-framework)
2. [Data Flow Summary](#data-flow-summary)
3. [Vendor Evaluations by Category](#vendor-evaluations-by-category)
4. [Highest-Risk Vendors](#highest-risk-vendors)
5. [Vendor Evaluation Template](#vendor-evaluation-template)
6. [New Vendor Approval Process](#new-vendor-approval-process)

---

## Evaluation Framework

Each vendor is evaluated on the following criteria:

| Criterion | Description | Weight |
|-----------|-------------|--------|
| **PHI Exposure** | What types and volume of PHI does the vendor receive? | Critical |
| **BAA Availability** | Does the vendor offer a HIPAA Business Associate Agreement? | Critical |
| **Security Certifications** | SOC 2 Type II, HIPAA, ISO 27001, FedRAMP, etc. | High |
| **Data Retention** | Does the vendor retain data? For how long? Can customer control retention? | High |
| **Encryption** | Encryption in transit and at rest? Customer-managed keys? | High |
| **Data Processing Agreement** | Clear DPA specifying processing purposes, subprocessors, and geographic restrictions? | Medium |
| **Incident Response** | Does the vendor have a documented incident response plan? Will they notify us of breaches? | Medium |
| **Geographic Data Residency** | Where is data processed and stored? US-only or international? | Medium |
| **Replaceability** | How difficult is it to switch to an alternative vendor? | Low |

### Risk Rating

| Rating | Definition |
|--------|-----------|
| **LOW** | Vendor has BAA, SOC 2, minimal PHI exposure, or no PHI processed |
| **MEDIUM** | Vendor has some certifications but BAA status is unclear; moderate PHI exposure |
| **HIGH** | Vendor processes significant PHI, BAA is unavailable or unlikely, limited certifications |
| **CRITICAL** | Vendor processes high-sensitivity PHI with no BAA, no relevant certifications, and no clear path to compliance |

---

## Data Flow Summary

The following diagram shows how PHI flows through Donna's vendor ecosystem:

```
Senior (phone call)
    │
    ▼
┌─────────┐     ┌───────────┐     ┌──────────────┐     ┌────────────────┐
│ Telnyx   │────►│ Deepgram  │────►│ Groq/Google  │────►│ Anthropic      │
│ (audio + │     │ (audio →  │     │ Groq/Google  │     │ (Claude:       │
│  phone#) │     │  text)    │     │ (Director    │     │  full convo)   │
└─────────┘     └───────────┘     │  analysis)   │     └───────┬────────┘
                                  └──────────────┘             │
                                                               ▼
┌─────────────┐     ┌───────────┐     ┌──────────────┐   ┌────────────┐
│ ElevenLabs/ │◄────│ Claude    │     │ OpenAI       │   │ Tavily     │
│ Cartesia    │     │ response  │     │ (embeddings  │   │ (web       │
│ (TTS text)  │     │ text      │     │  + search)   │   │  search)   │
└─────────────┘     └───────────┘     └──────────────┘   └────────────┘
                                               │
                                               ▼
                                      ┌──────────────┐
                                      │ Neon         │
                                      │ (PostgreSQL: │
                                      │  ALL data)   │
                                      └──────────────┘
                                               │
                              ┌────────────────┼────────────────┐
                              ▼                ▼                ▼
                        ┌──────────┐    ┌───────────┐    ┌──────────┐
                        │ Railway  │    │ Sentry    │    │ Resend   │
                        │ (logs,   │    │ (errors)  │    │ (email   │
                        │  runtime)│    └───────────┘    │ notices) │
                        └──────────┘                     └──────────┘
```

**PHI touches 12+ external vendors** during or shortly after a single phone call. This is the primary compliance risk. SMS is inactive for now; Twilio is not part of the active PHI flow.

---

## Vendor Evaluations by Category

### 1. Telephony: Telnyx

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | HIGH -- raw voice audio/media streaming, phone numbers, call metadata, phone number inventory, optional call recordings if enabled |
| **BAA Available** | **Yes / confirm scope** -- Telnyx publishes HIPAA guidance for BAA-covered and conduit-exception workflows; confirm Donna's Voice API + media streaming posture with Telnyx sales/legal |
| **Security Certifications** | SOC 2 Type II, ISO 27001, PCI DSS Level 1 |
| **Data Retention** | Configurable -- call logs retained by default, recordings if enabled. Must configure retention limits and keep recording disabled unless explicitly needed. |
| **Encryption** | TLS in transit, AES-256 at rest for recordings |
| **Data Residency** | US routing/data center options available; confirm for Voice API/media streaming setup |
| **Incident Response** | Documented; breach notification per BAA terms |
| **Risk Rating** | **MEDIUM** (BAA available but not yet signed; high PHI exposure) |

**Actions:**
1. Confirm Telnyx Voice API + media streaming HIPAA/BAA scope with Telnyx sales/legal
2. Sign Telnyx BAA or file legal approval for a conduit-exception posture
3. Configure data retention limits (minimize call log retention)
4. Ensure call recording is disabled unless explicitly needed (currently disabled)
5. Review Telnyx subprocessor list

### 1a. Inactive Telephony/SMS: Twilio

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | None in active runtime. Historical Twilio voice code is archived, and SMS notifications are disabled. |
| **BAA Available** | **Yes** if Twilio is reintroduced |
| **Risk Rating** | **LOW while inactive** |

**Actions:**
1. Keep Twilio out of active PHI paths while SMS remains disabled.
2. Re-run vendor/security review and execute a BAA before reintroducing Twilio SMS or Twilio voice.

---

### 2. Primary LLM: Anthropic (Claude)

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | CRITICAL -- receives full conversation context including system prompt (with senior name, language setting, age/birthday context, interests and interest details, additional family context, topics to avoid, memories, recent call history), all user utterances, and all assistant responses. Medical notes are deprecated and not injected, but users may still disclose health details during calls. Every word spoken in a call passes through Claude. |
| **BAA Available** | **Yes** -- Anthropic offers BAA on enterprise plans |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | API inputs/outputs retained for 30 days by default for trust & safety. Enterprise plans can negotiate shorter retention or opt-out. |
| **Encryption** | TLS in transit; encryption at rest |
| **Data Residency** | US (GCP infrastructure) |
| **Incident Response** | Documented in enterprise agreements |
| **Risk Rating** | **MEDIUM** (BAA available but not yet signed; highest PHI volume) |

**Actions:**
1. Contact Anthropic enterprise sales for BAA
2. Negotiate data retention terms (minimize or eliminate API log retention)
3. Confirm Anthropic does not use API data for model training (currently true for API)
4. Review Anthropic's subprocessor list
5. Evaluate whether prompt caching has additional data retention implications

---

### 3. Director LLM: Google (Gemini Flash)

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | HIGH -- receives conversation transcripts for Director analysis and post-call analysis. Post-call analysis includes full conversation for summary, engagement scoring, and caregiver takeaway generation. |
| **BAA Available** | **Yes** -- Google Cloud offers BAA as part of Google Cloud Healthcare |
| **Security Certifications** | SOC 2 Type II, ISO 27001, HIPAA, FedRAMP, HITRUST |
| **Data Retention** | Vertex AI API: no retention for model improvement. Logging configurable. |
| **Encryption** | TLS in transit, AES-256 at rest, customer-managed encryption keys (CMEK) available |
| **Data Residency** | US regions available; configurable |
| **Incident Response** | Documented; enterprise SLAs available |
| **Risk Rating** | **LOW** (BAA available, extensive certifications, clear compliance path) |

**Actions:**
1. Enable BAA in Google Cloud Console (Healthcare API settings)
2. Ensure Gemini API calls go through Vertex AI (covered by GCP BAA), not the free consumer API
3. Disable data logging for Gemini API calls
4. Consider CMEK for additional encryption control
5. **Gemini is the safest choice for any LLM workload requiring HIPAA compliance**

---

### 4. Legacy Director LLM: Cerebras

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | HIGH if re-enabled -- would receive recent conversation turns for Director analysis. Current `pipecat/services/director_llm.py` does not call Cerebras. |
| **BAA Available** | **Unlikely** -- Cerebras is primarily an AI chip/infrastructure company. No public HIPAA program or BAA offering found. |
| **Security Certifications** | Limited public information; primarily focused on hardware performance, not compliance |
| **Data Retention** | Unknown -- no public data retention policy for inference API |
| **Encryption** | TLS in transit (assumed); at-rest details unknown |
| **Data Residency** | Unknown |
| **Incident Response** | Unknown |
| **Risk Rating** | **CRITICAL if re-enabled; legacy/not active in current runtime** |

**Actions:**
1. Confirm no deployed branch or Railway environment still routes Director traffic to Cerebras.
2. Remove stale Cerebras environment variables and references if unused.
3. Do not re-enable Cerebras for PHI workloads without a signed BAA and documented retention terms.

**Recommended alternative:** Keep Director traffic on **Groq only with a signed BAA** or route it through **Google Gemini Flash** on a BAA-covered GCP path.

---

### 5. Director LLM: Groq

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | HIGH -- current primary Director provider receives recent conversation turns for Query Director and Guidance Director analysis |
| **BAA Available** | **Unclear** -- Groq has enterprise offerings but no public HIPAA program |
| **Security Certifications** | SOC 2 Type II (claimed); details limited |
| **Data Retention** | Unknown for inference API |
| **Encryption** | TLS in transit |
| **Data Residency** | US (LPU Cloud) |
| **Incident Response** | Unknown |
| **Risk Rating** | **HIGH** |

**Actions:**
1. Contact Groq sales to inquire about BAA availability
2. If BAA is available, document plan, data retention, and subprocessor terms
3. If BAA is not available, migrate Director traffic to Gemini Flash through a BAA-covered GCP path

---

### 6. STT: Deepgram

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | CRITICAL -- receives raw voice audio stream containing everything the senior says, including health discussions, medication names, personal details, emotional state |
| **BAA Available** | **Yes** -- Deepgram offers HIPAA-compliant deployments on enterprise plans |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | Streaming mode: audio is processed in real-time and not stored. Verify no logging of transcription results. |
| **Encryption** | TLS in transit; audio not persisted |
| **Data Residency** | US |
| **Incident Response** | Documented in enterprise agreements |
| **Risk Rating** | **MEDIUM** (BAA available but not yet signed; critical PHI exposure via audio) |

**Actions:**
1. Contact Deepgram enterprise for BAA
2. Confirm streaming audio is not retained or logged
3. Confirm transcription results are not retained
4. Review Deepgram's subprocessor list

---

### 7. TTS: ElevenLabs

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | MEDIUM -- receives Donna's spoken responses as text, which may reference medications ("Remember to take your metformin"), health advice, and appointment reminders. Does NOT receive the senior's speech. |
| **BAA Available** | **Unclear** -- ElevenLabs has enterprise plans but no public HIPAA program |
| **Security Certifications** | SOC 2 Type II (Enterprise plan) |
| **Data Retention** | Default: audio generation history may be stored. Enterprise: configurable. |
| **Encryption** | TLS in transit |
| **Data Residency** | US and EU options |
| **Incident Response** | Enterprise SLA |
| **Risk Rating** | **HIGH** |

**Actions:**
1. Contact ElevenLabs to inquire about BAA on enterprise plan
2. If BAA unavailable, evaluate **Google Cloud TTS** (covered by GCP BAA) as a replacement
3. Disable speech history/logging if possible in current ElevenLabs configuration
4. Review ElevenLabs data processing terms

---

### 8. TTS: Cartesia

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | MEDIUM -- same as ElevenLabs (receives Donna's response text) |
| **BAA Available** | **Unlikely** -- Cartesia is a smaller startup with no public compliance program |
| **Security Certifications** | None publicly documented |
| **Data Retention** | Unknown |
| **Encryption** | TLS in transit (assumed) |
| **Data Residency** | Unknown |
| **Incident Response** | Unknown |
| **Risk Rating** | **CRITICAL** |

**Actions:**
1. **Disable Cartesia immediately** via GrowthBook feature flag (`tts_provider` = "elevenlabs")
2. Do not route any PHI through Cartesia until compliance is confirmed
3. If a second TTS provider is needed, evaluate **Google Cloud TTS** (GCP BAA)

**Recommended alternative:** **Google Cloud Text-to-Speech** -- covered by GCP BAA, SOC 2, ISO 27001, HIPAA-eligible. Supports streaming, multiple voices, and SSML. Integration via the Pipecat `GoogleTTSService` is straightforward.

---

### 9. Embeddings & Search: OpenAI

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | HIGH -- receives all memory text for embedding (health conditions, medications, personal facts, relationships). Also receives web search queries that may reference health topics. |
| **BAA Available** | **Yes** -- OpenAI offers BAA on enterprise plans |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | API: data not used for training (opt-out by default for API). Zero-retention option available on enterprise. |
| **Encryption** | TLS in transit, AES-256 at rest |
| **Data Residency** | US |
| **Incident Response** | Documented in enterprise agreements |
| **Risk Rating** | **MEDIUM** (BAA available, good certifications, but high PHI volume through embeddings) |

**Actions:**
1. Contact OpenAI enterprise for BAA
2. Confirm zero-data-retention is enabled for API usage
3. Confirm training opt-out is active
4. Evaluate whether embedding can be done locally (e.g., using open-source models) to reduce PHI exposure -- tradeoff is embedding quality

---

### 10. Web Search: Tavily

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | MEDIUM -- receives search queries generated from senior conversations. Queries like "best exercises for arthritis", "side effects of metformin", or "what time does the pharmacy close" reveal health information about the calling senior (especially when combined with timing and frequency patterns). |
| **BAA Available** | **Unlikely** -- Tavily is a small startup focused on AI search; no public compliance program |
| **Security Certifications** | None publicly documented |
| **Data Retention** | Unknown |
| **Encryption** | TLS in transit (assumed) |
| **Data Residency** | Unknown |
| **Incident Response** | Unknown |
| **Risk Rating** | **CRITICAL** |

**Actions:**
1. **Replace Tavily with OpenAI web search** -- OpenAI is already integrated for news retrieval (`pipecat/services/news.py`) and offers enterprise BAA
2. Update `pipecat/services/news.py` so the active `web_search` tool uses OpenAI search only when Tavily cannot support compliant terms
3. Remove `TAVILY_API_KEY` from environment variables and `pipecat/config.py`
4. Migration effort: LOW (OpenAI web search is already integrated as the fallback path)

**Recommended alternative:** **OpenAI web search** (already integrated, enterprise BAA available). The migration is straightforward since OpenAI web search is already used for news retrieval. Alternatively, search queries could be de-identified before sending to any provider, but this is complex and may reduce search quality.

---

### 11. Database: Neon (PostgreSQL)

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | CRITICAL -- stores ALL persistent data: senior profiles (name, phone), conversation transcripts, semantic memories, reminders, call analyses, caregiver relationships, and deprecated medical-note columns until nulled by migration 014/026 |
| **BAA Available** | **Yes** -- Neon offers BAA on Pro and Enterprise plans |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | Customer-controlled; PITR (Point-in-Time Recovery) window configurable by plan |
| **Encryption** | TLS in transit, AES-256 at rest |
| **Data Residency** | US regions available (AWS) |
| **Incident Response** | Documented; breach notification per BAA |
| **Risk Rating** | **MEDIUM** (BAA available, critical data volume) |

**Actions:**
1. Sign Neon BAA (highest priority -- Neon holds all PHI)
2. Verify PITR retention window aligns with data retention policy
3. Ensure database connections use SSL/TLS (verify `sslmode=require` in connection string)
4. Implement database-level access controls (least-privilege users for each service)
5. Enable Neon audit logging if available

---

### 12. Hosting: Railway

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | MEDIUM -- application logs (sanitized but may contain PHI in error paths), environment variables (database URLs, API keys), container runtime memory |
| **BAA Available** | **Unclear** -- Railway is a growing platform; no public HIPAA program |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | Logs: 7 days default. Environment variables: retained while service exists. |
| **Encryption** | TLS in transit; details of at-rest encryption for logs/env vars unclear |
| **Data Residency** | US (GCP infrastructure) |
| **Incident Response** | Community-driven; no enterprise SLA documented |
| **Risk Rating** | **HIGH** |

**Actions:**
1. Contact Railway to inquire about BAA availability
2. If BAA unavailable, evaluate alternatives:
   - **AWS ECS/Fargate** -- BAA available, HIPAA-eligible
   - **Google Cloud Run** -- BAA available via GCP Healthcare
   - **Render** -- Inquire about BAA (SOC 2 certified)
3. As interim mitigation:
   - Enhance PII sanitization in logs to catch edge cases
   - Minimize PHI in environment variables (use secrets manager for sensitive config)
   - Ensure Railway log retention is set to minimum (7 days)

---

### 13. Error Monitoring: Sentry

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | MEDIUM -- error traces may contain senior IDs, phone numbers (despite `send_default_pii=False`), variable contents in stack traces, request metadata |
| **BAA Available** | **Yes** -- Sentry offers BAA on Business plan |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | Configurable per project; default 90 days |
| **Encryption** | TLS in transit, encryption at rest |
| **Data Residency** | US (default), EU option available |
| **Incident Response** | Documented |
| **Risk Rating** | **MEDIUM** (BAA available on upgrade; moderate PHI exposure) |

**Actions:**
1. Upgrade Sentry to Business plan
2. Sign Sentry BAA
3. Configure data retention to 90 days
4. Review `send_default_pii=False` settings and add additional data scrubbing rules
5. Add Sentry data scrubbing for: phone numbers, senior names, medical terms in error messages

---

### 14. Feature Flags: GrowthBook

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | LOW -- receives senior IDs and feature flag targeting attributes. Senior IDs alone are pseudonymous but could be linked to PHI if combined with database access. |
| **BAA Available** | **Unlikely** -- GrowthBook is focused on feature flags, not healthcare compliance |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | Feature flag evaluations may be logged; details unclear |
| **Encryption** | TLS in transit |
| **Risk Rating** | **LOW** |

**Actions:**
1. Replace raw senior UUIDs with anonymous hashed identifiers in GrowthBook targeting
2. Minimize attributes sent to GrowthBook (only what is needed for flag evaluation)
3. Review GrowthBook data processing terms

---

### 15. Authentication: Clerk

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | LOW -- handles caregiver authentication (email, name). Caregivers are not patients, but caregiver accounts link to specific seniors via the `caregivers` table (this linking happens in Donna's database, not in Clerk). |
| **BAA Available** | **Yes** -- Clerk offers BAA on enterprise plans |
| **Security Certifications** | SOC 2 Type II |
| **Data Retention** | User data retained while account exists |
| **Encryption** | TLS in transit, encryption at rest |
| **Risk Rating** | **LOW** |

**Actions:**
1. Evaluate whether Clerk enterprise BAA is needed (depends on whether caregiver accounts are considered to contain PHI by association)
2. If needed, contact Clerk sales for enterprise BAA

---

### 16. Frontend Hosting: Vercel

| Criterion | Assessment |
|-----------|-----------|
| **PHI Exposure** | NONE -- serves static React bundles. All API calls go directly from the browser to Railway-hosted backends; Vercel never sees PHI. |
| **BAA Available** | Not applicable |
| **Security Certifications** | SOC 2 Type II |
| **Risk Rating** | **NONE** |

**Actions:** None required. Vercel does not process PHI.

---

## Highest-Risk Vendors

These three vendors represent the greatest HIPAA compliance risk and should be addressed first:

### 1. Groq Director -- HIGH Risk Until BAA Is Confirmed

**Why:** Processes recent conversation turns for Director analysis, fired continuously during calls. BAA status is unclear.

**Data exposed:** Senior speech transcriptions including health discussions, medication references, personal details, emotional expressions. Approximately 50-100 API calls per 10-minute conversation.

**Recommended action:** Sign a Groq BAA or migrate Director LLM traffic to **Google Gemini Flash** through a BAA-covered GCP path.
- Gemini is already the fallback in `pipecat/services/director_llm.py`
- GCP BAA can cover Gemini API calls through eligible Google Cloud services
- Migration effort: LOW to MEDIUM depending on SDK/API path and latency acceptance

**Timeline:** Complete within 2 weeks.

### 2. Cartesia -- CRITICAL Risk

**Why:** Processes all of Donna's spoken responses as TTS input text. No BAA available. No public compliance program. No certifications documented. Smaller startup with uncertain long-term viability.

**Data exposed:** Every word Donna speaks, which can include user-entered reminder text, health details disclosed during the call, and personal details about the senior. Donna no longer offers medication reminder types or medical advice flows.

**Recommended action:** Disable Cartesia via feature flag and use **ElevenLabs** exclusively (if BAA secured) or migrate to **Google Cloud TTS**.
- Cartesia is already behind GrowthBook feature flag `tts_provider`
- Disabling is a configuration change, not a code change
- If ElevenLabs cannot provide BAA, migrate to Google Cloud TTS (GCP BAA, HIPAA-eligible)

**Timeline:** Disable Cartesia within 1 week (feature flag change). Evaluate Google Cloud TTS within 4 weeks.

### 3. Tavily -- CRITICAL Risk

**Why:** Receives search queries generated from senior conversations. Queries like "metformin side effects" or "exercises for hip replacement recovery" directly reveal health information. No BAA available. No compliance program. Small startup.

**Data exposed:** Health-related search queries derived from senior conversations. When combined with timing information, these queries can be linked to specific individuals.

**Recommended action:** Replace Tavily with **OpenAI web search**.
- OpenAI web search is already integrated in `pipecat/services/news.py`
- OpenAI offers enterprise BAA
- Make the active `web_search` tool use the existing OpenAI fallback path by default
- Remove `TAVILY_API_KEY` from config

**Timeline:** Complete within 2 weeks.

---

## Vendor Evaluation Template

Use this template when evaluating a new vendor or re-evaluating an existing one.

```
=== VENDOR SECURITY EVALUATION ===

Date: ____________________
Evaluator: ____________________

--- VENDOR INFORMATION ---

Vendor Name: ____________________
Service/Product: ____________________
Vendor Website: ____________________
Vendor Contact: ____________________
Current Plan/Tier: ____________________

--- DATA ASSESSMENT ---

What PHI will this vendor receive?
________________________________________________________________________

Data flow description (how PHI gets to the vendor):
________________________________________________________________________

Volume estimate (API calls/day, data size):
________________________________________________________________________

Can the PHI be de-identified before sending?
  [ ] Yes   [ ] Partially   [ ] No
If partially, what remains identifiable? ____________________

--- COMPLIANCE ASSESSMENT ---

BAA Available?
  [ ] Yes   [ ] No   [ ] Unclear   [ ] Not Applicable
If yes, plan/tier required: ____________________

Security Certifications:
  [ ] SOC 2 Type II
  [ ] ISO 27001
  [ ] HIPAA
  [ ] HITRUST
  [ ] FedRAMP
  [ ] PCI DSS
  [ ] Other: ____________________
  [ ] None documented

Data Retention Policy:
  Retention period: ____________________
  Customer-configurable? [ ] Yes  [ ] No
  Opt-out of training data? [ ] Yes  [ ] No  [ ] N/A

Encryption:
  In transit: [ ] TLS 1.2+  [ ] Other: ____________________
  At rest: [ ] AES-256  [ ] CMEK available  [ ] Unknown
  Key management: ____________________

Data Residency:
  [ ] US only
  [ ] US + EU
  [ ] Global / unspecified
  Specific regions: ____________________

Incident Response:
  Documented plan? [ ] Yes  [ ] No
  Breach notification timeline: ____________________
  Customer notification method: ____________________

Subprocessors:
  Documented list available? [ ] Yes  [ ] No
  Notable subprocessors: ____________________

--- RISK ASSESSMENT ---

PHI Exposure Level: [ ] None  [ ] Low  [ ] Medium  [ ] High  [ ] Critical
BAA Status: [ ] Signed  [ ] Available  [ ] Unclear  [ ] Unavailable
Overall Risk Rating: [ ] Low  [ ] Medium  [ ] High  [ ] Critical

--- DECISION ---

  [ ] APPROVED - Vendor meets HIPAA requirements
  [ ] APPROVED WITH CONDITIONS - Conditions: ____________________
  [ ] DEFERRED - Pending: ____________________
  [ ] REJECTED - Reason: ____________________

Alternative vendors considered:
________________________________________________________________________

Approved by: ____________________
Date: ____________________
```

---

## New Vendor Approval Process

Before any new vendor receives PHI:

### Step 1: Evaluation

- Complete the Vendor Security Evaluation Template above
- Assess PHI exposure and BAA requirements

### Step 2: BAA Requirement

- If vendor will receive PHI: **BAA must be signed BEFORE any PHI is shared**
- If vendor will not receive PHI: document why no BAA is needed

### Step 3: Technical Review

- Review the vendor's API documentation for data handling practices
- Verify encryption (TLS 1.2+ minimum)
- Confirm data residency meets requirements
- Review subprocessor list

### Step 4: Approval

- HIPAA Security Officer must approve the vendor
- Document the approval decision and conditions
- Add the vendor to the [BAA Tracker](BAA_TRACKER.md)

### Step 5: Ongoing Monitoring

- Re-evaluate vendor annually
- Monitor vendor security announcements and breach disclosures
- Update evaluation if vendor changes terms, certifications, or data practices

---

## Vendor Comparison Matrix

Quick reference comparing compliance readiness across all vendors:

| Vendor | PHI Level | BAA | SOC 2 | HIPAA Cert | Risk | Action |
|--------|-----------|-----|-------|------------|------|--------|
| Telnyx | High | Available / confirm scope | Yes | No | Medium | Sign BAA or file conduit-exception review |
| Twilio | None while inactive | Available if reintroduced | Yes | No | Low | Keep inactive unless SMS/voice returns |
| Anthropic | Critical | Available | Yes | No | Medium | Sign BAA |
| Google (Gemini) | High | Available | Yes | Yes | Low | Sign BAA |
| Groq | High | Unclear | Claimed | No | High | Evaluate or replace |
| Cerebras | High if re-enabled | Unlikely | No | No | **Critical if active** | Keep disabled/remove legacy refs |
| Deepgram | Critical | Available | Yes | No | Medium | Sign BAA |
| ElevenLabs | Medium | Unclear | Yes (Ent.) | No | High | Evaluate |
| Cartesia | Medium | Unlikely | No | No | **Critical** | **Disable** |
| OpenAI | High | Available | Yes | No | Medium | Sign BAA |
| Tavily | Medium | Unlikely | No | No | **Critical** | **Replace** |
| Neon | Critical | Available | Yes | No | Medium | Sign BAA |
| Railway | Medium | Unclear | Yes | No | High | Evaluate |
| Sentry | Medium | Available | Yes | No | Medium | Sign BAA |
| GrowthBook | Low | Unlikely | Yes | No | Low | Minimize data |
| Clerk | Low | Available | Yes | No | Low | Evaluate |
| Vercel | None | N/A | Yes | N/A | None | None |

---

*This document must be updated whenever a vendor is added, removed, or changes its compliance posture. All vendor evaluations should be retained for 6 years per HIPAA requirements.*
