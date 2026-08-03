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

test("agent prompt forbids claiming it cannot see provided documents", () => {
  const p = buildSystemPrompt("agent");
  includes(p, "NEVER claim you cannot see");
  includes(p, "I can't see the image");
});

test("agent prompt scopes uncertainty to flagged/ambiguous fields and discourages fake percentages", () => {
  const p = buildSystemPrompt("agent");
  includes(p, "Mention uncertainty ONLY for fields explicitly marked uncertain");
  includes(p, "Never state a numeric confidence from the context as an exact percentage");
  includes(p, "Present extracted fields naturally");
});
