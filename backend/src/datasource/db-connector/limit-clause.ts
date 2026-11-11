// Shared LIMIT appending for read-only query execution. The three connectors
// previously each carried a copy of "append LIMIT n unless /\bLIMIT\b/ matches
// the SQL" — which has two holes, both fixed here:
//
//  1. The regex matches the WHOLE SQL, so a LIMIT buried in a subquery /
//     derived table / CTE suppresses the append and leaves the outer query
//     unbounded (and such an inner LIMIT also means the
//     outer aggregation ran over truncated data). "Is there already a limit?"
//     must be answered for the OUTERMOST statement only — node-sql-parser
//     (already a dependency via SqlSafetyService) reports it as the top-level
//     `limit` node. Statements it cannot parse fall back to the old regex.
//  2. A trailing `;` turns `...; LIMIT n` into a syntax error, so it is
//     stripped before appending.
import { Parser } from 'node-sql-parser';

const parser = new Parser();
const ANY_LIMIT_RE = /\blimit\b/i;

interface StatementAst {
  limit?: { value?: unknown[] } | null;
}

function topLevelLimit(sql: string): { value?: unknown[] } | null | undefined {
  try {
    const ast = parser.astify(sql);
    const first = Array.isArray(ast) ? ast[0] : ast;
    return (first as StatementAst | undefined)?.limit;
  } catch {
    return undefined; // unparseable — caller falls back to the regex
  }
}

/** True when the OUTERMOST statement of `sql` already limits its row count.
 *  A subquery/CTE-only LIMIT returns false (the outer query is unbounded).
 *  Unparseable statements conservatively match a LIMIT anywhere. */
export function hasTopLevelLimit(sql: string): boolean {
  const limit = topLevelLimit(sql);
  if (limit === undefined) return ANY_LIMIT_RE.test(sql);
  return limit != null && Array.isArray(limit.value) && limit.value.length > 0;
}

/** Strip trailing semicolons (and the whitespace around them) so a LIMIT can
 *  be appended to what is otherwise the final statement. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/(?:\s*;\s*)+$/, '');
}

/** Parser dialect names (node-sql-parser's `database` option). */
function parserDatabase(engine: string): string | undefined {
  switch (engine.trim().toLowerCase()) {
    case 'mysql':
    case 'mariadb':
      return 'MySQL';
    case 'postgres':
    case 'postgresql':
    case 'pg':
      return 'Postgresql';
    case 'sqlite':
      return 'Sqlite';
    default:
      return undefined;
  }
}

/** Strip the OUTERMOST LIMIT (and OFFSET) from a statement, leaving any
 *  subquery/CTE limits intact. Used when the statement is wrapped in an
 *  aggregate (regression verify SQL): a top-level LIMIT would silently cap the
 *  COUNT/SUM to one page. Falls back to a trailing-LIMIT regex when the
 *  statement cannot be parsed. */
export function stripOuterLimit(sql: string, engine = ''): string {
  const stripped = stripTrailingSemicolon(sql);
  const database = parserDatabase(engine);
  const opt = database ? { database } : undefined;
  try {
    const ast = parser.astify(stripped, opt);
    const first = (Array.isArray(ast) ? ast[0] : ast) as unknown as Record<
      string,
      unknown
    >;
    // The parser ALWAYS emits a `limit` node (`{value: []}`) even without a
    // LIMIT clause — only a non-empty value list is a real outer limit.
    const limitValue = (
      first?.limit as { value?: unknown[] } | null | undefined
    )?.value;
    const offsetValue = (
      first?.offset as { value?: unknown[] } | null | undefined
    )?.value;
    const hasLimit = Array.isArray(limitValue) && limitValue.length > 0;
    const hasOffset = Array.isArray(offsetValue) && offsetValue.length > 0;
    if (!first || (!hasLimit && !hasOffset)) {
      return stripped;
    }
    const clone = { ...first };
    delete clone.limit;
    delete clone.offset;
    const out = parser.sqlify(
      (Array.isArray(ast) ? [clone] : clone) as never,
      opt,
    );
    return stripTrailingSemicolon(out);
  } catch {
    // Unparseable (provider-specific syntax): the pipeline's prompt places
    // LIMIT at the end of the outermost statement, so strip that shape.
    return stripped.replace(
      /\s+limit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\s*$/i,
      '',
    );
  }
}

/** Append `LIMIT n` to the outermost statement unless it already limits rows. */
export function appendLimit(sql: string, limit: number): string {
  const stripped = stripTrailingSemicolon(sql);
  if (hasTopLevelLimit(stripped)) return stripped;
  return `${stripped} LIMIT ${limit}`;
}
