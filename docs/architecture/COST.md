# Cost Analysis

> Investor-facing unit economics for Donna's Telnyx voice workflow.

*Runtime assumptions updated: May 25, 2026. Prices are still based on published vendor pricing pages as of April 22, 2026. Actual invoices can differ because of negotiated discounts, taxes, carrier fees, model substitutions, failed-call partial usage, startup credits, plan minimums, and regional routing.*

---

## Executive Summary

Donna's forward voice workflow assumes **Telnyx for phone voice and media streaming**, **Claude Haiku 4.5 for the live voice LLM**, **Claude Haiku 4.5 forced tool-use for completed-call analysis**, **ElevenLabs Flash for TTS**, and **email/in-app caregiver notifications only**. SMS is intentionally inactive. Using measured production speech volume from **March 16, 2026 through April 15, 2026** as the baseline, the current modeled stack costs about **$0.44 per 10-minute completed outbound call**, or **$0.044 per live call minute**, before customer support, payroll, App Store fees, payment processing, compliance counsel, or CAC.

For investor planning, model Donna as:

| Usage profile | Minutes / user / week | ElevenLabs base COGS / user / month | Gross margin at $29 |
|---|---:|---:|---:|
| Light / sustainable | 60 | ~$11 | ~61% |
| Moderate | 100 | ~$19 | ~34% |
| Heavy companion usage | 130 | ~$25 | ~15% |

Carrier savings help, but the business implication is still clear: a **$29 unlimited plan only works if average usage stays near normal companion usage** and if we package usage carefully. At 130 minutes/week, the default Telnyx + ElevenLabs stack is still too thin for a healthy consumer gross margin once non-infra costs are included.

Near-term operating assumption:

| Stack | Cost / 10-min call | Cost / minute | Heavy user COGS at 130 min/week | Gross margin at $29 |
|---|---:|---:|---:|---:|
| Telnyx + ElevenLabs default | ~$0.44 | ~$0.044 | ~$25/mo | ~15% |

Future speech-cost sensitivity only:

| Stack | Cost / 10-min call | Cost / minute | Heavy user COGS at 130 min/week | Gross margin at $29 |
|---|---:|---:|---:|---:|
| Telnyx + Cartesia Sonic / Deepgram Aura-2 | ~$0.36 | ~$0.036 | ~$20/mo | ~30% |
| Telnyx + Deepgram Aura-1 | ~$0.31 | ~$0.031 | ~$17/mo | ~40% |
| Telnyx speech evaluation: Telnyx STT + Telnyx TTS | ~$0.34 | ~$0.034 | ~$19/mo | ~34% |

Deck-safe phrasing:

> With Telnyx as the carrier baseline, Claude Haiku as the live voice LLM and post-call analysis model, ElevenLabs kept for voice quality, and SMS disabled, Donna's current infra COGS are roughly 4.4 cents per live call minute on measured production speech volume. At 60 minutes/week, that can support a $29 consumer plan before non-infra costs. At 130 minutes/week, margins are still too thin without pricing tiers, usage caps, or premium packaging. Lower-cost TTS is upside, not the current base case.

### Margin Upside With Optimizations

The base margin story is not "AI gets cheap enough for unlimited $29." The stronger story is: Donna can reach workable margins for normal usage by using Telnyx as the communications baseline, keeping ElevenLabs for voice quality, and pricing heavier companionship usage correctly.

Modeling cases:

| Case | Cost / minute | What has to be true |
|---|---:|---|
| ElevenLabs base | ~$0.044 | Telnyx voice/media, Deepgram STT, Claude Haiku live voice + post-call analysis, ElevenLabs TTS, email/in-app caregiver notifications, and measured Donna speech volume around 3.5K chars per 10-minute call. |
| Future lower-TTS sensitivity | ~$0.036 | Lower-cost TTS or Telnyx speech path passes senior-listening quality tests. |
| Aggressive future sensitivity | ~$0.028 | Lower assistant speech volume, cheaper TTS, controlled search/news, possible volume discounts. |

Gross margin by price point:

