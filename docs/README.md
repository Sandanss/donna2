# Donna Documentation Index

> Start with [`../DIRECTORY.md`](../DIRECTORY.md) before editing code. It is the active navigation map for current vs. legacy surfaces.

## Source Of Truth

| Area | Current document |
|---|---|
| Codebase map and edit paths | [`../DIRECTORY.md`](../DIRECTORY.md) |
| System architecture | [`architecture/OVERVIEW.md`](architecture/OVERVIEW.md), [`architecture/ARCHITECTURE.md`](architecture/ARCHITECTURE.md) |
| Scalability status and roadmap | [`architecture/SCALABILITY.md`](architecture/SCALABILITY.md), [`plans/2026-05-18-scale-to-2000-users-technical-plan.md`](plans/2026-05-18-scale-to-2000-users-technical-plan.md) |
| Pipecat voice pipeline | [`../pipecat/docs/ARCHITECTURE.md`](../pipecat/docs/ARCHITECTURE.md), [`../pipecat/docs/LEARNINGS.md`](../pipecat/docs/LEARNINGS.md) |
| Security architecture | [`architecture/SECURITY.md`](architecture/SECURITY.md) |
| Testing architecture | [`architecture/TESTING.md`](architecture/TESTING.md) |
| HIPAA/compliance | [`compliance/HIPAA_OVERVIEW.md`](compliance/HIPAA_OVERVIEW.md), [`compliance/BAA_TRACKER.md`](compliance/BAA_TRACKER.md), [`compliance/DATA_RETENTION_POLICY.md`](compliance/DATA_RETENTION_POLICY.md) |
| Frontend E2E | [`guides/FRONTEND_TESTING.md`](guides/FRONTEND_TESTING.md) |
| Feature backlog | [`FEATURE_BACKLOG.md`](FEATURE_BACKLOG.md) |
| Current audit findings | [`audits/2026-05-05-codebase-audit.md`](audits/2026-05-05-codebase-audit.md) |
| Current remediation plan | [`plans/2026-05-05-engineering-remediation-plan.md`](plans/2026-05-05-engineering-remediation-plan.md) |
| Prototype pilot backlog | [`plans/PROTOTYPE_PILOT_BACKLOG.md`](plans/PROTOTYPE_PILOT_BACKLOG.md) |
| Historical plans | [`plans/README.md`](plans/README.md) |
| Developer onboarding | [`ONBOARDING.md`](ONBOARDING.md) |

## Status Notes

- Active voice is Telnyx + Pipecat. Twilio voice and SMS references in dated plans are historical unless a current architecture document explicitly marks them active.
- Frontends call the repo-root Node API. They do not call Pipecat directly.
- The Node backend owns frontend APIs, manual call initiation, and the active scheduler.
- Pipecat owns real-time voice, Telnyx webhooks/WebSocket handling, the call pipeline, and post-call processing.
- On `zuludev`, Donna has two outbound-call architectures by design: the legacy in-process Node scheduler/dialer and the new queue/capacity dispatcher. The queue architecture is the path to the 2,000-user burst target; it is not fully cut over until `CALL_ARCHITECTURE_MODE=queue_primary` with real queue dialing enabled and rollout evidence saved.
- The path to 10,000 users is documented as forward work, not completed runtime. It builds on the 2,000-user queue architecture and adds triggers for operational table partitioning or an `ops.*` store, Redis Cluster or multi-region shared state, caller-ID pool/reputation management, provider sharding/failover, workflow-engine post-call execution, and larger archive/retention strategy.
- Do not claim audit, retention, logging, deletion, or compliance gaps are fixed until runtime code and validation prove it.
- Dated files under `docs/plans/archive/` are retained for context and may describe superseded architecture.

## Documentation Rules

- Prefer runtime code and `DIRECTORY.md` when docs disagree.
- Keep current docs free of raw PHI, real phone numbers, transcripts, medical notes, caregiver notes, and production secrets.
- Put future work in `docs/plans/`; keep `docs/README.md` as an index.
- Mark historical or superseded references explicitly instead of silently deleting useful context.
