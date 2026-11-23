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
//     across layers (a PERSONAL row hides a WORKSPACE row's alias list).
//   - only the first `maxKeywords` output tokens survive (mirrors the old
//     terminology expansion cap).
//
// The same exact-equality rule gates the PROMPT side (matchedAnnotations): a
// table meaning / field note is injected only for a table/field whose name or
// alias is one of the keywords.
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

/** Lowercased keyword set of one turn: every comma-separated token of the
 *  given CSVs (the LLM-extracted keywords plus their alias expansion). This is
 *  the ONLY match source for metric definitions, naming rules and the semantic
 *  prompt decoration — an empty set (extraction failed / EMPTY /
 *  ERROR:NOT_DATA_QUERY) matches nothing. */
export function keywordSet(
  ...csvs: Array<string | null | undefined>
): Set<string> {
  const out = new Set<string>();
  for (const csv of csvs) {
    for (const k of keywordTokens(csv ?? '')) out.add(k.toLowerCase());
  }
  return out;
}

/** Minimal annotation shape the match filter consumes (structural twin of
 *  SemanticService.SemanticAnnotations). The alias maps are absent on callers
 *  that do not resolve them, which reads as "no aliases". */
export interface AnnotatableSemantics {
  tableMeanings: Record<string, string>;
  fieldNotes: Record<string, unknown>;
  tableAliases?: Record<string, readonly string[]>;
  fieldAliases?: Record<string, readonly string[]>;
}

/** `name` or one of `aliases` equals a keyword — the exact-match rule a
 *  table/field semantic must pass to enter the prompt. Case-insensitive and
 *  trimmed on BOTH sides (the keyword set may be cased either way). */
export function matchesNameOrAlias(
  keywords: ReadonlySet<string>,
  name: string,
  aliases: readonly string[] = [],
): boolean {
  const names = [name, ...aliases]
    .map((word) => (word ?? '').trim().toLowerCase())
    .filter(Boolean);
  for (const keyword of keywords) {
    const k = (keyword ?? '').trim().toLowerCase();
    if (k !== '' && names.includes(k)) return true;
  }
  return false;
}

/** The annotations whose table/field name or alias equals one of the
 *  keywords — a table meaning or a field note is injected into the prompt ONLY
 *  for those. Tables the user did not name keep their raw DB comments.
 *  Known limitation: with no keywords nothing is injected at all. */
export function matchedAnnotations<T extends AnnotatableSemantics>(
  annotations: T,
  keywords: ReadonlySet<string>,
): { tableMeanings: Record<string, string>; fieldNotes: T['fieldNotes'] } {
  // Null-prototype map for the same reason as effectiveAnnotations: a table
  // literally named `constructor` must not resolve to Object.prototype members.
  const tableMeanings = Object.create(null) as Record<string, string>;
  for (const [name, meaning] of Object.entries(annotations.tableMeanings)) {
    if (matchesNameOrAlias(keywords, name, annotations.tableAliases?.[name])) {
      tableMeanings[name] = meaning;
    }
  }
  // The constraint widens the notes to `unknown`; the generic carries the
  // caller's real note type back out.
  const fieldNotes: Record<string, T['fieldNotes'][string]> = {};
  const notes = annotations.fieldNotes as Record<
    string,
    T['fieldNotes'][string]
  >;
  for (const [key, note] of Object.entries(notes)) {
    // key = `${tableName}.${fieldName}` — the field name is the last segment
    const fieldName = key.slice(key.lastIndexOf('.') + 1);
    if (
      matchesNameOrAlias(keywords, fieldName, annotations.fieldAliases?.[key])
    ) {
      fieldNotes[key] = note;
    }
  }
  return { tableMeanings, fieldNotes };
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
