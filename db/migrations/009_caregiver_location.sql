-- Store caregiver locality separately from the senior's location so notification
-- timing can use the caregiver's local timezone when they differ.

ALTER TABLE caregivers
  ADD COLUMN IF NOT EXISTS phone varchar(50),
  ADD COLUMN IF NOT EXISTS timezone varchar(100) DEFAULT 'America/New_York',
  ADD COLUMN IF NOT EXISTS city varchar(100),
  ADD COLUMN IF NOT EXISTS state varchar(50),
  ADD COLUMN IF NOT EXISTS zip_code varchar(20),
  ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now();
