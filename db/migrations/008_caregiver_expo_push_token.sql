-- Add expo_push_token column to caregivers so the backend can send push
-- notifications to the mobile app (e.g. invalidate reminder/schedule caches
-- when Donna creates a reminder by voice).

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS expo_push_token VARCHAR(255),
  ADD COLUMN IF NOT EXISTS expo_push_token_updated_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS caregivers_expo_push_token_idx
  ON caregivers (expo_push_token)
  WHERE expo_push_token IS NOT NULL;
