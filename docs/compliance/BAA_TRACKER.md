# Business Associate Agreement (BAA) Tracker

> Track BAA status for every third-party service that processes, stores, or transmits PHI.

| Field | Value |
|-------|-------|
| Last Updated | May 18, 2026 |
| Owner | TBD |
| Review Cadence | Quarterly |
| Related Docs | [HIPAA Overview](HIPAA_OVERVIEW.md), [Vendor Security Evaluation](VENDOR_SECURITY_EVALUATION.md), [May 5 Audit](../audits/2026-05-05-codebase-audit.md), [2,000-User Phase 0 Readiness](../operations/scale-2000-phase0-readiness.md) |

---

## Table of Contents

1. [What Is a BAA?](#what-is-a-baa)
2. [BAA Status Summary](#baa-status-summary)
3. [Detailed Vendor BAA Status](#detailed-vendor-baa-status)
4. [Action Items by Priority](#action-items-by-priority)
5. [Timeline](#timeline)

---

## What Is a BAA?

A **Business Associate Agreement (BAA)** is a legally binding contract required by HIPAA (45 CFR 164.502(e), 164.504(e)) between a covered entity (or business associate) and a business associate. It establishes:

- What PHI the business associate can access
- How the business associate must protect that PHI
- What happens in the event of a breach
- That the business associate will comply with applicable HIPAA requirements

**Without a signed BAA, sharing PHI with a third-party vendor is a HIPAA violation**, even if that vendor has excellent security practices.

**Donna's obligation**: Whether Donna is a covered entity or business associate, it must sign BAAs with every subcontractor that accesses PHI. These are called "downstream BAAs" or "subcontractor BAAs."

---

## BAA Status Summary

| Status | Count | Services |
|--------|-------|----------|
| BAA Signed | 0 | -- |
| BAA Available (not yet signed) | 8 | Telnyx, Anthropic, Google, Deepgram, OpenAI, Neon, Sentry, Clerk |
| BAA Availability Unclear | 4 | ElevenLabs, Groq, Railway, Resend |
| BAA Unlikely | 3 | Cerebras (legacy/not active), Cartesia, Tavily |
| BAA Not Required | 2 | Vercel, GrowthBook |

**Critical launch blocker: Zero BAAs are currently recorded as signed in this repo.** Active PHI flows send data to multiple vendors. Production PHI launch is blocked unless signed BAAs or documented legal determinations are verified outside the repo and then recorded here.

## 2,000-User Scaling Phase 0 Inventory

The 2,000-user scaling plan requires the capacity and BAA inventory below before live canary traffic. Populate measured peak, contract cap, owner, and target close date during Phase 0. Do not infer that a vendor is cleared for PHI just because technical scaling work exists.

| Vendor / Service | Phase 0 Measurement | Contract Cap | BAA Status | Owner | Target Close |
| --- | --- | --- | --- | --- | --- |
| Anthropic Haiku input/output TPM | TBD | TBD | NOT SIGNED | TBD | TBD |
| Anthropic Haiku concurrent calls | TBD | TBD | NOT SIGNED | TBD | TBD |
| Deepgram concurrent streams | TBD | TBD | NOT SIGNED | TBD | TBD |
| ElevenLabs concurrent TTS | TBD | TBD | NOT SIGNED / availability unclear | TBD | TBD |
| Cartesia concurrent TTS fallback | TBD | TBD | NOT SIGNED / unlikely | TBD | TBD |
| OpenAI embeddings RPM | TBD | TBD | NOT SIGNED | TBD | TBD |
| OpenAI news / web search QPS | TBD | TBD | NOT SIGNED | TBD | TBD |
| Tavily QPS | TBD | TBD | NOT SIGNED / unlikely | TBD | TBD |
| Telnyx outbound concurrent channels | TBD | TBD | NOT SIGNED in repo | TBD | TBD |
| Telnyx inbound concurrent channels | TBD | TBD | NOT SIGNED in repo | TBD | TBD |
| Telnyx caller-ID pool / branded calling | TBD | TBD | NOT SIGNED in repo | TBD | TBD |
| Neon pooled connections | TBD | TBD | NOT SIGNED | TBD | TBD |
| Redis vendor | TBD | TBD | TBD by selected vendor | TBD | TBD |
| Railway runtime/logging | TBD | TBD | NOT SIGNED / availability unclear | TBD | TBD |
| Resend send rate | TBD | TBD | NOT SIGNED / availability unclear | TBD | TBD |
| Sentry event volume | TBD | TBD | NOT SIGNED | TBD | TBD |

---

## Detailed Vendor BAA Status

### Voice & Telephony

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **Telnyx** | Voice audio/media streaming, phone numbers, call metadata, phone number inventory, optional call recordings if enabled | **Yes** | NOT SIGNED | **Yes** | HIPAA-eligible services / BAA or conduit-exception review | Active voice carrier. Telnyx publishes HIPAA guidance for BAA-covered and conduit-exception workflows; confirm Donna's Voice API + media streaming configuration with Telnyx sales/legal and keep call recording disabled unless explicitly approved. |
| **Twilio** | No active PHI flow. Historical voice implementation is archived and SMS notifications are inactive. | No while inactive | N/A | Yes if reintroduced | HIPAA-eligible | Keep Twilio out of active PHI paths unless SMS or Twilio voice is intentionally reintroduced with a BAA/compliance review. |

### LLM / AI Services

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **Anthropic (Claude)** | Full live conversation context, completed-call transcripts for post-call analysis, user-entered reminders, health discussions if disclosed by users, senior names, profile context, memory context, caregiver-facing summaries/takeaways | **Yes** | NOT SIGNED | **Yes** | Enterprise | Claude Haiku 4.5 is the primary conversational LLM and the subscriber post-call analysis model. All conversation content, prompt profile context, and post-call analysis transcript payloads pass through Anthropic. Contact sales@anthropic.com for enterprise BAA. |
| **Google (Gemini)** | Conversation transcripts for Director fallback; onboarding summary/evaluation payloads where enabled | **Yes** | NOT SIGNED | **Yes** | Google Cloud with BAA enabled | Gemini Flash is used for Director fallback and lightweight onboarding/evaluation paths, not the active subscriber post-call analysis path. Enable BAA in Google Cloud Console under "Healthcare" settings. |
| **Groq** | Conversation transcriptions (recent turns), Director analysis context | **Yes** | NOT SIGNED | **Unclear** | Enterprise (likely) | Current primary Director LLM for Query Director + Guidance Director. Contact Groq sales to inquire about BAA availability. |
| **Cerebras** | Conversation transcriptions if old env/code paths are restored | **Yes** | NOT SIGNED | **Unlikely** | Unknown | Legacy/not active in current `pipecat/services/director_llm.py` runtime path. Remove stale env/config/docs if no deployed branch still uses it. |

### Speech Services

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **Deepgram** | Raw caller audio stream (Telnyx wire is 16kHz L16; Pipecat keeps internal STT input at 16kHz PCM), produces transcriptions containing health discussions, medication info, personal details | **Yes** | NOT SIGNED | **Yes** | Enterprise | Deepgram offers HIPAA-compliant deployments on enterprise plans. Contact sales for BAA. All spoken words -- including medication names, health complaints, personal details -- pass through Deepgram. |
| **ElevenLabs** | Text-to-speech input: all of Donna's spoken responses, which may reference user-entered reminders or health details disclosed during a call | **Yes** | NOT SIGNED | **Unclear** | Enterprise (if available) | ElevenLabs is used for TTS (`eleven_flash_v2_5` by default). The text input includes Donna's side of conversation, which may contain health references if a user introduces them. Contact ElevenLabs support to inquire about HIPAA compliance and BAA. |
| **Cartesia** | Same as ElevenLabs -- TTS input text containing Donna's spoken responses | **Yes** | NOT SIGNED | **Unlikely** | Unknown | Alternative TTS provider (selected via GrowthBook feature flag `tts_provider`). Cartesia is a smaller company; HIPAA BAA is unlikely. **HIGH RISK -- evaluate alternatives.** |

### Search & Embeddings

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **OpenAI** | Memory text for embedding generation (health conditions, medications, personal details), web search queries (may include health topics) | **Yes** | NOT SIGNED | **Yes** | Enterprise | Used for: (1) text-embedding-3-small for semantic memory (all memory content gets embedded), (2) Web search for news/information. Memory content includes health facts, medication details, etc. Contact OpenAI enterprise for BAA. |
| **Tavily** | Search queries generated by the active `web_search` tool, which may include health-related questions ("best exercises for arthritis", "side effects of metformin") | **Yes** | NOT SIGNED | **Unlikely** | Unknown | Fast in-call web search provider. Health-related queries expose PHI (combined with context of who is asking). **HIGH RISK -- evaluate alternatives.** |

### Email & Notifications

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **Resend** | Caregiver email notifications and weekly report email content generated by `services/notifications.js` and `services/weekly-report.js`. These messages may include senior-linked summaries, schedules, reminders, concerns, or other PHI-bearing context unless minimized. | **Yes if PHI is present in email body/metadata** | NOT SIGNED | **Unclear** | Unknown | Newly tracked from the May 5 audit. Either execute a BAA/compliant vendor path or minimize email bodies so Resend receives only non-PHI notification text and links to authenticated in-app views. |

### Infrastructure & Data

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **Neon (PostgreSQL)** | ALL persistent data: senior profiles, conversations, transcripts, memories, reminders, call analyses, caregiver relationships, and deprecated medical-note columns until nulled by migration 014/026 | **Yes** | NOT SIGNED | **Yes** | Pro or Enterprise | Neon is the primary database. Contains PHI/sensitive data when users provide health details. Neon offers BAAs -- enable in the dashboard or contact sales. This is one of the most critical BAAs to sign. |
| **Railway** | Application logs (sanitized but may contain PHI in error traces), environment variables (API keys, database URLs), container runtime | **Yes** | NOT SIGNED | **Unclear** | Unknown | Railway hosts both Pipecat and Node.js services. Logs may contain PHI despite sanitization (error traces, unexpected data paths). Environment variables contain database credentials. Contact Railway support to inquire about BAA. |
| **Sentry** | Error traces that may contain senior IDs, phone numbers (despite `send_default_pii=False`), stack traces with variable contents, request metadata | **Yes** | NOT SIGNED | **Yes** | Business plan | Sentry captures errors server-side. Despite `send_default_pii=False`, error context may include PHI (e.g., a failed database query that includes a senior's name in the error message). Upgrade to Business plan for BAA. |

### Authentication & Feature Management

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Plan Required | Notes |
|---------|---------------|---------------|------------|----------------|---------------|-------|
| **GrowthBook** | Senior IDs (used as feature flag targeting attributes), feature flag evaluations | **Low risk** | NOT SIGNED | **Unlikely** | Unknown | GrowthBook receives senior IDs for feature flag targeting. Senior IDs alone are not PHI, but combined with other data could be. **Minimize data sent**: use anonymous hashes instead of raw senior IDs. |
| **Clerk** | Caregiver email addresses, names, authentication tokens | **Low risk** | NOT SIGNED | **Yes** | Enterprise | Clerk handles caregiver authentication only. Caregiver data is not PHI per se (caregivers are not the patients), but if caregiver accounts link to specific seniors, this creates an indirect PHI exposure. Enterprise plan offers BAA. |

### Frontend Hosting

| Service | Data Processed | BAA Required? | BAA Status | BAA Available? | Notes |
|---------|---------------|---------------|------------|----------------|-------|
| **Vercel** | Static frontend assets only. No PHI passes through Vercel -- all API calls go directly to Railway-hosted backends. | **No** | N/A | N/A | Frontend apps (admin-v2, website/caregiver web, observability) are static React apps hosted on Vercel. API calls bypass Vercel entirely. No BAA needed unless Vercel-hosted server-side processing is introduced. |

---

## Action Items by Priority

### CRITICAL: Sign BAAs Immediately (BAA Available)

These vendors offer BAAs and process significant PHI. Signing should begin immediately.

| # | Vendor | Action | Contact | Estimated Time |
|---|--------|--------|---------|----------------|
| 1 | **Neon** | Enable BAA in dashboard or contact sales | dashboard.neon.tech or sales@neon.tech | 1-2 weeks |
| 2 | **Telnyx** | Confirm HIPAA-eligible Voice API/media streaming setup and execute BAA or documented conduit-exception/legal review | Telnyx Mission Control or sales@telnyx.com | 1-2 weeks |
| 3 | **Anthropic** | Contact enterprise sales for BAA | sales@anthropic.com | 2-4 weeks |
| 4 | **Deepgram** | Contact enterprise sales for BAA | sales@deepgram.com | 2-4 weeks |
| 5 | **Google (Gemini)** | Enable BAA in GCP Console | Google Cloud Console > Healthcare | 1-2 weeks |
| 6 | **OpenAI** | Contact enterprise sales for BAA | Enterprise portal or sales@openai.com | 2-4 weeks |
| 7 | **Sentry** | Upgrade to Business plan, sign BAA | sentry.io pricing or sales | 1-2 weeks |
| 8 | **Resend** | Confirm BAA availability or remove PHI from email bodies/metadata | Resend support/sales | Unknown |

### HIGH: Evaluate Alternatives (BAA Unlikely)

These vendors are unlikely to offer BAAs. Evaluate HIPAA-compliant alternatives.

| # | Vendor | Current Use | Alternative | Migration Effort | Notes |
|---|--------|-------------|-------------|------------------|-------|
| 9 | **Groq** | Director LLM (Query + Guidance) | **Google Gemini** through a BAA-covered GCP path, or Groq with signed BAA | Medium | Groq is current primary. Keep using it only if vendor terms/BAA support the PHI workload. |
| 9a | **Cerebras** | Legacy Director LLM reference | Remove stale env/config/docs | Low | Current Director code no longer calls Cerebras. Confirm no deployed branch or Railway env still routes PHI to Cerebras. |
| 10 | **Cartesia** | TTS (feature-flagged) | **ElevenLabs** (may offer enterprise BAA) or **Google Cloud TTS** (has BAA via GCP) | Low | Cartesia is already behind a feature flag. Disable the flag and use ElevenLabs exclusively until BAA is confirmed. Google Cloud TTS is the safest option (GCP BAA covers it). |
| 11 | **Tavily** | In-call `web_search` tool fast path | **OpenAI web search** (already integrated, enterprise BAA available) | Low | OpenAI web search is already used for news retrieval and fallback. Remove Tavily dependency if no BAA/compliant terms are available. |

### MEDIUM: Clarify BAA Status

| # | Vendor | Action | Contact |
|---|--------|--------|---------|
| 12 | **ElevenLabs** | Inquire about HIPAA compliance and BAA on enterprise plan | support@elevenlabs.io or sales |
| 13 | **Groq** | Inquire about BAA availability | sales@groq.com |
| 14 | **Railway** | Inquire about BAA availability; if unavailable, evaluate alternatives (AWS ECS/Fargate, GCP Cloud Run -- both offer BAAs) | Railway support or Discord |
| 15 | **Resend** | Inquire about HIPAA compliance and BAA availability; if unavailable, remove PHI from email payloads or move to a BAA-backed email provider | Resend support/sales |

### LOW: Minimize Data Exposure

| # | Vendor | Action |
|---|--------|--------|
| 14 | **GrowthBook** | Replace raw senior IDs with anonymous hashed identifiers in feature flag targeting attributes |
| 15 | **Clerk** | Evaluate whether enterprise BAA is needed based on data linking caregivers to specific seniors |

---

## Timeline

### Week 1-2: Initiate Contact

- [ ] Contact Neon to enable BAA (self-service or sales)
- [ ] Confirm Telnyx HIPAA-eligible Voice API/media streaming setup and BAA/conduit-exception posture
- [ ] Contact Anthropic enterprise sales
- [ ] Contact Deepgram enterprise sales
- [ ] Enable BAA in Google Cloud Console
- [ ] Contact OpenAI enterprise sales
- [ ] Upgrade Sentry to Business plan
- [ ] Contact Resend or replace/minimize PHI-bearing email delivery
- [ ] Send inquiry emails to ElevenLabs, Groq, Railway, Resend about BAA availability

### Week 3-4: Evaluate and Negotiate

- [ ] Review and sign Neon BAA
- [ ] Review and sign Telnyx BAA or file legal approval for a conduit-exception posture
- [ ] Review and sign Google Cloud BAA
- [ ] Review and sign Sentry BAA
- [ ] Evaluate responses from ElevenLabs, Groq, Railway
- [ ] Evaluate Resend response and decide whether caregiver email content must be minimized or migrated
- [ ] Begin technical planning for Groq/Cartesia/Tavily compliance decisions and removal of legacy Cerebras references

### Week 5-8: Replace Non-Compliant Vendors

- [ ] Replace Tavily with OpenAI web search for in-call `web_search` queries if Tavily cannot support a BAA
- [ ] Disable Cartesia feature flag; default to ElevenLabs (or migrate to Google Cloud TTS)
- [ ] Confirm Director LLM compliance path for Groq, or migrate Director LLM to Gemini Flash through a BAA-covered GCP path
- [ ] Remove PHI from Resend email bodies/metadata or migrate email delivery to a signed-BAA vendor
- [ ] Remove Tavily API key and code references
- [ ] Sign remaining BAAs (Anthropic, Deepgram, OpenAI -- enterprise sales cycles may take longer)

### Week 9-12: Complete and Document

- [ ] Verify all BAAs are signed and filed
- [ ] Update this tracker with signed dates and contract references
- [ ] Hash senior IDs sent to GrowthBook
- [ ] Evaluate Clerk enterprise BAA need
- [ ] Conduct vendor security review (see [Vendor Security Evaluation](VENDOR_SECURITY_EVALUATION.md))

### Ongoing: Quarterly Review

- [ ] Review all vendor BAA status quarterly
- [ ] Re-evaluate new vendors before integration (BAA required before any vendor receives PHI)
- [ ] Update this tracker when vendors are added, removed, or BAA status changes

---

## BAA Filing

Once BAAs are signed, record them here:

| Vendor | BAA Signed Date | Contract Reference | Renewal Date | Signed By |
|--------|-----------------|--------------------|--------------|-----------|
| *(none signed yet)* | | | | |

Store physical/digital copies of all signed BAAs in a secure, access-controlled location. BAAs must be retained for 6 years from the date of termination (per HIPAA record retention requirements).

---

*This tracker must be updated every time a vendor is added, removed, or BAA status changes. No new vendor should receive PHI without a signed BAA.*
