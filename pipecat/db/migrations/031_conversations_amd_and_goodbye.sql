-- Pipecat-side mirror of db/migrations/020_conversations_amd_and_goodbye.sql.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS amd_result VARCHAR(40),
  ADD COLUMN IF NOT EXISTS goodbye_detected_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS end_reason VARCHAR(60);
