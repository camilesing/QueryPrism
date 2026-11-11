// Pure query-quota policy (MetaDataImprove M7) — no Nest/Prisma imports,
// unit-testable. Budgets are enforced at the chat pipeline entry because the
// agents downstream (MCP integrations, embedded assistants) cannot be trusted
// to self-limit: one agent plan easily asks twenty questions, each a full
// NL2SQL pipeline + datasource execution.
import { createHash } from 'crypto';
import type { RequestContextData } from '../common/context/request-context';

/** Subject types that carry a budget row. 'default' is the workspace
 * fallback row (subjectId null) consumed when the subject has no own row. */
export const BUDGET_SUBJECT_TYPES = [
  'default',
  'user',
  'mcp_integration',
  'assistant',
] as const;
export type BudgetSubjectType = (typeof BUDGET_SUBJECT_TYPES)[number];

/** Who is spending query budget. 'regression' never counts — the regression
 * runner executes dozens of standard questions per run on purpose. */
export interface QuerySubject {
  type: 'user' | 'mcp_integration' | 'assistant' | 'regression';
  id: number | null;
}

/** Resolve the charging subject with priority assistant > agent > user.
 * The embedded-assistant header identifies the public agent surface; the
 * MCP transport stamps `agent` on the ALS store; everything else is a
 * page user. Returns null only when no identity is attached at all. */
export function resolveSubject(
  ctx: RequestContextData | undefined,
): QuerySubject | null {
  if (ctx?.assistant) return { type: 'assistant', id: ctx.assistant.id };
  if (ctx?.agent?.type === 'regression')
    return { type: 'regression', id: null };
  if (ctx?.agent?.type === 'mcp_integration')
    return { type: 'mcp_integration', id: ctx.agent.id ?? null };
  const uid = ctx?.user?.id;
  if (uid !== undefined) return { type: 'user', id: uid };
  return null;
}

/** A QueryBudget row in the shape the resolution needs. */
export interface BudgetRowLike {
  subjectType: string;
  subjectId: number | null;
  dailyLimit: number;
}

/** Effective daily limit for a subject: its own row > the workspace default
 *  row (matched by type — its subjectId is the 0 sentinel) > null (=
 *  unlimited). Regression never resolves a limit. */
export function pickDailyLimit(
  rows: BudgetRowLike[],
  subject: QuerySubject,
): number | null {
  if (subject.type === 'regression') return null;
  const own = rows.find(
    (r) => r.subjectType === subject.type && r.subjectId === subject.id,
  );
  if (own) return own.dailyLimit;
  const fallback = rows.find((r) => r.subjectType === 'default');
  return fallback ? fallback.dailyLimit : null;
}

/** Local-calendar-day key 'YYYY-MM-DD'. Quotas reset on the server's local
 * midnight — simple and matches how admins read the usage page. */
export function dayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Normalize SQL text for cache hashing: collapse whitespace RUNS OUTSIDE
 *  quoted literals/identifiers and trim. Case and in-quote whitespace are
 *  preserved — `'a  b'` and `'a b'` are different executed statements and
 *  must never share a cache key. Supports single-quoted strings, double-
 *  quoted and backtick identifiers, with doubled-delimiter escapes. */
export function normalizeSqlForHash(sql: string): string {
  let out = '';
  let quote: string | null = null;
  let pendingSpace = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[i + 1]; // doubled delimiter stays inside the literal
          i += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      if (pendingSpace && out) out += ' ';
      pendingSpace = false;
      quote = ch;
      out += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out) out += ' ';
    pendingSpace = false;
    out += ch;
  }
  return out.trim();
}

/** Cache key for the EFFECTIVE SQL (LIMIT already appended by appendLimit —
 * appendLimit is deterministic, so hashing its output matches what the
 * connector executes). Different limits / different row-permission WHEREs
 * produce different SQL → different keys, so entries never cross-serve. */
export function effectiveSqlHash(finalSql: string): string {
  return createHash('sha256')
    .update(normalizeSqlForHash(finalSql))
    .digest('hex');
}
