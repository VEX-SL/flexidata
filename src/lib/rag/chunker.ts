export interface Chunk {
  content: string;
  index: number;
}

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;

/**
 * Split text into overlapping chunks for embedding.
 * Respects paragraph boundaries when possible.
 */
export function chunkText(text: string): Chunk[] {
  if (!text || !text.trim()) return [];

  // Normalize whitespace but preserve structure
  const normalized = text.replace(/\r\n/g, "\n").trim();

  // If short enough, return as single chunk
  if (normalized.length <= CHUNK_SIZE) {
    return [{ content: normalized, index: 0 }];
  }

  // Split by paragraphs first
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let currentChunk = "";
  let chunkIndex = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // If adding this paragraph exceeds chunk size, save current and start new
    if (
      currentChunk.length + trimmed.length + 2 > CHUNK_SIZE &&
      currentChunk.length > 0
    ) {
      chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });

      // Keep overlap: take the last N characters
      const overlapText = currentChunk.slice(-CHUNK_OVERLAP);
      currentChunk = overlapText + "\n\n" + trimmed;
    } else {
      currentChunk = currentChunk
        ? currentChunk + "\n\n" + trimmed
        : trimmed;
    }

    // If a single paragraph is longer than CHUNK_SIZE, split it by sentences
    while (currentChunk.length > CHUNK_SIZE * 1.5) {
      const splitPoint = findSplitPoint(currentChunk);
      const part = currentChunk.slice(0, splitPoint).trim();
      chunks.push({ content: part, index: chunkIndex++ });

      const overlapText = currentChunk.slice(
        Math.max(0, splitPoint - CHUNK_OVERLAP)
      );
      currentChunk = overlapText;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunks.push({ content: currentChunk.trim(), index: chunkIndex++ });
  }

  return chunks;
}

/**
 * Find a good split point (sentence boundary or newline)
 */
function findSplitPoint(text: string): number {
  // Try to split at a sentence boundary near the target size
  const target = CHUNK_SIZE;

  // Look for sentence endings near the target
  const searchStart = Math.max(0, target - 100);
  const searchEnd = Math.min(text.length, target + 100);
  const searchRegion = text.slice(searchStart, searchEnd);

  // Try period + space, exclamation, question mark
  const sentenceEnd = searchRegion.search(/[.!?]\s/);
  if (sentenceEnd !== -1) {
    return searchStart + sentenceEnd + 2;
  }

  // Try newline
  const newline = searchRegion.search(/\n/);
  if (newline !== -1) {
    return searchStart + newline + 1;
  }

  // Try space
  const space = searchRegion.lastIndexOf(" ");
  if (space !== -1) {
    return searchStart + space + 1;
  }

  // Fallback: hard split at target
  return target;
}
