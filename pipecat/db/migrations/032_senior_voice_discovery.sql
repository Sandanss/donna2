-- Senior first-call voice discovery state.
-- Existing seniors are backfilled to complete so normal scheduled calls do not
-- pause after this deploy. New seniors default to not_started and receive an
-- initial discovery schedule before regular check-ins run.

ALTER TABLE seniors
  ADD COLUMN IF NOT EXISTS voice_discovery_status varchar(40),
  ADD COLUMN IF NOT EXISTS voice_discovery_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS voice_discovery_last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS voice_discovery_last_outcome varchar(80),
  ADD COLUMN IF NOT EXISTS voice_discovery_completed_at timestamptz;

UPDATE seniors
SET voice_discovery_status = 'complete',
    voice_discovery_completed_at = COALESCE(voice_discovery_completed_at, created_at)
WHERE voice_discovery_status IS NULL;

ALTER TABLE seniors
  ALTER COLUMN voice_discovery_status SET DEFAULT 'not_started',
  ALTER COLUMN voice_discovery_status SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seniors_voice_discovery_status
  ON seniors (voice_discovery_status)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_senior_call_schedules_voice_discovery_due
  ON senior_call_schedules (next_run_at)
  WHERE is_active = true AND call_type = 'discovery';
