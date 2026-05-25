# 2,000-User Phase 1 Migration Runbook

This runbook covers the schema and idempotency phase from `docs/plans/2026-05-18-scale-to-2000-users-technical-plan.md`.

Run this first on a production-sized clone, then staging, then production after Phase 0 exits.

## Order

1. Apply the additive queue foundation migration:
   - Node path: `db/migrations/010_call_queue_foundation.sql`
   - Pipecat/shared path: `pipecat/db/migrations/023_call_queue_foundation.sql`

2. Run the aggregate idempotency preflight:

   ```bash
   npm run phase1:preflight-idempotency
   ```

   This must report `ok: true` before the concurrent unique-index migration is allowed. If it reports duplicate `conversations.call_sid`, duplicate `reminder_deliveries.delivery_key`, duplicate `call_metrics.call_sid`, or unresolved derived delivery-key collisions, stop and document the resolution policy.

3. Dry-run the reminder delivery key backfill:

   ```bash
   npm run phase1:backfill-delivery-keys -- --dry-run
   ```

4. If `collisionRows > 0`, stop. Document the collision-resolution policy before writing anything or applying the delivery-key unique index.

5. If collisions are zero, write the backfill:

   ```bash
   npm run phase1:backfill-delivery-keys -- --write
   ```

   The command updates a bounded batch (`--limit` defaults to 5000 and is capped at 50000). After each write batch, re-run the **dry run**. Repeat write batches until a dry run reports both `candidateRows=0` and `wouldUpdate=0`; write-mode `wouldUpdate` is always `0` by design.

6. Re-run the aggregate idempotency preflight:

   ```bash
   npm run phase1:preflight-idempotency
   ```

7. Apply concurrent idempotency indexes outside a transaction/autocommit:
   - Node path: `db/migrations/011_call_queue_concurrent_indexes.sql`
   - Pipecat/shared path: `pipecat/db/migrations/024_call_queue_concurrent_indexes.sql`

8. Apply Phase 6 post-call job state-machine migrations before post-call queue evidence:
   - Node path: `db/migrations/012_post_call_job_state_machine.sql`
   - Pipecat/shared path: `pipecat/db/migrations/025_post_call_job_state_machine.sql`

9. Apply Phase 7 canary membership before canary cohort APIs or `canary_queue` mode:
   - Node path: `db/migrations/013_canary_cohort_membership.sql`
   - No Pipecat mirror currently exists; Node owns this table and Pipecat hard-delete parity must be verified separately.

## Required Timing Record

Record elapsed time on the production-sized clone:

| Step | Elapsed | Max Lock Observed | Result |
| --- | ---: | ---: | --- |
| `010_call_queue_foundation.sql` | TBD | TBD | TBD |
| `023_call_queue_foundation.sql` if used separately | TBD | TBD | TBD |
| idempotency preflight before backfill | TBD | n/a | TBD |
| delivery-key dry run | TBD | n/a | TBD |
| delivery-key write | TBD | TBD | TBD |
| idempotency preflight before concurrent indexes | TBD | n/a | TBD |
| `011_call_queue_concurrent_indexes.sql` | TBD | low | TBD |
| `024_call_queue_concurrent_indexes.sql` | TBD | low | TBD |
| `012_post_call_job_state_machine.sql` / `025_post_call_job_state_machine.sql` | TBD | TBD | TBD |
| `013_canary_cohort_membership.sql` | TBD | TBD | TBD |

## Safety Notes

- `npm run phase1:preflight-idempotency` emits aggregate counts only. It must not print call SIDs, reminder IDs, delivery keys, names, phone numbers, transcripts, notes, or response bodies.
- The delivery-key backfill performs a full-table collision preflight before it updates any limited batch.
- `CREATE INDEX CONCURRENTLY` must not be run through a migration runner that wraps files in `BEGIN/COMMIT`.
- `call_metrics.call_sid` is Pipecat-owned and gets a unique concurrent index in the Pipecat concurrent migration. The post-call writer tolerates duplicate retries by updating the existing metrics row after a unique violation.
- Backfill and migration logs must not include reminder titles, user responses, names, phone numbers, transcripts, or medical notes.
