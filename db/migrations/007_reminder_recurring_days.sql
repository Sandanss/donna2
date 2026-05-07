-- Add recurring_days column to reminders for day-of-week scheduling.
-- Stores an array of integers 0-6 (0=Sun, 1=Mon, ..., 6=Sat).

ALTER TABLE reminders
  ADD COLUMN IF NOT EXISTS recurring_days JSONB;
