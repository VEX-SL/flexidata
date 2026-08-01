import type {
  AIClient,
  ClassificationResult,
  ExtractionProfile,
  ProfileType,
} from "./types";
import { getProfileManager } from "./profiles/registry";
import { defaultAIClient } from "./ai";

const KNOWN_TYPES: ProfileType[] = [
  "invoice",
  "receipt",
  "resume",
  "contract",
  "unknown",
];

export interface ClassifyOptions {
  pinned?: ProfileType;
  /** Injected for testability — defaults to the real AIClient adapter. */
  ai?: AIClient;
}

/**
 * Classifier — AI-first, rule-validated, "unknown" fallback.
 * Order (per architecture decision):
 *   1. AI classification  →  2. rule validation of the AI answer
 *   3. rule-based fallback (never keyword-first)  →  4. Unknown
 *
 * Pure module: no provider/database dependency when an AIClient is injected.
 */
export async function classifyDocument(
  sourceText: string,
  opts: ClassifyOptions = {}
): Promise<ClassificationResult> {
  if (opts.pinned && (KNOWN_TYPES as string[]).includes(opts.pinned)) {
    return {
      profileType: opts.pinned,
      confidence: 1,
      source: "rule",
      reasons: ["Profile pinned by caller"],
      candidates: [{ profileType: opts.pinned, confidence: 1 }],
    };
  }

  const profiles = getProfileManager().candidates();
  const ai = opts.ai ?? defaultAIClient;

  let aiResult: ClassificationResult | null = null;
  try {
    aiResult = await aiClassify(ai, profiles, sourceText);
  } catch (err) {
    console.error("[Pipeline] AI classification failed:", err);
  }

  // Rule-validate the AI answer: if it strongly disagrees, trust the rules.
  if (aiResult && aiResult.profileType !== "unknown") {
    const ruleScore = scoreByAliases(sourceText, aiResult.profileType);
    if (ruleScore <= 0 && aiResult.confidence < 0.5) {
      console.warn(
        `[Pipeline] AI classified '${aiResult.profileType}' but rules found no markers; deferring to rules`
      );
      aiResult = null;
    }
  }

  if (aiResult) {
    return aiResult;
  }

  // Rule-based fallback (only reached when AI is unavailable/empty).
  const best = ruleClassify(sourceText, profiles);
  if (best) {
    best.reasons = ["Rule-based fallback (AI unavailable)"];
    best.source = "rule";
    return best;
  }

  return {
    profileType: "unknown",
    confidence: 0,
    source: "fallback",
    reasons: ["No classifier signal matched"],
    candidates: [],
  };
}

async function aiClassify(
  ai: AIClient,
  profiles: ExtractionProfile[],
  text: string
): Promise<ClassificationResult> {
  const options = profiles.map((p) => p.id).join(", ");
  const prompt =
    `Classify this document into exactly one type: ${options}.\n` +
    `Respond with ONLY JSON: {"type": "...", "confidence": 0.0-1.0, "reasons": ["..."]}.\n\n` +
    `Document (first 6000 characters):\n${text.slice(0, 6000)}`;

  const response = await ai.chatCompletion({
    messages: [
      {
        role: "system",
        content:
          "You are a document classifier. Reply with ONLY a JSON object, no markdown.",
      },
      { role: "user", content: prompt },
    ],
    maxTokens: 300,
    temperature: 0,
  });

  const parsed = parseClassification(response.content ?? "");
  const type = clampToKnown(parsed?.type);
  const confidence = clampConfidence(parsed?.confidence);
  const reasons: string[] = Array.isArray(parsed?.reasons)
    ? parsed.reasons.map(String).slice(0, 5)
    : [];

  return {
    profileType: type,
    confidence,
    source: "ai",
    reasons,
    candidates: [{ profileType: type, confidence }],
  };
}

function parseClassification(
  content: string
): { type?: string; confidence?: number; reasons?: string[] } | null {
  try {
    const cleaned = content
      .replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1")
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end < start) return null;
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function clampToKnown(value: unknown): ProfileType {
  const lower = String(value ?? "").trim().toLowerCase();
  if ((KNOWN_TYPES as string[]).includes(lower)) return lower as ProfileType;
  return "unknown";
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Alias-based scoring used ONLY for validation/fallback, never as the
 * primary classification signal. Scans the document head (first 3000 chars).
 */
function scoreByAliases(text: string, profileId: string): number {
  const profile = getProfileManager().get(profileId);
  if (!profile) return 0;
  const head = text.slice(0, 3000).toLowerCase();
  return profile.docTypes.reduce(
    (score, alias) => (head.includes(alias.toLowerCase()) ? score + 1 : score),
    0
  );
}

function ruleClassify(
  text: string,
  profiles: ExtractionProfile[]
): ClassificationResult | null {
  let best: { profile: ExtractionProfile; score: number } | null = null;
  const head = text.slice(0, 3000).toLowerCase();

  for (const profile of profiles) {
    let score = 0;
    for (const alias of profile.docTypes) {
      const aliasLower = alias.toLowerCase();
      if (aliasLower.length < 3) continue;
      const matches = head.split(aliasLower).length - 1;
      score += matches;
    }
    if (!best || score > best.score) best = { profile, score };
  }

  if (!best || best.score <= 0) return null;

  const type = clampToKnown(best.profile.id);
  return {
    profileType: type,
    confidence: Math.min(1, 0.4 + best.score * 0.15),
    source: "rule",
    reasons: [`Rule-based match with ${best.score} alias hit(s)`],
    candidates: [{ profileType: type, confidence: best.score }],
  };
}

export { scoreByAliases };
