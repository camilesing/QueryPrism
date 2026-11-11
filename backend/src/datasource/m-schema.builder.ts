// M-Schema builder: turns synced tables + the user-edited FK graph into the
// compact schema string the generate_sql prompt consumes — a token-light,
// table/field list with foreign keys.
//
// Honors the per-table / per-field `checked` flags so users can hide tables or
// columns from the LLM, and prefers `customComment` over the DB-derived
// comment when set. Pure (no NestJS / Prisma imports) so it is trivially
// unit-testable.

/** A single foreign-key edge stored in Datasource.tableRelation. */
export interface TableRelationEdge {
  fromTable: string;
  fromField: string;
  toTable: string;
  toField: string;
}

/** Table/Field row ids → names, for resolving the X6 cell ids the relation
 *  editor persists (MetaDataImprove M3.1). The synced Table/Field rows are
 *  the source of truth; the canvas labels are the fallback for rows that
 *  were renamed or deleted after the graph was saved. */
export interface RelationIdNames {
  /** Table row id (X6 node id, stringified) → table name. */
  tableById: Map<string, string>;
  /** `${tableRowId}:${fieldRowId}` (X6 node:port ids) → field name. */
  fieldByPort: Map<string, string>;
}

/** Build the id→name maps from the synced table rows (shape of Prisma
 *  Table[] with fields included — getMSchema and the chat pipeline both
 *  already hold this). */
export function relationIdNamesOf(
  tables: Array<{
    id: number;
    tableName: string;
    fields: Array<{ id: number; fieldName: string }>;
  }>,
): RelationIdNames {
  const tableById = new Map<string, string>();
  const fieldByPort = new Map<string, string>();
  for (const t of tables) {
    tableById.set(String(t.id), t.tableName);
    for (const f of t.fields) {
      fieldByPort.set(`${t.id}:${f.id}`, f.fieldName);
    }
  }
  return { tableById, fieldByPort };
}

export interface MSchemaField {
  fieldName: string;
  fieldType: string | null;
  fieldComment: string | null;
  customComment: string | null;
  isPrimaryKey: boolean;
  fieldIndex: number | null;
  checked: boolean;
}

export interface MSchemaTable {
  tableName: string;
  tableComment: string | null;
  customComment: string | null;
  checked: boolean;
  fields: MSchemaField[];
}

export interface MSchemaInput {
  datasourceName: string;
  tables: MSchemaTable[];
  /** Stored as Json on Datasource; normalized defensively here. */
  tableRelation?: unknown;
  /** Row id → name maps for resolving X6 cell ids inside `tableRelation`
   *  (M3.1). Without them only the canvas labels are available. */
  relationIdNames?: RelationIdNames;
  /** Effective business semantics (MetaDataImprove M2): resolved by the chat
   *  layer (PERSONAL > WORKSPACE > GLOBAL) and injected as the authoritative
   *  comment layer — a curated meaning beats both customComment and the
   *  DB-derived comment. */
  semantics?: MSchemaSemantics;
}

/** The annotation subset the builder consumes (structural twin of
 *  SemanticService.SemanticAnnotations — kept local so the builder stays
 *  free of semantic-module imports). */
export interface MSchemaSemantics {
  /** tableName → curated business meaning. */
  tableMeanings: Record<string, string>;
  /** `${tableName}.${fieldName}` → role-tagged field note. */
  fieldNotes: Record<
    string,
    {
      role: string;
      meaning: string;
      unit?: string;
      /** Cached dimension members; label is the business-facing name. */
      enums?: Array<{ value: string; label?: string }>;
    }
  >;
}

/** Role tags shown before the field comment — zh labels match the project's
 *  primary locale and read naturally inside M-Schema comment lines. */
const ROLE_TAGS: Record<string, string> = {
  metric: '指标',
  dimension: '维度',
  time: '时间',
};

/** Per-value and total bounds for the enum sample appended to a field line.
 *  Values come from the datasource (or a semantic import), so a long text
 *  dimension must not blow up every M-Schema render. */
