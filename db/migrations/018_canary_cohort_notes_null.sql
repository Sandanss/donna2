-- Canary cohort membership must remain PHI-free. The old free-form notes
-- column is retained only for compatibility with already-deployed schema,
-- but all values are cleared and future writes must keep it NULL.

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

COMMENT ON COLUMN canary_cohort_membership.notes
  IS 'Deprecated PHI-safety field. Must remain NULL; do not store free-form cohort notes.';
