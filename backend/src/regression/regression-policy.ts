// Pure regression-suite policy (MetaDataImprove M6) — no Nest/Prisma imports,
// unit-testable. The suite re-runs a workspace's standard questions whenever a
// semantic definition changes, and compares the DB-side aggregates against the
// stored baseline. The point is NOT "does the SQL run" — it is "did the
// numbers inexplicably grow": a join change that fans out rows or a dropped
// filter that widens a caliber are invisible in code review, only visible by
// running the numbers.
import type { QueryResult } from '../datasource/db-connector/db-connector.interface';
import { stripOuterLimit } from '../datasource/db-connector/limit-clause';
import { normalizeDatasourceType } from '../datasource/datasource-type';
import { effectiveSqlHash } from '../quota/quota-policy';

/** Baseline snapshot stored on RegressionCase.baseline / recomputed each run. */
export interface CaseAggregate {
  rowCount: number;
  /** DB-side SUM per numeric result column (empty when none). */
  sums: Record<string, number>;
  /** Set when the SUM probe failed and this baseline only carries the row
   *  count (e.g. a numeric-looking text column rejected by SUM). */
  sumsUnavailable?: boolean;
}

export interface RegressionBaseline extends CaseAggregate {
  sqlHash: string;
  capturedAt: string;
  runId: number;
}

/** Per-case comparison outcome persisted on RegressionRunCase.delta. */
export interface CaseDelta {
  rowCountPct: number | null;
  /** Relative change % per column present on BOTH sides. */
  sums: Record<string, number>;
  /** Numeric columns only present in current / only in baseline sums. */
  newColumns: string[];
  missingColumns: string[];
  /** Machine-readable flag reasons, e.g. row_count_inflated / sum_inflated:amount. */
  reasons: string[];
}

/** Relative change of current vs base in percent. base 0 → current 0 is 0;
 *  base 0 → current >0 counts as +100 (something came out of nothing). */
export function deltaPct(base: number, current: number): number {
  if (base === 0) return current === 0 ? 0 : 100;
  return ((current - base) / Math.abs(base)) * 100;
}

/** Compare current aggregates against the baseline with the case's tolerance.
 *  Reasons carry direction — INFLATED is the review-blocking one (fan-out /
 *  widened caliber), shrunk is recorded but is usually a data refresh. */
export function compareCase(
  baseline: CaseAggregate,
  current: CaseAggregate,
  tolerancePct: number,
): CaseDelta {
  const reasons: string[] = [];
  const rowCountPct = deltaPct(baseline.rowCount, current.rowCount);
  if (rowCountPct > tolerancePct) reasons.push('row_count_inflated');
  else if (rowCountPct < -tolerancePct) reasons.push('row_count_shrunk');

  const sums: Record<string, number> = {};
  if (baseline.sumsUnavailable) {
    // Captured rowCount-only: comparing against an empty sum map would report
    // every current column as new. Row-count drift still flags normally.
    return { rowCountPct, sums, newColumns: [], missingColumns: [], reasons };
  }
  const baseCols = Object.keys(baseline.sums);
  const curCols = Object.keys(current.sums);
  const newColumns = curCols.filter((c) => !(c in baseline.sums));
  const missingColumns = baseCols.filter((c) => !(c in current.sums));
  for (const col of curCols) {
    if (!(col in baseline.sums)) continue;
    const pct = deltaPct(baseline.sums[col], current.sums[col]);
    sums[col] = pct;
    if (pct > tolerancePct) reasons.push(`sum_inflated:${col}`);
    else if (pct < -tolerancePct) reasons.push(`sum_shrunk:${col}`);
  }
  if (newColumns.length > 0 || missingColumns.length > 0) {
    reasons.push('schema_changed');
  }
  return { rowCountPct, sums, newColumns, missingColumns, reasons };
}

/** Identifier quoting per engine family: MySQL takes backticks, the
 *  PostgreSQL/SQLite family takes double quotes. Escape the delimiter that is
 *  actually used (and normalize aliases like `PG` / `MySQL`). */
export function quoteIdentifier(name: string, engine: string): string {
  const mysql = normalizeDatasourceType(engine) === 'mysql';
  const q = mysql ? '`' : '"';
  const escaped = mysql ? name.replace(/`/g, '``') : name.replace(/"/g, '""');
  return `${q}${escaped}${q}`;
}

/** Wrap the LLM's SQL in a DB-side aggregate so the comparison sees TRUE row
 *  counts and TRUE sums — the pipeline's stored result is capped by
 *  quota.max_rows, and two truncated 1000-row samples cannot tell 5k rows
 *  from 100k (exactly the fan-out we hunt). The generated SQL's own outer
 *  LIMIT is stripped first: the prompt asks for one, and aggregating over the
 *  capped page would hide exactly the growth this suite exists to detect.
 *  Returns one row: [__cnt, __s0, __s1, ...] aligned with numericCols. */
export function buildVerifySql(
  sql: string,
  numericCols: string[],
  engine: string,
): string {
  const sums = numericCols
    .map((c, i) => `, SUM(${quoteIdentifier(c, engine)}) AS "__s${i}"`)
    .join('');
  const unwrapped = stripOuterLimit(sql, engine);
  return `SELECT COUNT(*) AS "__cnt"${sums} FROM (${unwrapped}) AS "__reg_sub"`;
}

/** Numeric result columns, detected from the pipeline's stored sample rows:
 *  a column qualifies when every non-empty value is a finite number (or every
 *  value is a numeric string — bigint columns serialize as strings). All-null
 *  columns are skipped (no basis to SUM). */
export function detectNumericColumns(
  columns: string[],
  rows: unknown[][],
): string[] {
  // Duplicate result names (SELECT a.id, b.id) are ambiguous inside SUM and
  // would make the verify query fail: keep the first occurrence only.
  const seen = new Set<string>();
  return columns.filter((name, idx) => {
    if (!name || seen.has(name)) return false;
    const vals = rows
      .map((r) => r?.[idx])
      .filter((v) => v !== null && v !== undefined && v !== '');
    if (vals.length === 0) return false;
    if (vals.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      seen.add(name);
      return true;
    }
    const numericText = vals.every(
      (v) => typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()),
    );
    if (numericText) seen.add(name);
    return numericText;
  });
}

/** Parse the verify query's single result row back into a CaseAggregate. */
export function parseVerifyResult(
  numericCols: string[],
  result: QueryResult,
): CaseAggregate {
  const row = result.rows[0] ?? [];
  const rowCount = Number(row[0] ?? 0);
  const sums: Record<string, number> = {};
  numericCols.forEach((col, i) => {
    const v = row[i + 1];
    if (v !== null && v !== undefined) sums[col] = Number(v);
  });
  return { rowCount, sums };
}

/** Drift signal for the run-case row: hash of the LLM SQL text (LIMIT-free —
 *  this is about the generated query, not the executed page). */
export function sqlTextHash(sql: string): string {
  return effectiveSqlHash(sql);
}
