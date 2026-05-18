# Senior Consent & Verification Flow

**Created by**: Nick & David | **Assigned to**: Facundo | **Date**: May 17, 2026
**Priority**: High | **Scope**: Mobile app first, web later

---

## Context

Right now, when a caregiver completes onboarding, `seniors.isActive` gets set to `true` and the scheduler starts calling immediately. There's no step where the senior learns what Donna is, consents to receiving calls, or consents to call recording. We need to fix this before launch.

**Reference**: Sign up for Miele's trial membership (we'll cover the cost). Study their caregiver onboarding flow — specifically how they coach caregivers on talking to their loved one about the service, and how they handle the senior's first interaction. We're modeling our flow after theirs.

---

## What Needs to Happen (3 Parts)

### PART 1: Post-Signup "Let Your Loved One Know" Screen (Mobile App)

**Where it goes**: After the current Success screen in the mobile onboarding flow (`apps/mobile/src/stores/onboarding.ts` manages state, success screen is the final step).

**New screen flow after success**:

1. **"Let [Senior Name] Know" screen**
   - Explain to the caregiver that before Donna can start calling, the senior needs to know what's happening and give permission
   - Give the caregiver **conversation tips/suggestions** on how to approach the conversation (Miele-style coaching). Examples:
     - "You might say: 'Hey [name], I signed you up for a service called Donna. She's a friendly AI assistant that'll call you every day to chat and help you remember things like your medications.'"
     - "Let them know it's just a phone call — they don't need to download anything"
     - "Reassure them they can stop the calls anytime"
   - **Primary CTA**: "Call [Senior Name] Now" — taps to initiate a native phone call to the senior's number (just a regular phone call from the caregiver, not a Donna call). Use `Linking.openURL('tel:+1XXXXXXXXXX')` with the senior's phone number
   - **Secondary option**: "I've already let them know" or "I'll do this later" — skip button
   - Either path moves forward to the dashboard

2. This screen should feel supportive, not like a blocker. The tone is "here's how to have this conversation" not "you must do this now."

---

### PART 2: Dashboard Consent State (Mobile App)

**Current state**: After onboarding, the caregiver sees the dashboard and calls start going out immediately.

**New behavior**:

- On senior creation (`POST /api/onboarding` in `routes/onboarding.js`), the senior should be created with a new field indicating consent has NOT been obtained yet. Suggested approach: add a `consentStatus` field to the `seniors` table.
  - Values: `pending` (default on creation), `granted`, `declined`
  - Also add `consentDate` (timestamp, nullable) for when consent was recorded
  - `isActive` should still default to `true`, but the **scheduler must check `consentStatus = 'granted'`** in addition to `isActive = true` before making any calls

- **Dashboard UI when consent is pending**:
  - Show a banner/card at the top: "No calls have gone out yet — [Senior Name] still needs to give permission"
  - CTA button: "Schedule Donna's Introduction Call" — this triggers the consent call (Part 3)
  - The caregiver picks a time for Donna to call the senior
  - Until consent is granted, the rest of the dashboard can show the senior's profile, reminders, etc., but should make it clear that calls are on hold

- **Dashboard UI when consent is declined**:
  - Show state indicating the senior declined
  - Option to reschedule another consent call

- **Dashboard UI when consent is granted**:
  - Normal dashboard behavior, calls flow as they do today

---

### PART 3: New Call Type — "consent" Verification Call (Pipecat)

**This is a third call type** alongside the existing regular calls and onboarding calls. Add `call_type = "consent"` to the system.

**What this call does**:

1. Donna calls the senior at the scheduled time
2. Donna introduces herself: explains she's an AI assistant, that their family member signed them up, what she does (daily calls, reminders, friendly conversation)
3. Donna asks for **two explicit consents**:
   - Permission to call them regularly
   - Permission to record the calls
4. Based on the senior's response, write the result to the database

**Pipeline configuration** — this is a stripped-down call:

- **NO** web search tool
- **NO** memory saving/extraction
- **NO** Conversation Director (Groq guidance/query system)
- **NO** predictive prefetch
- **NO** post-call memory extraction or interest discovery
- **YES** Deepgram STT
- **YES** Claude Haiku (for natural conversation)
- **YES** ElevenLabs TTS
- **YES** One async tool call for consent detection

