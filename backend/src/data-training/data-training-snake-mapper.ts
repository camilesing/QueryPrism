// data-training snake-mapper — pure function:
// maps a Prisma DataTraining row (+ caller-supplied name maps) to the 10-field
// snake_case wire shape the frontend `training/index.vue` reads. Mirrors
// terminology-snake-mapper but simpler — no pid/other_words (data-training has
// no parent/child self-relation); datasource is a single Int? (not an array)
// so datasource_name is `string | null` (not `string[]`); advanced_application
// is String? on the column
// → coerce Number(String?) on read so the edit form's el-select binds against
// the numeric Assistant id (the frontend is the source of truth for the wire
// contract).

export interface DataTrainingRow {
  id: number;
  oid: number;
  datasource: number | null;
  question: string;
  description: string | null;
  enabled: boolean;
  advancedApplication: string | null;
  createdAt: Date;
}

export interface DataTrainingSnake {
  id: number;
  oid: number;
  datasource: number | null;
  datasource_name: string | null;
  question: string;
  description: string | null;
  enabled: boolean;
  advanced_application: number | null;
  advanced_application_name: string | null;
  create_time: number;
}

/** Coerce the stringified Assistant id column to a number (or null). Mirrors
 *  terminology-snake-mapper.toAdvancedAppId. */
function toAdvancedAppId(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function toDataTrainingSnake(
  row: DataTrainingRow,
  datasourceNameMap: Map<number, string>,
  advancedAppNamesMap: Map<number, string>,
): DataTrainingSnake {
  const datasource = row.datasource;
  const datasourceName =
    datasource != null ? (datasourceNameMap.get(datasource) ?? null) : null;
  const advAppId = toAdvancedAppId(row.advancedApplication);
  const advAppName =
    advAppId != null ? (advancedAppNamesMap.get(advAppId) ?? null) : null;
  return {
    id: row.id,
    oid: row.oid,
    datasource,
    datasource_name: datasourceName,
    question: row.question,
    description: row.description,
    enabled: row.enabled,
    advanced_application: advAppId,
    advanced_application_name: advAppName,
    create_time: row.createdAt.getTime(),
  };
}
