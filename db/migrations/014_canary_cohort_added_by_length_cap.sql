-- Defense-in-depth: cap canary_cohort_membership.added_by at 255 chars.
-- The route at routes/canary.js passes req.auth.userId (Clerk IDs are
-- short) but the column was declared unbounded TEXT. Capping at the DB
-- layer prevents accidental large strings from any future caller.
--
-- ALTER COLUMN TYPE with an existing TEXT → VARCHAR(N) cast is safe
-- because every existing value is well under the limit (operator IDs).
-- PG performs a table rewrite for ALTER TYPE on a populated table — at
-- target scale (<10k rows for the foreseeable future) this is fine.
-- Run outside a transaction is NOT required; the standard transactional
-- migration path is safe here.

ALTER TABLE canary_cohort_membership
  ALTER COLUMN added_by TYPE VARCHAR(255);

COMMENT ON COLUMN canary_cohort_membership.added_by
  IS 'admin_users.id (UUID as text) or Clerk user ID of the operator who added the senior. Audit trail; not validated as FK so DELETE on admin_users does not cascade-prune canary history. Capped at 255 chars for defense-in-depth.';
