-- Phase 6 post-call job queue state machine and dependency support.
-- Payloads remain in payload_encrypted only; this migration adds only
-- operational state, dependency IDs, retry metadata, and terminal timestamps.

ALTER TABLE post_call_jobs
  ADD COLUMN IF NOT EXISTS depends_on UUID[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS dead_letter_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_dependencies
  ON post_call_jobs USING GIN(depends_on);

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_dead_letter
  ON post_call_jobs(dead_lettered_at DESC)
  WHERE status = 'dead_letter';

COMMENT ON COLUMN post_call_jobs.depends_on
  IS 'Prerequisite post_call_jobs IDs that must be completed before this job can be leased.';

COMMENT ON COLUMN post_call_jobs.dead_letter_reason
  IS 'PHI-free terminal reason code for dead-lettered post-call jobs.';
