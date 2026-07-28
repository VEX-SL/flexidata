let embeddingPipeline: any = null;

const MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

async function getPipeline() {
  if (!embeddingPipeline) {
    console.log(`[RAG] Loading embedding model: ${MODEL_NAME}`);
    const { pipeline, env } = await import("@xenova/transformers");
    env.allowLocalModels = true;
    embeddingPipeline = await pipeline("feature-extraction", MODEL_NAME, {
      quantized: true,
    });
    console.log(`[RAG] Embedding model loaded`);
  }
  return embeddingPipeline;
}

export async function embedText(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data) as number[];
}

export async function embedTexts(
  texts: string[]
): Promise<number[][]> {
  const pipe = await getPipeline();
  const embeddings: number[][] = [];

  // Process in batches of 32 to avoid memory issues
  const batchSize = 32;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (text) => {
        const output = await pipe(text, { pooling: "mean", normalize: true });
        return Array.from(output.data) as number[];
      })
    );
    embeddings.push(...results);
  }

  return embeddings;
}

/**
 * Format a number array as a pgvector literal string: '[0.1,0.2,...]'
 */
export function toPgVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
