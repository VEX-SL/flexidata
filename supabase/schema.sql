-- ====================================================
-- FlexiData AI — Supabase Database Schema
-- Run this in: Supabase Dashboard > SQL Editor
-- ====================================================

-- Enable pgvector for RAG (Milestone 3)
CREATE EXTENSION IF NOT EXISTS vector;

-- ==========================================
-- 1. Profiles (auto-created on signup via trigger)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT,
  avatar_url  TEXT,
  plan        TEXT DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- ==========================================
-- 2. Files
-- ==========================================
CREATE TABLE IF NOT EXISTS public.files (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  url            TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     BIGINT DEFAULT 0,
  extracted_text TEXT,
  status         TEXT DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error_message  TEXT,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 3. Chats
-- ==========================================
CREATE TABLE IF NOT EXISTS public.chats (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id    UUID,
  file_id     UUID REFERENCES public.files(id) ON DELETE SET NULL,
  title       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chats_updated_at ON public.chats;
CREATE TRIGGER chats_updated_at
  BEFORE UPDATE ON public.chats
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

-- ==========================================
-- 4. Messages
-- ==========================================
CREATE TABLE IF NOT EXISTS public.messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id    UUID NOT NULL REFERENCES public.chats(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 5. Agents
-- ==========================================
CREATE TABLE IF NOT EXISTS public.agents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  system_prompt     TEXT,
  model_preference  TEXT,
  temperature       NUMERIC(3,2) DEFAULT 0.7,
  visibility        TEXT DEFAULT 'private' CHECK (visibility IN ('private', 'shared', 'public')),
  share_token       TEXT UNIQUE,
  chats_count       INTEGER DEFAULT 0,
  files_count       INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS agents_updated_at ON public.agents;
CREATE TRIGGER agents_updated_at
  BEFORE UPDATE ON public.agents
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

-- ==========================================
-- 6. Agent Files
-- ==========================================
CREATE TABLE IF NOT EXISTS public.agent_files (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id     UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  file_name    TEXT NOT NULL,
  file_type    TEXT NOT NULL,
  file_url     TEXT,
  status       TEXT DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'indexed', 'error')),
  error_message TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 7. Documents (parsed content for RAG)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  source_file_id  UUID NOT NULL REFERENCES public.agent_files(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  parsed_content  TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 8. Document Chunks (pgvector embeddings for RAG)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.document_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   UUID NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  agent_id      UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  content       TEXT NOT NULL,
  embedding     vector(384),
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding
  ON public.document_chunks
  USING hnsw (embedding vector_cosine_ops);

-- ==========================================
-- 9. Agent Shares (public share links)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.agent_shares (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  share_token TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- 10. Provider Logs (AI usage tracking)
-- ==========================================
CREATE TABLE IF NOT EXISTS public.provider_logs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  prompt_tokens     INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms        INTEGER DEFAULT 0,
  success           BOOLEAN DEFAULT true,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ==========================================
-- Row Level Security
-- ==========================================
ALTER TABLE public.profiles        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_files     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_shares    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_logs   ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read/update own profile
CREATE POLICY "profiles_select_own" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE USING (auth.uid() = id);

-- Files: users can CRUD own files
CREATE POLICY "files_all_own" ON public.files FOR ALL USING (auth.uid() = user_id);

-- Chats: users can CRUD own chats
CREATE POLICY "chats_all_own" ON public.chats FOR ALL USING (auth.uid() = user_id);

-- Messages: users can read/create messages on their own chats
CREATE POLICY "messages_select_own" ON public.messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.chats WHERE id = messages.chat_id AND user_id = auth.uid())
);
CREATE POLICY "messages_insert_own" ON public.messages FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.chats WHERE id = messages.chat_id AND user_id = auth.uid())
);

-- Agents: users can CRUD own agents
CREATE POLICY "agents_all_own" ON public.agents FOR ALL USING (auth.uid() = user_id);

-- Agent Files: users can CRUD files on their own agents
CREATE POLICY "agent_files_all_own" ON public.agent_files FOR ALL USING (
  EXISTS (SELECT 1 FROM public.agents WHERE id = agent_files.agent_id AND user_id = auth.uid())
);

-- Documents: users can CRUD documents on their own agents
CREATE POLICY "documents_all_own" ON public.documents FOR ALL USING (
  EXISTS (SELECT 1 FROM public.agents WHERE id = documents.agent_id AND user_id = auth.uid())
);

-- Document Chunks: users can CRUD chunks on their own agents
CREATE POLICY "document_chunks_all_own" ON public.document_chunks FOR ALL USING (
  EXISTS (SELECT 1 FROM public.agents WHERE id = document_chunks.agent_id AND user_id = auth.uid())
);

-- Agent Shares: anyone can read shares (for public agent access), owner can manage
CREATE POLICY "agent_shares_public_read" ON public.agent_shares FOR SELECT USING (true);
CREATE POLICY "agent_shares_owner_all" ON public.agent_shares FOR ALL USING (
  EXISTS (SELECT 1 FROM public.agents WHERE id = agent_shares.agent_id AND user_id = auth.uid())
);

-- Provider Logs: users can read own logs, service role inserts
CREATE POLICY "provider_logs_select_own" ON public.provider_logs FOR SELECT USING (auth.uid() = user_id);

-- ==========================================
-- Indexes
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_files_user_id         ON public.files(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_user_id         ON public.chats(user_id);
CREATE INDEX IF NOT EXISTS idx_chats_file_id         ON public.chats(file_id);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id      ON public.messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_created      ON public.messages(chat_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agents_user_id        ON public.agents(user_id);
CREATE INDEX IF NOT EXISTS idx_agents_share_token    ON public.agents(share_token);
CREATE INDEX IF NOT EXISTS idx_agent_files_agent_id  ON public.agent_files(agent_id);
CREATE INDEX IF NOT EXISTS idx_documents_agent_id    ON public.documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_documents_source      ON public.documents(source_file_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_agent ON public.document_chunks(agent_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_doc   ON public.document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_provider_logs_user    ON public.provider_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_provider_logs_created ON public.provider_logs(created_at);
