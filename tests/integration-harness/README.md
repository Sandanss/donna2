# Integration test harness — scale-2000 coverage

This directory holds shared helpers for the test gaps identified in the Phase 0-5 coverage audit.

## What's here

- `postgres.js` — opens a connection to `TEST_DATABASE_URL`, applies `db/migrations/*.sql` and `pipecat/db/migrations/*.sql`, exposes `getPool()`, `truncateOpsTables()`, `closePool()`, and `skipIfNoDb` for tests that require a real Postgres.
- `redis.js` — exposes `createMockRedis()` (ioredis-mock) plus a `command(...parts)` adapter compatible with the `command` injection point used by `services/pipecat-capacity.js`, `services/dispatcher-affinity.js`, and `services/redis-rate-limit-store.js`. No Docker required.
- `fake-db.js` — an in-process Postgres-shape mock that simulates SKIP LOCKED semantics for the load-style dispatcher tests when a real database isn't available. Useful as a behavioral fallback but does NOT exercise real lock contention.

## Running

Unit tests (default, no DB):

```bash
npx vitest run
```

Integration tests that need a real Postgres (Tier-2):

```bash
TEST_DATABASE_URL=postgres://... npx vitest run tests/integration-real-db
```

Without `TEST_DATABASE_URL`, those tests are skipped via `skipIfNoDb`.

**Target DB requirements:** the `TEST_DATABASE_URL` must point at a database where the full Donna schema has already been pushed (`npm run db:push` or equivalent). `getPool()` additionally applies `db/migrations/*.sql` so any queue-side migrations not in the drizzle schema are in place. The seniors / reminders / caregivers base tables must exist — they're the FK targets for the queue tables.

Use a **Neon dev branch** rather than a shared staging DB so the `truncateOpsTables()` cleanup in `beforeEach` doesn't disrupt anyone else.

Today's Tier-2 coverage (`tests/integration-real-db/dispatcher-real-postgres.test.js`):
- Real `leaseQueuedCalls` at 8 concurrent workers against `FOR UPDATE SKIP LOCKED` — zero duplicate leases over 32 rows.
- `acquireOutboundCallGuard` race against `UNIQUE(guard_key)` — exactly one of two racers wins.
- Senior-delete race over 50 trials: deactivation interleaved with `markOutboundCallGuardInitiatingIfCallable` resolves to cancelled 100%.
- `reconcileQueueLeases` recovers an actually-expired lease in one cycle against a real `NOW()` clock.

## Why no testcontainers / pg-mem

- testcontainers needs Docker, which isn't available on every dev machine and adds a heavy boot step per test file. Wire it later in CI if/when we want hermetic runs.
- pg-mem is single-threaded JS — its "concurrent" worker tests would serialize and produce false confidence about `FOR UPDATE SKIP LOCKED` race safety.

A real Postgres (Neon dev branch or local) is the only honest way to validate the Phase 4 concurrency exit criteria.
