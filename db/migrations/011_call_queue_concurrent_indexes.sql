-- Hot-table idempotency indexes for the queue architecture.
--
-- Run this migration outside a transaction. PostgreSQL does not allow
-- CREATE INDEX CONCURRENTLY inside BEGIN/COMMIT, and these indexes touch
-- production tables that may already be large.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_call_sid_unique
  ON conversations(call_sid)
  WHERE call_sid IS NOT NULL;

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_reminder_deliveries_delivery_key_unique
  ON reminder_deliveries(delivery_key)
  WHERE delivery_key IS NOT NULL;
