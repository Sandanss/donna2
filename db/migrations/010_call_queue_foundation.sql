-- Queue-based call architecture foundation.
--
-- This migration is additive and dark by default. It creates the durable
-- scheduler, dispatch, guard, and post-call job tables needed to run the new
-- architecture beside the legacy scheduler.

CREATE TABLE IF NOT EXISTS senior_call_schedules (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  senior_id UUID NOT NULL REFERENCES seniors(id),
  source_profile_hash TEXT,
  call_type VARCHAR(50) NOT NULL DEFAULT 'schedule',
  timezone VARCHAR(100) NOT NULL,
  target_local_time TIME NOT NULL,
  window_minutes INTEGER NOT NULL DEFAULT 15,
  frequency VARCHAR(50) NOT NULL,
  days_of_week INTEGER[],
  one_time_date DATE,
  priority_lane VARCHAR(50) NOT NULL DEFAULT 'scheduled_checkin',
  reminder_ids UUID[],
  context_notes_encrypted TEXT,
  next_run_at TIMESTAMP NOT NULL,
  last_materialized_for TIMESTAMP,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  senior_id UUID NOT NULL REFERENCES seniors(id),
  schedule_id UUID REFERENCES senior_call_schedules(id),
  reminder_id UUID REFERENCES reminders(id),
  call_type VARCHAR(50) NOT NULL,
  priority_lane VARCHAR(50) NOT NULL,
  priority_score INTEGER NOT NULL DEFAULT 0,
  target_at TIMESTAMP NOT NULL,
  earliest_at TIMESTAMP NOT NULL,
  latest_at TIMESTAMP NOT NULL,
  status VARCHAR(50) NOT NULL,
  dedupe_key TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_id UUID,
  last_error_code TEXT,
  last_error_at TIMESTAMP,
  cancel_reason TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_attempts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  queue_id UUID NOT NULL REFERENCES call_queue(id),
  senior_id UUID NOT NULL REFERENCES seniors(id),
  attempt_number INTEGER NOT NULL,
  provider VARCHAR(50) NOT NULL DEFAULT 'telnyx',
  call_control_id TEXT,
  status VARCHAR(50) NOT NULL,
  reservation_id TEXT,
  reserved_capacity INTEGER NOT NULL DEFAULT 1,
  architecture VARCHAR(50) NOT NULL,
  cohort VARCHAR(50),
  test_run_id TEXT,
  dispatch_decision_id UUID,
  dial_started_at TIMESTAMP,
  answered_at TIMESTAMP,
  media_started_at TIMESTAMP,
  ended_at TIMESTAMP,
  provider_error_code TEXT,
  provider_error_class TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS post_call_jobs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID REFERENCES conversations(id),
  call_sid TEXT NOT NULL,
  senior_id UUID REFERENCES seniors(id),
  job_type VARCHAR(100) NOT NULL,
  status VARCHAR(50) NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT NOT NULL,
  payload_encrypted TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMP,
  last_error_code TEXT,
  last_error_at TIMESTAMP,
  run_after TIMESTAMP NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbound_call_guards (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  senior_id UUID NOT NULL REFERENCES seniors(id),
  guard_key TEXT NOT NULL,
  call_type VARCHAR(50) NOT NULL,
  architecture VARCHAR(50) NOT NULL,
  queue_id UUID REFERENCES call_queue(id),
  legacy_dedup_key TEXT,
  target_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  call_control_id TEXT,
  status VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduler_shadow_comparisons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  test_run_id TEXT,
  senior_id UUID REFERENCES seniors(id),
  queue_id UUID REFERENCES call_queue(id),
  call_type VARCHAR(50) NOT NULL,
  priority_lane VARCHAR(50),
  legacy_dedup_key TEXT,
  queue_dedupe_key TEXT,
  target_at TIMESTAMP,
  legacy_decision VARCHAR(100),
  queue_decision VARCHAR(100),
  skip_reason TEXT,
  capacity_decision VARCHAR(100),
  estimated_queue_lag_seconds INTEGER,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE reminder_deliveries
  ADD COLUMN IF NOT EXISTS delivery_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_senior_call_schedules_source_hash
  ON senior_call_schedules(senior_id, source_profile_hash)
  WHERE source_profile_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_senior_call_schedules_next_run
  ON senior_call_schedules(is_active, next_run_at);

CREATE INDEX IF NOT EXISTS idx_senior_call_schedules_senior_active
  ON senior_call_schedules(senior_id, is_active);

CREATE INDEX IF NOT EXISTS idx_senior_call_schedules_lane_next_run
  ON senior_call_schedules(priority_lane, next_run_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_queue_dedupe_key
  ON call_queue(dedupe_key);

CREATE INDEX IF NOT EXISTS idx_call_queue_ready
  ON call_queue(status, priority_lane, earliest_at);

CREATE INDEX IF NOT EXISTS idx_call_queue_deadline
  ON call_queue(status, latest_at);

CREATE INDEX IF NOT EXISTS idx_call_queue_senior_status
  ON call_queue(senior_id, status);

CREATE INDEX IF NOT EXISTS idx_call_queue_lease_expires
  ON call_queue(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_attempts_queue_attempt
  ON call_attempts(queue_id, attempt_number);

CREATE UNIQUE INDEX IF NOT EXISTS idx_call_attempts_call_control_id
  ON call_attempts(call_control_id)
  WHERE call_control_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_call_attempts_status_created
  ON call_attempts(status, created_at);

CREATE INDEX IF NOT EXISTS idx_call_attempts_senior_created
  ON call_attempts(senior_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_call_jobs_dedupe_key
  ON post_call_jobs(dedupe_key);

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_ready
  ON post_call_jobs(status, priority DESC, run_after);

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_lease_expires
  ON post_call_jobs(lease_expires_at)
  WHERE lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_post_call_jobs_senior_created
  ON post_call_jobs(senior_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_call_guards_guard_key
  ON outbound_call_guards(guard_key);

CREATE INDEX IF NOT EXISTS idx_outbound_call_guards_senior_status
  ON outbound_call_guards(senior_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_outbound_call_guards_expires
  ON outbound_call_guards(expires_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_shadow_test_run
  ON scheduler_shadow_comparisons(test_run_id, created_at);

CREATE INDEX IF NOT EXISTS idx_scheduler_shadow_senior_created
  ON scheduler_shadow_comparisons(senior_id, created_at);

COMMENT ON TABLE call_queue
  IS 'Durable outbound call queue. Store operational IDs, lane, status, and timestamps only; no raw PHI.';

COMMENT ON TABLE call_attempts
  IS 'Provider dial attempts for queued calls. No names, phone numbers, reminder text, transcripts, or medical notes.';

COMMENT ON TABLE post_call_jobs
  IS 'Post-call worker jobs. Payloads may contain PHI only when encrypted in payload_encrypted.';

COMMENT ON TABLE outbound_call_guards
  IS 'Durable double-call guard shared by legacy and queue schedulers.';

COMMENT ON TABLE scheduler_shadow_comparisons
  IS 'ID-only scheduler comparison rows for shadow testing the queue architecture.';
