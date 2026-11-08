// datasource-snake-mapper. Maps Datasource/Table/Field rows to
// the snake_case shape the frontend reads. Applied in the controller,
// not the service, so existing service specs stay green.
//
// Two server-derived fields:
//   - `type_name`: the DB product's display label. Derived on read
//     (cheap pure lookup) since the Datasource model has no type_name column.
//   - `num`: a "selected/total" snapshot (e.g. "3/10") updated
//     at create/syncTables/chooseTables; the total half needs a live connection
//     to the source DB. The snapshot is stored in a `num` column
//     (written in DatasourceService.syncTable via persistNum); the mapper prefers
//     that stored snapshot, falling back to `String(selectedCount)` for rows
//     without one (e.g. seeded before the column existed). The frontend renders
//     `num` verbatim as a badge.
//
// Json blobs (configuration encrypted string, table_relation X6 cells,
// recommended_config) pass through verbatim — a global camelToSnake interceptor
// would mangle their inner keys. Structural param types keep the spec's plain
// fixtures cast-free; real Prisma rows satisfy them too (extra fields ignored).
const ISO = (d: Date): string => d.toISOString();

// DB type → display label map. Case-sensitive here (the frontend always
// sends the canonical lowercase value). `sqlite` (backend-only demo
// type) + `postgresql` (legacy value) are extra entries beyond the
// frontend's type enum.
const TYPE_LABEL: Record<string, string> = {
  excel: 'Excel/CSV',
  redshift: 'AWS Redshift',
  ck: 'ClickHouse',
  dm: '达梦',
  doris: 'Apache Doris',
  es: 'Elasticsearch',
  kingbase: 'Kingbase',
  sqlServer: 'Microsoft SQL Server',
  mysql: 'MySQL',
  oracle: 'Oracle',
  pg: 'PostgreSQL',
  starrocks: 'StarRocks',
  hive: 'Apache Hive',
  // QueryPrism extensions (not in the frontend's type enum):
  sqlite: 'SQLite',
  postgresql: 'PostgreSQL',
};

function typeName(type: string): string {
  return TYPE_LABEL[type] ?? type;
}

// ─── Datasource ─────────────────────────────────────────────────────────

export interface DatasourceRow {
  id: number;
  name: string;
  description: string | null;
  type: string;
  configuration: string | null;
  status: string;
  tableRelation: unknown;
  recommendedConfig: unknown;
  num?: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { tables: number; chats: number };
  tables?: unknown[];
}

export interface DatasourceSnake {
  id: number;
  name: string;
  description: string | null;
  type: string;
  type_name: string;
  configuration: string | null;
  create_time: string;
  status: string;
  num: string;
  table_relation: unknown;
  recommended_config: unknown;
}

/** Map a Datasource row (with optional _count/tables include) to the
 *  frontend's snake_case list/get shape. */
export function toDatasourceSnake(row: DatasourceRow): DatasourceSnake {
  const selected = row._count?.tables ?? row.tables?.length ?? 0;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    type_name: typeName(row.type),
    configuration: row.configuration,
    create_time: ISO(row.createdAt),
    status: row.status,
    num: row.num ?? String(selected),
    table_relation: row.tableRelation,
    recommended_config: row.recommendedConfig,
  };
}

// ─── Table ───────────────────────────────────────────────────────────────

export interface TableRow {
  id: number;
  datasourceId: number;
  tableName: string;
  tableComment: string | null;
  customComment: string | null;
  checked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TableSnake {
  id: number;
  ds_id: number;
  table_name: string;
  table_comment: string | null;
  custom_comment: string | null;
  checked: boolean;
  create_time: string;
  update_time: string;
}

/** Map a Table row to the snake_case shape the frontend's tableList reads.
 *  `datasourceId` is exposed as `ds_id` (CoreTable contract field the frontend
 *  keys on for grouping). `embedding` is dropped — the frontend never reads it
 *  and the vector is large. */
export function toTableSnake(t: TableRow): TableSnake {
  return {
    id: t.id,
    ds_id: t.datasourceId,
    table_name: t.tableName,
    table_comment: t.tableComment,
    custom_comment: t.customComment,
    checked: t.checked,
    create_time: ISO(t.createdAt),
    update_time: ISO(t.updatedAt),
  };
}

// ─── Field ──────────────────────────────────────────────────────────────

export interface FieldRow {
  id: number;
  tableId: number;
  fieldName: string;
  fieldType: string | null;
  fieldComment: string | null;
  customComment: string | null;
  isPrimaryKey: boolean;
  fieldIndex: number | null;
  checked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface FieldSnake {
  id: number;
  table_id: number;
  field_name: string;
  field_type: string | null;
  field_comment: string | null;
  custom_comment: string | null;
  is_primary_key: boolean;
  field_index: number | null;
  checked: boolean;
  create_time: string;
  update_time: string;
}

/** Map a Field row to the snake_case shape the frontend's fieldList reads.
 *  `tableId` is exposed as `table_id`. `ds_id` is OMITTED: it would be
 *  reached via field.table.datasourceId (an extra join) — the frontend never
 *  reads field.ds_id, so the join is skipped. Add `include: { table: { select:
 *  { datasourceId: true } } }` to fieldList + map `ds_id` if a future feature
 *  needs it. */
export function toFieldSnake(f: FieldRow): FieldSnake {
  return {
    id: f.id,
    table_id: f.tableId,
    field_name: f.fieldName,
    field_type: f.fieldType,
    field_comment: f.fieldComment,
    custom_comment: f.customComment,
    is_primary_key: f.isPrimaryKey,
    field_index: f.fieldIndex,
    checked: f.checked,
    create_time: ISO(f.createdAt),
    update_time: ISO(f.updatedAt),
  };
}
