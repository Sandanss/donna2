-- Collapse the two-decision consent model into a single combined ask.
--
-- Migration 014 originally modeled consent as two separate decisions —
-- call_permission and recording_permission — captured as separate rows in
-- senior_consents. Product decision 2026-05-25 is to ask a single combined
-- question ("okay if I call you regularly and record our calls?") with a
-- single yes/no answer, captured as one row with consent_type='call_and_recording'.
--
-- This migration is additive: the CHECK constraint is widened to accept the
-- new value alongside the legacy values. We do NOT delete any pre-existing
-- rows — they remain valid as audit history. Application code writes only
-- 'call_and_recording' going forward.
--
-- Idempotent (DROP CONSTRAINT IF EXISTS, then ADD).

ALTER TABLE senior_consents
  DROP CONSTRAINT IF EXISTS senior_consents_type_check;

ALTER TABLE senior_consents
  ADD CONSTRAINT senior_consents_type_check
  CHECK (consent_type IN (
    'call_permission',       -- legacy, kept for any pre-2026-05-25 dev rows
    'recording_permission',  -- legacy
    'call_and_recording'     -- current model: single combined consent
  ));

COMMENT ON COLUMN senior_consents.consent_type
  IS 'Combined consent type. Current model writes call_and_recording for all new rows. call_permission / recording_permission are legacy values preserved for backwards-compatible audit.';
