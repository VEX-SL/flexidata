/**
 * JSON Repair — turns messy model output into a parseable object.
 * Handles: code fences, trailing text, first/last brace isolation, trailing
 * commas, and partially-valid JSON.
 */

export function extractJSON(text: string): unknown {
  if (!text || text.trim().length === 0) {
    throw new Error("Empty model output — nothing to parse");
  }

  let candidate = stripCodeFences(text.trim());

  // Isolate the outermost JSON object/array (models often add prose around it).
  const outer = findOuterBracket(candidate);
  if (outer) {
    candidate = candidate.slice(outer.start, outer.end + 1);
  }

  // Attempt 1: parse as-is.
  try {
    return JSON.parse(candidate);
  } catch {
    // Attempt 2: remove trailing commas (most common repair).
  }

  const cleaned = candidate.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(cleaned);
  } catch {
    // Attempt 3: rebuild from the last viable closing bracket.
    const last = lastBalanced(candidate);
    if (last) {
      try {
        return JSON.parse(last);
      } catch {
        // ignore
      }
    }
  }

  throw new Error("Unable to parse model output as JSON");
}

/** Remove ```json ... ``` fences (open or closed). */
export function stripCodeFences(text: string): string {
  return text
    .replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1")
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

/** Return the index range of the outermost { ... } or [ ... ]. */
function findOuterBracket(text: string): { start: number; end: number } | null {
  const startIdx = text.search(/[[{]/);
  if (startIdx < 0) return null;

  const opener = text[startIdx];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return { start: startIdx, end: i };
    }
  }
  return null;
}

/** From the last opening bracket, find the longest balanced substring. */
function lastBalanced(text: string): string | null {
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    const range = findOuterBracket(text.slice(start));
    if (range) {
      return text.slice(start, start + range.end + 1);
    }
  }
  return null;
}
