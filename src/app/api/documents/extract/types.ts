/**
 * Shared types and helpers for the document extraction route.
 *
 * Kept in a separate module so the route handler can export only the
 * HTTP-method exports that Next.js expects, without tripping the
 * generated type checker.
 */

export type DocumentPipeline = (
  buffer: Buffer,
  schema: import("@/lib/extraction/pipeline").PipelineSchema,
) => Promise<{
  result: {
    data: Record<string, unknown>;
    meta: Record<string, unknown>;
    issues: unknown[];
    overallConfidence: number;
  };
  elapsedMs: number;
}>;

export type PdfRenderer = (buffer: Buffer) => Promise<Buffer>;
