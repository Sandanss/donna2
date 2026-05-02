-- Add call_summaries and pause_calls columns to notification_preferences
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS call_summaries BOOLEAN DEFAULT true;
ALTER TABLE notification_preferences ADD COLUMN IF NOT EXISTS pause_calls BOOLEAN DEFAULT false;
