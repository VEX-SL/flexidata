-- ====================================================
-- FlexiData AI — RAG Search Functions
-- Run this in: Supabase Dashboard > SQL Editor
-- ====================================================

-- Function: Search document chunks by cosine similarity
CREATE OR REPLACE FUNCTION public.search_document_chunks(
  p_agent_id UUID,
  p_embedding VECTOR(384),
  p_match_count INT DEFAULT 8
)
RETURNS TABLE (
  content TEXT,
  document_title TEXT,
  score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.content,
    d.title AS document_title,
    (1 - (dc.embedding <=> p_embedding))::FLOAT AS score
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.agent_id = p_agent_id
    AND dc.embedding IS NOT NULL
  ORDER BY dc.embedding <=> p_embedding
  LIMIT p_match_count;
END;
$$;

-- Fallback raw search (if RPC above fails)
CREATE OR REPLACE FUNCTION public.search_chunks_raw(
  p_agent_id UUID,
  p_embedding TEXT,
  p_top_k INT DEFAULT 8
)
RETURNS TABLE (
  content TEXT,
  document_title TEXT,
  score FLOAT
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT
    dc.content,
    d.title AS document_title,
    (1 - (dc.embedding <=> p_embedding::vector))::FLOAT AS score
  FROM public.document_chunks dc
  JOIN public.documents d ON d.id = dc.document_id
  WHERE dc.agent_id = p_agent_id
    AND dc.embedding IS NOT NULL
  ORDER BY dc.embedding <=> p_embedding::vector
  LIMIT p_top_k;
END;
$$;
