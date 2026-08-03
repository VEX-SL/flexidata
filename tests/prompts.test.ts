import { buildSystemPrompt } from "@/lib/ai/prompts";
import { test, includes } from "./harness.ts";

test("agent prompt forbids relabeling the document type from content", () => {
  const p = buildSystemPrompt("agent");
  includes(p, "Never relabel");
  includes(p, "payment receipt is NOT an invoice");
});

test("agent prompt forbids inventing fields that are not in the document", () => {
  const p = buildSystemPrompt("agent");
  includes(p, "Do NOT invent fields");
  includes(p, "invoice number");
});

test("agent prompt warns that OCR output can be garbled and must be flagged", () => {
  const p = buildSystemPrompt("agent");
  includes(p, "OCR");
  includes(p, "garbled");
  includes(p, "flag");
});
