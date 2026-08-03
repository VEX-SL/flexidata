import { readFileSync } from "node:fs";
import { buildSystemPrompt } from "@/lib/ai/prompts";
import { getProviderManager } from "@/lib/ai/manager";
import { createAdminClient } from "@/lib/supabase/admin";

const envPath = new URL("../../.env", import.meta.url);
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!(m[1] in process.env)) process.env[m[1]] = v;
}

const userId = "5fa261e2-b639-4b61-9d51-a7ebeea04f8b";
const agentId = "c470d5c3-198e-42c4-97ed-1422458385bb";
const section = (t: string) => console.log(`\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`);

const supabase = createAdminClient();

// ── Step 1: exactly what /api/chat/message (and /stream) does ──
section("STEP 1 — DOCUMENTS FED TO THE AGENT (same query as the chat routes)");
const { data: agent } = await supabase
  .from("agents")
  .select("id, name, description")
  .eq("id", agentId)
  .eq("user_id", userId)
  .single();
console.log("agent:", JSON.stringify(agent));

const { data: docs } = await supabase
  .from("documents")
  .select("title, parsed_content")
  .eq("agent_id", agentId)
  .order("created_at", { ascending: false })
  .limit(5);

let fileContext = "";
if (docs && docs.length > 0) {
  fileContext = docs
    .map((d) => `### Document: ${d.title}\n${d.parsed_content?.slice(0, 30_000) || ""}`)
    .join("\n\n---\n\n");
  console.log(`found ${docs.length} document(s), context ${fileContext.length} chars`);
} else {
  console.log("no documents found");
}

// ── Step 2: system prompt exactly as the routes build it ──
section("STEP 2 — SYSTEM PROMPT SENT TO THE MODEL");
const systemPrompt =
  buildSystemPrompt("agent") +
  (fileContext ? `\n\n## Provided Context:\n${fileContext}` : "");
console.log(systemPrompt);

// ── Step 3: ask the same kind of question the user asks ──
section("STEP 3 — CHAT COMPLETION (real model, agent mode)");
const userMsg = "ما هو نوع هذا المستند؟ اذكر التفاصيل: المبلغ، التاريخ، التاجر. هل هو فاتورة أم إيصال؟";
console.log("user message:", userMsg);

const manager = getProviderManager();
const result = await manager.chatCompletion({
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMsg },
  ],
});

console.log("\nmodel:", result.model);
console.log("\n--- AGENT RESPONSE ---\n" + result.content);
