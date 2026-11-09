// semantic-snake-mapper — camelCase DB rows → the snake_case wire shapes the
// admin page consumes. Json blobs (enumValues, payload, snapshot) pass through
// verbatim (same rule as chat-snake-mapper: no deep key rewriting).
import type {
  FieldSemantic,
  FieldSemanticVersion,
  SemanticChangeRequest,
  TableSemantic,
  TableSemanticVersion,
} from '@prisma/client';

export interface TableSemanticSnake {
  id: number;
  scope: string;
  oid: number | null;
  owner_uid: number | null;
  datasource_id: number;
  table_name: string;
  meaning: string;
  enabled: boolean;
  version: number;
  create_by: number | null;
  create_time: string;
  update_time: string;
  /** false → the synced Table row is gone (rename/drop); the entry dangles. */
  table_exists: boolean;
}

export interface FieldSemanticSnake {
  id: number;
  scope: string;
  oid: number | null;
  owner_uid: number | null;
  datasource_id: number;
  table_name: string;
  field_name: string;
  role: string;
  meaning: string;
  unit: string | null;
  enum_values: unknown;
  enabled: boolean;
  version: number;
  create_by: number | null;
  create_time: string;
  update_time: string;
  table_exists: boolean;
}

export type SemanticEntitySnake = TableSemanticSnake | FieldSemanticSnake;

export interface SemanticRequestSnake {
  id: number;
  entity_type: string;
  action: string;
  target_type: string;
  payload: unknown;
  status: string;
  proposer_uid: number;
  proposer: string | null;
  reviewer_uid: number | null;
  review_note: string | null;
  reviewed_at: string | null;
  create_time: string;
}

export interface SemanticVersionSnake {
  id: number;
  version: number;
  snapshot: unknown;
  changed_by: number | null;
  note: string | null;
  create_time: string;
}

export interface SemanticPage<T> {
  current_page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  data: T[];
}

export type SemanticRequestPage = SemanticPage<SemanticRequestSnake>;

const ISO = (d: Date): string => d.toISOString();

export function toTableSemanticSnake(
  row: TableSemantic,
  tableExists: boolean,
): TableSemanticSnake {
  return {
    id: row.id,
    scope: row.scope,
    oid: row.oid,
    owner_uid: row.ownerUid,
    datasource_id: row.datasourceId,
    table_name: row.tableName,
    meaning: row.meaning,
    enabled: row.enabled,
    version: row.version,
    create_by: row.createBy,
    create_time: ISO(row.createdAt),
    update_time: ISO(row.updatedAt),
    table_exists: tableExists,
  };
}

export function toFieldSemanticSnake(
  row: FieldSemantic,
  tableExists: boolean,
): FieldSemanticSnake {
  return {
    id: row.id,
    scope: row.scope,
    oid: row.oid,
    owner_uid: row.ownerUid,
    datasource_id: row.datasourceId,
    table_name: row.tableName,
    field_name: row.fieldName,
    role: row.role,
    meaning: row.meaning,
    unit: row.unit,
    enum_values: row.enumValues,
    enabled: row.enabled,
    version: row.version,
    create_by: row.createBy,
    create_time: ISO(row.createdAt),
    update_time: ISO(row.updatedAt),
    table_exists: tableExists,
  };
}

export function toRequestSnake(
  row: SemanticChangeRequest,
): SemanticRequestSnake {
  return {
    id: row.id,
    entity_type: row.entityType,
    action: row.action,
    target_type: row.targetType,
    payload: row.payload,
    status: row.status,
    proposer_uid: row.proposerUid,
    proposer: row.proposer,
    reviewer_uid: row.reviewerUid,
    review_note: row.reviewNote,
    reviewed_at: row.reviewedAt != null ? ISO(row.reviewedAt) : null,
    create_time: ISO(row.createdAt),
  };
}

export function toVersionSnake(
  row: TableSemanticVersion | FieldSemanticVersion,
): SemanticVersionSnake {
  return {
    id: row.id,
    version: row.version,
    snapshot: row.snapshot,
    changed_by: row.changedBy,
    note: row.note,
    create_time: ISO(row.createdAt),
  };
}
