// Table-recall pure functions — the keyword-fusion chain:
//
//   calcKeywordScore  — keyword↔table match score (name/comment/field weights)
//   rankTables        — fuse α*vector + (1-α)*keyword, exact (kw=1.0) first,
//                       then keep explicitly mentioned tables and fill slots
//   selectTables      — explicit-mention retention (identifier-boundary match,
//                       quoted identifiers whole, longest overlap wins)
//
// Pure and DB-free so the recall strategy is unit-testable in isolation.

// ─────────────────────────── recall width ───────────────────────────

/** Fixed table-recall width: how many checked tables the keyword-fused
 *  ranking returns before rule 2 and the clarify gate run. Deliberately NOT a
 *  runtime parameter (product decision), unlike the fusion weights.
 *
 *  Known effects at the defaults (semantic.max_tables = 3,
 *  clarify.table_threshold = 3):
 *    - rule 2 never narrows — 3 candidates are not MORE than max_tables, so it
 *      only engages after an admin lowers semantic.max_tables to 1–2;
 *    - the clarify gate pauses whenever a question names no table/comment and
 *      the datasource has ≥ 3 checked tables (3 candidates meet the threshold). */
export const TABLE_RECALL_TOP_K = 3;

// ─────────────────────── explicit mention detection ───────────────────────

const IDENTIFIER_CHARS = 'A-Za-z0-9_$';
const IDENT_FIRST_OR_LAST = new RegExp(`[${IDENTIFIER_CHARS}]`);
const RE_UNDERSCORE_SPACE = /[_\s]+/;
const RE_QUOTED_IDENTIFIER =
  /"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])*\]/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All [start, end) spans where `name` occurs in `question` at identifier
 *  boundaries (adjacent Chinese text and SQL delimiters allowed). Port of
 *  _mention_spans — the look-around is only added on identifier-character
 *  edges, so a name starting/ending with punctuation still matches. */
export function mentionSpans(
  question: string,
  name: string,
): Array<[number, number]> {
  if (!name) return [];
  const left = IDENT_FIRST_OR_LAST.test(name[0])
    ? `(?<![${IDENTIFIER_CHARS}])`
    : '';
  const right = IDENT_FIRST_OR_LAST.test(name[name.length - 1])
    ? `(?![${IDENTIFIER_CHARS}])`
    : '';
  const re = new RegExp(`${left}${escapeRegExp(name)}${right}`, 'g');
  const spans: Array<[number, number]> = [];
  for (const m of question.matchAll(re)) {
    spans.push([m.index, m.index + m[0].length]);
  }
  return spans;
}

/** Keep the longest overlapping name and any independently mentioned shorter
 *  names. Port of _longest_mentions — "order_id" winning doesn't discard an
 *  unrelated "orders" mention elsewhere in the question. */
export function longestMentions(
  spansByName: Map<string, Array<[number, number]>>,
): Set<string> {
  const allSpans = new Set<[number, number]>();
  for (const occurrences of spansByName.values()) {
    for (const s of occurrences) allSpans.add(s);
  }
  const longest = new Set<string>();
  let furthestEnd = -1;
  const sorted = [...allSpans].sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  for (const [start, end] of sorted) {
    if (end > furthestEnd) {
      longest.add(`${start}:${end}`);
      furthestEnd = end;
    }
  }
  const names = new Set<string>();
  for (const [name, occurrences] of spansByName) {
    if (occurrences.some(([a, b]) => longest.has(`${a}:${b}`))) {
      names.add(name);
    }
  }
  return names;
}

/** A recall candidate: table id + name + effective comment
 *  (customComment merged over tableComment by the caller). */
export interface TableRecallCandidate {
  id: number;
  tableName: string;
  comment: string;
}

/** Map LLM-suggested table names onto the clarify candidate pool. Names are
 *  matched case-insensitively after stripping wrapping quotes; a
 *  schema-qualified name (`public.orders`) also matches its bare table name.
 *  Unknown names are dropped, ids keep the LLM's order and de-duplicate. */
