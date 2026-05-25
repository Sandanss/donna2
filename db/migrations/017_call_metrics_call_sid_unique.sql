-- Mirror Pipecat's call_metrics(call_sid) uniqueness on the Node migration
-- path. The webhook/call-finalization writers treat call_sid as idempotent.
--
-- Run outside a transaction because this uses CREATE INDEX CONCURRENTLY.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_call_metrics_call_sid_unique
  ON call_metrics(call_sid);
