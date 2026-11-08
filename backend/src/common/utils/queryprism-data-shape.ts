// queryprism-data-shape — converts MCB's internal QueryResult {columns, rows}
// (array-of-arrays) to the frontend wire contract {fields, fields_info, data}
// (array of row objects).
//
// The frontend stores the whole response verbatim (`record.data = response`)
// for chart rendering, and the datasource SQL preview viewer reads `.fields`
// + `.data` — so a raw `{columns, rows}` would surface as undefined and break
// chart/preview rendering. MCB's db-connector QueryResult lacks per-column
// type info, so `fields_info` is null (the chart renderer infers numeric
// columns from the data values).
//
// MCB's connector returns columns as the underlying DB reports them; the
// casing is kept verbatim because the LLM chart config (record.chart)
// references the SAME column names MCB's pipeline produced — changing the
// casing here would desync the chart's field references from the data keys.

import { convertLargeNumbersInObjectArray } from './data-format';

/** Frontend data shape: column names + nullable per-column metadata + rows as
 *  objects keyed by column name. */
export interface QueryPrismDataShape {
  fields: string[];
  fields_info: { name: string; is_numeric: boolean }[] | null;
  data: Record<string, unknown>[];
}

/** A query result in MCB's internal array-of-arrays form (db-connector). */
export interface QueryResultLike {
  columns: string[];
  rows: unknown[][];
}

/** Convert `{columns, rows}` → `{fields, fields_info: null, data: [objects]}`.
 *  The optional `sql` argument adds a `sql` string field alongside the data.
 *  Numbers crossing the huge/tiny thresholds become plain decimal strings —
 *  JS would otherwise JSON-serialize them exponentially and the frontend
 *  formatter only understands plain decimals. */
export function toQueryPrismDataShape(
  qr: QueryResultLike,
  sql?: string,
): QueryPrismDataShape & { sql?: string } {
  const shape: QueryPrismDataShape & { sql?: string } = {
    fields: qr.columns,
    fields_info: null,
    data: convertLargeNumbersInObjectArray(
      qr.rows.map((r) =>
        Object.fromEntries(qr.columns.map((c, i) => [c, r[i]])),
      ),
    ),
  };
  if (sql !== undefined) shape.sql = sql;
  return shape;
}

/** Coerce an unknown stored value into the list-of-objects shape. The
 *  predict_data column may hold: an array of objects (already correct), a
 *  `{columns, rows}` QueryResult, or null. Returns `[]` for null/unknown
 *  shapes so the predict table renders an empty state instead of crashing on
 *  `.map`. */
export function toQueryPrismListShape(
  stored: unknown,
): Record<string, unknown>[] {
  if (Array.isArray(stored)) {
    return convertLargeNumbersInObjectArray(
      stored.filter(
        (r): r is Record<string, unknown> =>
          r != null && typeof r === 'object' && !Array.isArray(r),
      ),
    );
  }
  if (
    stored != null &&
    typeof stored === 'object' &&
    Array.isArray((stored as QueryResultLike).columns) &&
    Array.isArray((stored as QueryResultLike).rows)
  ) {
    const qr = stored as QueryResultLike;
    return toQueryPrismDataShape(qr).data;
  }
  return [];
}
