# 2,000-User Phase 5 Live A/B and Rollback Runbook

Use staging first. Use only dummy or explicitly consenting test phones. Do not run live outbound calls against real seniors for this drill.

Phase 5 proves that legacy and queue-owned dialing can run concurrently without duplicate calls, and that rollback from `canary_queue` to `legacy_only` is measured and clean.

## Required Inputs

- `TEST_RUN_ID`: stable ID for this Phase 5 run, for example `phase5-staging-2035-03-11`.
- Control cohort: synthetic senior IDs that stay legacy-owned.
- Treatment cohort: synthetic senior IDs passed through `CALL_QUEUE_COHORT_ALLOWLIST`.
- Caller-ID answer-rate baseline from Phase 0.
- Rollback SLO: maximum rollback time is **300 seconds** from mode flip to legacy-only dial authority.
- Test phones are dummy or explicitly consenting.
- All names, reminder titles, caregiver notes, and scenario labels use non-PHI sentinel text.

## Preflight

1. Confirm Phase 4 validation already passed:

   ```bash
   npm run phase2:validate-rollout-config
   npm test -- tests/services/call-queue.test.js tests/services/dispatcher-worker.test.js tests/services/dispatcher-affinity.test.js
   cd pipecat && uv run python -m pytest tests/test_rate_limit.py tests/test_call_attempts.py tests/test_api_routes.py -q
   ```

2. Configure staging so legacy remains control dial authority and queue owns only treatment:

   ```bash
   railway variable set --service donna-api --environment staging CALL_ARCHITECTURE_MODE=canary_queue
   railway variable set --service donna-api --environment staging CALL_QUEUE_ALLOW_REAL_DIAL=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_COHORT_ALLOWLIST=<comma-separated-treatment-senior-ids>
   railway variable set --service donna-api --environment staging CALL_QUEUE_CANARY_PERCENT=0
   railway variable set --service donna-api --environment staging CALL_QUEUE_TEST_RUN_ID=$TEST_RUN_ID
   railway variable set --service donna-api --environment staging CALL_QUEUE_DISPATCHER_ENABLED=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_RECONCILER_ENABLED=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_REQUIRE_DIAL_GUARD=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_USE_CAPACITY_REGISTRY=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY=true
   ```

3. Validate the rollout config without printing secrets or PHI:

   ```bash
   railway run --environment staging --service donna-api -- npm run phase2:validate-rollout-config
   ```

4. Start or deploy the standalone dispatcher worker if it is used for this drill:

   ```bash
   railway up --service donna-dispatcher --environment staging --path-as-root .
   ```

## Live Matrix

Run the matrix from the technical plan with only synthetic seniors. The expected ownership is:

| Cohort | Dial authority |
| --- | --- |
| Control | Legacy scheduler |
| Treatment | Queue dispatcher |

After each scenario, check call acceptance and logs, but do not paste phone numbers, names, transcripts, reminder text, caregiver notes, profile notes, prompt context, or `ws_token` values into notes.

## Report

Run the caller-ID answer-rate canary as a staged ramp. At each checkpoint,
generate the aggregate report and verify answer rate is at least 80% of the
Phase 0 baseline before moving to the next checkpoint:

| Checkpoint | Required answer-rate check |
| ---: | --- |
| 50 attempts | answer rate >= 80% of Phase 0 baseline |
| 100 attempts | answer rate >= 80% of Phase 0 baseline |
| 250 attempts | answer rate >= 80% of Phase 0 baseline |

Generate the aggregate Phase 5 report from staging:

```bash
railway run --environment staging --service donna-api -- \
  npm run phase5:live-ab-report -- \
  --test-run-id=$TEST_RUN_ID \
  --answer-rate-baseline=<phase0-single-call-answer-rate> \
  --out=tmp/phase5-live-ab-report.json
```

The report is PHI-safe aggregate output. It checks:

- attempts are present for the `TEST_RUN_ID`
- no duplicate queue attempts
- no duplicate call-control IDs
- no duplicate conversation rows for one call-control ID
- no duplicate reminder delivery keys
- media-start rate for answered calls is at least 95%
- caller-ID answer rate is at least 80% of the Phase 0 baseline

## Rollback Drill

1. Capture the rollback start timestamp:

   ```bash
   ROLLBACK_STARTED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
   ```

2. Flip staging back to legacy-only and stop the dispatcher:

   ```bash
   railway variable set --service donna-api --environment staging CALL_ARCHITECTURE_MODE=legacy_only
   railway variable set --service donna-api --environment staging CALL_QUEUE_ALLOW_REAL_DIAL=false
   railway variable set --service donna-api --environment staging CALL_QUEUE_DISPATCHER_ENABLED=false
   railway variable set --service donna-dispatcher --environment staging CALL_ARCHITECTURE_MODE=legacy_only
   railway variable set --service donna-dispatcher --environment staging CALL_QUEUE_ALLOW_REAL_DIAL=false
   railway restart --service donna-dispatcher --environment staging
   ```

3. Capture completion once legacy is confirmed as the only dial authority:

   ```bash
   ROLLBACK_COMPLETED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
   railway run --environment staging --service donna-api -- \
     npm run phase5:live-ab-report -- \
     --test-run-id=$TEST_RUN_ID \
     --answer-rate-baseline=<phase0-single-call-answer-rate> \
     --rollback-started-at=$ROLLBACK_STARTED_AT \
     --rollback-completed-at=$ROLLBACK_COMPLETED_AT \
     --rollback-target-seconds=300 \
     --out=tmp/phase5-rollback-report.json
   ```

Pass criteria: `rollback_drain` and `rollback_within_target` pass, elapsed seconds is recorded at or below 300 seconds, and no active queue-owned leases or initiating attempts remain for the test run.

## PHI Checks

Run the sentinel scan and log review after the live drill:

```bash
npm run phi:sentinel
railway logs --service donna-api --environment staging --since 30m --lines 500
railway logs --service donna-pipecat --environment staging --since 30m --lines 500
```

Expected: no raw senior names, phone numbers, transcripts, reminder text, caregiver notes, profile notes, prompt context, or `ws_token` values.
