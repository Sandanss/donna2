# Scale 2000 Infra Bugfix Remediation Plan

Date: 2026-05-25
Branch: `codex/zuludev-scale-2000-infra-fixes`
Base: `origin/zuludev` at `af203f7`

## Goal

Close the scale-2000 infrastructure defects found in the latest-main review before any `queue_primary` production cutover. The work keeps the legacy scheduler deployable while making queue-owned dialing safer under canary and multi-replica load.

## Priority Order

### P0: Do Not Run Queue-Primary Until Fixed

1. **Global dispatcher capacity can overbook across workers**
   - Risk: multiple dispatcher replicas can each read the same capacity snapshot and dial beyond Pipecat fleet capacity.
   - Fix direction: add an atomic shared-state fleet slot claim or run dispatcher as a single active leader until slot claims exist.
   - Evidence: unit test with concurrent dispatchers proves only available slots are acquired globally.

2. **Recovered outbound guards still block the same guard key**
   - Risk: `released_expired` rows keep the unique `guard_key`, so recovered queue rows cannot re-acquire dial authority.
   - Fix direction: make the guard key uniqueness partial on live guard states, or delete expired uninitiated guards.
   - Evidence: test proves a released-expired guard does not block re-acquisition of the same guard key.

3. **`initiating` queue rows can strand forever**
   - Risk: dispatcher crash after `markQueuedCallInitiating` leaves rows outside lease recovery and expiry.
   - Fix direction: recover stale `initiating` rows with expired leases and expire overdue `initiating` rows past `latest_at`.
   - Evidence: reconciler tests for `leased` and `initiating` recovery/expiry.

4. **Ambiguous Telnyx success can double-call a senior**
   - Risk: Pipecat can create the Telnyx call, Node can time out before receiving the response, and Node then requeues the same call.
   - Fix direction: after the guard is moved to `initiating`, treat dial failures as ambiguous: preserve guard/queue for reconciliation instead of deleting/requeuing immediately.
   - Evidence: test for a dial throw after guard-initiation leaves the row non-queued and does not release the guard.

5. **Dispatch failures can hot-loop**
   - Risk: queue rows immediately return to `queued` on repeated provider/registry failures.
   - Fix direction: add bounded retry/backoff or terminal failure after max dispatch attempts.
   - Evidence: test proves retry rows move to `deferred` with `earliest_at` in the future, and eventually `failed`.

### P1: Scale Readiness And Compliance Parity

6. **Phase 8 ignores current backlog**
   - Fix direction: include ready/overdue queue backlog in scale recommendation and scale-down guard.
   - Evidence: planner test with overdue row blocks scale-down.

7. **Post-call jobs can strand in `running`**
   - Fix direction: only mark jobs `running` after provider semaphore acquisition, or add explicit stale-running dead-letter/recovery path.
   - Evidence: worker test for crash-before-handler recoverability.

8. **Post-call queue does not release Pipecat capacity yet**
   - Fix direction: document as activation blocker or add a flag that enqueues and skips inline non-critical post-call work only after artifact coverage is proven.
   - Evidence: post-call capacity release test or documented cutover gate.

9. **Pipecat hard-delete misses `canary_cohort_membership`**
   - Fix direction: add legal-hold check, counts, and delete statements to the Pipecat hard-delete mirror.
   - Evidence: Python hard-delete tests or query coverage.

10. **Retention purge order conflicts with queue FKs**
    - Fix direction: purge queue child tables before parent rows, or align parent retention longer than child retention.
    - Evidence: retention-order test covers `call_attempts` before `call_queue`.

11. **Node/Pipecat migration drift** — RESOLVED
    - Evidence: `db/migrations/017_call_metrics_call_sid_unique.sql` now mirrors the `call_metrics.call_sid` unique index on the Node migration path.

12. **Canary notes can store PHI**
    - Fix direction: remove free-form notes from new writes/responses or replace with PHI-free reason code.
    - Evidence: route/service tests assert notes are not accepted or emitted.

### P2: Operational Consistency And Follow-Ups

13. **Standalone dispatcher does not read DB canary cohort**
    - Fix direction: use `resolveMergedCanarySeniorIds` in `scripts/run-dispatcher-worker.js`.
    - Evidence: dispatcher-worker test with DB canary member.

14. **Affinity hint does not affect routing**
    - Fix direction: keep disabled/documented until routing exists, or pass an explicit routing hint to a load balancer that can honor it.
    - Evidence: no claim that affinity is active routing until end-to-end route test exists.

15. **Manual `/api/call` bypasses queue/capacity**
    - Fix direction: keep documented as outside 2k scheduled-burst path or add manual queue enqueue path behind flags.
    - Evidence: route-level test if queue-backed manual call is implemented.

## Execution Plan

1. Land P0 state-machine fixes first in `services/call-queue.js`, `services/pipecat-capacity.js`, migrations, and targeted Vitest coverage. **Status: implemented; targeted tests passing.**
2. Land P1 compliance and planner fixes next, including mirrored Node/Pipecat behavior.
3. Land P2 operational consistency items only where scoped and low-risk; otherwise leave explicit docs/backlog entries.
4. Run targeted Node tests after each slice; run Pipecat tests for any Python deletion/retention changes.
5. Update architecture docs after code reflects the new runtime behavior.

## Progress Log

- 2026-05-25: Added bounded Redis capacity slot claims for dispatcher reservations so multiple workers cannot each consume the same local capacity snapshot.
- 2026-05-25: Changed outbound guard uniqueness to live states only, with mirrored Node/Pipecat migrations, so `released_expired` guards no longer block re-acquisition.
- 2026-05-25: Made stale `initiating` rows recoverable only when there is no plausible in-flight call, and made overdue `initiating`/`deferred` rows expire.
- 2026-05-25: Changed dispatch failures to `deferred` retry/backoff with a terminal `failed` state after bounded attempts.
- 2026-05-25: Treat post-authority dial errors as ambiguous and avoid releasing guard/capacity or requeueing a call that may already exist in Telnyx.
- 2026-05-25: Added Phase 8 current-backlog demand, moved post-call `running` transitions behind provider semaphores, removed canary free-form notes, fixed retention purge order, mirrored canary hard-delete behavior, merged DB canary cohort into the standalone dispatcher, and queued manual calls in `queue_primary`.

## Validation Checklist

- `npx vitest run tests/services/call-queue.test.js`
- `npx vitest run tests/services/pipecat-capacity.test.js`
- `npx vitest run tests/services/phase8-capacity-plan.test.js`
- `npx vitest run tests/services/post-call-jobs.test.js`
- `npx vitest run tests/services/canary-cohort.test.js`
- Python hard-delete/retention targeted tests, or `make test-python` if touched tests are not isolated.

## Rollout Notes

- Do not enable `CALL_ARCHITECTURE_MODE=queue_primary` with multiple dispatcher replicas until P0 item 1 has evidence.
- Do not enable live queue canary for real seniors until P0 items 2-5 are merged.
- Keep `CALL_QUEUE_REQUIRE_CAPACITY_REGISTRY=true` for any live queue dialing environment.
- Keep legacy rollback available through the evidence window.
