# Pipecat Operational Follow-ups

Observed while validating `codex/conversation-pipeline-fixes` on April 13, 2026.

## Follow-ups

- [x] Use shared state in Pipecat dev and production when a Redis endpoint is valid. `REDIS_URL` is the active Railway path. The code can still use `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` when `REDIS_URL` is absent, but the stale Railway Upstash variables were removed after Railway Redis validation. During earlier validation, the checked Upstash URL returned DNS `NXDOMAIN`; `UpstashRestState` now temporarily disables itself after HTTP/DNS failure so single-replica deployments fall back to local state instead of repeatedly treating a dead endpoint as shared. A valid Redis/Upstash endpoint is still required before scaling beyond one Pipecat replica.
- [x] Fix data-retention purge SQL warnings around `LIMIT` in both Python and Node retention jobs by deleting from a limited `ctid` batch CTE.
- [x] Update Railway Makefile/helper commands that assumed the old `railway variables get` / `railway variables set` CLI behavior.
- [x] Make local simulation fixture integration tests auto-skip when `DATABASE_URL` is absent or unreachable.

## Dev Redis Provisioning

Completed April 14, 2026:

- Created Railway Redis service `Redis` in the `donna` project `dev` environment.
- Set `donna-pipecat` dev `REDIS_URL` to `${{Redis.REDIS_URL}}`.
- Redeployed `donna-pipecat` dev as deployment `d8c88c67-f76c-45f4-9f85-3e444f72e50b`.
- Verified `Redis`, `donna-pipecat`, and `donna-api` were all `SUCCESS`.
- Verified `make health-dev` returned healthy Pipecat and Node responses.
- Verified Redis from inside the Pipecat dev container with a non-PHI `codex:redis-smoke:*` key: selected `RedisState`, `is_shared=True`, set/get matched, and delete was confirmed.
- Removed stale Upstash variables from `donna-pipecat` and `donna-api` dev after Railway Redis validation. `REDIS_URL` is the only Redis-related variable left on `donna-pipecat` dev.

Note: `REDIS_URL` resolves to Railway private networking (`redis.railway.internal`), so local `railway run` commands cannot prove Redis connectivity from a developer machine. Use `railway ssh --service donna-pipecat --environment dev ...` when the smoke test needs private-network access.

## Production Redis Provisioning

Completed April 14, 2026:

- Created Railway Redis service `Redis-sJE8` in the `donna` project `production` environment.
- Set `donna-pipecat` production `REDIS_URL` to `${{Redis-sJE8.REDIS_URL}}`.
- Redeployed `donna-pipecat` production as deployment `fdc80fea-5f6d-4bcd-83bd-6a6062ec9cb0`.
- Verified `Redis-sJE8`, `donna-pipecat`, and `donna-api` were all `SUCCESS`.
- Verified `make health-prod` returned healthy Pipecat and Node responses.
- Verified Redis from inside the Pipecat production container with a non-PHI `codex:redis-smoke:*` key: selected `RedisState`, `is_shared=True`, set/get matched, and delete was confirmed.
- Removed stale Upstash variables from `donna-pipecat` and `donna-api` production. `REDIS_URL` is the only Redis-related variable left on `donna-pipecat` production.

Note: production Redis also resolves on Railway private networking (`redis-sje8.railway.internal`). Use `railway ssh --service donna-pipecat --environment production ...` for future Redis smoke tests that need network access from inside Railway.

## Reminder Context Shared State

Completed April 14, 2026:

- Pipecat-side reminder initiation now stores reminder context in local memory and Redis as `reminder_ctx:{call_sid}` with a 30 minute TTL.
- `/voice/answer` now loads reminder context local-first, then Redis, before falling back to the database delivery row used by Node-scheduled reminders.
- Call completion and post-call cleanup now await reminder context deletion from Redis.
- Unit coverage verifies local-first lookup, Redis fallback, Redis write TTL, Redis cleanup, and stale cleanup for Redis-deserialized timestamp strings.
