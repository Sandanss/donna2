# Phase 7 - Small Live Canary Runbook

This runbook covers the operational execution of Phase 7 of `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`. Phase 7 is the first time the queue path dials real customers. Treat every step as production-affecting.

Hard prerequisite gate (verify before ramping):

- [ ] Phase 3 exit criteria met: replica readiness gate live and two-replica race tests green.
- [ ] Phase 4 exit criteria met: dispatcher dry-run/live checks and guard reconciler verified.
- [ ] Phase 6 exit criteria met: post-call queue, stampede harness, and dead-letter replay verified.
- [ ] Vendor PHI/compliance requirements cleared for this rollout step, or explicitly paused by current legal/compliance direction.
- [ ] Incident runbook v1 published.
- [ ] Phase 5 rollback drill executed and timed.
- [ ] Caller-ID answer-rate canary passed at >=80% of baseline.
- [ ] Cost projection approved.

If any gate is open, do not start Phase 7.

---

## Cohort Membership

Phase 7 ramps 5 -> 10 -> 25 seniors. Membership lives in `canary_cohort_membership` (migration 013). The dispatcher merges `canary_cohort_membership` with the legacy `CALL_QUEUE_COHORT_ALLOWLIST` env var (DB union env) every scheduler tick. The DB is the steady-state source of truth, while the env var stays as an emergency override path. To onboard the first senior without redeploy, set `CALL_QUEUE_COHORT_ALLOWLIST` to a single test UUID once so `validateCallArchitectureConfig` passes, then use the admin endpoints below to manage the real cohort.

### Add Seniors To Canary

```bash
curl -X POST https://donna-api-production-2450.up.railway.app/api/canary/members \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{
    "senior_ids": ["uuid-1", "uuid-2", "uuid-3", "uuid-4", "uuid-5"],
    "ramp_phase": "5",
    "notes": "ramp start"
  }'
```

The response is `{ added: [...], errors: [...] }`. Validate every senior is in `added`; investigate any `errors` such as invalid UUID or already-in-canary.

### List Current Canary Cohort

```bash
curl https://donna-api-production-2450.up.railway.app/api/canary/members \
  -H 'Authorization: Bearer <admin-jwt>'
```

Response: `{ members: [{ senior_id, ramp_phase, added_at, added_by, notes }] }`. No PHI is returned.

### Remove A Senior From Canary

```bash
curl -X DELETE https://donna-api-production-2450.up.railway.app/api/canary/members/<senior-uuid> \
  -H 'Authorization: Bearer <admin-jwt>' \
  -H 'Content-Type: application/json' \
  -d '{"reason": "phase_complete"}'
```

Allowed reasons: `phase_complete`, `ramp_back`, `rollback_legacy_only`, `manual_admin`, `senior_inactive`, `caregiver_paused`. Other values are rejected so the audit row stays PHI-free.

---

## Daily Review

Run once per 24 hours during canary. Operator and on-call both review.

```bash
npm run phase7:canary-daily-report -- --window-hours=24 --out=tmp/phase7-day1.json
```

The script:

- Reads active canary membership from `canary_cohort_membership`.
- Splits the last 24 h of `call_attempts` and `post_call_jobs` into `treatment` (canary) and `control` (everyone else).
- Computes the SLO row set the runtime can observe directly:
  - setup latency p95 per cohort
  - setup success rate per cohort vs floor 0.95
  - duplicate outbound rows per cohort, target 0
  - post-call critical-job completion rate vs floor 0.95
  - post-call critical-job p95 seconds (informational in the current script; only completion rate drives pass/fail)
- Prints a PHI-free JSON report with a `breaches` list.

Output is aggregate counts and percentiles only. No senior names, phone numbers, transcripts, reminder text, caregiver notes, raw senior IDs, or guard keys appear. Senior IDs can be included as truncated SHA-256 hashes with `--include-senior-id-hashes`.

Exit codes:

- `0`: clean, no breaches.
- `1`: SLO breaches present. Review `breaches`; decide whether to continue, ramp back, or rollback.
- `2`: script failure such as DB unreachable. Re-run; if persistent, page on-call.

### Cron-Friendly Alert Wrapper

For Slack/PagerDuty integration, prefer the compact rollback-check wrapper. It runs the same daily report internally but prints a brief alert plus the exact manual rollback command when breaches exist, and exits 1 so cron alerts on exit code without parsing JSON.

