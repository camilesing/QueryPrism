// custom-prompt-snake-mapper — maps a CustomPrompt
// prisma row to the snake_case shape the frontend (api/prompt.ts +
// views/system/prompt/index.vue) reads. Applied in the controller layer;
// the service pre-builds the datasourceNamesMap + advancedAppNamesMap so the
// mapper stays a pure function.
//
// The frontend reads 11 fields per row (derived from the template +
// form interface):
//   - id (number; passed back to DELETE/upsert as a number)
//   - oid (number; workspace scope — included for parity, frontend doesn't read)
//   - type (string; GENERATE_SQL | ANALYSIS | PREDICT_DATA — edit form populates)
//   - create_time (number; epoch-ms — formatTimestamp reads a number)
//   - name (string|null)
//   - prompt (string|null; plaintext, no AES)
//   - specific_ds (boolean; true=scope to datasource_ids, false=all datasources)
//   - datasource_ids (number[]; Json column — [] when null)
//   - datasource_names (string[]; JOIN-enriched from Datasource.name — dropped
//     when the id is unknown; order preserved)
//   - advanced_application (number|null; kept as the stringified id in a
//     String? column
//     + coerces back to a number here so the edit form's el-select binds against
//     the numeric assistant id returned by getAdvancedApplicationList — same
//     convention as other assistant-scoped resources)
//   - advanced_application_name (string|null; JOIN-enriched from Assistant.name)

/** Subset of the CustomPrompt prisma row the mapper reads. Structural type. */
export interface CustomPromptRow {
  id: number;
  oid: number;
  type: string;
  name: string | null;
  prompt: string | null;
  specificDs: boolean;
  datasourceIds: number[] | null;
  // Stringified Assistant.id (the column is String? to avoid a SQLite
  // type-change migration; the mapper coerces back to a number for the wire).
  advancedApplication: string | null;
  createTime: Date | null;
}

/** The snake_case list shape the frontend prompt table reads (11 fields). */
export interface CustomPromptSnake {
  id: number;
  oid: number;
  type: string;
  create_time: number;
  name: string | null;
  prompt: string | null;
  specific_ds: boolean;
  datasource_ids: number[];
  datasource_names: string[];
  advanced_application: number | null;
  advanced_application_name: string | null;
}

/** Coerce the stored stringified assistant id back to a number, tolerating the
 *  null/empty-string cases that arise when no advanced application is bound. */
function toAdvancedAppId(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Map a CustomPrompt row to the snake_case custom-prompt-list shape.
 *  `datasourceNamesMap` + `advancedAppNamesMap` are batch-lookups the service
 *  pre-builds for the distinct ids in the page (avoids N+1 per row). */
export function toCustomPromptSnake(
  row: CustomPromptRow,
  datasourceNamesMap: Map<number, string>,
  advancedAppNamesMap: Map<number, string>,
): CustomPromptSnake {
  const dsIds = Array.isArray(row.datasourceIds) ? row.datasourceIds : [];
  const dsNames = dsIds
    .map((id) => datasourceNamesMap.get(id))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const advAppId = toAdvancedAppId(row.advancedApplication);
  const advAppName =
    advAppId != null ? (advancedAppNamesMap.get(advAppId) ?? null) : null;
  return {
    id: row.id,
    oid: row.oid,
    type: row.type,
    create_time: row.createTime ? row.createTime.getTime() : 0,
    name: row.name,
    prompt: row.prompt,
    specific_ds: row.specificDs,
    datasource_ids: dsIds,
    datasource_names: dsNames,
    advanced_application: advAppId,
    advanced_application_name: advAppName,
  };
}
