-- Pipecat-side mirror of db/migrations/019_consent_single_decision.sql.
-- See that file for the full rationale.

ALTER TABLE senior_consents
  DROP CONSTRAINT IF EXISTS senior_consents_type_check;

ALTER TABLE senior_consents
  ADD CONSTRAINT senior_consents_type_check
  CHECK (consent_type IN (
    'call_permission',
    'recording_permission',
    'call_and_recording'
  ));
