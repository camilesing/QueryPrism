// metric-snake-mapper — camelCase DB rows → snake_case wire shapes for the
// M4 metric + data-standard admin page. Json blobs (aliases, definition,
// snapshot, payload) pass through verbatim (same rule as
// semantic-snake-mapper: no deep key rewriting).
import type { DataStandard, MetricDef } from '@prisma/client';

export interface MetricDefSnake {
  id: number;
  scope: string;
  oid: number | null;
  owner_uid: number | null;
  kind: string;
  code: string;
  name: string;
  aliases: unknown;
  description: string | null;
  unit: string | null;
  definition: unknown;
  enabled: boolean;
  version: number;
  create_by: number | null;
  create_time: string;
  update_time: string;
  /** false → the bound table is gone (atomic/modifier only; reference-free
   *  kinds are always true and the UI renders no binding). */
  table_exists: boolean;
}

export interface DataStandardSnake {
  id: number;
  scope: string;
  oid: number | null;
  owner_uid: number | null;
  kind: string;
  code: string;
  term: string;
  name: string;
  aliases: unknown;
  category: string | null;
  description: string | null;
  enabled: boolean;
  version: number;
  create_by: number | null;
  create_time: string;
  update_time: string;
}

const ISO = (d: Date): string => d.toISOString();

export function toMetricDefSnake(
  row: MetricDef,
  tableExists: boolean,
): MetricDefSnake {
  return {
    id: row.id,
    scope: row.scope,
    oid: row.oid,
    owner_uid: row.ownerUid,
    kind: row.kind,
    code: row.code,
    name: row.name,
    aliases: row.aliases,
    description: row.description,
    unit: row.unit,
    definition: row.definition,
    enabled: row.enabled,
    version: row.version,
    create_by: row.createBy,
    create_time: ISO(row.createdAt),
    update_time: ISO(row.updatedAt),
    table_exists: tableExists,
  };
}

export function toDataStandardSnake(row: DataStandard): DataStandardSnake {
  return {
    id: row.id,
    scope: row.scope,
    oid: row.oid,
    owner_uid: row.ownerUid,
    kind: row.kind,
    code: row.code,
    term: row.term,
    name: row.name,
    aliases: row.aliases,
    category: row.category,
    description: row.description,
    enabled: row.enabled,
    version: row.version,
    create_by: row.createBy,
    create_time: ISO(row.createdAt),
    update_time: ISO(row.updatedAt),
  };
}
