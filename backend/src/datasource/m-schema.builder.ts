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
    { role: string; meaning: string; unit?: string; enums?: string[] }
  >;
}

/** Role tags shown before the field comment — zh labels match the project's
 *  primary locale and read naturally inside M-Schema comment lines. */
const ROLE_TAGS: Record<string, string> = {
  metric: '指标',
  dimension: '维度',
  time: '时间',
};

/** Compose the field comment line: `[角色] 含义 (单位: x; 枚举: a/b)`. */
function semanticFieldNote(
  note: MSchemaSemantics['fieldNotes'][string],
): string {
  const tag = ROLE_TAGS[note.role];
  const meaning = note.meaning?.trim() ?? '';
  const head = [tag ? `[${tag}]` : '', meaning].filter(Boolean).join(' ');
  const tails: string[] = [];
  if (note.unit?.trim()) tails.push(`单位: ${note.unit.trim()}`);
  if (note.enums?.length) tails.push(`枚举: ${note.enums.join('/')}`);
  const tail = tails.length ? ` (${tails.join('; ')})` : '';
  return `${head}${tail}`;
}

/**
 * Coerce the raw `tableRelation` JSON (array of edges or `{ edges: [...] }`)
 * into a clean list, dropping any malformed entries so a bad edit can never
 * break schema generation.
 */
export function normalizeTableRelation(raw: unknown): TableRelationEdge[] {
  const list: unknown = Array.isArray(raw)
    ? raw
    : isEdgesObject(raw)
      ? raw.edges
      : [];
  if (!Array.isArray(list)) return [];
  // filter(isEdge) narrows to TableRelationEdge[]; no cast needed.
  return list.filter(isEdge);
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
    // back to customComment, then the synced DB comment.
    const semanticMeaning = input.semantics?.tableMeanings?.[table.tableName];
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

  const edges = normalizeTableRelation(input.tableRelation);
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
