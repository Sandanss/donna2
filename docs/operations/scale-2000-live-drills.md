# 2,000-User Live Drill Runbook

Use staging first. Use only dummy or explicitly consenting test phones. Do not run a live outbound call against a senior unless the target has been confirmed as a test/consenting target for this drill.

Current staging uses the same Neon `DATABASE_URL` as production. Treat any staging command that writes queue, job, guard, reminder, conversation, or call-attempt rows as a production-data mutation. Keep cohorts to dummy/consenting test seniors and do not run worker commands without the explicit DB-write confirmation flag.

BAA completion is not a blocker for staging drills when founders explicitly accept that scope, but it remains a production promotion/commercial rollout gate.

## Preflight

1. Confirm services are healthy:

   ```bash
   make health-staging
   ```

2. Confirm staging Redis is a valid Railway Redis service, not the stale Upstash fallback. If `REDIS_URL` is missing and only `UPSTASH_REDIS_REST_URL` is present, the Redis drill is expected to fail until staging Redis is provisioned:

   ```bash
   railway environment link staging
   railway add --database redis --service Redis-staging
   railway variable set --service donna-pipecat --environment staging "REDIS_URL=\${{Redis-staging.REDIS_URL}}"
   railway variable set --service donna-api --environment staging "REDIS_URL=\${{Redis-staging.REDIS_URL}}"
   railway variable set --service donna-pipecat --environment staging REDIS_RATE_LIMITS_ENABLED=true
   railway variable set --service donna-api --environment staging REDIS_RATE_LIMITS_ENABLED=true
   railway variable set --service donna-api --environment staging NODE_DISPATCHER_DRAIN_TIMEOUT_MS=30000
   railway variable delete --service donna-pipecat --environment staging UPSTASH_REDIS_REST_URL
   railway variable delete --service donna-pipecat --environment staging UPSTASH_REDIS_REST_TOKEN
   railway variable delete --service donna-api --environment staging UPSTASH_REDIS_REST_URL
   railway variable delete --service donna-api --environment staging UPSTASH_REDIS_REST_TOKEN
   ```

   `REDIS_URL` uses Railway private networking, so do the connectivity smoke from inside the deployed Pipecat container, not with local `railway run`. Pipecat rate limits require `REDIS_URL`; Upstash REST alone is not enough for SlowAPI's Redis storage adapter.

3. Confirm staging has the required live-call environment values without printing secret values:

   ```bash
   railway run --environment staging --service donna-pipecat -- node -e "const names=['DATABASE_URL','DONNA_API_KEYS','FIELD_ENCRYPTION_KEY','TELNYX_API_KEY','TELNYX_PUBLIC_KEY','TELNYX_CONNECTION_ID','TELNYX_PHONE_NUMBER','REDIS_URL']; console.log(Object.fromEntries(names.map(n=>[n,Boolean(process.env[n])])));"
   ```

4. Redeploy or restart Pipecat after Redis variable changes, then run shared-state readiness and fail-closed simulation from inside Railway:

   ```bash
   make deploy-staging-pipecat
   railway ssh --environment staging --service donna-pipecat -- uv run python scripts/redis_shared_state_drill.py --simulate-outage
   ```

   Expected: `checks[0].ok`, `checks[0].shared`, and `checks[0].available` are true for the actual staging shared-state backend, and `simulatedFailClosed` is true for the forced outage path. If `shared=true` but `available=false`, staging is configured for a shared backend but is currently falling back to local memory and is not ready for scaled-mode drills.

5. Redeploy or restart Node after Redis variable changes. Watch one restart or deploy and confirm dispatcher drain completes without orphaned unconfirmed reservations:

   ```bash
   make deploy-staging-nodejs
   railway logs --service donna-api --environment staging --since 10m --lines 200
   ```

   Expected: logs include `Node graceful shutdown complete`, `dispatcherDrain.remaining` is `0`, and no senior names, phone numbers, reminder titles, transcripts, caregiver notes, profile notes, prompt context, or raw rate-limit keys appear.

## Dual-Path Scheduler Smoke

Use this before any live queue-owned call. The goal is to prove both paths can run concurrently while legacy remains the only dial authority.

1. Enable shadow materialization only:

   ```bash
   railway variable set --service donna-api --environment staging CALL_ARCHITECTURE_MODE=shadow_materialize
   railway variable set --service donna-api --environment staging CALL_QUEUE_DUAL_WRITE_SCHEDULES=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_COMPARE_WITH_LEGACY=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_ALLOW_REAL_DIAL=false
   railway run --environment staging --service donna-api -- npm run phase2:validate-rollout-config
   ```

