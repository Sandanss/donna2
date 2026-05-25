# Donna — Business Plan

> AI companion that makes daily phone calls to elderly people. Companionship, reminders, and peace of mind for caregivers.

*Last updated: April 2026*

---

## The Problem

- 55M Americans over 65. 28% live alone. That number grows by 10,000 people per day.
- US Surgeon General declared loneliness a public health epidemic — as harmful as smoking 15 cigarettes/day.
- Adult children (caregivers) worry constantly but can't call every day. Caregiver burnout costs $500B+ annually.
- Existing solutions (home health aides, senior living) are $3,000-8,000/month and don't solve loneliness.

## The Product

Donna is an AI voice companion that calls elderly people daily. She:
- Has warm, natural conversations (not robotic IVR)
- Remembers past conversations — knows their grandkids' names, their hobbies, their medication schedule
- Delivers medication reminders woven naturally into conversation
- Sends caregivers mood summaries and alerts after each call
- Learns and adapts to each senior's personality over time

**What makes it work**: Seniors already know how to use a phone. No app to install, no device to set up. Donna calls them. They just talk.

---

## Target Market

### Primary buyer: The adult child caregiver
- Age 40-65, typically a daughter
- Lives in a different city from their parent
- Feels guilty about not calling enough
- Willing to pay $29/month for peace of mind — less than a single lunch out

### End user: The senior (70+)
- Lives alone or with limited social contact
- May have mild cognitive decline
- Comfortable with phone calls (not apps)
- Craves conversation and connection

### TAM/SAM/SOM
- **TAM**: 15M elderly Americans living alone × $29/mo = $5.2B
- **SAM**: 3M caregivers actively seeking solutions = $1B
- **SOM (Year 1-2)**: 5,000-10,000 users = $1.7-3.5M ARR

---

## Pricing

### Subscription: $29/month
- Daily check-in calls (configurable frequency)
- Medication reminders
- Caregiver dashboard with mood summaries
- Memory that builds over time

### Free Trial: 120 minutes over 30 days
No credit card required. Enough for ~12 calls.

**Why 120 minutes / 30 days (not 3 free calls or a free tier)**:

The senior needs time to build a relationship with Donna. On call 1-3, they're skeptical. By call 10-12, Donna knows their grandson's name, remembers their garden, asks about their doctor's appointment. That emotional bond is what converts.

- **If they don't use it**: Costs us nothing. They self-selected out.
- **If they use 30-60 min**: Light user. May convert, may not. Cost: ~$2-4 current stack.
- **If they hit the cap**: Hooked. Senior is asking "when is Donna calling again?" Cost: ~$8 current stack, ~$4-6 after TTS/carrier optimization.

**No free tier.** A 10-minute call currently costs about ~$0.70 in AI/voice infrastructure, mostly TTS and telephony. A perpetual free user at 130 min/week costs about ~$39/month on the current stack — more than the subscription price. Free tiers destroy gross margins.

### Conversion mechanism

At 100 minutes, Donna naturally mentions: "I've really enjoyed getting to know you this month."

The app sends the caregiver a notification:
> "Mom used 100 of 120 free minutes this month. She talked about her garden, her medication schedule, and Jake's baseball game. Keep Donna calling?"

The **senior** sells the product to the **caregiver**. No ads, no hard sell. "Mom asked me when Donna is calling again" is the conversion event.

**Expected metrics**:
- Average trial cost: ~$5-8 depending on minutes used and TTS/carrier stack
- Trial → paid conversion: 30-40% (seniors who hit 80+ minutes convert at 60%+)
- Effective CAC: $5-12
- No paid acquisition needed in early stages — word of mouth among caregivers

---

## Unit Economics

### Per-Call Cost (10-minute average)

