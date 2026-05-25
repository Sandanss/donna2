-- Let released/cancelled outbound call guards keep their audit trail without
-- permanently blocking the same guard_key from being acquired again.
--
-- Run outside a transaction. PostgreSQL does not allow CREATE/DROP INDEX
-- CONCURRENTLY inside BEGIN/COMMIT, and this table can be hot during queue
-- rollout.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_outbound_call_guards_guard_key_live
  ON outbound_call_guards(guard_key)
  WHERE status IN ('active', 'initiating', 'initiated');

DROP INDEX CONCURRENTLY IF EXISTS idx_outbound_call_guards_guard_key;
