-- profile_suggestions JSONB on conversations.
--
-- Discovery calls (call_type='discovery') emit a structured list of proposed
-- profile updates — friends, hobbies, interests, routines, family — captured
-- via the record_discovery_fact tool. The list is saved here at post-call
-- time so caregivers can review-and-approve before any change lands on
-- seniors.interests / seniors.family_info. Storage is per-conversation so we
-- preserve the source of each suggestion (audit + lets caregivers reject
-- one call's suggestions without affecting others).
--
-- Payload shape (PHI — application is responsible for any encryption):
--   {
--     "captured_at": "2026-05-24T15:30:00-04:00",
--     "facts": [
--       { "category": "friend", "content": "Plays bridge Thursdays with Eleanor",
--         "confidence": "stated" }
--     ]
--   }

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS profile_suggestions JSONB;

CREATE INDEX IF NOT EXISTS idx_conversations_profile_suggestions_pending
  ON conversations (id)
  WHERE profile_suggestions IS NOT NULL;

COMMENT ON COLUMN conversations.profile_suggestions
  IS 'JSONB list of caregiver-reviewable profile facts from a discovery call. App writes; caregiver UI reads, approves, applies to seniors.* fields.';
