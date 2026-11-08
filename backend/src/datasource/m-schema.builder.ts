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
    const tableComment = commentFor(table.tableComment, table.customComment);
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
      const comment = commentFor(field.fieldComment, field.customComment);
      const pk = field.isPrimaryKey ? ' (PK)' : '';
      lines.push(
        `  ${field.fieldName} ${type}${pk}${comment ? ` # ${comment}` : ''}`,
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
