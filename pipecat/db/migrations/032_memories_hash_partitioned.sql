-- Partition senior memories by senior_id and split prospect memories.
--
-- Run on a database clone first. This rebuilds the memories table so every
-- senior memory read/write can prune to one of 64 hash partitions.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS prospect_memories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL,
  type VARCHAR(50) NOT NULL,
  content TEXT NOT NULL DEFAULT '[encrypted]',
  content_encrypted TEXT,
  source VARCHAR(255),
  importance INTEGER DEFAULT 50,
  embedding vector(1536),
  metadata JSON,
  created_at TIMESTAMP DEFAULT NOW(),
  last_accessed_at TIMESTAMP
);

DO $$
BEGIN
  IF to_regclass('public.prospects') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM pg_constraint
       WHERE conname = 'prospect_memories_prospect_id_fkey'
         AND conrelid = 'public.prospect_memories'::regclass
     ) THEN
    ALTER TABLE public.prospect_memories
      ADD CONSTRAINT prospect_memories_prospect_id_fkey
      FOREIGN KEY (prospect_id) REFERENCES public.prospects(id);
  END IF;
END $$;

DO $$
DECLARE
  old_has_prospect_id BOOLEAN := FALSE;
  is_partitioned BOOLEAN := FALSE;
  partition_index INTEGER;
  partition_suffix TEXT;
BEGIN
  IF to_regclass('public.memories') IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM pg_partitioned_table
      WHERE partrelid = 'public.memories'::regclass
    ) INTO is_partitioned;
  END IF;

  IF NOT is_partitioned THEN
    IF to_regclass('public.memories_unpartitioned_backup') IS NOT NULL THEN
      RAISE EXCEPTION 'memories_unpartitioned_backup already exists; inspect and remove it before rerunning migration 032';
    END IF;

    IF to_regclass('public.memories') IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'memories'
          AND column_name = 'prospect_id'
      ) INTO old_has_prospect_id;

      ALTER TABLE public.memories RENAME TO memories_unpartitioned_backup;
    END IF;

    CREATE TABLE IF NOT EXISTS public.memories (
      id UUID NOT NULL DEFAULT gen_random_uuid(),
      senior_id UUID NOT NULL REFERENCES public.seniors(id),
      type VARCHAR(50) NOT NULL,
      content TEXT NOT NULL DEFAULT '[encrypted]',
      content_encrypted TEXT,
      source VARCHAR(255),
      importance INTEGER DEFAULT 50,
      embedding vector(1536),
      metadata JSON,
      created_at TIMESTAMP DEFAULT NOW(),
      last_accessed_at TIMESTAMP,
      PRIMARY KEY (senior_id, id)
    ) PARTITION BY HASH (senior_id);

    FOR partition_index IN 0..63 LOOP
      partition_suffix := lpad(partition_index::text, 2, '0');
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS public.memories_p%s PARTITION OF public.memories FOR VALUES WITH (modulus 64, remainder %s)',
        partition_suffix,
        partition_index
      );
    END LOOP;

    IF to_regclass('public.memories_unpartitioned_backup') IS NOT NULL THEN
      EXECUTE
        'INSERT INTO public.memories
           (id, senior_id, type, content, content_encrypted, source,
            importance, embedding, metadata, created_at, last_accessed_at)
         SELECT id, senior_id, type, COALESCE(content, ''[encrypted]''), content_encrypted, source,
                importance, embedding, metadata, COALESCE(created_at, NOW()), last_accessed_at
         FROM public.memories_unpartitioned_backup
         WHERE senior_id IS NOT NULL
         ON CONFLICT (senior_id, id) DO NOTHING';

      IF old_has_prospect_id THEN
        EXECUTE
          'INSERT INTO public.prospect_memories
             (id, prospect_id, type, content, content_encrypted, source,
              importance, embedding, metadata, created_at, last_accessed_at)
           SELECT id, prospect_id, type, COALESCE(content, ''[encrypted]''), content_encrypted, source,
                  importance, embedding, metadata, COALESCE(created_at, NOW()), last_accessed_at
           FROM public.memories_unpartitioned_backup
           WHERE prospect_id IS NOT NULL
           ON CONFLICT (id) DO NOTHING';
      END IF;

      DROP TABLE public.memories_unpartitioned_backup;
    END IF;
  END IF;

  FOR partition_index IN 0..63 LOOP
    partition_suffix := lpad(partition_index::text, 2, '0');
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)',
      'idx_memories_p' || partition_suffix || '_embedding_hnsw',
      'memories_p' || partition_suffix
    );
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_memories_id_lookup
  ON memories(id);

CREATE INDEX IF NOT EXISTS idx_memories_senior_importance_created
  ON memories(senior_id, importance DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_senior_created
  ON memories(senior_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_memories_prospect_created
  ON prospect_memories(prospect_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_memories_prospect_importance_created
  ON prospect_memories(prospect_id, importance DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prospect_memories_embedding_hnsw
  ON prospect_memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

COMMENT ON TABLE memories
  IS 'Senior semantic memories, hash-partitioned by senior_id into 64 partitions.';

COMMENT ON TABLE prospect_memories
  IS 'Onboarding/prospect semantic memories kept separate from senior hash partitions.';