export function matchSuggestedTableIds(
  names: readonly string[],
  candidates: readonly TableRecallCandidate[],
): number[] {
  const normalize = (raw: string): string =>
    raw.trim().replace(/[`"']/g, '').toLowerCase();
  const byName = new Map<string, number>();
  for (const c of candidates) {
    const name = normalize(c.tableName);
    if (name && !byName.has(name)) byName.set(name, c.id);
  }
  const ids: number[] = [];
  for (const raw of names) {
    const name = normalize(raw);
    if (!name) continue;
    const bare = name.split('.').pop() ?? name;
    const id = byName.get(name) ?? byName.get(bare);
    if (id != null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Shared explicit-mention detection over a candidate pool: quoted-identifier
 *  aware name spans + comment spans, resolved through longestMentions.
 *  Returns the lowercased names/comments the question explicitly carries. */
function detectExplicitMentions<T extends TableRecallCandidate>(
  ranked: T[],
  question: string,
): { names: Set<string>; comments: Set<string> } {
  const q = (question || '').toLowerCase();
  const quoted: Array<[[number, number], string]> = [];
  for (const m of q.matchAll(RE_QUOTED_IDENTIFIER)) {
    const token = m[0];
    const closing = token[token.length - 1];
    const inner = token.slice(1, -1).replaceAll(closing + closing, closing);
    quoted.push([[m.index, m.index + token.length], inner]);
  }
  const nameSpans = new Map<string, Array<[number, number]>>();
  const commentSpans = new Map<string, Array<[number, number]>>();
  for (const table of ranked) {
    const name = (table.tableName || '').trim().toLowerCase();
    if (name && !nameSpans.has(name)) {
      // bare occurrences only when NOT inside a quoted identifier
      const bare = mentionSpans(q, name).filter(
        ([a, b]) => !quoted.some(([[s, e]]) => a < e && s < b),
      );
      // a quoted identifier equal to the name counts as a whole mention
      for (const [span, quotedName] of quoted) {
        if (quotedName === name) bare.push(span);
      }
      nameSpans.set(name, bare);
    }
    const comment = (table.comment || '').trim().toLowerCase();
    if (comment && !commentSpans.has(comment)) {
      commentSpans.set(comment, mentionSpans(q, comment));
    }
  }
  return {
    names: longestMentions(nameSpans),
    comments: longestMentions(commentSpans),
  };
}

/** The explicitly mentioned table names/comments (lowercased) of a candidate
 *  pool — exposed so callers that reorder/narrow the pool can retain what the
 *  user actually named. */
export function explicitMentions<T extends TableRecallCandidate>(
  ranked: T[],
  question: string,
): { names: Set<string>; comments: Set<string> } {
  return detectExplicitMentions(ranked, question);
}

/** Keep explicitly mentioned candidates, then fill remaining slots by the
 *  caller's rank order (port of _select_tables, applyLimit always true here).
 *  Overlapping names and comments resolve to the longest mention separately. */
export function selectTables<T extends TableRecallCandidate>(
  ranked: T[],
  question: string,
  limit: number,
): T[] {
  const explicit = detectExplicitMentions(ranked, question);
  const required: T[] = [];
  const remaining: T[] = [];
  for (const table of ranked) {
    const name = (table.tableName || '').trim().toLowerCase();
    const comment = (table.comment || '').trim().toLowerCase();
    if (explicit.names.has(name) || explicit.comments.has(comment)) {
      required.push(table);
    } else {
      remaining.push(table);
    }
  }
  const fill = remaining.slice(0, Math.max(0, limit - required.length));
  return [...required, ...fill];
}

// ───────────────────────── clarify gate (MetaDataImprove M1) ──────────────

export interface ClarifyGateOptions {
  enabled: boolean;
  /** Ask only when at least this many candidate tables are in play. */
  tableThreshold: number;
  /** Clarify rounds already spent on this record. The gate stays closed once
   *  the budget is exhausted; the caller passes the persisted counter
   *  (ChatRecord.clarifyRound), not a status-derived guess. */
  rounds: number;
  maxRounds: number;
}

/** Should the pipeline pause and ask the user to narrow the tables? Rule 1 of
 *  the metadata-improvement plan: with no valid semantics (M1 has none, so
 *  this is always the branch) and >= tableThreshold candidate tables about to
 *  be stuffed into the schema, ask instead of guessing — one wrong pick breaks
 *  the join. An explicitly named table/comment means the user already decided,
 *  so no question is asked.
 *
 *  M1 limitation: no semantic layer yet, so "no valid semantics" degenerates
 *  to "nothing explicitly mentioned"; multi-turn follow-ups can still trigger
 *  the gate (mitigate via clarify.enabled / skip). */
export function needsClarify<T extends TableRecallCandidate>(
  candidates: T[],
  question: string,
  opts: ClarifyGateOptions,
): boolean {
  if (!opts.enabled) return false;
  if (opts.rounds >= opts.maxRounds) return false;
  const q = (question || '').trim();
  if (!q) return false;
  if (candidates.length < opts.tableThreshold) return false;
  const explicit = detectExplicitMentions(candidates, q);
  return explicit.names.size === 0 && explicit.comments.size === 0;
}

// ───────────────────────── keyword matching score ─────────────────────────

/** A field row for keyword scoring — customComment takes precedence over
 *  fieldComment (user edits beat synced metadata). */
export interface KeywordField {
  fieldName: string;
  fieldComment?: string | null;
  customComment?: string | null;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Keyword↔table match score in [0,1] (port of calc_keyword_score).
 *
 *  Per-keyword best match:
 *    == table name ………… 1.0        == table comment …… 0.9
 *    ⊂ table comment …… 0.7         ∈ table name parts  0.25 + 0.25·coverage
 *    == field comment … 0.5         ⊂ field comment …… 0.4
 *    ∈ field name parts  0.3
 *  Final = best keyword score × keyword coverage (matched/total), rounded
 *  to 2 decimals. `keywordsCsv` is the comma-separated (already extracted +
 *  semantic-alias-expanded) keyword string, or a raw question as fallback. */
export function calcKeywordScore(
  keywordsCsv: string,
  tableName: string,
  tableComment: string,
  fields: KeywordField[],
): number {
  if (!keywordsCsv) return 0;
  const keywords = keywordsCsv
    .split(',')
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
  if (keywords.length === 0) return 0;

  const tn = (tableName || '').toLowerCase();
  const tc = (tableComment || '').toLowerCase();
  const totalKw = keywords.length;

  const tnParts = new Set(
    tn.split(RE_UNDERSCORE_SPACE).filter((p) => p !== ''),
  );

  const fieldComments: string[] = [];
  const fieldNameParts: Array<Set<string>> = [];
  for (const field of fields ?? []) {
    let fc = (field.customComment ?? '').trim().toLowerCase();
    if (!fc) fc = (field.fieldComment ?? '').trim().toLowerCase();
    fieldComments.push(fc);
    const fname = (field.fieldName || '').toLowerCase();
    fieldNameParts.push(
      fname
        ? new Set(fname.split(RE_UNDERSCORE_SPACE).filter((p) => p !== ''))
        : new Set<string>(),
    );
  }

  const kwScores = new Map<string, number>();
  for (const kw of keywords) {
    // 1. full table-name match
    if (kw === tn) {
      kwScores.set(kw, 1.0);
      continue;
    }
    // 2. full table-comment match
    if (tc && kw === tc) {
      kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0.9));
      continue;
    }
    // 3. keyword inside table comment
    if (tc && tc.includes(kw)) {
      kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0.7));
      continue;
    }
    // 4. keyword among table-name parts — score computed after the loop
    if (tnParts.has(kw)) {
      kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0));
    }
    // 5. field comments — exact 0.5 / substring 0.4
    for (const fc of fieldComments) {
      if (!fc) continue;
      if (kw === fc) {
        kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0.5));
        break;
      } else if (fc.includes(kw)) {
        kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0.4));
      }
    }
    // 6. field-name parts — 0.3
    if ((kwScores.get(kw) ?? 0) < 0.3) {
      for (const fparts of fieldNameParts) {
        if (fparts.has(kw)) {
          kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, 0.3));
          break;
        }
      }
    }
  }

  if (kwScores.size === 0) return 0;

  // full table-name/comment hit → the headline score outright
  if (kwScores.get(tn) === 1.0) return 1.0;
  if (tc && kwScores.get(tc) === 0.9) return 0.9;

  // partial table-name match: 0.25 + 0.25·(matched parts / name parts)
  if (tnParts.size > 0) {
    const matched = keywords.filter((kw) => tnParts.has(kw));
    if (matched.length > 0) {
      const tnScore = round2(0.25 + 0.25 * (matched.length / tnParts.size));
      for (const kw of matched) {
        kwScores.set(kw, Math.max(kwScores.get(kw) ?? 0, tnScore));
      }
    }
  }

  const best = Math.max(...kwScores.values());
  const coverage = kwScores.size / totalKw;
  return round2(best * coverage);
}

// ─────────────────────────── fusion + ranking ────────────────────────────

/** A candidate with both sub-scores attached. */
export interface ScoredTable extends TableRecallCandidate {
  vectorScore: number;
  keywordScore: number;
}

/** Fuse α·vector + (1-α)·keyword; exact keyword hits (score 1.0 — the
 *  question names the table) always rank first; then explicit-mention
 *  retention + rank-fill via selectTables (calc_table_embedding steps 3-4). */
export function rankTables<T extends ScoredTable>(
  tables: T[],
  question: string,
  opts: { alpha: number; count: number },
): T[] {
  const fused = tables.map((t) => ({
    ...t,
    fused: opts.alpha * t.vectorScore + (1 - opts.alpha) * t.keywordScore,
  }));
  const byFused = (a: { fused: number }, b: { fused: number }) =>
    b.fused - a.fused;
  const exact = fused.filter((t) => t.keywordScore === 1).sort(byFused);
  const rest = fused.filter((t) => t.keywordScore !== 1).sort(byFused);
  return selectTables([...exact, ...rest], question, opts.count);
}
