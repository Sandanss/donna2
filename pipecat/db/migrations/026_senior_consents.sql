-- Pipecat-side mirror of db/migrations/014_senior_consents.sql.
-- Keep in lockstep with the Node-side migration; both apply the same DDL
-- because Pipecat and Node share a single Neon database. The Pipecat
-- migration runner picks up files in this directory; the Node runner picks
-- up db/migrations/. Either one applying the change is sufficient — the
-- CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS guards make it safe
-- to run both.

CREATE TABLE IF NOT EXISTS senior_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  senior_id UUID NOT NULL REFERENCES seniors(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id),
  consent_type VARCHAR(50) NOT NULL,
  granted BOOLEAN NOT NULL,
  senior_quote_encrypted TEXT,
  captured_by VARCHAR(50) NOT NULL DEFAULT 'donna_tool',
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT senior_consents_type_check
    CHECK (consent_type IN ('call_permission', 'recording_permission')),
  CONSTRAINT senior_consents_captured_by_check
    CHECK (captured_by IN ('donna_tool', 'manual', 'imported'))
);

CREATE INDEX IF NOT EXISTS idx_senior_consents_latest
  ON senior_consents (senior_id, consent_type, captured_at DESC);

ALTER TABLE seniors
  ADD COLUMN IF NOT EXISTS consent_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS consent_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callable BOOLEAN NOT NULL DEFAULT true;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'seniors_consent_status_check'
  ) THEN
    ALTER TABLE seniors
      ADD CONSTRAINT seniors_consent_status_check
      CHECK (consent_status IN ('pending', 'granted', 'declined'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_seniors_dispatchable
  ON seniors (id)
  WHERE is_active = true AND callable = true AND consent_status = 'granted';

UPDATE seniors
   SET consent_status = 'granted',
       consent_date   = COALESCE(consent_date, created_at, NOW()),
       updated_at     = NOW()
 WHERE consent_status = 'pending';
