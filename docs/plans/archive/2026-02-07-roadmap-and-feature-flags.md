# Donna v5.0 — Product Roadmap, Feature Flags & Tool Stack

> Historical roadmap. Current active runtime is Telnyx voice, Claude Haiku 4.5, Groq Director with Gemini fallback, ElevenLabs Flash, and email/in-app notifications only. Twilio SMS and 8kHz audio items below are not active implementation guidance.

> **Created:** February 7, 2026
> **Status:** Planning — not yet implemented
> **Depends on:** Pipecat migration (v4.0) complete

---

## Overview

This document defines the next wave of Donna features, organized into prioritized tiers, the external tool stack to leverage (instead of building from scratch), and the feature flag system (GrowthBook) that enables per-user rollout and A/B testing.

---

## Part 1: External Tool Stack

### Decision: Buy > Build for Infrastructure

At ~80 feature flags and growing, we need proper tooling. The following tools were selected after evaluating open-source and SaaS options for each category. The goal is maximum value with minimal operational overhead.

### Selected Tools

| Category | Tool | Type | Cost | Why This One |
|----------|------|------|------|-------------|
| **Feature Flags + A/B Testing** | **GrowthBook** (self-hosted) | Open source | $0 | Only OSS tool with real stats engine (Bayesian, CUPED). Warehouse-native — queries our Neon Postgres for experiment results. Admin UI included. |
| **Error Monitoring** | **Sentry** (cloud) | SaaS | $0 (free tier) | 5,000 errors/mo. 3 lines of code. Python + Node.js SDKs. Catches production errors we're currently blind to. |
| **Transactional Email** | **Resend** + **React Email** | SaaS + OSS | $0 (free tier) | 3,000 emails/mo free. Templates as React components in our codebase. Needed for alerts + weekly reports. |
| **Notifications (SMS)** | **Twilio** (existing) | SaaS | Pay-per-use | Already have it. Use for caregiver SMS alerts. |
| **Analytics/BI** | **Metabase** (self-hosted) | Open source | ~$5-10/mo | Single Docker container on Railway. SQL dashboards on Neon Postgres. Replaces building custom admin analytics. |
| **Billing** | **Stripe** | SaaS | 2.9% + $0.30/txn | Customer portal, usage metering, dunning — all built in. Best docs. |
| **Job Queue** | **BullMQ** (when needed) | Open source | ~$5/mo (Redis) | Replace polling scheduler when we need retries + scheduled emails. Not urgent. |

**Total added cost: ~$10-15/mo** (Metabase hosting + Redis when we add BullMQ)

### Tools We Evaluated and Rejected

| Tool | Category | Why Not |
|------|----------|---------|
| **Custom flag system** | Feature flags | 80+ flags needs search, filtering, audit logs, bulk ops. Not worth building from scratch. |
| **Unleash** | Feature flags | No built-in A/B stats engine. OSS limited to 2 environments. |
| **PostHog** | Feature flags | Self-hosting needs 6+ services + 16GB RAM. Overkill. Cloud free tier is good but vendor lock-in. |
| **Flagsmith** | Feature flags | No built-in A/B stats. Good PostgreSQL support but GrowthBook's experiment engine is a dealbreaker advantage. |
| **Flipt** | Feature flags | No A/B stats. Git-native model adds complexity without benefit. |
| **FeatBit** | Feature flags | Immature (1.7k stars), C#/.NET stack mismatch, requires MongoDB. |
| **Novu** | Notifications | 7+ containers self-hosted. Overkill for SMS + email with <100 users. |
| **Knock** | Notifications | $0 → $250/mo jump. Not worth it at our scale. |
| **Apache Superset** | Analytics | Multi-container, heavy. Metabase is simpler and sufficient. |
| **Amazon SES** | Email | Resend is simpler, free tier is sufficient, better DX. |
| **Highlight.io** | Errors | Smaller free tier than Sentry (500 vs 5,000). $150/mo paid jump. |
| **Trigger.dev** | Job queue | BullMQ is simpler and more mature for our use case. |

### Integration Priority (what to set up first)

1. **Sentry** — 5 minutes to integrate, immediate value (catches errors during voice calls)
2. **GrowthBook** — gates all new feature rollouts + A/B testing
3. **Resend + React Email** — needed before caregiver alerts and weekly reports
4. **Stripe** — needed before we can charge customers
5. **Metabase** — nice-to-have for internal analytics
6. **BullMQ** — add when notification volume or retry needs justify it