2. Backfill normalized schedules and let one scheduler cycle run:

   ```bash
   railway run --environment staging --service donna-api -- npm run phase2:backfill-call-schedules -- --dry-run
   railway run --environment staging --service donna-api -- npm run phase2:backfill-call-schedules
   ```

   Expected: no failed rows, queue materialization/comparison rows use IDs only, and no queue-owned Telnyx calls are created.

3. Before `canary_queue`, configure a confirmed test cohort by senior ID only:

   ```bash
   railway variable set --service donna-api --environment staging CALL_ARCHITECTURE_MODE=canary_queue
   railway variable set --service donna-api --environment staging CALL_QUEUE_ALLOW_REAL_DIAL=true
   railway variable set --service donna-api --environment staging CALL_QUEUE_COHORT_ALLOWLIST=<comma-separated-test-senior-ids>
   railway variable set --service donna-api --environment staging CALL_QUEUE_CANARY_PERCENT=0
   railway run --environment staging --service donna-api -- npm run phase2:validate-rollout-config
   ```

   Expected: allowlisted seniors are queue-owned, non-allowlisted seniors remain legacy-owned, and `outbound_call_guards` suppress any duplicate guard attempt.

## Live Telnyx Call Drill

1. Identify a confirmed dummy/consenting staging senior ID. Do not paste the phone number into logs, docs, or PR comments.

2. Prewarm only:

   ```bash
   railway run --environment staging --service donna-api -- npm run phase0:live-call-drill -- --senior-id=<staging-senior-uuid> --prewarm-only
   ```

   Expected: `prewarmOk` is true.

3. Place the live outbound call:

   ```bash
   railway run --environment staging --service donna-api -- npm run phase0:live-call-drill -- --senior-id=<staging-senior-uuid> --confirm-live-call
   ```

   Expected: Telnyx accepts the call and returns a call SID/control ID. The test caller answers, confirms two-way audio, says goodbye, and lets the call end normally.

4. Post-call checks:

   ```bash
   make health-staging
   railway logs --service donna-pipecat --environment staging --since 10m --lines 200
   ```

   Check for successful Telnyx callback/media events, post-call completion, and absence of raw names, phone numbers, transcripts, reminder text, caregiver notes, profile notes, prompt context, or `ws_token` values in logs.

## Phase 6 Post-Call Queue Shadow Smoke

Use this after the live call drill, while inline Pipecat post-call processing remains authoritative.

1. Enable post-call queue materialization on Pipecat, but keep automatic workers off:

   ```bash
   railway variable set --service donna-pipecat --environment staging POST_CALL_QUEUE_ENABLED=true
   railway variable set --service donna-pipecat --environment staging POST_CALL_WORKER_ENABLED=false
   make deploy-staging-pipecat
   ```

2. Complete one dummy/consenting live call, then run one Pipecat execution tick from the Pipecat service environment:

   ```bash
   railway run --environment staging --service donna-pipecat -- npm run phase6:post-call-pipecat-worker-once -- --confirm-db-writes --limit=100
   ```

   Expected: output is aggregate counts only, no job IDs or PHI-bearing payloads. `dead_letter` count is zero. If jobs return retryable `failed` status with `*_pending` error codes immediately after call end, wait for the immediate inline cleanup and rerun after backoff. Do not replay rows until the worker logs show completion or a bounded error.

3. Run the 600-completion stampede simulation with Phase 0 measured provider limits and observed staging DB pool headroom:

   ```bash
   railway run --environment staging --service donna-api -- npm run phase6:post-call-stampede -- \
     --completions=600 \
     --gemini-flash-measured-concurrent=<phase0-gemini-concurrency> \
     --openai-embeddings-rpm=<phase0-openai-embeddings-rpm> \
     --resend-send-rate=<phase0-resend-send-rate> \
     --db-pool-idle-ratio=<observed-staging-idle-ratio>
   ```

   Expected: `critical_jobs_p95`, `provider_concurrency_caps`, `db_pool_idle`, and `non_critical_backlog_drain` all pass. Output is provider-stub aggregate data only.

## Pass Criteria

- Staging Pipecat and Node health are green before and after the drill.
- Shared-state actual health is green.
- Shared-state simulated outage fails closed.
- Live Telnyx call reaches a consenting test phone.
- Two-way audio works.
- Call ends cleanly.
- Post-call inline processing completes, and the Phase 6 shadow worker records no dead letters.
- Phase 6 stampede simulation passes with measured provider caps and staging DB pool headroom.
- Logs remain PHI-safe.
