-- ====================================================
-- FlexiData AI — Document Intelligence Pipeline
-- Run this in: Supabase Dashboard > SQL Editor
-- (Run AFTER schema.sql)
-- ====================================================

-- ==========================================
-- 1. Extraction Profiles (catalog of profile plugins)
--    Each row = one versioned profile (schema + prompt + rules
--    live in code; this table tracks versions + enabled state).
-- ==========================================
CREATE TABLE IF NOT EXISTS public.extraction_profiles (
  id         TEXT PRIMARY KEY,          -- slug, e.g. 'invoice', 'receipt'
  version    INTEGER NOT NULL DEFAULT 1,
  label      TEXT NOT NULL,
  doc_types  TEXT[] NOT NULL DEFAULT '{}',
  enabled    BOOLEAN NOT NULL DEFAULT true,
  schema_def JSONB,                     -- JSON Schema of the profile's fields (for UI/review)
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 2. Extractions (pipeline run results)
--    Immutable metadata (pipeline_version, profile_version, provider, model,
--    processing_time_ms, created_at) is written once on completion and never
--    updated afterwards. idempotency_key enforces exactly-once runs.
-- ==========================================
CREATE TABLE IF NOT EXISTS public.extractions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  file_id            UUID REFERENCES public.files(id) ON DELETE SET NULL,
  idempotency_key    TEXT,                     -- dedupe: client key or file:<file_id>
  profile_type       TEXT NOT NULL DEFAULT 'unknown',
  profile_version    INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued','classifying','extracting','validating','complete','error')),
  -- ── Immutable metadata (set once) ──
  pipeline_version   INTEGER NOT NULL DEFAULT 1,
  provider           TEXT,                     -- which AI provider served the run
  model              TEXT,                     -- which AI model produced the extraction
  processing_time_ms INTEGER,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  completed_at       TIMESTAMPTZ,
  -- ── Results (written once on completion) ──
  overall_confidence NUMERIC(5,4),             -- 0..1
  fields_json        JSONB,                    -- [{key,value,confidence,source,status}]
  validation_json    JSONB,                    -- {ok, missing, results[]}
  confidence_json    JSONB,                    -- {overall, signals, summary[]}
  trace_json         JSONB,                    -- TraceEvent[] (debugging/monitoring)
  error_json         JSONB,                    -- StructuredError {stage,code,message,retryable,details}
  source_text        TEXT,                     -- truncated extracted text (review/debug)
  ocr_confidence     NUMERIC(5,4),
  ocr_json           JSONB,                    -- OcrDocument {text, lines[], confidence} for the readable review preview
  error_message      TEXT,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- Triggers
-- ==========================================
DROP TRIGGER IF EXISTS extractions_updated_at ON public.extractions;
CREATE TRIGGER extractions_updated_at
  BEFORE UPDATE ON public.extractions
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

DROP TRIGGER IF EXISTS extraction_profiles_updated_at ON public.extraction_profiles;
CREATE TRIGGER extraction_profiles_updated_at
  BEFORE UPDATE ON public.extraction_profiles
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

-- ==========================================
-- Seed data: built-in profile plugins (v1)
-- ==========================================
INSERT INTO public.extraction_profiles (id, version, label, doc_types)
VALUES
  ('invoice',  1, 'Invoice',   ARRAY['invoice', 'فاتورة', 'faktur', 'facture']),
  ('receipt',  1, 'Receipt',   ARRAY['receipt', 'إيصال', 'kwitansi', 'reçu']),
  ('resume',   1, 'Resume',    ARRAY['resume', 'cv', 'curriculum vitae', 'سيرة ذاتية']),
  ('contract', 1, 'Contract',  ARRAY['contract', 'agreement', 'عقد', 'ميثاق']),
  ('unknown',  1, 'Unknown',   ARRAY['unknown'])
ON CONFLICT (id) DO NOTHING;

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE public.extraction_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.extractions       ENABLE ROW LEVEL SECURITY;

-- Profiles: authenticated users can read the catalog (writes via service role / seed)
DROP POLICY IF EXISTS "extraction_profiles_read" ON public.extraction_profiles;
CREATE POLICY "extraction_profiles_read"
  ON public.extraction_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL AND enabled = true);

-- Extractions: users can CRUD their own
DROP POLICY IF EXISTS "extractions_all_own" ON public.extractions;
CREATE POLICY "extractions_all_own"
  ON public.extractions FOR ALL
  USING (auth.uid() = user_id);

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_extractions_user_id   ON public.extractions(user_id);
CREATE INDEX IF NOT EXISTS idx_extractions_file_id   ON public.extractions(file_id);
CREATE INDEX IF NOT EXISTS idx_extractions_status    ON public.extractions(status);
CREATE INDEX IF NOT EXISTS idx_extractions_created   ON public.extractions(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_extractions_idempotency
  ON public.extractions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ==========================================
-- Upgrade path for existing databases (idempotent)
-- ==========================================
ALTER TABLE public.extractions ADD COLUMN IF NOT EXISTS ocr_json JSONB;