**The consent tool**:

- Single tool available to Claude: something like `record_consent_response`
- Parameters: `{ consented: boolean }` (or `granted` / `declined`)
- When called, writes to the `seniors` table: sets `consentStatus` to `granted` or `declined`, sets `consentDate` to now
- If `granted` → the scheduler can now start calling this senior normally
- If `declined` → `consentStatus = 'declined'`, no calls go out. Caregiver sees the declined state on their dashboard

**Alternatively** (your call on implementation): instead of a Claude tool, use a lightweight Groq-based async detector (similar to the Quick Observer pattern) that listens for affirmative/negative responses to the consent question and fires off the DB write. Either approach works — the key requirement is that consent status gets written to the DB based on what the senior says.

**Prompt** (V1 — Nick will refine later):

- Introduce as Donna, an AI assistant
- Mention that [caregiver name/relation] signed them up
- Briefly explain: "I'll call you regularly to chat, help you remember things like medications, and keep your family updated"
- Ask: "Is it okay if I call you like this going forward?"
- Ask: "And is it okay if I record our calls so your family can stay in the loop?"
- If yes to both → mark consent granted, say something warm like "I'm looking forward to our chats"
- If no → mark declined, be gracious about it, say goodbye

**Flow/Nodes**: Create a simple 2-phase flow (no need for the full 4-phase system):

1. **Consent phase**: Introduction + ask for permission
2. **Closing phase**: Confirm result + goodbye

Don't overthink the script — Nick will clean it up later. Focus on the mechanics.

---

## Backend Changes Summary

| Change | File(s) | Details |
|---|---|---|
| Add `consentStatus` + `consentDate` to seniors table | `db/schema.js`, new migration | `consentStatus` enum: `pending`/`granted`/`declined`, default `pending`. `consentDate` timestamp nullable |
| Set `consentStatus = 'pending'` on creation | `routes/onboarding.js` | Default on insert |
| Scheduler: gate on consent | `services/scheduler.js` | Add `AND s.consent_status = 'granted'` to the query at ~line 788 and anywhere else seniors are queried for calling |
| New call type routing | `pipecat/flows/nodes.py` | Add `consent` case in `build_initial_node()` at ~line 889 |
| Consent call prompt | `pipecat/prompts.py` | New `CONSENT_SYSTEM_PROMPT` and `CONSENT_TASK` |
| Consent call flow nodes | `pipecat/flows/nodes.py` | `build_consent_node()` + `build_consent_closing_node()` |
| Consent tool | `pipecat/flows/tools.py` | `record_consent_response` tool definition + handler |
| Stripped pipeline | `pipecat/bot.py` | When `call_type == 'consent'`, skip Director, prefetch, memory, web search processors |
| Accept `consent` call type | `pipecat/api/routes/telnyx.py` | Allow `consent` in `TelnyxOutboundCallRequest.call_type` |
| Trigger consent call from Node | `routes/calls.js` or new route | Endpoint for caregiver to schedule/trigger a consent call, passes `callType: 'consent'` to Pipecat |
| Dashboard API | `routes/seniors.js` | Return `consentStatus` in senior responses so frontend can render the right state |

---

## Flow Diagram

```
Caregiver completes onboarding
        |
        v
   Success Screen
        |
        v
"Let [Name] Know" Screen
  |-- Call senior now (native phone call from caregiver)
  '-- Skip / I'll do it later
        |
        v
   Dashboard (consent = pending)
   "No calls yet -- permission needed"
        |
        v
  Caregiver schedules consent call
        |
        v
  Donna calls senior (call_type = "consent")
  |-- Introduces herself as AI assistant
  |-- Explains what she does
  |-- Asks: can I call you?
  '-- Asks: can I record calls?
        |
   +---------+
   v         v
GRANTED   DECLINED
   |         |
   v         v
Regular    Dashboard shows
calls      "declined" state
begin      (can retry)
```

---

## What's NOT in Scope (for now)

- Web app version of the "Let Your Loved One Know" screen (do later)
- Privacy policy language (Nick is meeting with legal)
- Polished consent call script (Nick will refine)
- Re-consent flows or consent expiration
- SMS/text-based consent alternative
