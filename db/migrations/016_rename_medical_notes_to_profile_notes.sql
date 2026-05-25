-- Rename senior profile free-text notes away from medical framing.
-- Existing encrypted/plaintext data is preserved by renaming the columns
-- when the old names exist. The copy branches make this safe if a database
-- already has both names from a partial/manual migration.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'medical_notes'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'profile_notes'
  ) THEN
    ALTER TABLE seniors RENAME COLUMN medical_notes TO profile_notes;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'profile_notes'
  ) THEN
    ALTER TABLE seniors ADD COLUMN profile_notes TEXT;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'medical_notes'
  ) THEN
    UPDATE seniors
    SET profile_notes = medical_notes
    WHERE profile_notes IS NULL AND medical_notes IS NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'medical_notes_encrypted'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'profile_notes_encrypted'
  ) THEN
    ALTER TABLE seniors RENAME COLUMN medical_notes_encrypted TO profile_notes_encrypted;
  ELSIF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'profile_notes_encrypted'
  ) THEN
    ALTER TABLE seniors ADD COLUMN profile_notes_encrypted TEXT;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'seniors' AND column_name = 'medical_notes_encrypted'
  ) THEN
    UPDATE seniors
    SET profile_notes_encrypted = medical_notes_encrypted
    WHERE profile_notes_encrypted IS NULL
      AND medical_notes_encrypted IS NOT NULL;
  END IF;
END $$;
