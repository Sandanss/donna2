# Donna 100,000 User Scaling Roadmap

Date: May 24, 2026
Status: Directional roadmap — not a committed plan
Companion to: [`2026-05-18-scale-to-2000-users-technical-plan.md`](2026-05-18-scale-to-2000-users-technical-plan.md)
Primary surfaces (future): `services/call-queue.js` partitioning, Postgres topology, `pipecat/main.py` regional deploy, provider router, post-call worker pool

## Status of this document

This is a **roadmap, not a plan**. It describes the architectural moves that become necessary somewhere between 10k and 100k daily users, the rough order they become load-bearing, and the design decisions worth making *now* (during the 2k buildout) so we don't paint ourselves into a corner. None of this is committed work. The point is to make the 2k → 10k → 100k path evolutionary, not a rewrite.

The scale-to-2000 plan is the authoritative document for everything happening this quarter. Where this roadmap says "today" it means the state after the 2k plan ships. Current `zuludev` code still uses flat default-schema queue/job tables; `ops.*`, hash partitioning, region columns, and cross-DB splits below are future targets unless a later migration lands.

---

## 1. What 100k actually means

### 1.1 Load math

Assumptions: most users opt into one scheduled call/day, peak demand clusters in a 2-hour morning window per timezone, average call length is 5 minutes.

