-- Deprecate medical-note storage and concern-alert preferences.
-- Columns remain for compatibility with older deployments, but runtime code no
-- longer accepts, reads, or emits these fields.

DO $$
BEGIN
  IF to_regclass('public.seniors') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'seniors'
         AND column_name = 'medical_notes'
     )
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'seniors'
         AND column_name = 'medical_notes_encrypted'
     )
  THEN
    UPDATE seniors
    SET medical_notes = NULL,
        medical_notes_encrypted = NULL
    WHERE medical_notes IS NOT NULL
       OR medical_notes_encrypted IS NOT NULL;
  END IF;

  IF to_regclass('public.notification_preferences') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'notification_preferences'
         AND column_name = 'concern_detected'
     )
  THEN
    ALTER TABLE notification_preferences
      ALTER COLUMN concern_detected SET DEFAULT false;

    UPDATE notification_preferences
    SET concern_detected = false
    WHERE concern_detected IS DISTINCT FROM false;
  END IF;
END $$;