| Price | Usage | ElevenLabs base | Future lower-TTS sensitivity | Aggressive future sensitivity |
|---|---:|---:|---:|---:|
| $29/mo | 60 min/week | ~61% | ~68% | ~75% |
| $29/mo | 100 min/week | ~34% | ~46% | ~58% |
| $29/mo | 130 min/week | ~15% | ~30% | ~46% |
| $39/mo | 60 min/week | ~71% | ~76% | ~81% |
| $39/mo | 100 min/week | ~51% | ~60% | ~69% |
| $39/mo | 130 min/week | ~37% | ~48% | ~60% |
| $49/mo | 60 min/week | ~77% | ~81% | ~85% |
| $49/mo | 100 min/week | ~61% | ~68% | ~75% |
| $49/mo | 130 min/week | ~49% | ~59% | ~68% |

Investor-safe margin claim:

> With Telnyx + Claude Haiku + ElevenLabs and SMS disabled, Donna can reach about **61% gross margin on normal 60 min/week usage at $29/month** on today's measured speech volume, before non-infra costs. To get software-like margins with heavier companion usage, Donna still benefits from usage-aware packaging and heavier users priced closer to **$49/month**. Lower-cost TTS can lift margins later, but it is not the current assumption.

---

## Forward Runtime Assumption

This document is now a forward-looking Telnyx model. It is not a historical carrier comparison.

| Layer | Modeled default | Notes |
|---|---|---|
| Phone carrier | Telnyx Voice API + Elastic SIP Trunking + Media Streaming over WebSockets | Outbound local call model uses Voice API fee, SIP outbound fee, and media streaming fee. |
| STT | Deepgram Nova-3 General streaming | Continuous stream for full call duration. |
| Main voice LLM | Anthropic Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Prompt caching remains assumed. Live dev tests showed materially lower TTFB than Sonnet while preserving Donna's voice quality. |
| Director LLM | Groq `openai/gpt-oss-20b`, Gemini fallback | Runs off critical path for guidance/query extraction. |
| Post-call analysis | Anthropic Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Runtime default for completed-call analysis via forced tool-use. `CALL_ANALYSIS_MODEL` accepts Claude/Anthropic model IDs; onboarding summaries still use a lightweight Gemini Flash path and are not material to subscriber-call COGS. |
| Memory extraction | OpenAI small model + embeddings | Runs post-call; embeddings are de minimis in cost. |
| TTS | ElevenLabs Flash (`eleven_flash_v2_5`) | Keep this assumption for now. Active Telnyx calls request 16kHz PCM from TTS; higher-rate TTS output is only for non-phone paths. Other speech vendors are sensitivity only. |
| Web/news | Tavily basic search, OpenAI web search fallback/news | Current feature remains enabled in the model. |
| Notifications | Resend email + in-app notification records | SMS is inactive for now; legacy SMS columns/fields remain only for backward compatibility. |
| Hosting/data | Railway, Neon Postgres/pgvector, Redis | Mostly fixed platform cost, not the main COGS driver. |

Important correction: the carrier baseline is Telnyx from this document forward, but the TTS baseline remains ElevenLabs for now. The main variable COGS problem is now **TTS + STT + LLM/search**, not the communications carrier.

---

## Pricing Inputs