| Service | Cost |
|---------|------|
| TTS (ElevenLabs Flash default) | ~$0.18 |
| Voice carrier + media stream (Telnyx) | ~$0.11 |
| Voice LLM (Claude Haiku 4.5, cached) | ~$0.03 |
| STT (Deepgram Nova 3) | ~$0.08 |
| News/search + post-call/memory/compute | ~$0.04 |
| Email/in-app notifications | ~$0.00 |
| **Total per call** | **~$0.43 current → ~$0.31-0.36 with lower-cost TTS/STT** |

### Per-User Monthly Cost

| Stack | 60 min/week COGS | 130 min/week COGS | Gross margin at $29, 60 min/week |
|-------|------------------|-------------------|-------------------------------|
| Current (Telnyx + ElevenLabs Flash) | ~$11 | ~$24 | ~62% |
| Telnyx + cheaper TTS | ~$8-9 | ~$17-20 | ~68-72% |
| Telnyx + cheaper STT/TTS | ~$8 | ~$17 | ~72% |
| Target (optimized) | ~$8-9 | ~$17-20 | **70%+ at 60 min/week** |

### Margin Upside

| Monthly price | 60 min/week user | 100 min/week user | 130 min/week user |
|---------------|------------------|-------------------|-------------------|
| $29 | ~68-75% optimized margin | ~46-58% optimized margin | ~30-46% optimized margin |
| $39 | ~76-81% optimized margin | ~60-69% optimized margin | ~48-60% optimized margin |
| $49 | ~81-85% optimized margin | ~68-75% optimized margin | ~59-68% optimized margin |

The investor-safe target is **65-75% gross margin on normal 60 min/week consumer usage** after TTS and carrier optimization. Heavy 130 min/week users should be on a higher plan, usage allowance, or B2B contract so the product does not become a negative-margin unlimited calling plan.

**Critical path**: TTS optimization first, then carrier optimization when call volume justifies migration risk. The $29 consumer plan is fundable only if average usage stays around 60 min/week or the optimized stack is live. Heavy 130 min/week users need a higher plan, usage allowance, or B2B pricing.

---

## Growth Model

### Phase 1: Prove it works (now → 200 users)
- Self-funded
- Direct outreach: elder care Facebook groups, caregiver forums, senior centers
- Free trial (120 min / 30 days) as the only funnel
- Goal: prove retention (3-month cohort surviving at 90%+)
- Timeline: 3-6 months
- Burn: $2-5K/month

### Phase 2: Seed round (200 → 2,000 users)
- Raise $3-5M at $15-25M valuation
- Hire: 2-3 engineers, 1 growth marketer, 1 caregiver community manager
- Distribution: caregiver influencer partnerships, elder care provider partnerships (home health agencies, geriatricians)
- Goal: $500K ARR, <5% monthly churn
- Timeline: 6-12 months post-raise

### Phase 3: Series A (2,000 → 10,000 users)
- Raise $8-12M at $40-60M valuation
- B2B channel: sell to senior living communities, home health agencies, health systems
- Launch family plan (multiple seniors per caregiver)
- Add WhatsApp/video call channels
- Goal: $3M+ ARR
- Timeline: 12-18 months post-Series A

### Revenue Projections

| Month | Users | MRR | ARR | Gross margin |
|---|---|---|---|---|
| 3 | 50 | $1,450 | $17K | 40% |
| 6 | 200 | $5,800 | $70K | 55% |
| 9 | 500 | $14,500 | $174K | 65% |
| 12 | 1,000 | $29,000 | $348K | 70% |
| 18 | 3,000 | $87,000 | $1M | 70% |
| 24 | 8,000 | $232,000 | $2.8M | 72% |

*Assumes Telnyx + TTS optimization completed by month 3.*

---

## Fundraising Strategy

### Skip pre-seed. Self-fund to 200 users.

Pre-seed money is expensive (20-25% dilution for $750K-1.5M) and unnecessary if founders can cover $5-10K/month for 3-6 months. The product is built. It works. You just need distribution.

### Raise a strong Seed at 200+ users