---

## Part 2: Feature Flag System — GrowthBook

### Why GrowthBook

With ~80 flags, we need:
- Searchable/filterable flag management UI
- Audit logs (who changed what, when)
- Bulk operations (enable feature X for all seniors in timezone Y)
- Built-in A/B test statistical analysis
- Per-user targeting with deterministic hashing

GrowthBook is the only open-source tool that provides all of this plus a real experiment stats engine (Bayesian credible intervals, CUPED, SRM detection).

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GrowthBook Server                     │
│              (self-hosted on Railway)                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  Admin UI     │  │  API Server  │  │  Stats Engine │  │
│  │  (React)      │  │  (Node.js)   │  │  (Bayesian)   │  │
│  └──────────────┘  └──────┬───────┘  └───────┬───────┘  │
│                           │                   │          │
│                    ┌──────┴───────┐   ┌───────┴───────┐  │
│                    │   FerretDB   │   │  Neon Postgres │  │
│                    │  (MongoDB →  │   │  (experiment   │  │
│                    │   Postgres)  │   │   data source) │  │
│                    └──────────────┘   └───────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                                    ▲
         │ SDK polls for flag configs         │ Queries experiment
         │ (every 60s, cached)                │ results from our
         ▼                                    │ call_analyses table
┌─────────────────┐                  ┌────────┴────────┐
│  Pipecat (Python)│                  │  Node.js (API)  │
│  GrowthBook SDK  │                  │  GrowthBook SDK │
│                  │                  │                  │
│  Resolve flags   │                  │  Resolve flags   │
│  once per call   │                  │  for scheduler   │
│  → session_state │                  │  + admin API     │
└─────────────────┘                  └─────────────────┘
```

### Setup

**Self-hosted on Railway:**
- GrowthBook Docker image (single container)
- FerretDB sidecar (translates MongoDB wire protocol → Neon PostgreSQL)
- No new databases — everything goes to existing Neon Postgres
- GrowthBook connects to Neon as its "data warehouse" for experiment analysis

**Environment variables to add:**
```bash
# GrowthBook
GROWTHBOOK_API_HOST=https://growthbook-production.up.railway.app
GROWTHBOOK_CLIENT_KEY=sdk-...       # Read-only SDK key
GROWTHBOOK_SECRET_KEY=secret-...    # Admin API key (optional, for programmatic flag management)
```

### SDK Integration

#### Voice Pipeline (bot.py)

```python
from growthbook import GrowthBook

# On call start — resolve all flags once, cache in session_state
gb = GrowthBook(
    api_host=os.getenv("GROWTHBOOK_API_HOST"),
    client_key=os.getenv("GROWTHBOOK_CLIENT_KEY"),
    attributes={
        "id": senior_id,
        "timezone": senior.get("timezone"),
        "is_active": senior.get("isActive"),
        "call_type": session_state.get("call_type"),
    },
)
await gb.load_features()

session_state["_flags"] = {
    "emergency_alerts": gb.is_on("emergency_alerts"),
    "tts_speed": gb.get_feature_value("tts_speed", 0.9),
    "prompt_style": gb.get_feature_value("prompt_style", "warm"),
    "voice_customization": gb.is_on("voice_customization"),
    # ... all relevant flags
}

# Use throughout the call without additional lookups
speed = session_state["_flags"].get("tts_speed", 0.9)
```

#### Node.js (scheduler, admin API)

```javascript
const { GrowthBook } = require("@growthbook/growthbook");

const gb = new GrowthBook({
  apiHost: process.env.GROWTHBOOK_API_HOST,
  clientKey: process.env.GROWTHBOOK_CLIENT_KEY,
  attributes: { id: seniorId, timezone: senior.timezone },
});
await gb.loadFeatures();

