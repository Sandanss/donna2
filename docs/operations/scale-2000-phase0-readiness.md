# 2,000-User Phase 0 Readiness

This is the execution checklist for Phase 0 of `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`.

Phase 0 is a measurement and decision gate. It does not approve live queue dialing or horizontal scale by itself.

## Commands

Collect PHI-free aggregate production baselines:

```bash
npm run phase0:baseline -- --days=30 --out=tmp/phase0-baseline.json
```

Generate the cost projection after filling current vendor unit costs:

```bash
cp docs/operations/templates/phase0-cost-assumptions.example.json tmp/phase0-cost-assumptions.json
npm run phase0:cost -- --baseline=tmp/phase0-baseline.json --assumptions=tmp/phase0-cost-assumptions.json --out=tmp/phase0-cost-model.json
```

Donna's current planning assumptions are also captured in `docs/operations/templates/phase0-cost-assumptions.business-plan-current.json`, derived from the Unit Economics section of `docs/BUSINESS_PLAN.md`:

```bash
npm run phase0:cost -- --baseline=tmp/phase0-baseline.json --assumptions=docs/operations/templates/phase0-cost-assumptions.business-plan-current.json --out=tmp/phase0-cost-model.json
```

Run the CI-safe sentinel scan against local logs and generated artifacts:

```bash
npm run phi:sentinel
```

Run staging live drills:

```bash
npm run phase0:redis-drill -- --simulate-outage
npm run phase0:live-call-drill -- --senior-id=<staging-senior-uuid> --prewarm-only
npm run phase0:live-call-drill -- --senior-id=<staging-senior-uuid> --confirm-live-call
npm run phase6:post-call-worker-once -- --confirm-db-writes --limit=100
npm run phase6:post-call-stampede -- --completions=600 --db-pool-idle-ratio=<observed-staging-idle-ratio>
```

See `docs/operations/scale-2000-live-drills.md` for the Railway-wrapped staging commands and log review checklist.
Current staging uses the same Neon `DATABASE_URL` as production, so any staging drill that writes queue/job/call rows must be limited to dummy or explicitly consenting test seniors.
For scaled-mode readiness, the Redis drill must report `shared=true` and `available=true` for the actual staging backend before the intentional outage simulation.

## PHI Boundary

The Phase 0 baseline collector selects only aggregate counts and percentiles. It must not select or print senior names, phone numbers, transcripts, reminder titles, reminder descriptions, caregiver notes, profile notes, raw prompts, or raw search queries.

The sentinel scanner intentionally does not print matched lines. Findings report file path, sentinel label, and count only.

## Required Baselines

| Metric | Source | Artifact Field |
| --- | --- | --- |
| p50 / p95 connected call duration | `conversations.duration_seconds` | `connected_call_duration_seconds` |
| Answer rate by morning / afternoon / evening | `conversations` joined to senior timezone | `outbound_answer_rate_by_local_window` |
| Peak active calls observed | event sweep over `conversations.started_at/ended_at` | `estimated_peak_active_calls` |
| Active senior count | `seniors.is_active` | `active_senior_counts` |
| Prompt-cache / token metric coverage | `conversations.call_metrics` coverage counts | `conversation_call_metrics_coverage` |
| Queue depth placeholder | `call_queue`, if Phase 1 tables exist | `call_queue_depth_placeholder` |
| Post-call backlog placeholder | `post_call_jobs`, if Phase 1 tables exist | `post_call_backlog_placeholder` |

## Manual Measurements Still Required

These are not persisted in Donna's database today and must be pulled from Railway, Neon, or vendor dashboards until runtime metric emission exists:

- Scheduler cycle p50 / p95.
- Peak DB pool utilization per service.
- Peak Anthropic input TPM and output TPM.
- Peak Deepgram concurrent streams.
- Peak ElevenLabs concurrent TTS.
- Peak OpenAI embeddings RPM.
- Telnyx outbound and inbound concurrent channels.
- Pipecat per-replica CPU and memory at peak.
- Anthropic prompt-cache hit rate if not present in `conversations.call_metrics`.

## Phase 0 Decision Log

Record decisions before Phase 1 is considered unblocked:

| Decision | Owner | Result | Evidence |
| --- | --- | --- | --- |
| Launch capacity target: 600 vs. 900 active calls | TBD | TBD | Baseline + vendor caps |
| Initial lane reserve percentages | TBD | TBD | Window traffic measurement |
| Node dispatcher location | TBD | TBD | Railway topology decision |
| Redis vendor | TBD | TBD | Failure-mode drill requirements |
| TTS vendor at scale | TBD | TBD | BAA + latency + cost |
| Outbound caller-ID strategy | TBD | TBD | Telnyx conversation |
| Queue/job/guard/shadow retention windows | TBD | TBD | Compliance review |
| Post-call worker location | TBD | TBD | DB pool and deploy topology |

## Incident Runbook Skeleton

Each scenario needs detection signal, immediate response, rollback criteria, and escalation owner before Phase 7:

| Scenario | Detection | Immediate Response | Rollback Criteria | Owner |
| --- | --- | --- | --- | --- |
| DB pool exhausted at T-2 min | DB pool idle < 10%, queue leasing errors | Pause dispatcher, reduce batch size, scale DB/pool | Pool idle < 5% sustained | TBD |
| Redis unavailable in scaled mode | Health/readiness red, reservation errors | Stop dispatcher, keep Pipecat fail-closed | Any accepted call without Redis in scaled mode | TBD |
| Dispatcher stuck | Queue depth growing, no new leases | Restart worker, inspect advisory locks, disable queue flags | Hard-reminder lag > 5 min | TBD |
| Pipecat replica down at T-5 min | Missing heartbeat, readiness red | Drain missing instance, scale replacement | Available capacity below window demand | TBD |
| Telnyx outbound failure storm | Provider error spike | Stop live dispatcher, preserve queue rows | Treatment setup success drops > 2 pts | TBD |
| Vendor rate-limit storm | Provider 429/concurrency errors | Lower concurrency caps, pause non-critical work | User-facing call setup impacted | TBD |
| PHI sentinel hit | Sentinel CI/prod scan finding | Stop deploy, quarantine artifact/log, privacy review | Any production PHI in logs/artifacts | TBD |
| Duplicate-call detected | Guard/reconciler violation | Disable queue dialing, reconcile affected seniors | Any duplicate guard key dialed | TBD |
| Replica readiness stuck red | Readiness > 90s red | Keep instance out of capacity, inspect warm-up checks | Capacity shortfall before window | TBD |

## Live Drill Notes

- BAA completion is not required to run staging drills when founders explicitly accept that scope, but BAA status remains a production/commercial rollout gate.
- Live outbound call drills require a dummy or explicitly consenting test phone. Do not call an arbitrary active staging senior just because the record has a callable phone number.
- Drill artifacts and logs must not include senior names, phone numbers, transcripts, reminder text, caregiver notes, profile notes, prompt context, or `ws_token` values.

## Database Partitioning Note

Do not shard by last name. Phase 0 should identify hot tables with measurements first. If indexes, pooling, and queue leasing are insufficient, the next design is Postgres-native partitioning by `senior_id` hash or by time window depending on the table's access pattern. Multi-database sharding stays out of scope for the 2,000-user milestone.
