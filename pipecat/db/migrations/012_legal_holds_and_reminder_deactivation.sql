-- Runtime legal hold support and reminder deactivation timestamps.
-- Legal holds block automated retention and hard-delete flows.

CREATE TABLE IF NOT EXISTS legal_holds (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  resource_type VARCHAR(100) NOT NULL,
  resource_id TEXT NOT NULL,
  hold_reason TEXT NOT NULL,
  placed_by VARCHAR(255) NOT NULL,
  placed_at TIMESTAMP DEFAULT NOW(),
  released_at TIMESTAMP,
  release_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_legal_holds_active_resource
  ON legal_holds(resource_type, resource_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_legal_holds_placed_at
  ON legal_holds(placed_at);

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMP;

UPDATE reminders
SET deactivated_at = COALESCE(last_delivered_at, created_at)
WHERE is_active = false
  AND deactivated_at IS NULL;
