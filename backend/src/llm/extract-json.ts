// Robust nested-JSON extractor for LLM output. Models frequently wrap JSON in
// prose or markdown fences and may include brace/bracket characters inside SQL
// string literals, so a naive JSON.parse or regex fails. A single
// depth/string/escape scan finds each balanced outermost candidate and returns
// the FIRST one that parses. A candidate that fails to parse is skipped as a
// whole — the scan resumes after its closing bracket — so a malformed object
// can never leak one of its own nested children as the "result".

/** Extract and parse the first valid outer JSON object/array in `text`.
 *  Returns null if none parses. (Return type is `unknown`, which already
 *  subsumes `null`.) */
export function extractNestedJson(text: string): unknown {
  if (!text) return null;
  let depth = 0;
  let start = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (depth === 0) {
      if (ch === '{' || ch === '[') {
        start = i;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        // The scanner counts boundaries only — it does not check bracket
        // types (a '{' may close against ']'); JSON.parse validates both.
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}
