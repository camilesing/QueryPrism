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

/** Append `LIMIT n` to the outermost statement unless it already limits rows. */
export function appendLimit(sql: string, limit: number): string {
  const stripped = stripTrailingSemicolon(sql);
  if (hasTopLevelLimit(stripped)) return stripped;
  return `${stripped} LIMIT ${limit}`;
}
