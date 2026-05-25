-- Senior consent audit table + denormalized roll-up on seniors.
--
-- Captures explicit consent events from the `consent` call type. Each call
-- records two rows: one for call_permission and one for recording_permission.
-- The denormalized seniors.consent_status column is the gate the scheduler /
-- call queue reads (avoids a join per dispatch); senior_consents is the
-- legal/HIPAA audit trail.
--
-- Decline blocking uses a dedicated `callable` flag, NOT is_active. Rationale:
-- is_active is caregiver-controlled (soft pause); callable is consent-driven.
-- Mixing them loses the ability to tell "caregiver paused calls" apart from
-- "senior declined consent" — they're operationally different. Scheduler /
-- call queue must read both (see idx_seniors_dispatchable below).
--
-- Roll-up rule (computed by app layer in pipecat/services/seniors.py):
--   both latest rows granted=true   → consent_status='granted',  callable=true
--   any  latest row  granted=false  → consent_status='declined', callable=false
--   otherwise                        → consent_status='pending'  (callable unchanged)

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

-- Hot path: "give me the latest consent of type X for senior Y" should be
-- a single index lookup. The DESC ordering matches the app-layer roll-up.
CREATE INDEX IF NOT EXISTS idx_senior_consents_latest
  ON senior_consents (senior_id, consent_type, captured_at DESC);

ALTER TABLE seniors
  ADD COLUMN IF NOT EXISTS consent_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS consent_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callable BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE seniors
  ADD CONSTRAINT seniors_consent_status_check
  CHECK (consent_status IN ('pending', 'granted', 'declined'));

-- Grandfather existing seniors. Without this UPDATE, every senior created
-- before the consent flow ships would suddenly fail the scheduler's
-- consent_status='granted' check and stop receiving calls. The post-2026-05-17
-- mobile onboarding flow is responsible for explicitly setting new seniors to
-- 'pending' so they go through a consent call. This statement is idempotent
-- (only touches rows still on the migration default).
UPDATE seniors
   SET consent_status = 'granted',
       consent_date   = COALESCE(consent_date, created_at, NOW()),
       updated_at     = NOW()
 WHERE consent_status = 'pending';

-- Scheduler / call queue reads (is_active, callable, consent_status) together;
-- partial index keeps the eligible set small. Existing scheduler queries that
-- only check is_active will keep working — once consent calls go live, those
-- queries should be tightened to also require callable=true AND consent_status='granted'.
CREATE INDEX IF NOT EXISTS idx_seniors_dispatchable
  ON seniors (id)
  WHERE is_active = true AND callable = true AND consent_status = 'granted';

COMMENT ON TABLE senior_consents
  IS 'Audit trail of consent events captured during call_type=consent calls. Legal/HIPAA source of truth; seniors.consent_status is the denormalized roll-up the scheduler reads.';
COMMENT ON COLUMN senior_consents.consent_type
  IS 'call_permission = okay to call. recording_permission = okay to record/transcribe.';
COMMENT ON COLUMN senior_consents.senior_quote_encrypted
  IS 'Verbatim senior response, PHI-encrypted at app layer (lib/encryption pattern).';
COMMENT ON COLUMN seniors.consent_status
  IS 'Roll-up of latest senior_consents rows. pending → no consent call completed yet. granted → both call+recording granted. declined → either denied (also flips callable=false).';
COMMENT ON COLUMN seniors.callable
  IS 'Consent-driven block on outbound calling. Separate from is_active (caregiver soft-pause). Flipped false on consent decline by app layer (pipecat/services/seniors.record_consent).';
