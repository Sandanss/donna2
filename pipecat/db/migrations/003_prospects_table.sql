-- Migration: Add prospects table for unsubscribed new customer callers
-- Run against: dev, staging, production Neon branches

-- Prospects table — tracks unsubscribed callers across calls
CREATE TABLE IF NOT EXISTS prospects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phone VARCHAR(50) NOT NULL UNIQUE,
  learned_name VARCHAR(255),
  relationship VARCHAR(100),
  loved_one_name VARCHAR(255),
  caller_context JSONB DEFAULT '{}',
  call_count INTEGER DEFAULT 0,
  first_call_at TIMESTAMP DEFAULT NOW(),
  last_call_at TIMESTAMP DEFAULT NOW(),
  converted_senior_id UUID REFERENCES seniors(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Allow memories and conversations to reference prospects
ALTER TABLE memories ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_prospects_phone ON prospects(phone);
CREATE INDEX IF NOT EXISTS idx_memories_prospect_id ON memories(prospect_id) WHERE prospect_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_prospect_id ON conversations(prospect_id) WHERE prospect_id IS NOT NULL;