const MAX_ENUM_VALUE_LENGTH = 80;
const MAX_ENUM_SAMPLE_LENGTH = 1_000;

const clipEnumText = (value: string): string =>
  value
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_ENUM_VALUE_LENGTH);

/** Compose the field comment line: `[角色] 含义 (单位: x; 枚举: a(标签)/b)`.
 *  Enum entries render `value(label)` so the LLM sees both the exact value to
 *  filter on and the business-facing label. */
function semanticFieldNote(
  note: MSchemaSemantics['fieldNotes'][string],
): string {
  const tag = ROLE_TAGS[note.role];
  const meaning = note.meaning?.trim() ?? '';
  const head = [tag ? `[${tag}]` : '', meaning].filter(Boolean).join(' ');
  const tails: string[] = [];
  if (note.unit?.trim()) tails.push(`单位: ${note.unit.trim()}`);
  if (note.enums?.length) {
    const sample = note.enums
      .map((e) => {
        const value = clipEnumText(e.value ?? '');
        if (!value) return '';
        const label = e.label ? clipEnumText(e.label) : '';
        return label && label !== value ? `${value}(${label})` : value;
      })
      .filter(Boolean)
      .join('/')
      .slice(0, MAX_ENUM_SAMPLE_LENGTH);
    if (sample) tails.push(`枚举: ${sample}`);
  }
  const tail = tails.length ? ` (${tails.join('; ')})` : '';
  return `${head}${tail}`;
}

/**
 * Coerce the raw `tableRelation` JSON into a clean edge list, dropping any
 * malformed entries so a bad edit can never break schema generation.
 *
 * Three stored shapes are accepted:
 *  1. plain array of `{fromTable,fromField,toTable,toField}` edges
 *  2. `{ edges: [...] }` wrapper
 *  3. the raw X6 `graph.toJSON().cells` array the relation editor
 *     (TableRelationship.vue) actually persists — nodes carry the table
 *     name on their label, ports carry field names, and `shape=='edge'`
 *     cells reference them by cell/port id. Edge ids resolve through the
 *     Table/Field row maps first (fresh even after renames), falling back
 *     to the canvas labels; unresolvable edges are dropped (M3.1: this is
 *     what re-connects the editor's graph to the SQL prompt — previously
 *     shape 3 silently normalized to [] and no FK line ever rendered).
 */
export function normalizeTableRelation(
  raw: unknown,
  names?: RelationIdNames,
): TableRelationEdge[] {
  const list: unknown = Array.isArray(raw)
    ? raw
    : isEdgesObject(raw)
      ? raw.edges
      : [];
  if (!Array.isArray(list)) return [];
  if (isX6CellArray(list)) return edgesFromX6Cells(list, names);
  // filter(isEdge) narrows to TableRelationEdge[]; no cast needed.
  return list.filter(isEdge);
}

/** A semantic diff between two normalized FK-edge lists (relation-version
 *  compare): edges present only in `to` are added, only in `from` removed.
 *  Node positions are deliberately ignored — the editor's X6 snapshot also
 *  carries layout, but a moved box is not a relation change. */
export interface TableRelationDiff {
  added: TableRelationEdge[];
  removed: TableRelationEdge[];
}

/** Stable identity of one FK edge (a delimiter-joined string would collide on
 *  names containing the delimiter, so serialize the tuple). */
function edgeKey(edge: TableRelationEdge): string {
  return JSON.stringify([
    edge.fromTable,
    edge.fromField,
    edge.toTable,
    edge.toField,
  ]);
}

/** Diff two normalized edge lists, preserving each list's order and
 *  collapsing exact duplicates (an edge is a set member semantically). */
