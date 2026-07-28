import { createAdminClient } from "@/lib/supabase/admin";
import { embedText } from "./embedding";

const DEFAULT_TOP_K = 8;

/**
 * Semantic search: embed the query, then find the most similar chunks
 * using pgvector cosine similarity.
 */
export async function searchRelevantChunks(
  agentId: string,
  query: string,
  topK: number = DEFAULT_TOP_K
): Promise<{ content: string; documentTitle: string; score: number }[]> {
  const supabase = createAdminClient();

  // Embed the query
  const queryEmbedding = await embedText(query);
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  // Search using pgvector cosine similarity
  const { data: chunks, error } = await supabase.rpc(
    "search_document_chunks",
    {
      p_agent_id: agentId,
      p_embedding: embeddingLiteral,
      p_match_count: topK,
    }
  );

  if (error) {
    // Fallback: try direct query if RPC doesn't exist
    console.warn("[RAG] RPC search failed, trying direct query:", error.message);
    return await searchFallback(agentId, embeddingLiteral, topK);
  }

  return chunks || [];
}

/**
 * Fallback search using direct SQL if the RPC function doesn't exist yet.
 */
async function searchFallback(
  agentId: string,
  embeddingLiteral: string,
  topK: number
): Promise<{ content: string; documentTitle: string; score: number }[]> {
  const supabase = createAdminClient();

  // Use raw SQL for cosine similarity search
  const { data, error } = await supabase.rpc("search_chunks_raw", {
    p_agent_id: agentId,
    p_embedding: embeddingLiteral,
    p_top_k: topK,
  });

  if (error) {
    console.error("[RAG] Fallback search failed:", error.message);
    return [];
  }

  return data || [];
}

/**
 * Build context string from search results for injection into the AI prompt.
 */
export function buildRAGContext(
  results: { content: string; documentTitle: string; score: number }[]
): string {
  if (results.length === 0) return "";

  // Group by document title
  const byDoc = new Map<string, string[]>();
  for (const r of results) {
    const existing = byDoc.get(r.documentTitle) || [];
    existing.push(r.content);
    byDoc.set(r.documentTitle, existing);
  }

  const parts: string[] = [];
  for (const [title, chunks] of byDoc) {
    const combined = chunks.join("\n\n---\n\n");
    parts.push(`### ${title}\n${combined}`);
  }

  return parts.join("\n\n---\n\n");
}
