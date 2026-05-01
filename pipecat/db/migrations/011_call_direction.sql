-- Add direction column to conversations table
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS direction VARCHAR(20);
CREATE INDEX IF NOT EXISTS idx_conversations_direction ON conversations(direction) WHERE direction IS NOT NULL;

-- Backfill: all existing senior conversations were outbound
UPDATE conversations SET direction = 'outbound' WHERE direction IS NULL AND senior_id IS NOT NULL;
UPDATE conversations SET direction = 'inbound' WHERE direction IS NULL AND prospect_id IS NOT NULL;