```bash
npm run phase7:canary-rollback-check                       # full output on breach, silent on clean
npm run phase7:canary-rollback-check -- --quiet            # silent on clean, alert on breach
npm run phase7:canary-rollback-check -- --window-hours=48  # widen the lookback window
npm run phase7:canary-rollback-check -- --json             # JSON output for piping to a dashboard
```

This script never auto-flips `CALL_ARCHITECTURE_MODE`. It alerts; the operator executes the rollback per the procedure below. Auto-flip is intentionally not built because humans stay in the loop for production dial-authority changes.

### Aggregate Exit Report

The older aggregate canary report remains available for exit evidence and rollback timing:

```bash
npm run phase7:canary-report -- \
  --test-run-id=phase7-canary-001 \
  --answer-rate-baseline=0.72 \
  --required-continuous-days=7 \
  --min-canary-seniors=5 \
  --max-canary-seniors=25 \
  --rollback-started-at=2035-03-18T14:00:00.000Z \
  --rollback-completed-at=2035-03-18T14:02:30.000Z \
  --rollback-target-seconds=300 \
  --phi-sentinel-findings=0 \
  --p0p1-incidents=0
```

Use this output as the final Phase 7 gate evidence after the daily report has stayed clean for the required window.

---

## Ramp Schedule

```text
Day 1     | Add 5 internal seniors to canary (ramp_phase="5")
Day 2     | Run daily report. If clean, hold.
Day 3     | Hold. Run daily report.
Day 4     | If 48 h clean, add 5 more (ramp_phase="10").
Day 5     | Run daily report.
Day 6     | Hold. Run daily report.
Day 7     | If 48 h clean, add 15 more (ramp_phase="25").
Day 8-9   | Hold. Run daily report each day.
Day 10    | Exit gate review: 7 continuous days clean across all 25.
```

Any SLO breach during a hold period: pause ramp, investigate, decide rollback vs targeted fix.

---

## Rollback

Two levels of rollback, escalating.

### Level 1 - Pull Individual Seniors From Canary

For non-systemic issues such as one senior having problems or one caregiver reporting confusion:

```bash
curl -X DELETE https://donna-api-production-2450.up.railway.app/api/canary/members/<senior-uuid> \
  -H 'Authorization: Bearer <admin-jwt>' \
  -d '{"reason": "ramp_back"}'
```

Senior immediately routes through legacy on the next dial cycle. No deploy needed.

### Level 2 - Flip Dispatcher To `legacy_rollback`

For systemic issues such as duplicate dial, setup p95 breach across many calls, or post-call queue stuck:

```bash
railway variable set --service donna-api --environment production CALL_ARCHITECTURE_MODE=legacy_rollback
make deploy-prod-nodejs
```

This stops the queue dispatcher from issuing new dials; legacy is dial authority for everyone. Queue rows, guards, and attempts remain in the database for post-hoc reconciliation.

After Level 2 rollback:

1. Record start and finish timestamps.
2. Run `npm run phase5:live-ab-report -- --test-run-id=<id> --rollback-started-at=<iso> --rollback-completed-at=<iso> --rollback-target-seconds=300` to capture the rollback drain stat.
3. Page on-call and founder.
4. Do not re-enable canary mode until root cause is identified.

---

## Exit Criteria

Phase 7 -> Phase 8 requires all of the following to hold for 7 continuous days at the 25-senior ramp:

- [ ] All SLOs met across both cohorts.
- [ ] 0 duplicate-call guard violations.
- [ ] 0 PHI sentinel findings in Node logs, Pipecat logs, Sentry, Redis raw, and queue/job tables.
- [ ] 0 P0/P1 incidents.
- [ ] Rollback drill re-executed inside the canary environment with treatment traffic; elapsed time recorded in the runbook log.

Record exit-criteria evidence in `docs/operations/scale-2000-phase7-exit-evidence.md` when Phase 7 completes.

---

## PHI Safety Reminders

- The daily report must stay aggregate. If a future field surfaces a transcript, name, or phone number, that's a P0: stop the report run and patch.
- `/api/canary/members` returns `senior_id` (UUID), `ramp_phase`, `added_at`, `added_by`, `notes`. `notes` is intentionally short and operator-supplied. Do not paste call summaries or senior personal context into it.
- Audit rows (`canary_cohort_add` / `canary_cohort_remove`) carry only `ramp_phase` and `reason`, no call content.

---

Last updated: 2026-05-24 after merging Phase 7 canary harness into `zuludev`.
