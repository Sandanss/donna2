-- Phase 7 small live canary: track which seniors are currently in the
-- canary cohort. Operations roll the ramp by adding seniors here. Active
-- membership is rows with removed_at IS NULL.
--
-- This table is the source of truth for canary membership. The legacy
-- env-var fallback (CALL_QUEUE_COHORT_ALLOWLIST) remains for emergency
-- override / pre-DB-migration environments.

CREATE TABLE IF NOT EXISTS canary_cohort_membership (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  senior_id UUID NOT NULL REFERENCES seniors(id),
  ramp_phase VARCHAR(50) NOT NULL,
  added_at TIMESTAMP NOT NULL DEFAULT NOW(),
  added_by TEXT,
  removed_at TIMESTAMP,
  removed_reason TEXT,
  notes TEXT
);

-- Hot path: "give me the active canary set" should be a single index scan.
-- The partial unique constraint allows a senior to be removed and later
-- re-added while preserving historical rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_canary_cohort_active
  ON canary_cohort_membership(senior_id)
  WHERE removed_at IS NULL;

-- Audit / ramp-history path: per-phase listing.
CREATE INDEX IF NOT EXISTS idx_canary_cohort_phase_added
  ON canary_cohort_membership(ramp_phase, added_at DESC);

COMMENT ON TABLE canary_cohort_membership
  IS 'Phase 7 small live canary cohort membership. senior_id is the canary subject; ramp_phase is "5" / "10" / "25" etc; removed_at IS NULL = currently in canary.';
COMMENT ON COLUMN canary_cohort_membership.ramp_phase
  IS 'Free-form ramp tag (e.g. "5", "10", "25"). Used for cohort phase reporting; not enforced as enum.';
COMMENT ON COLUMN canary_cohort_membership.added_by
  IS 'admin_users.id (UUID as text) of the operator who added the senior. Audit trail; not validated as FK so DELETE on admin_users does not cascade-prune canary history.';
COMMENT ON COLUMN canary_cohort_membership.removed_reason
  IS 'PHI-free reason string: "phase_complete", "ramp_back", "rollback_legacy_only", "manual_admin". Never includes call content.';
