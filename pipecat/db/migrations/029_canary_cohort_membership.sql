-- Mirror Node canary cohort membership table for Pipecat-side compliance,
-- retention, export, and hard-delete paths.
--
-- The table is operational only and must remain PHI-free. Do not store
-- names, phone numbers, call content, reminder text, or free-form notes.

CREATE TABLE IF NOT EXISTS canary_cohort_membership (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  senior_id UUID NOT NULL REFERENCES seniors(id),
  ramp_phase VARCHAR(50) NOT NULL,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  added_by TEXT,
  removed_at TIMESTAMP,
  removed_reason TEXT,
  notes TEXT,
  CONSTRAINT chk_canary_cohort_notes_null CHECK (notes IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canary_cohort_active
  ON canary_cohort_membership(senior_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_canary_cohort_phase_added
  ON canary_cohort_membership(ramp_phase, added_at DESC);

UPDATE canary_cohort_membership
SET notes = NULL
WHERE notes IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_canary_cohort_notes_null'
      AND conrelid = 'canary_cohort_membership'::regclass
  ) THEN
    ALTER TABLE canary_cohort_membership
      ADD CONSTRAINT chk_canary_cohort_notes_null CHECK (notes IS NULL) NOT VALID;
  END IF;
END $$;

ALTER TABLE canary_cohort_membership
  VALIDATE CONSTRAINT chk_canary_cohort_notes_null;

ALTER TABLE canary_cohort_membership
  ALTER COLUMN added_by TYPE VARCHAR(255)
  USING LEFT(added_by, 255);

COMMENT ON TABLE canary_cohort_membership
  IS 'Phase 7 small live canary cohort membership. senior_id is the canary subject; ramp_phase is "5" / "10" / "25" etc; removed_at IS NULL = currently in canary.';
COMMENT ON COLUMN canary_cohort_membership.ramp_phase
  IS 'Free-form ramp tag (e.g. "5", "10", "25"). Used for cohort phase reporting; not enforced as enum.';
COMMENT ON COLUMN canary_cohort_membership.added_by
  IS 'admin_users.id (UUID as text) of the operator who added the senior. Audit trail; not validated as FK so DELETE on admin_users does not cascade-prune canary history.';
COMMENT ON COLUMN canary_cohort_membership.removed_reason
  IS 'PHI-free reason string: "phase_complete", "ramp_back", "rollback_legacy_only", "manual_admin". Never includes call content.';
COMMENT ON COLUMN canary_cohort_membership.notes
  IS 'Deprecated PHI-safety field. Must remain NULL; do not store free-form cohort notes.';