| Metric | Target for Seed |
|---|---|
| Paying users | 200-500 |
| ARR | $70-170K |
| Monthly churn | <5% |
| Gross margin | 65%+ after optimized TTS/carrier stack |
| MoM growth | 15-20% |
| Trial → paid conversion | 30%+ |
| Cohort retention (3-mo) | 85%+ |

**Raise**: $3-5M at $15-25M post-money valuation.

**The pitch**: "200 families are paying us $29/month. Monthly churn is 4%. Seniors talk to Donna for 10 minutes a day. We have the optimized voice stack live, so usage scales with healthy margins. Here's a recording of Margaret telling Donna about her grandson's baseball game. Margaret's daughter hasn't missed a summary in 3 months. Our CAC is $5."

### Series A at $1M+ ARR

| Metric | Target for Series A |
|---|---|
| Users | 2,000-5,000 |
| ARR | $1-2M |
| Monthly churn | <4% |
| Gross margin | 70%+ with optimized stack and plan-level usage controls |
| B2B channel started | Yes |
| Team | 5-8 people |

**Raise**: $8-12M at $40-60M valuation.

---

## Competitive Landscape

| Competitor | Approach | Weakness |
|---|---|---|
| **Amazon Alexa / Google Home** | Smart speakers with skills | Seniors don't use them. Requires setup. No outbound calling. No memory. |
| **GrandPad** | Simplified tablet for seniors | $50/mo + device cost. Still requires the senior to initiate. Not proactive. |
| **Papa** | Human companions (gig workers) | $30-40/hour. Not scalable. Scheduling friction. No daily availability. |
| **Mon Ami** | Volunteer visitor matching | Supply-constrained. Not daily. No health monitoring. |
| **Generic AI chatbots** | ChatGPT, Character.ai | Text-based (seniors can't/won't use). No phone. No proactive outreach. No caregiver integration. |

**Donna's moat**: Proactive outbound calls (senior doesn't need to do anything), persistent memory across calls (relationship builds over time), caregiver integration (peace of mind is the selling point), and voice-first design (phone, not app).

---

## Risks

| Risk | Mitigation |
|---|---|
| Senior refuses to talk to AI | Donna is transparent about being AI but leads with personality. Trial is free. |
| Caregiver doesn't see value | Post-call summaries with specific details ("Mom mentioned her knee is hurting") prove value instantly. |
| AI says something harmful | Safety boundaries in prompt. Call analysis flags concerns. Caregiver gets alerts. |
| Competitor with more resources | First-mover advantage in voice + memory + caregiver integration. Switching cost = senior's relationship with Donna. |
| Regulation (HIPAA, FCC) | Not a medical device (companionship, not diagnosis). Telnyx handles voice infrastructure; Donna still needs outbound consent/TCPA processes and signed BAAs for PHI-bearing vendors. |
| Cost structure doesn't scale | Telnyx + TTS optimization path to 70% margins is clear and achievable in 1-2 months of engineering. |

---

## Technical Architecture (Summary)

Real-time voice pipeline built on Pipecat (open source):

```
Phone call → Deepgram STT → Quick Observer (regex) → Conversation Director (Groq)
  → Claude Haiku 4.5 → ElevenLabs TTS by default (Cartesia optional) → Phone call

Background: Memory prefetch, Claude web_search tool when needed, call analysis, caregiver notifications
```

- **3 active LLM tools** available to Claude during subscribed calls (`web_search`, `mark_reminder_acknowledged`, `create_reminder`); memories and caregiver notes are prefetched/injected outside Claude tool calls, and onboarding exposes `web_search` only
- **Semantic memory** with pgvector — Donna remembers across calls
- **2-layer observer architecture** — instant regex patterns + background LLM analysis
- **Post-call pipeline** — analysis, memory extraction, caregiver email/in-app notifications, snapshot rebuild

Full technical docs: [pipecat/docs/ARCHITECTURE.md](../pipecat/docs/ARCHITECTURE.md) and [claude.md](../claude.md)

---

## Team

*[To be filled in]*

---

## Ask

*[To be filled in based on fundraising stage]*