export function diffRelationEdges(
  from: TableRelationEdge[],
  to: TableRelationEdge[],
): TableRelationDiff {
  const fromKeys = new Set(from.map(edgeKey));
  const toKeys = new Set(to.map(edgeKey));
  const seenAdded = new Set<string>();
  const added: TableRelationEdge[] = [];
  for (const edge of to) {
    const key = edgeKey(edge);
    if (fromKeys.has(key) || seenAdded.has(key)) continue;
    seenAdded.add(key);
    added.push(edge);
  }
  const seenRemoved = new Set<string>();
  const removed: TableRelationEdge[] = [];
  for (const edge of from) {
    const key = edgeKey(edge);
    if (toKeys.has(key) || seenRemoved.has(key)) continue;
    seenRemoved.add(key);
    removed.push(edge);
  }
  return { added, removed };
}

/** An X6 cells array mixes node and edge cells; edges are the entries with
 *  a `shape` of 'edge'. Any array carrying string `shape` fields is treated
 *  as cells (a plain edge array never has one). */
function isX6CellArray(list: unknown[]): boolean {
  return list.some(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Record<string, unknown>).shape === 'string',
  );
}

/** A cell metadata value as a lookup key. X6 keeps numeric ids numeric in
 *  the serialized JSON (Table/Field row ids are numbers), so numbers are
 *  stringified to match the row-id maps. */
function cellString(cell: unknown, key: string): string {
  if (typeof cell !== 'object' || cell === null) return '';
  const v = (cell as Record<string, unknown>)[key];
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
}

/** A node cell's table name: synced Table row first, canvas label second. */
function nodeTableName(node: Record<string, unknown>, names?: RelationIdNames) {
  const id = cellString(node, 'id');
  const fromRow = names?.tableById.get(id);
  if (fromRow) return fromRow;
  // addNode sets attrs.label.text; the raw metadata also carries `label`.
  const attrs = node.attrs as Record<string, unknown> | undefined;
  const label = attrs?.label as Record<string, unknown> | undefined;
  const text = typeof label?.text === 'string' ? label.text.trim() : '';
  return text || cellString(node, 'label');
}

/** Resolve the raw X6 cells array into FK edges (see normalizeTableRelation
 *  shape 3). Self-edges and edges with unresolvable endpoints are dropped;
 * exact duplicates collapse (the editor allows re-drawing an edge). */
