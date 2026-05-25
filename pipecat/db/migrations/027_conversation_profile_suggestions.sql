-- Pipecat-side mirror of db/migrations/015_conversation_profile_suggestions.sql.
-- Keep in lockstep with the Node-side migration.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS profile_suggestions JSONB;

CREATE INDEX IF NOT EXISTS idx_conversations_profile_suggestions_pending
  ON conversations (id)
  WHERE profile_suggestions IS NOT NULL;
