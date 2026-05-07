-- Track how a reminder was created so the mobile/web app can badge
-- voice-created reminders distinctly from caregiver-created ones.
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS created_via VARCHAR(20) NOT NULL DEFAULT 'manual';