function edgesFromX6Cells(
  cells: unknown[],
  names?: RelationIdNames,
): TableRelationEdge[] {
  const tableByCellId = new Map<string, string>();
  const fieldByPort = new Map<string, string>();
  for (const cell of cells) {
    if (
      typeof cell !== 'object' ||
      cell === null ||
      (cell as Record<string, unknown>).shape === 'edge'
    ) {
      continue;
    }
    const node = cell as Record<string, unknown>;
    const id = cellString(node, 'id');
    if (!id) continue;
    tableByCellId.set(id, nodeTableName(node, names));
    const ports = node.ports as Record<string, unknown> | undefined;
    const items = ports?.items;
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue;
      const portId = cellString(item, 'id');
      if (!portId) continue;
      const attrs = (item as Record<string, unknown>).attrs as
        Record<string, unknown> | undefined;
      const label = attrs?.portNameLabel as Record<string, unknown> | undefined;
      const text = typeof label?.text === 'string' ? label.text.trim() : '';
      const fromRow = names?.fieldByPort.get(`${id}:${portId}`);
      fieldByPort.set(portId, fromRow ?? text);
    }
  }

  const edges: TableRelationEdge[] = [];
  const seen = new Set<string>();
  for (const cell of cells) {
    if (
      typeof cell !== 'object' ||
      cell === null ||
      (cell as Record<string, unknown>).shape !== 'edge'
    ) {
      continue;
    }
    const edge = cell as Record<string, unknown>;
    const source = edge.source as Record<string, unknown> | undefined;
    const target = edge.target as Record<string, unknown> | undefined;
    const fromTable = tableByCellId.get(cellString(source, 'cell'));
    const toTable = tableByCellId.get(cellString(target, 'cell'));
    if (!fromTable || !toTable || fromTable === toTable) continue;
    const fromField = fieldByPort.get(cellString(source, 'port'));
    const toField = fieldByPort.get(cellString(target, 'port'));
    if (!fromField || !toField) continue;
    const e = { fromTable, fromField, toTable, toField };
    const key = `${e.fromTable}.${e.fromField}->${e.toTable}.${e.toField}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  return edges;
}

function isEdgesObject(raw: unknown): raw is { edges: unknown[] } {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    'edges' in raw &&
    Array.isArray((raw as { edges: unknown[] }).edges)
  );
}

function isEdge(raw: unknown): raw is TableRelationEdge {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.fromTable === 'string' &&
    typeof e.fromField === 'string' &&
    typeof e.toTable === 'string' &&
    typeof e.toField === 'string'
  );
}

function commentFor(
  dbComment: string | null,
  customComment: string | null,
): string | null {
  const c = (customComment ?? '').trim();
  if (c) return c;
  const d = (dbComment ?? '').trim();
  return d ? d : null;
}

/** Build the M-Schema string for the generate_sql prompt. */
export function buildMSchema(input: MSchemaInput): string {
  const lines: string[] = [];
  lines.push(`【DB_ID】 ${input.datasourceName}`);
  lines.push('【Schema】');

  const tables = [...input.tables]
    .filter((t) => t.checked)
    .sort((a, b) => a.tableName.localeCompare(b.tableName));

  for (const table of tables) {
    // A curated semantic meaning is the authoritative table comment; fall
    // back to customComment, then the synced DB comment. Guard the lookup:
    // tableNames like `constructor` hit Object.prototype on a plain record.
    const tableMeanings = input.semantics?.tableMeanings;
    const semanticMeaning =
      tableMeanings &&
      Object.prototype.hasOwnProperty.call(tableMeanings, table.tableName)
        ? tableMeanings[table.tableName]
        : undefined;
    const tableComment =
      semanticMeaning?.trim() ||
      commentFor(table.tableComment, table.customComment) ||
      null;
    lines.push(
      `# Table: ${table.tableName}${tableComment ? ` # ${tableComment}` : ''}`,
    );

    const fields = [...table.fields]
      .filter((f) => f.checked)
      .sort((a, b) => {
        const ai = a.fieldIndex ?? Number.MAX_SAFE_INTEGER;
        const bi = b.fieldIndex ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.fieldName.localeCompare(b.fieldName);
      });

    for (const field of fields) {
      const type = field.fieldType || 'unknown';
      const semanticNote =
        input.semantics?.fieldNotes?.[`${table.tableName}.${field.fieldName}`];
      const comment =
        semanticNote?.meaning?.trim() ||
        commentFor(field.fieldComment, field.customComment) ||
        null;
      // Role/unit/enum decorations ride along after the comment text.
      const decoration = semanticNote ? semanticFieldNote(semanticNote) : null;
      const note = decoration || comment;
      const pk = field.isPrimaryKey ? ' (PK)' : '';
      lines.push(
        `  ${field.fieldName} ${type}${pk}${note ? ` # ${note}` : ''}`,
      );
    }
  }

  // FK lines are narrowed to the schema the LLM actually sees (M3.2): an
  // edge naming an absent table or a hidden column invites a hallucinated
  // join — exactly the failure the relation graph exists to prevent. The
  // chat pipeline additionally stuffs ≤2-hop bridge tables (join-path.ts)
  // so multi-table questions carry their connecting edges.
  const checkedFields = new Map(
    tables.map((t) => [
      t.tableName,
      new Set(t.fields.filter((f) => f.checked).map((f) => f.fieldName)),
    ]),
  );
  const edges = normalizeTableRelation(
    input.tableRelation,
    input.relationIdNames,
  ).filter(
    (e) =>
      checkedFields.get(e.fromTable)?.has(e.fromField) &&
      checkedFields.get(e.toTable)?.has(e.toField),
  );
  if (edges.length > 0) {
    lines.push('【Foreign keys】');
    for (const e of edges) {
      lines.push(
        `  ${e.fromTable}(${e.fromField}) -> ${e.toTable}(${e.toField})`,
      );
    }
  }

  return lines.join('\n');
}