| Service | Modeled price | Source |
|---|---:|---|
| Telnyx Voice API programmatic call fee | $0.002/min + SIP fee | [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api) |
| Telnyx outbound local SIP | starting at $0.005/min | [Telnyx SIP Trunking pricing](https://telnyx.com/pricing/elastic-sip) |
| Telnyx inbound local SIP | starting at $0.0035/min | [Telnyx SIP Trunking pricing](https://telnyx.com/pricing/elastic-sip) |
| Telnyx Media Streaming over WebSockets | $0.0035/min | [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api) |
| Telnyx STT | $0.015/min | [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api) |
| Telnyx TTS | $0.000003/character | [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api) |
| Deepgram Nova-3 streaming STT | $0.0077/min pay-as-you-go | [Deepgram pricing](https://deepgram.com/pricing) |
| Deepgram Aura-2 TTS | $0.030/1K chars | [Deepgram pricing](https://deepgram.com/pricing) |
| Deepgram Aura-1 TTS | $0.015/1K chars | [Deepgram pricing](https://deepgram.com/pricing) |
| ElevenLabs Flash TTS | $0.05/1K chars | [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) |
| Cartesia Sonic TTS | 1 credit/char; Scale annual plan implies about $0.030/1K chars | [Cartesia pricing](https://cartesia.ai/pricing) |
| Claude Haiku 4.5 | $1/MTok input, $5/MTok output, $0.10/MTok cache read | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Groq GPT OSS 20B | $0.075/MTok input, $0.30/MTok output | [Groq pricing](https://groq.com/pricing) |
| Gemini 3 Flash Preview | $0.50/MTok input, $3/MTok output | [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| OpenAI web search preview | $25/1K calls for non-reasoning preview models | [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) |
| Tavily basic search | 1 credit/search; $0.008/credit pay-as-you-go | [Tavily credits](https://docs.tavily.com/documentation/api-credits) |
| Railway | usage based; Pro has $20 minimum | [Railway pricing](https://railway.com/pricing) |
| Neon | Launch $0.106/CU-hour; Scale $0.222/CU-hour; $0.35/GB-month | [Neon pricing](https://neon.com/pricing) |
| Resend | Free 3K emails/mo; Pro $20/mo for 50K emails | [Resend pricing](https://resend.com/pricing) |

Carrier formulas used in this model:

| Call type | Telnyx formula | Cost / 10-min call |
|---|---:|---:|
| Outbound local AI call | Voice API $0.002/min + outbound SIP $0.005/min + media streaming $0.0035/min | $0.105 |
| Inbound local AI call | Voice API $0.002/min + inbound SIP $0.0035/min + media streaming $0.0035/min | $0.090 |

Telnyx STT is modeled as an evaluation path, not as the default cost winner. At published list rates, direct Deepgram Nova-3 streaming is cheaper than Telnyx STT, so Telnyx STT should be justified by latency, simplification, or negotiated pricing rather than list-price savings alone.

---

## Modeling Assumptions

Base unit: **one 10-minute completed outbound local call**.

### Observed Production Speech Metrics

Production measurement window: **March 16, 2026 through April 15, 2026**.

The current investor model now anchors on observed Donna speech volume instead of the earlier 6,000-character placeholder.

Transcript-derived production sample:

- **78** completed production calls with usable assistant transcript text and duration of at least **60 seconds**
- **190.2** total measured call minutes
- **58,871** total assistant characters
- **309.6 weighted assistant characters/minute** across the full sample
- **253.6 median characters/minute**
- **172.2 p25 / 460.0 p75 characters/minute**
- **755 average assistant characters/call**
- **509 median assistant characters/call**
- **2.4 average call minutes**, **2.1 median call minutes**

Longer-call buckets from the same production window:

| Bucket | Calls | Weighted chars/min | Avg assistant chars/call | Avg duration |
|---|---:|---:|---:|---:|
| 1-3 min | 65 | 270.8 | 536 | 2.0 min |
| 3-5 min | 9 | 419.4 | 1,510 | 3.6 min |
| 5-10 min | 4 | 359.1 | 2,611 | 7.3 min |

Direct `call_metrics.token_usage.tts_characters` spot-check:

- **11** production calls currently have direct `tts_characters` populated
- **353.4 weighted characters/minute**
- This is directionally consistent with the transcript-derived longer-call range

Planning baseline used below:

- **3.1K-3.6K Donna characters per 10-minute call** is the current measured production band
- The default modeled base case uses **3.5K characters per 10-minute call**

### Planning Assumptions

| Assumption | Base value | Why |
|---|---:|---|
| Call duration | 10 minutes | Current product target; hard stop around 12 minutes. |
| Turns | ~20 assistant responses | Typical companion call shape. |
| TTS characters | ~3,500 chars/call | Based on measured production Donna speech volume from March 16, 2026 through April 15, 2026, using a planning band of roughly 3.1K-3.6K chars per 10-minute call. |
| Claude usage | 70K input, 55K cache-read, 15K uncached, 1.5K output | Matches prompt-cached append architecture. |
| Director usage | 35K input, 8K output | Query + guidance analysis across the call. |
| Post-call Claude Haiku | 6K input, 800 output | Summary, engagement, mood, and caregiver takeaways; no concern-alert or recommended-follow-up workflow. |
| OpenAI memory extraction | 6K input, 600 output + small embedding cost | Post-call memory extraction and storage. |
| News/search | 0.2 Tavily searches/call + one OpenAI daily news fetch on calling days | Web search remains enabled; cached news is per senior/day, not per turn. |
| Notification | one caregiver email/in-app notification per completed call | Email is usually inside Resend free/low-cost tier. SMS is inactive. |
| Compute/db variable load | $0.005/call placeholder | Platform cost is mostly fixed and modeled separately below. |

Sensitivity:

- If Donna tracks the low end of the current production band at about **3,100 chars** in a 10-minute call, subtract about **$0.02-$0.03/call** from the 3.5K-character base model.
- If Donna drifts back up to about **6,000 chars** in a 10-minute call, add about **$0.15/call** to the 3.5K-character base model.
- If daily news is disabled, subtract about **$0.025/calling day**.
- Inbound local AI calls are about **$0.015 cheaper per 10-minute call** than outbound local AI calls at list prices.
- Telnyx carrier and media cost is about **24% of current Telnyx default call COGS**; TTS remains the largest cost center.

---

## Current Per-Call Cost

**Forward default stack: Telnyx + Deepgram STT + Claude Haiku live voice + Groq Director + Claude Haiku post-call + ElevenLabs TTS.**

| Component | Usage | Cost / 10-min call |
|---|---:|---:|
| ElevenLabs TTS | 3,500 chars at $0.05/1K | $0.175 |
| Telnyx voice + media streaming | 10 min at $0.0105/min | $0.105 |
| Claude Haiku 4.5 | 15K uncached in, 55K cache-read, 1.5K out | $0.028 |
| Deepgram Nova-3 STT | 10 min stream | $0.077 |
| Daily news + web search | 1 daily OpenAI news fetch + low Tavily usage | $0.027 |
| Claude Haiku post-call | 6K in, 800 out | ~$0.010 |
| Groq Director | 35K in, 8K out | $0.005 |
| OpenAI memory + embeddings | post-call extraction/storage | $0.002 |
| Railway/Neon variable placeholder | per-call amortized | $0.005 |
| **Total** |  | **~$0.44** |
| **Per live call minute** |  | **~$0.044** |

Moving the main voice LLM from Claude Sonnet 4.5 to Claude Haiku 4.5 reduces the modeled live-voice Claude line from about **$0.084** to **$0.028** per 10-minute call. That saves about **$0.056/call**, or roughly **13% of total call COGS** on the current measured speech baseline. Claude Haiku post-call analysis remains small at about one cent per completed call.

Current cost concentration:

| Rank | Cost center | Share |
|---:|---|---:|
| 1 | TTS | ~41% |
| 2 | Telnyx carrier/media | ~24% |
| 3 | STT | ~18% |
| 4 | Search/post-call/other | ~10% |
| 5 | Claude Haiku | ~6% |

The main LLM is no longer a major cost center. **TTS + STT + carrier/media are roughly 83% of current call COGS.**

Search and memory are not major cost drivers on the current baseline:

- **Daily news + web search:** **$0.027/call**, or about **6.3%** of current call COGS
- **OpenAI memory extraction + embeddings:** **$0.002/call**, or about **0.5%**
- **Combined explicit search + memory extraction:** **$0.029/call**, or about **6.8%**
- Even if the full **Railway/Neon variable placeholder** is treated as memory/prefetch-adjacent overhead, that bucket is still only about **$0.034/call**, or **7.9%**

Cost take-away: **search is a small but real line item; memory extraction is close to rounding error.** If Donna needs material margin improvement, the first levers are still **TTS, carrier/media, and STT**, not memory work.

---

## Per-User Monthly COGS

Uses 52 weeks / 12 months = 4.33 weeks/month. The first row is the current operating assumption; lower-TTS rows are future sensitivity only.

| Stack | 60 min/week | 100 min/week | 130 min/week |
|---|---:|---:|---:|
| Telnyx + ElevenLabs default | $11.15 | $18.59 | $24.17 |
| Telnyx + Cartesia Sonic | $9.33 | $15.56 | $20.22 |
| Telnyx + Deepgram Aura-2 | $9.33 | $15.56 | $20.22 |
| Telnyx + Deepgram Aura-1 | $7.97 | $13.28 | $17.27 |
| Telnyx STT + Telnyx TTS evaluation | $8.78 | $14.63 | $19.02 |

Gross margin at $29/month:

| Stack | 60 min/week | 100 min/week | 130 min/week |
|---|---:|---:|---:|
| Telnyx + ElevenLabs default | 62% | 36% | 17% |
| Telnyx + Cartesia Sonic | 68% | 46% | 30% |
| Telnyx + Deepgram Aura-2 | 68% | 46% | 30% |
| Telnyx + Deepgram Aura-1 | 73% | 54% | 40% |
| Telnyx STT + Telnyx TTS evaluation | 70% | 50% | 34% |

Gross margin at $49/month for heavy 130 min/week users:

| Stack | Heavy-user COGS | Gross margin at $49 |
|---|---:|---:|
| Telnyx + ElevenLabs default | $24.17 | 51% |
| Telnyx + Cartesia Sonic | $20.22 | 59% |
| Telnyx + Deepgram Aura-1 | $17.27 | 65% |
| Telnyx STT + Telnyx TTS evaluation | $19.02 | 61% |

Pricing implication: **$29/month is viable for light and moderate users on the current measured speech baseline, but heavy unlimited usage is still thin on the default Telnyx + ElevenLabs stack.** To make $29 work broadly while keeping ElevenLabs, we still benefit from usage tiers or a monthly minute allowance. Lower-cost TTS remains upside only.

---

## Free Trial Cost

The current free trial cap is 120 minutes over 30 days.

| Stack | Trial COGS at 120 minutes |
|---|---:|
| Telnyx + ElevenLabs default | ~$5.15 |
| Telnyx + Cartesia / Aura-2 | ~$4.31 |
| Telnyx + Deepgram Aura-1 | ~$3.68 |
| Telnyx STT + Telnyx TTS evaluation | ~$4.05 |

With ElevenLabs kept as the default, a full 120-minute trial costs about **$5.15** in variable infra on the current measured speech baseline. The old "$5 trial cost" is still roughly the right planning frame, but it depends on keeping Donna near today's actual speech volume rather than drifting back toward the old 6,000-character placeholder.

---

## Scale Scenarios

Assumption: 1 user = 1 senior profile. Variable COGS only; fixed platform costs are below.

These are cost scenarios, not architecture readiness claims. Current architecture work targets the 2,000-user burst milestone first; 10,000 users require the forward scale path documented in [`SCALABILITY.md`](SCALABILITY.md#path-to-10000-users) and the scale plan.

### 1,000 Users

| Usage | ElevenLabs base | Future lower-TTS sensitivity |
|---|---:|---:|
| 60 min/week | ~$11.2K/mo | ~$9.3K/mo |
| 100 min/week | ~$18.6K/mo | ~$15.6K/mo |
| 130 min/week | ~$24.2K/mo | ~$20.2K/mo |

### 10,000 Users

| Usage | ElevenLabs base | Future lower-TTS sensitivity |
|---|---:|---:|
| 60 min/week | ~$112K/mo | ~$93K/mo |
| 100 min/week | ~$186K/mo | ~$156K/mo |
| 130 min/week | ~$242K/mo | ~$202K/mo |

Fixed platform cost estimate:

| Stage | Likely monthly infra/platform spend | Notes |
|---|---:|---|
| Dev/pilot | $100-$500 | Railway, Neon, Redis, Resend, Sentry; often inside free/low tiers. |
| 200 users | $500-$1.5K | More database/log/email usage; still not dominant. |
| 1,000 users | $1K-$3K | Neon/Railway/observability/support plans start to matter. |
| 10,000 users | $8K-$25K+ | Depends on DB retention, logs, support plans, analytics, enterprise compliance. |

These fixed/platform estimates exclude headcount, support labor, legal/compliance work, BAA/enterprise minimums, insurance, App Store fees, and payment processing.

---

## Optimization Plan

### 1. Use The Measured Speech Baseline And Improve Direct Coverage

Measured production baseline as of **March 16, 2026 through April 15, 2026**:

- transcript-derived Donna speech volume: **309.6 weighted chars/minute** across the full 78-call sample
- longer-call transcript range: roughly **3.1K-3.6K characters per 10-minute call**
- direct `tts_characters` spot-check: **353.4 weighted chars/minute** across 11 calls

Next instrumentation step:

- assistant TTS characters
- Claude prompt tokens, cache-read tokens, output tokens
- call minutes
- search/news calls
- Telnyx billed voice, SIP, and media streaming minutes

Investor model sensitivity is still dominated by TTS characters, but the current gap is no longer between 6,000 and 3,000 chars. The real risk is speech volume drifting away from today's measured **3.1K-3.6K** band.

### 2. Keep ElevenLabs For Now, But Track TTS Sensitivity

Do not assume a near-term TTS vendor switch in the investor base case. ElevenLabs stays the default until we explicitly decide that another voice passes senior-listening quality tests, latency tests, and compliance review.

Future sensitivity:

| Provider | Modeled TTS cost at 3,500 chars | Savings vs ElevenLabs |
|---|---:|---:|
| ElevenLabs Flash | $0.175 | Baseline |
| Cartesia Sonic | ~$0.105 | ~$0.070/call |
| Deepgram Aura-2 | $0.105 | ~$0.070/call |
| Deepgram Aura-1 | $0.053 | ~$0.123/call |
| Telnyx TTS | $0.011 | ~$0.164/call |

Future evaluation order, only if we revisit TTS:

1. Cartesia Sonic if voice quality is materially better for seniors.
2. Deepgram Aura-2 if quality is good enough and vendor simplification matters.
3. Deepgram Aura-1 if it passes senior-listening quality tests, because the COGS impact is strong.
4. Telnyx TTS if the voice quality, streaming behavior, HIPAA/BAA posture, and latency are acceptable.

### 3. Treat Telnyx As The Communications Baseline

The carrier model should now assume Telnyx for:

- outbound and inbound calls
- media streaming
- carrier dashboards and billing reconciliation

Operational work to keep the model honest:

- track Telnyx billed call minutes separately from app conversation duration
- track media streaming minutes separately from PSTN minutes
- monitor failed-call partial usage and retries
- keep number rental, emergency calling, and compliance fees outside per-call COGS unless they become material

### 4. Decide Later Whether Telnyx Speech Services Are Worth It

This is future research, not the current model. Telnyx TTS is extremely cheap on published list pricing, but quality is the gating factor. Telnyx STT is more expensive than direct Deepgram Nova-3 at list price, so it is not a pure cost play.

Use Telnyx STT/TTS only if one of these becomes true:

- end-to-end latency is materially lower
- fewer streaming hops reduce failure rate
- quality passes senior-listening tests
- negotiated pricing beats direct speech vendors
- observability and billing become simpler enough to justify the switch

### 5. Tune Product Pricing Around Minutes

Recommended investor-safe pricing posture:

- Do not pitch "$29 unlimited" without a usage-control story.
- Pitch "$29 with a generous included minute allowance" or "$29 starting price."
- Use 60 minutes/week as the base consumer assumption.
- Treat 130 minutes/week as a heavy-user or premium-plan assumption.

Example:

| Plan framing | Included usage | ElevenLabs base margin | Future lower-TTS margin |
|---|---:|---:|---:|
| $29 starter | ~60 min/week | ~61% | ~68% |
| $49 companion | ~130 min/week | ~49% | ~59% |
| B2B / care org | negotiated | depends on usage | target 60%+ |

---

## Monitoring Metrics

Track these daily from `call_metrics`, `conversations`, vendor dashboards, and notification logs:

- completed call minutes
- assistant TTS character count per call
- Claude prompt/cache/output tokens per call
- Deepgram billed stream minutes
- Telnyx billed voice minutes
- Telnyx billed media streaming minutes
- post-call analysis success/failure rate
- OpenAI/Tavily search calls per senior/day
- COGS per completed call
- COGS per active senior per month

The key operating metric for investors should be:

> Gross margin at actual minutes used per active senior.

Average users hide the risk. Heavy seniors can be the best-retained users and the most expensive users at the same time.

---

## Source Links

- [Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api)
- [Telnyx SIP Trunking pricing](https://telnyx.com/pricing/elastic-sip)
- [Deepgram pricing](https://deepgram.com/pricing)
- [ElevenLabs API pricing](https://elevenlabs.io/pricing/api)
- [Cartesia pricing](https://cartesia.ai/pricing)
- [Anthropic Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [Groq pricing](https://groq.com/pricing)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [OpenAI API pricing](https://developers.openai.com/api/docs/pricing)
- [Tavily credits and pricing](https://docs.tavily.com/documentation/api-credits)
- [Railway pricing](https://railway.com/pricing)
- [Neon pricing](https://neon.com/pricing)
- [Resend pricing](https://resend.com/pricing)