| Metric | 2k users (today's target) | 100k users (this roadmap) | Multiplier |
| --- | --- | --- | --- |
| Daily outbound calls | ~2,000 | ~100,000 | 50× |
| Peak dispatches / sec (US-wide, busiest 15 min) | ~5 | ~200–300 | 50× |
| Peak concurrent calls | ~600 | ~1,500–2,000 | 3× |
| Post-call jobs / day | ~10k (5 per call) | ~500k | 50× |
| pgvector embeddings | ~100k (~50/user) | ~5M+ | 50× |
| Audit log rows / day | ~50k | ~2.5M | 50× |
| Telnyx outbound minutes / day | ~10k | ~500k | 50× |
| Anthropic input tokens / day | ~150M | ~7.5B | 50× |

Peak *concurrent* calls grows only 3× because timezones spread the load — the morning peak in ET doesn't overlap with the morning peak in PT. Dispatch rate, post-call work, and storage all grow ~50×.

### 1.2 What stays the same

Most of the per-call architecture *doesn't* change. Each Pipecat instance is already stateless and per-user; the voice pipeline scales by adding replicas, which we already do. The 2k plan's queue + dial-authority guard + capacity heartbeats are the right primitives. We're not rewriting the call path.

### 1.3 What changes

Five things become load-bearing at 100k that aren't load-bearing at 2k:

1. **Queue contention** — `FOR UPDATE SKIP LOCKED` on one queue table is fine at 5 dispatches/sec, becomes painful at 200+.
2. **One Postgres for everything** — Neon serves us well today; at 100k, hot tables (conversations, memories, audit) compete with the dispatcher for IOPS and connections.
3. **Single-region deploy** — at 2k we tolerate ~50ms cross-country latency; at 100k regional Pipecat is a real latency and isolation win.
4. **Provider fragility** — any single provider (Telnyx, Anthropic, Deepgram, ElevenLabs) having a 30-minute degraded window costs us real money and trust.
5. **Cost per call** — at 2k, cost discipline is a margin nice-to-have; at 100k, every $0.05/call is $150k/year.

The rest of this document expands each of those, with the DB migration covered in depth in §3.

---

## 2. Non-engineering gates (these are the real bottlenecks)

It's tempting to scope this as a pure-engineering problem. It isn't. In rough order of "most likely to actually block us":

### 2.1 Provider contracts

- **Telnyx.** Default concurrent call limit is single-account-tier. At 1.5–2k concurrent we need an enterprise contract with raised limits, dedicated SIP trunks, and ideally multi-region presence. Caller-ID reputation also matters more at 100k — the answer-rate canary work in the 2k plan becomes a 24/7 monitoring obligation.
- **Anthropic.** Claude Haiku TPM/RPM at 100k is enterprise-tier. Need a custom rate limit (or Bedrock/Vertex as a second supply source), and a real conversation about prompt caching guarantees at scale.
- **Deepgram.** Concurrent stream limits — enterprise tier handles thousands, but it's a separate contract from the per-minute pricing.
- **ElevenLabs / Cartesia.** Per-stream concurrency and per-account character quotas. ElevenLabs enterprise is the gate.
- **Neon.** Single-cluster compute will hit a ceiling. Neon's enterprise tier supports larger compute and read replicas; whether it can handle our write rate at 100k is a real question worth pricing now (see §3).

**Concrete action well before 10k:** have each provider's enterprise account manager named and reachable. Have a written commitment on concurrency ceiling and what overage looks like. Renegotiate every ~6 months as we approach each provider's stated limit.

### 2.2 HIPAA and compliance at scale

- BAAs with every provider in the call path (already in progress for 2k) need to stay current and be re-reviewed annually.
- Breach response gets harder when "a breach" might mean 100k notifications. Pre-built notification infrastructure, legal templates, and a documented decision tree before the first incident.
- Audit log volume grows 50×. Today's pattern of "audit table in main Postgres" doesn't survive — see §3.
- Data retention deletes become a real engineering load. Today's daily retention scan is fine; at 100k it becomes a queued worker pool.

### 2.3 Operations and on-call

- A single founder-on-call doesn't survive 100k daily calls. Real on-call rotation, with documented runbooks for every degradation mode in the 2k plan, plus the ones this roadmap adds.
- Incident response practiced, not theoretical. Quarterly game days simulating provider outage, DB failover, post-call worker stall.
- Customer support scales sublinearly with users — but only with self-service tooling for caregivers. Mobile app + admin tooling needs to absorb 95% of "why didn't Mom get her call today" without paging a human.

### 2.4 Cost margins

At $19/mo, per-user revenue is $228/year. Per-call cost today (rough): Telnyx + Deepgram + Anthropic + Groq + ElevenLabs + post-call models ≈ $0.30–0.80 per 5-min call. With one call/day that's $110–290/year in provider costs alone, before infra. Cost engineering (§7) is not optional past ~10k users.

---

## 3. Database evolution: the long-term migration

This is the section the rest of the roadmap hinges on. The DB is the hardest thing to change later, and choices we make at 2k constrain what's cheap at 100k.

### 3.1 Today (current branch and post-2k baseline)

- **One Neon Postgres cluster**, branched for dev/staging/prod.
- Current runtime migrations create flat default-schema operational tables: `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`, `scheduler_shadow_comparisons`, and Node-owned `canary_cohort_membership`.
- The `ops.*` schema and hash partitions are forward targets from the 2k plan, not current branch implementation.
- Connection pooling via PgBouncer / Neon's pooler.
- pgvector for memory embeddings, in-DB.

This is fine for 2k. It will start to feel constrained somewhere between 10k–25k, depending on access patterns.

### 3.2 The principle: split by access pattern before sharding by tenant

Sharding by `senior_id` is intuitive (each user is independent), but it's also the most invasive change to make. Before going there, split tables by **how they're accessed**:

| Access pattern | Examples | Move to |
| --- | --- | --- |
| **Hot transactional, user-scoped** | `seniors`, `caregivers`, `reminders`, `daily_call_context` | Stay in primary Postgres |
| **Hot transactional, ops-scoped** | current flat `call_queue`, `call_attempts`, `post_call_jobs`, `outbound_call_guards`; future `ops.*` equivalents | Dedicated **ops** Postgres (own cluster) |
| **Append-only, high volume** | `conversations` (turn transcripts), `call_analyses`, audit logs | Dedicated **journal** store — Postgres logical replica, ClickHouse, or BigQuery |
| **Vector search** | `memories` pgvector embeddings | Dedicated vector DB (Pinecone, Weaviate, or pgvector on its own cluster) at ~1M+ vectors |
| **Long-cold archive** | Conversations >90 days, retired senior data | Object storage (S3) with metadata pointers |

The win of access-pattern splits: each store can be sized, replicated, and scaled independently. The dispatcher's queue contention doesn't fight with caregiver dashboard reads. Audit log writes don't compete with reminder scheduler writes. Vector search latency doesn't blow up when post-call workers backfill embeddings in bulk.

The cost: cross-store consistency. We need application-level logic (or a workflow engine) to handle "if the call_attempt write succeeds but the conversation journal write fails, what happens?" — answered by idempotent post-call jobs and a deterministic retry/reconciliation pattern, which the 2k plan already establishes.

### 3.3 The four phases of DB evolution

**Phase A (today through ~5k users): tune the single cluster.**

- Stay on one Neon Postgres.
- Verify the repository/module boundary works as the seam — today that is unqualified queue tables in `services/call-queue.js`; if `ops.*` lands, all dispatcher queries should move there without scattering SQL across services.
- Read replicas for analytics queries (admin dashboards, daily reports).
- Aggressive `VACUUM` and index maintenance on `call_queue` and `call_attempts`; partition maintenance begins only after partitioned tables land.
- pgvector stays in-DB; index type stays `hnsw`.

**Acceptance for leaving Phase A:** p95 query latency on the dispatcher's dequeue stays under 50ms at peak. If it doesn't, Phase B is overdue.

**Phase B (~5k–25k users): split out the operational store.**

- Move operational queue/job/attempt/guard tables to a dedicated Postgres cluster ("donna-ops"). If `ops.*` has not already landed, this requires an online migration from the current flat tables.
- Cross-DB foreign keys disappear — the operational `call_queue.senior_id` is just a UUID, not an enforced FK. Application logic (dispatcher service) is the boundary.
- Audit logs move to the journal store (Postgres logical replica first, ClickHouse later if cardinality warrants it).
- Read replica for admin/caregiver-facing reads to take pressure off primary.

**Why now:** the dispatcher is the workload with the spikiest write pattern. Isolating it means a queue backlog can't cause a caregiver dashboard slowdown, and vice versa. The journal store split is driven by audit log volume specifically — at 5k users we're already writing 100k+ audit rows/day, and that workload is fundamentally different from the OLTP workload of the main DB.

**Acceptance for leaving Phase B:** dispatcher writes don't show up in main DB pg_stat. Audit log writes go through a queue, not synchronous inserts in the request path (already true post-2k plan, but verify).

**Phase C (~25k–60k users): vector store split + journal store split.**

- pgvector workload moves out — either to a dedicated Postgres-with-pgvector cluster (cheapest path, keeps SQL ergonomics), or to a managed vector DB (Pinecone, Turbopuffer). At ~5M embeddings, in-DB pgvector is doable but starts to dominate IOPS during memory-search-heavy peaks.
- Journal store becomes its own real store. Conversations >24h old move to ClickHouse / BigQuery / S3+Parquet. The main DB keeps a thin pointer + "last summary" cache.
- Embedding generation moves fully async — the call path doesn't wait, post-call jobs write to the vector store via a queue.

**Why now:** the memory subsystem is Donna's most distinctive feature, and the slow-down mode at scale is "memory search is competing with the call dispatcher for connections." Splitting them removes that contention permanently.

**Acceptance for leaving Phase C:** vector search p95 stays under 100ms at peak. Journal store can absorb a 10× write spike (a bad-news event triggering many summaries) without backpressure on calls.

**Phase D (60k+ users): consider tenant sharding.**

This is the "shard by senior_id across multiple primary clusters" step. **Do not do this earlier than necessary** — it's the most invasive change, breaks all cross-tenant queries (admin analytics, cohort reports), and adds an operational burden every team that's tried it has underestimated.

Likely shape if/when needed:
- 4–8 primary shards, each holding a hash range of `senior_id`.
- Per-shard read replicas.
- A thin routing layer in the application (a "senior_id → shard" lookup, with consistent hashing or a directory service).
- Cross-shard reads (admin tooling, daily reports) go through a separate analytics pipeline reading from journal/warehouse, not by fanning out to all shards.

**Better alternative if access patterns allow:** vertical scale-up of the primary, plus read replicas, plus aggressive journaling, can probably take us to 100k without sharding. Neon's largest compute is *large*. Sharding is a "we've measured the ceiling and it's lower than our trajectory" decision, not a "we're growing fast" decision.

### 3.4 Decisions worth making now (during 2k buildout)

These cost almost nothing now and pay off enormously:

- **Application queries hit operational queue tables through a single repository/module boundary**, not scattered across services. If/when `ops.*` or a separate ops DB lands, only that boundary changes. (`services/call-queue.js` is already shaping up this way.)
- **No new FKs should cross the future `public.* / ops.*` boundary.** Current migrations still use default-schema FKs, so removing cross-boundary FKs is future online migration work.
- **Every senior-scoped write includes `senior_id` in the row**, even when redundant. Sharding later requires this; backfilling it is painful.
- **Audit logs are insert-only and never queried in the hot path.** Already true. Keep it that way — no triggers that read audit on write.
- **Memory embeddings are queried by `senior_id + similarity`, never global similarity.** Already true. This makes per-tenant sharding of the vector store trivial later.
- **Region column on every operationally relevant table.** This is not current runtime schema. Add it to `call_attempts`, `call_queue`, `post_call_jobs`, and future cross-cluster-replicated tables when multi-region routing becomes real. Default `'us-east-1'` is fine for the first migration.
- **Don't add cross-table joins that the dispatcher needs.** The dispatcher should be able to operate with only `ops.*` knowledge. Today it joins to `seniors` for some queries — that's a future migration cost worth paying down opportunistically.

### 3.5 What we're explicitly *not* deciding now

- Which vector DB (Pinecone vs Weaviate vs self-hosted pgvector). Decide when we have real workload data at ~1M embeddings.
- Whether to shard at all (Phase D) or scale up. Decide based on measured ceiling, not anticipation.
- Whether the journal store is ClickHouse, BigQuery, or something else. The choice depends on what analytics workloads emerge, which we don't know yet.

---

## 4. Queue partitioning

### 4.1 Today

Current `call_queue` is a flat default-schema table. The dispatcher leases with `FOR UPDATE SKIP LOCKED` and uses status/lane/time indexes. At ~5 dispatches/sec this is fine for the 2k target, but `ops.call_queue PARTITION BY HASH (senior_id)` remains a future migration target.

### 4.2 At 100k

200+ dispatches/sec on a single logical queue starts to cause lock contention even with `SKIP LOCKED`. Two paths:

**Path 1: Worker-affinity to hash partitions.** First add hash partitions, then have each dispatcher worker lease only from N partitions (e.g., partition `i` if `worker_id % N == i % N`). No worker ever contends with another for the same partition. This is an online schema+dispatcher migration, not an already available switch.

**Path 2: Move to a broker.** Vercel Queues, Kafka, or Redis Streams with consumer groups. The broker handles fan-out; Postgres becomes the durable record of truth but not the lease point.

**Recommendation:** Path 1 first. It's a `services/call-queue.js` change, no new infra. Path 2 only if Path 1 hits a ceiling, or if regional deploy (§5) needs cross-region queue semantics that Postgres doesn't give us.

### 4.3 Acceptance

Dispatcher p95 lease latency stays under 100ms at 300 dispatches/sec sustained for 15 minutes. Measured in load test, not anticipated.

---

## 5. Multi-region deployment

### 5.1 Today

Single region (us-east-1 on Railway). Most US users are within 100ms; west coast users see 70–80ms latency on the voice path, which is tolerable but noticeable.

### 5.2 At 100k

Two motivations to go multi-region:

- **Latency.** A west coast senior on a us-east call adds ~80ms each way to STT/TTS round trips. At 100k we have many west coast users and the cumulative friction is real.
- **Isolation.** If us-east has a Railway / AWS / network issue, single-region means total outage. Multi-region with regional dispatchers means a region failure degrades capacity, not service.

### 5.3 Shape

- **Pipecat replicas in us-east-1 and us-west-2.** Each region runs its own pool. Dispatcher routes calls to the region matching the senior's timezone (ET/CT → east, PT/MT → west, with overflow rules).
- **Telnyx supports multi-region SIP trunks**, so the media path is regional.
- **Database stays single-region.** Cross-region writes are a different beast and not necessary at 100k — DB latency is well-tolerated at the dispatch layer where it lives. The actual call path doesn't hit the main DB synchronously past the initial context fetch (already cached).
- **Capacity heartbeats are regional.** Redis (Upstash) already supports multi-region; we just add a `region` dimension to heartbeat keys.

### 5.4 What this doesn't fix

Multi-region Pipecat doesn't help with provider outages. If Anthropic is degraded, both regions degrade. Provider redundancy (§6) is the fix for that.

---

## 6. Provider abstraction and fallback

### 6.1 Today

Each provider is wired directly: Anthropic for Claude, Deepgram for STT, ElevenLabs (or Cartesia per env) for TTS, Groq for Director. No automatic fallback — if Anthropic 429s, the call degrades.

### 6.2 At 100k

Any single provider having a 30-minute degraded window during peak hours impacts thousands of users. Real fallback is a hard requirement.

### 6.3 Shape

Three layers, easy to hard:

- **Layer 1: Provider router.** A thin per-provider class with health tracking and circuit-breaker behavior. Already partly in place (`pipecat/lib/circuit_breaker.py`). Promote to a first-class router that owns provider selection per call.
- **Layer 2: Real fallback providers.** Claude Haiku → Claude Sonnet → OpenAI gpt-5 mini (via AI Gateway). Deepgram → AssemblyAI. ElevenLabs → Cartesia. Telnyx → Twilio. Each fallback maintained in a "warm" state — used for ~1% of traffic continuously so we know it works.
- **Layer 3: AI Gateway adoption (or build).** Vercel AI Gateway gives us provider-agnostic LLM routing with built-in observability and zero data retention. Cheaper to adopt than build, but the build-vs-buy question gets serious at 100k token volume.

### 6.4 What this doesn't fix

Telnyx is the hardest to redundancy-plan because phone numbers and caller-ID reputation are tied to a specific carrier. A second carrier for fallback adds compliance burden (a second BAA) and reputation rebuilding (caller-ID warmth doesn't transfer). Worth scoping as its own project before crossing ~20k users.

---

## 7. Cost engineering

### 7.1 Per-call cost components (rough, today)

| Component | Per 5-min call | Notes |
| --- | --- | --- |
| Telnyx outbound (5 min @ ~$0.013/min) | ~$0.07 | Enterprise rate lower |
| Deepgram (5 min @ ~$0.0043/min) | ~$0.02 | |
| Anthropic Claude Haiku (input + output) | ~$0.10–0.20 | Prompt caching reduces this materially |
| Groq Director (input + output) | ~$0.01–0.03 | |
| ElevenLabs (TTS, ~600 chars/min × 5) | ~$0.05–0.15 | Cartesia is cheaper |
| Post-call (Gemini analysis + OpenAI memory) | ~$0.03–0.08 | |
| **Total per call** | **~$0.30–0.55** | |

At one call/day per user, that's $110–200/user/year vs. $228 revenue. Margins exist but are not generous.

### 7.2 Levers, in order of impact

- **Prompt caching discipline.** Already in place; verify it stays effective as prompts evolve. Caching breakage (e.g., the recent onboarding-prompt-under-1024-tokens bug) is silent and expensive.
- **Model routing.** Easy turns (small talk, acknowledgments) routed to a cheaper model (Haiku); complex turns (memory recall, multi-step requests) routed to Sonnet. The Director is well-placed to make this call.
- **TTS provider choice.** Cartesia is ~50% cheaper than ElevenLabs for comparable quality. The current env-var switch lets us A/B; at 100k it likely defaults to Cartesia.
- **Call length caps.** Soft caps on call duration (currently ~5 min) save 20–40% on long calls without hurting UX. Tune based on user satisfaction data.
- **Batched post-call work.** Memory extraction across calls in a batch is cheaper than one-at-a-time. Already partially batched; can go further.
- **Self-hosted Whisper for STT.** If Deepgram pricing becomes the bottleneck. Adds operational burden; only worth it past ~50k users.

### 7.3 Target

Per-call cost under $0.40 by 25k users. Under $0.30 by 100k. Anything above $0.40 means margin work has fallen behind.

---

## 8. Observability and incident response

### 8.1 What changes at 100k

You cannot debug an individual call. Telemetry has to be aggregate-first, with the ability to drill into a specific call when paged.

- **Sampled tracing.** 100% of calls today; 1–5% at 100k. Always-on for failed/short calls and a sampled subset of long calls.
- **Anomaly detection.** "Calls in cohort X are 20% longer than baseline" alerts. "Memory recall failure rate up 3x in last 15 min." Vercel Agent for the API + custom alerting for the voice pipeline.
- **Per-region, per-provider, per-cohort dashboards.** Today one Grafana view is enough; at 100k it has to slice many ways.

### 8.2 Runbook discipline

Every degradation mode this roadmap introduces gets a runbook *before* it ships, not after the first incident. The 2k plan's runbooks are the template — terse, numbered, with specific commands.

---

## 9. Rough sequencing

This is the order things become load-bearing, not a committed schedule. Each step gates on real metrics from the previous, not calendar time.

| Phase | User count | Engineering moves | DB moves |
| --- | --- | --- | --- |
| Today | 0–2k | 2k plan executes | Single Neon |
| Near (post-2k) | 2k–5k | Provider router (Layer 1) | Read replicas |
| Mid | 5k–25k | Add/activate worker-affinity queue partitions; provider fallback (Layer 2) | Phase B: split operational tables into `ops.*`/ops DB |
| Mid-late | 25k–60k | Multi-region Pipecat; AI Gateway adoption | Phase C: vector + journal split |
| Late | 60k–100k | Per-region capacity orchestration; advanced cost routing | Phase D: tenant sharding (only if measured ceiling demands it) |

The honest summary: **the next 6 months are the 2k plan, and we don't need most of this roadmap until ~5k.** What we need *now* is to keep the decisions in §3.4 and §1.3 visible during the 2k execution so we don't accidentally lock in a 100k regret.

---

## 10. Open questions

These are decisions worth having a written answer to within the next 6 months:

1. **Which provider relationship breaks first under growth?** Most likely Telnyx (concurrency + caller-ID reputation) or Anthropic (TPM). Map both to specific contract milestones.
2. **What does our pgvector workload look like at 1M embeddings?** Run a load test now (on a Neon branch) to find out before we have 1M for real.
3. **Are we Postgres-first or workflow-engine-first for post-call work?** The 2k plan recommends a workflow engine (Temporal/Inngest) and keeps the Postgres worker as Plan B. Make the call before ~10k users — switching costs go up fast after.
4. **Multi-region database story.** Do we ever need it? Probably not for 100k. Document the threshold at which we'd reconsider.
5. **Caregiver dashboard scaling.** Today's admin UI is fine for hundreds of caregivers. At 100k seniors, caregivers likely number 50k+. The admin UI becomes its own scaling problem worth scoping separately.

---

*This document should be revisited annually, or whenever a real growth milestone (10k, 25k, 50k) is hit. It's a directional guide, not a commitment.*
