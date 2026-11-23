// Table-recall keyword expansion from the governed semantic layer.
//
// The removed Terminology layer used to fold a synonym group (term + synonyms)
// into the LLM-extracted keyword CSV before keyword-fused table ranking. Its
// replacement is TableSemantic/FieldSemantic.aliases:
//
//   - a keyword hitting a TABLE name/alias folds in that table's name + aliases
//   - a keyword hitting a FIELD name/alias folds in the owning table name and
//     the field name (the recall scorer weighs table names highest)
//
// Matching is case-insensitive but EXACT per comma-separated token — no
// substring/fuzzy matching (aliases are curated; fuzzy expansion would inject
// noise into the fusion score).
//
// Known limitations:
//   - aliases participate in recall only; they are NOT injected into the SQL
//     prompt (the table/field `meaning` is).
//   - the effective row is resolved per natural key, so aliases never merge
//     across layers (a WORKSPACE row hides a PERSONAL row's alias list).
//   - only the first `maxKeywords` output tokens survive (mirrors the old
//     terminology expansion cap).
//
// Pure and DB-free so the expansion strategy is unit-testable in isolation.

/** Minimal table-semantic shape the expansion consumes (aliases are a Json
 *  column, so callers pass the raw value). */
export interface TableAliasRow {
  tableName: string;
  aliases?: unknown;
}

/** Minimal field-semantic shape the expansion consumes. */
export interface FieldAliasRow {
  tableName: string;
  fieldName: string;
  aliases?: unknown;
}

const MAX_KEYWORDS = 10;

/** Defensive parse of a stored aliases JSON blob into trimmed strings. */
function aliasList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a): a is string => typeof a === 'string')
    .map((a) => a.trim())
    .filter(Boolean);
}

function keywordTokens(csv: string): string[] {
  return (csv ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

/** Expand a comma-separated keyword list with table/field semantic aliases.
 *  Returns the ORIGINAL string when nothing matches (callers can persist it
 *  as-is). */
export function expandKeywordsWithAliases(
  keywordsCsv: string,
  tables: readonly TableAliasRow[],
  fields: readonly FieldAliasRow[],
  maxKeywords = MAX_KEYWORDS,
): string {
  const keywords = keywordTokens(keywordsCsv);
  if (keywords.length === 0) return keywordsCsv;
  const limit = Math.max(1, Math.floor(maxKeywords));
  const out = [...keywords];
  const seen = new Set(out.map((k) => k.toLowerCase()));

  const add = (word: string): void => {
    const w = (word ?? '').trim();
    if (!w) return;
    const key = w.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  };

  /** token (lowercased) → the words a hit should fold in. */
  const groups = new Map<string, string[]>();
  const index = (token: string, group: string[]): void => {
    const key = (token ?? '').trim().toLowerCase();
    if (!key) return;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, [...group]);
      return;
    }
    for (const word of group) {
      if (!existing.some((e) => e.toLowerCase() === word.toLowerCase())) {
        existing.push(word);
      }
    }
  };

  for (const table of tables) {
    const group = [table.tableName, ...aliasList(table.aliases)];
    for (const token of group) index(token, group);
  }
  for (const field of fields) {
    // A field hit identifies its OWNER table, so the group is the table + the
    // field itself (not the field's sibling aliases).
    const group = [field.tableName, field.fieldName];
    for (const token of [field.fieldName, ...aliasList(field.aliases)]) {
      index(token, group);
    }
  }

  for (const kw of keywords) {
    if (out.length >= limit) break;
    for (const word of groups.get(kw.toLowerCase()) ?? []) {
      if (out.length >= limit) break;
      add(word);
    }
  }
  // Nothing folded in → hand back the caller's exact string (spacing intact).
  if (out.length === keywords.length) return keywordsCsv;
  return out.slice(0, limit).join(',');
}