const retryPolicy = gb.getFeatureValue("call_retry", { max_retries: 2, interval: 15 });
const notificationsEnabled = gb.isOn("caregiver_notifications");
```

### A/B Test Tracking

GrowthBook's warehouse-native approach means we don't need separate tracking tables. It queries our existing database:

1. **Experiment assignments** — GrowthBook SDK logs assignments automatically (or we log to our own `experiment_assignments` table)
2. **Metrics** — GrowthBook connects to Neon Postgres and runs SQL to compute results:
   - Engagement score: `SELECT senior_id, AVG(engagement_score) FROM call_analyses WHERE ...`
   - Call duration: `SELECT senior_id, AVG(duration_seconds) FROM conversations WHERE ...`
   - Satisfaction: `SELECT senior_id, AVG(rating) FROM call_ratings WHERE ...`

We define metrics in GrowthBook's UI as SQL queries against our existing tables. No new event tracking infrastructure needed.

### Targeting Examples

GrowthBook supports rich targeting rules via its UI:

| Scenario | Targeting Rule |
|----------|---------------|
| Enable for specific senior | `id = "2b455a9c-..."` |
| Rollout to 25% of seniors | Percentage rollout: 25% |
| Enable for all EST timezone | `timezone = "America/New_York"` |
| A/B test prompt style | 50/50 split: "warm" vs "concise" |
| Enable for reminder calls only | `call_type = "reminder"` |

### Flag Categories (planned ~80 flags)

| Category | Example Flags | Count (est.) |
|----------|--------------|-------------|
| **Voice pipeline** | tts_speed, tts_voice_id, vad_confidence, vad_stop_secs, llm_model, llm_max_tokens | ~10 |
| **Prompt variations** | prompt_style, greeting_style, closing_style, personality_tone, avoid_topics | ~10 |
| **Call flow** | opening_duration, force_winding_minutes, force_end_minutes, allow_interruptions | ~8 |
| **Memory & context** | memory_tier_strategy, context_cache_ttl, memory_decay_halflife, greeting_rotation | ~8 |
| **Observer** | observer_goodbye_delay, director_enabled, director_model, director_timeout | ~6 |
| **Safety** | emergency_alerts, emergency_sms, emergency_email, alert_severity_threshold | ~5 |
| **Notifications** | caregiver_notifications, weekly_reports, call_summary_sms, missed_call_alert | ~6 |
| **Scheduling** | call_retry, dnd_windows, proactive_calls, max_calls_per_day, preferred_time_flex | ~7 |
| **Features** | topic_seeding, satisfaction_survey, analytics_dashboard, voice_customization | ~8 |
| **Billing** | billing_enabled, plan_tier, max_seniors, max_calls_monthly | ~5 |
| **Experiments** | prompt_style_ab, greeting_ab, tts_model_ab, director_model_ab | ~7 |

---

## Part 3: Feature Roadmap

### Tier 1 — Safety Critical (build first)

These features protect seniors and are table-stakes for a care product.

#### 1.1 Emergency Detection & Caregiver Alerting

**Problem:** Quick Observer already detects health/safety patterns (falls, chest pain, confusion) but only injects guidance into the LLM — no one outside the call is notified.

**What to build:**
- Alert dispatch service: SMS (Twilio) + email (Resend) to caregiver
- `alerts` table: senior_id, alert_type, severity, description, evidence (quote from transcript), status (pending/acknowledged/resolved), notified_at, acknowledged_at
- `notification_preferences` on caregivers table: channels (sms, email, push), urgency threshold (all, high-only, critical-only)
- Quick Observer integration: when a `high` severity health/safety pattern fires AND the flag is enabled, dispatch alert immediately (don't wait for post-call)
- Post-call analysis also generates alerts for concerns detected in batch

**Execution:**
1. Add `alerts` table + `notification_preferences` column on caregivers
2. Build `pipecat/services/alerts.py` — `send_alert(senior_id, type, severity, evidence)` using Twilio (SMS) + Resend (email)
3. Wire into `quick_observer.py` — after pattern match, if severity=high, fire alert
4. Wire into `post_call.py` — after analysis, if concerns have severity=high, fire alert
5. Admin UI: alerts list page with acknowledge/resolve actions
6. Consumer app: notification preferences settings

**Flag:** `emergency_alerts` (boolean, default false, roll out per-senior)

#### 1.2 Missed Call Handling & Retry Policy

**Problem:** When a scheduled call goes to no-answer, nothing visible happens. Caregivers don't know. No retry.

**What to build:**
- Configurable retry policy per senior: max_retries (default 2), retry_interval_minutes (default 15)
- `call_attempts` tracking: extend reminder_deliveries or add retry metadata
- After N missed calls in a row, notify caregiver ("Donna couldn't reach [Name] today")
- Scheduler awareness: retry logic in `scheduler.py` / `services/scheduler.js`

**Execution:**
1. Configure `call_retry` flag in GrowthBook (value type with JSON default)
2. Update scheduler to track attempt count per reminder delivery
3. On no-answer: schedule retry after interval
4. After max_retries exhausted: dispatch notification to caregiver via Twilio/Resend
5. Admin UI: show retry status on calls page

**Flag:** `call_retry` (value type — `{"max_retries": 2, "interval_minutes": 15}`)

#### 1.3 Do Not Disturb Windows

**Problem:** No way to prevent calls during nap time, meals, or other regular activities.

**What to build:**
- `dnd_windows` field on senior profile: array of `{start: "13:00", end: "15:00", days: ["Mon","Tue","Wed","Thu","Fri"]}`
- Scheduler checks DND before initiating calls
- If reminder falls in DND window, reschedule to after window ends
- Consumer app: DND configuration in schedule settings

**Execution:**
1. Add `dnd_windows` JSONB column on seniors
2. Update scheduler prefetch to check DND
3. Consumer app: DND editor (time range picker + day selector)
4. Admin UI: show DND in senior detail

**Flag:** `dnd_windows` (boolean, default true — enable for all once built)

---

### Tier 2 — Caregiver Value (retention drivers)

These features make caregivers stay because they get real value.

#### 2.1 Caregiver Notifications

**Problem:** Caregivers only see information when they actively check the dashboard. No proactive updates.

**What to build:**
- Notification dispatch service: Twilio (SMS) + Resend (email)
- Event triggers: call_completed, concern_detected, reminder_missed, weekly_summary
- Per-caregiver preferences: which events, which channels, quiet hours
- `notifications` table: caregiver_id, event_type, channel, content, sent_at, read_at

**Execution:**
1. Build `services/notifications.js` (Node.js — thin routing layer over Twilio + Resend)
2. Add `notifications` table
3. Extend `notification_preferences` on caregivers
4. Post-call hook: dispatch call_completed notification with summary
5. Consumer app: notification preferences page

**Flag:** `caregiver_notifications` (boolean)

#### 2.2 Weekly Summary Reports

**Problem:** Caregivers want a digest, not real-time firehose.

**What to build:**
- Weekly cron job (Monday 9 AM caregiver timezone)
- Aggregates past 7 days: calls made, avg engagement, topics, concerns, reminder adherence
- React Email template with key stats and highlights
- "Nothing concerning" vs "Attention needed" framing
- Sent via Resend

**Execution:**
1. Build report generation service (aggregate call_analyses for past 7 days)
2. React Email template (JSX, version-controlled in our repo)
3. Cron job in Node.js scheduler (or BullMQ repeatable job when added)
4. Send via Resend API
5. Unsubscribe link

**Flag:** `weekly_reports` (boolean)

#### 2.3 Engagement & Wellness Dashboard

**Problem:** call_analyses data exists but isn't visualized. Caregivers can't see trends.

**What to build (two approaches):**

**Internal (admin):** Self-hosted Metabase on Railway, connected to Neon Postgres. Build SQL dashboards for engagement trends, concern frequency, call volume. Zero custom code.

**Consumer-facing:** API endpoints + React charts (Recharts or Tremor) in consumer app.
- `/api/seniors/:id/analytics` — engagement trend, concern history, reminder adherence
- Engagement score over last 30 days (line chart)
- Concern frequency by category (bar chart)
- Reminder delivery success rate (percentage)
- Call duration trend (line chart)

**Execution:**
1. Deploy Metabase on Railway (~$5-10/mo) for internal dashboards
2. Build analytics aggregation API endpoints (SQL window functions over call_analyses)
3. Consumer app: analytics page with Recharts

**Flag:** `analytics_dashboard` (boolean)

#### 2.4 Conversation Topic Seeding

**Problem:** Caregivers know what's happening in their parent's life but can't tell Donna.

**What to build:**
- `conversation_seeds` table: senior_id, content ("Ask about her trip to Florida"), priority, expires_at, used_at
- Consumed by `_build_senior_context()` in flow nodes — injected into system prompt as "Topics a family member suggested you bring up"
- Consumer app: "Suggest a topic" input on dashboard
- Seeds expire after being used in a call (or after N days)

**Execution:**
1. Add `conversation_seeds` table
2. Consumer app: topic suggestion input
3. API endpoint: POST /api/seniors/:id/topic-seeds
4. `_build_senior_context()` includes active seeds
5. Post-call: mark used seeds

**Flag:** `topic_seeding` (boolean)

---

### Tier 3 — Conversation Quality

These features make calls better and enable data-driven optimization.

#### 3.1 Per-Senior Voice & Personality Customization

**Problem:** One voice/style doesn't fit all seniors. Some want formal, some casual. Some prefer a male voice.

**What to build:**
- GrowthBook flags per senior for: tts_voice_id, tts_speed, personality_tone, avoid_topics
- bot.py reads flag values from GrowthBook SDK when constructing TTS and prompt
- Admin can override per-senior via GrowthBook UI

**Execution:**
1. Create flags in GrowthBook: `tts_speed` (value), `tts_voice_id` (value), `personality_tone` (value), `avoid_topics` (value)
2. bot.py: resolve flags on call start, use values for TTS + prompt
3. prompts.py: personality modifier in system prompt based on flag value
4. prompts.py: avoid_topics exclusion block
5. Consumer app: preferences editor (writes to GrowthBook via API or to senior profile)

**Flag:** Multiple value-type flags in GrowthBook

#### 3.2 Call Satisfaction Measurement

**Problem:** No direct feedback from seniors on call quality.

**What to build:**
- Optional end-of-call question in closing phase: "Was it nice chatting today?" (voice response, not DTMF)
- Quick Observer parses response (positive/negative/neutral)
- Store in `call_ratings` table: conversation_id, rating (1-5 inferred), raw_response
- GrowthBook experiment: test "voice_ask" vs "sms" vs "none" as delivery methods

**Execution:**
1. Add closing phase prompt variation that asks satisfaction question
2. Quick Observer pattern for positive/negative response
3. `call_ratings` table
4. GrowthBook metric: AVG(rating) from call_ratings — used in experiment analysis
5. Dashboard: satisfaction trend chart (Metabase or consumer app)

**Flag:** `satisfaction_survey` (variant — "voice_ask" | "sms" | "none")

#### 3.3 Response Latency Tracking & Dashboard

**Problem:** We just added metrics logging (LLM TTFB, TTS TTFB, turn latency) but it only goes to logs, not DB.

**What to build:**
- Persist per-turn metrics in `call_metrics` table or extend conversations.callMetrics
- Metabase dashboard: latency percentiles (p50, p95) over time
- GrowthBook metric: AVG(llm_ttfb) — used to measure latency impact of experiments

**Execution:**
1. Extend MetricsLoggerProcessor to accumulate metrics in session_state
2. Post-call: persist aggregated metrics (avg/p50/p95 per call) to DB
3. Metabase: latency dashboard (SQL query, no custom code)
4. GrowthBook: define latency metrics for experiment analysis

**Flag:** `latency_tracking` (boolean, default true)

---

### Tier 4 — Growth & Business

#### 4.1 Multi-Senior Management

See: `docs/plans/2026-02-05-multi-senior-management.md` (existing plan)

**Flag:** `multi_senior` (boolean)

#### 4.2 Family Invite System

**What to build:**
- Invite flow: caregiver enters email → invite sent via Resend → recipient creates Clerk account → linked to senior
- Roles: admin (full control), viewer (read-only), responder (gets alerts only)
- Permission checks on all API endpoints

**Flag:** `family_invites` (boolean)

#### 4.3 Billing & Subscriptions

**What to build:**
- Stripe integration: plans, payment methods, invoices
- Stripe Customer Portal (self-service subscription management — no custom UI needed)
- Usage metering: report call events to Stripe, Stripe calculates charges
- Enforce plan limits in scheduler and call initiation via GrowthBook flags (`max_seniors`, `max_calls_monthly`)

**Execution:**
1. Stripe: create products + price plans
2. `subscriptions` table: caregiver_id, stripe_customer_id, plan, status, current_period_end
3. Stripe webhooks: update subscription status on payment events
4. Customer Portal link in consumer app (Stripe-hosted, zero custom UI)
5. GrowthBook flags: `max_seniors`, `max_calls_monthly` (value type, default by plan)
6. Scheduler: check flag limits before initiating calls

**Flag:** `billing` (boolean)

#### 4.4 Proactive Wellness Check-Ins

**What to build:**
- Trigger calls based on patterns, not just reminders:
  - No call in X days → check-in call
  - Previous call showed low engagement → follow-up
  - Weather alert in senior's area → "stay safe" call
- `proactive_triggers` table: senior_id, trigger_type, condition, last_triggered_at

**Flag:** `proactive_calls` (boolean)

---

## Part 4: Execution Order

### Phase 0: Infrastructure (Week 1)

| # | Task | Type | Depends On |
|---|------|------|------------|
| 1 | Deploy GrowthBook on Railway (Docker + FerretDB) | Infra | — |
| 2 | Connect GrowthBook to Neon Postgres as data warehouse | Infra | #1 |
| 3 | Integrate Sentry in Pipecat (main.py) + Node.js (index.js) | Infra | — |
| 4 | Create Resend account + verify domain | Infra | — |
| 5 | Add GrowthBook Python SDK to Pipecat | Python | #1 |
| 6 | Add GrowthBook Node.js SDK to Express | Node.js | #1 |
| 7 | Wire flag resolution into bot.py (resolve on call start → session_state) | Python | #5 |
| 8 | Seed initial ~20 flags in GrowthBook (voice pipeline, observer, flow) | Config | #1 |

**Milestone:** Errors are caught by Sentry. Flags resolve per-senior in voice pipeline. Can toggle flags in GrowthBook UI.

### Phase 1: Safety (Week 2-3)

| # | Task | Backend | Depends On |
|---|------|---------|------------|
| 9 | Create `alerts` table + `notification_preferences` on caregivers | DB | — |
| 10 | Build `pipecat/services/alerts.py` (Twilio SMS + Resend email) | Python | #4, #9 |
| 11 | Wire emergency alerting into Quick Observer | Python | #10 |
| 12 | Wire concern alerting into post_call.py | Python | #10 |
| 13 | Build call retry logic in scheduler | Node.js | Phase 0 |
| 14 | Add DND windows to senior profile + scheduler | Both | Phase 0 |
| 15 | Admin UI: alerts list page | Frontend | #9 |

**Milestone:** Caregivers get SMS/email when safety concern detected. Missed calls retry. DND respected.

### Phase 2: Caregiver Engagement (Week 3-5)

| # | Task | Backend | Depends On |
|---|------|---------|------------|
| 16 | Build notification dispatch service (Twilio + Resend) | Node.js | #4, #9 |
| 17 | Post-call notification hook (call completed + summary) | Node.js | #16 |
| 18 | React Email templates (weekly report, alert, call summary) | Frontend | #4 |
| 19 | Weekly summary report generation + cron | Node.js | #16, #18 |
| 20 | Deploy Metabase on Railway, connect to Neon | Infra | — |
| 21 | Build Metabase dashboards (engagement, concerns, calls) | Config | #20 |
| 22 | Analytics API endpoints for consumer app | Node.js | — |
| 23 | Consumer app: analytics charts page | Frontend | #22 |
| 24 | Topic seeding: DB + API + prompt injection | Both | Phase 0 |
| 25 | Consumer app: topic suggestion input | Frontend | #24 |

**Milestone:** Caregivers get weekly reports, can view trends, can suggest topics.

### Phase 3: Quality & Optimization (Week 5-7)

| # | Task | Backend | Depends On |
|---|------|---------|------------|
| 26 | Create remaining ~60 flags in GrowthBook (all categories) | Config | Phase 0 |
| 27 | Per-senior voice/personality via GrowthBook flags | Both | #26 |
| 28 | Persist response latency metrics to DB | Python | MetricsLogger (done) |
| 29 | Define GrowthBook metrics (engagement, duration, latency, satisfaction) | Config | #2 |
| 30 | Launch first A/B test: prompt style ("warm" vs "concise") | Config | #29 |
| 31 | Satisfaction survey (closing phase variation) | Python | #26 |
| 32 | `call_ratings` table + GrowthBook metric | Both | #31 |

**Milestone:** Running prompt A/B tests with real stats. Per-senior customization live. Latency tracked.

### Phase 4: Growth (Week 7+)

| # | Task | Backend | Depends On |
|---|------|---------|------------|
| 33 | Stripe integration (products, webhooks, customer portal) | Node.js | — |
| 34 | `subscriptions` table + plan limit enforcement | Both | #33 |
| 35 | Family invite system (Resend invites + Clerk accounts) | Both | #4 |
| 36 | Proactive wellness check-ins | Both | Phase 1 (alerts) |
| 37 | Multi-senior management (see existing plan) | Both | Phase 0 |
| 38 | Add BullMQ for job queue (replace polling, add retries) | Node.js | — |

---

## Part 5: Flag Categories (~80 flags)

Once GrowthBook is deployed, seed flags in these categories:

### Voice Pipeline (~10 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `tts_speed` | value | 0.9 | Per-senior TTS speed (0.7–1.0) |
| `tts_voice_id` | value | null | Per-senior ElevenLabs voice |
| `tts_model` | value | "eleven_flash_v2_5" | TTS model selection |
| `vad_confidence` | value | 0.6 | VAD confidence threshold |
| `vad_stop_secs` | value | 1.2 | Silence duration before speech end |
| `vad_min_volume` | value | 0.5 | Minimum volume threshold |
| `llm_model` | value | "claude-haiku-4-5-20251001" | LLM model selection |
| `llm_max_tokens` | value | 150 | Default max response tokens |
| `stt_model` | value | "nova-3-general" | Deepgram STT model |
| `audio_sample_rate` | value | 8000 | Audio sample rate |

### Prompt Variations (~10 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `prompt_style` | variant | "warm" | A/B: "warm" vs "concise" prompt |
| `greeting_style` | variant | "interest_first" | A/B: greeting approach |
| `closing_style` | variant | "natural" | A/B: closing approach |
| `personality_tone` | value | "warm" | Per-senior personality |
| `avoid_topics` | value | [] | Topics to never discuss |
| `max_questions_consecutive` | value | 2 | Question frequency limit |
| `interest_usage_frequency` | value | "moderate" | How often to reference interests |
| `context_summary_style` | value | "detailed" | RESET_WITH_SUMMARY prompt style |
| `reminder_delivery_style` | variant | "natural" | A/B: reminder phrasing approach |
| `filler_words_enabled` | boolean | false | "Hmm...", "Let me think..." |

### Call Flow (~8 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `opening_max_minutes` | value | 2.0 | Max time in opening phase |
| `force_winding_minutes` | value | 9.0 | Force winding-down after N min |
| `force_end_minutes` | value | 12.0 | Hard call end after N min |
| `allow_interruptions` | boolean | true | Barge-in support |
| `goodbye_delay_secs` | value | 3.5 | Delay before EndFrame on goodbye |
| `respond_immediately_opening` | boolean | true | Bot speaks first |
| `min_call_duration` | value | 60 | Minimum call length (seconds) |
| `max_call_duration` | value | 900 | Maximum call length (seconds) |

### Memory & Context (~8 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `memory_tier_strategy` | value | "tier3" | Memory retrieval strategy |
| `context_cache_enabled` | boolean | true | 5 AM pre-caching |
| `context_cache_ttl_hours` | value | 24 | Cache TTL |
| `memory_decay_halflife_days` | value | 30 | Decay rate |
| `memory_dedup_threshold` | value | 0.9 | Cosine similarity for dedup |
| `greeting_rotation_enabled` | boolean | true | Rotate greetings |
| `daily_context_enabled` | boolean | true | Cross-call same-day memory |
| `max_memories_in_prompt` | value | 8 | Memory count limit in system prompt |

### Observer (~6 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `director_enabled` | boolean | true | Enable/disable Layer 2 |
| `director_model` | value | "gemini-3-flash-preview" | Director LLM model |
| `director_timeout_ms` | value | 10000 | Director analysis timeout |
| `quick_observer_enabled` | boolean | true | Enable/disable Layer 1 |
| `observer_goodbye_patterns` | boolean | true | Programmatic goodbye detection |
| `director_fallback_actions` | boolean | true | Time-based force transitions |

### Safety (~5 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `emergency_alerts` | boolean | false | Enable caregiver alerting |
| `emergency_sms` | boolean | true | SMS channel for alerts |
| `emergency_email` | boolean | true | Email channel for alerts |
| `alert_severity_threshold` | value | "high" | Min severity to trigger alert |
| `escalation_after_minutes` | value | 5 | Escalate if no ack after N min |

### Notifications (~6 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `caregiver_notifications` | boolean | false | Enable notifications |
| `weekly_reports` | boolean | false | Monday email digest |
| `call_summary_sms` | boolean | false | SMS after each call |
| `missed_call_alert` | boolean | false | Alert on no-answer |
| `notification_quiet_hours` | value | null | DND for notifications |
| `notification_digest` | boolean | false | Batch notifications (vs real-time) |

### Scheduling (~7 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `call_retry` | value | `{"max_retries":2,"interval":15}` | Retry policy |
| `dnd_windows` | boolean | true | Respect DND windows |
| `proactive_calls` | boolean | false | Pattern-based calls |
| `max_calls_per_day` | value | 3 | Daily call limit per senior |
| `preferred_time_flex_minutes` | value | 30 | Schedule flexibility window |
| `outbound_caller_id` | value | null | Custom caller ID |
| `call_recording_enabled` | boolean | false | Twilio call recording |

### Features (~8 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `topic_seeding` | boolean | false | Caregiver-suggested topics |
| `satisfaction_survey` | variant | "none" | Post-call satisfaction |
| `analytics_dashboard` | boolean | false | Consumer analytics page |
| `voice_customization` | boolean | false | Per-senior voice settings |
| `latency_tracking` | boolean | true | Persist latency metrics |
| `news_search` | boolean | true | In-call web search |
| `cognitive_exercises` | boolean | false | Brain games during calls |
| `activity_suggestions` | boolean | false | Weather/interest-based suggestions |

### Billing (~5 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `billing_enabled` | boolean | false | Stripe billing active |
| `plan_tier` | value | "free" | Current plan |
| `max_seniors` | value | 1 | Plan limit: seniors |
| `max_calls_monthly` | value | 30 | Plan limit: calls |
| `trial_days_remaining` | value | 14 | Free trial countdown |

### Experiments (~7 flags)

| Flag | Type | Default | Purpose |
|------|------|---------|---------|
| `prompt_style_ab` | variant | "warm" | Prompt tone experiment |
| `greeting_ab` | variant | "interest_first" | Greeting approach experiment |
| `tts_model_ab` | variant | "eleven_flash_v2_5" | TTS provider experiment |
| `director_model_ab` | variant | "gemini-3-flash-preview" | Director model experiment |
| `vad_sensitivity_ab` | variant | "standard" | VAD tuning experiment |
| `closing_approach_ab` | variant | "natural" | Closing style experiment |
| `reminder_timing_ab` | variant | "director" | Reminder delivery timing experiment |

---

## Part 6: A/B Test Examples

### Prompt Style Experiment

**Hypothesis:** A more concise prompt style leads to faster responses without hurting engagement.

**Setup in GrowthBook:**
- Feature: `prompt_style_ab` (variant type)
- Variants: `["warm", "concise"]` (50/50 split)
- Targeting: all active seniors
- `warm`: Current prompt (rich, detailed personality instructions)
- `concise`: Shorter prompt (fewer examples, tighter instructions)

**GrowthBook Metrics (SQL against Neon):**
- `engagement_score`: `SELECT senior_id, engagement_score, created_at FROM call_analyses`
- `call_duration`: `SELECT senior_id, duration_seconds, created_at FROM conversations WHERE status = 'completed'`
- `llm_ttfb_avg`: `SELECT senior_id, (call_metrics->>'llm_ttfb_avg')::float, created_at FROM conversations`

**Analysis:** GrowthBook computes Bayesian credible intervals automatically. Dashboard shows per-variant means with confidence intervals. Results available after ~100 calls per variant.

### Greeting Style Experiment

**Hypothesis:** Interest-based greetings drive higher engagement than generic time-based ones.

**Setup in GrowthBook:**
- Feature: `greeting_ab` (variant type)
- Variants: `["interest_first", "time_based", "context_first"]` (33/33/33 split)

**GrowthBook Metrics:** engagement_score, call_duration, first_turn_response_length

---

*This document is the source of truth for Donna's next development phase. Update as features are built, tools are deployed, and flags are created.*
