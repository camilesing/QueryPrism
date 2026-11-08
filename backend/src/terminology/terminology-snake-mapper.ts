// terminology-snake-mapper — maps a Terminology prisma parent row to the
// snake_case shape the frontend reads (views/system/professional/index.vue:501-556
// `scope.row.*`). Applied in the controller layer; the service pre-builds the
// three lookup maps so the mapper stays a pure function (mirrors cycle 3
// audit's oidNameMap).
//
// The frontend reads 11 fields per row (derived from the frontend template):
//   - id (number; the frontend passes it back to DELETE/enable as a number, so
//     we keep it numeric, unlike audit which stringifies)
//   - word                 ← row.word
//   - description          ← row.description (nullable)
//   - other_words          ← children's words grouped by pid (parent.id → [child.word])
//   - specific_ds          ← row.specificDs
//   - datasource_ids       ← row.datasourceIds (Json number[]; [] when null)
//   - datasource_names     ← Datasource.name looked up by each datasource_id
//                            (dropped when the id is unknown; order preserved)
//   - enabled              ← row.enabled
//   - advanced_application ← Number(row.advancedApplication) (stored as the
//                            stringified id in a String? column; coerced back
//                            to a number here so the edit form's el-select
//                            binds against the numeric assistant id returned
//                            by getAdvancedApplicationList — the frontend is
//                            the source of truth for the wire contract)
//   - advanced_application_name ← Assistant.name looked up by the numeric
//                            advanced_application id (null when absent)
//   - create_time          ← row.createdAt epoch-ms (formatTimestamp reads a
//                            number, same as cycle 1 apikey / cycle 3 audit)

/** Subset of the Terminology prisma row the mapper reads. Structural type. */
export interface TerminologyRow {
  id: number;
  word: string;
  description: string | null;
  specificDs: boolean;
  datasourceIds: number[] | null;
  enabled: boolean;
  // Stringified Assistant.id (the column is String? to avoid a SQLite
  // type-change migration; the mapper coerces back to a number for the wire).
  advancedApplication: string | null;
  createdAt: Date;
}

/** The snake_case list shape the frontend terminology table reads (11 fields). */
export interface TerminologySnake {
  id: number;
  word: string;
  description: string | null;
  other_words: string[];
  specific_ds: boolean;
  datasource_ids: number[];
  datasource_names: string[];
  enabled: boolean;
  advanced_application: number | null;
  advanced_application_name: string | null;
  create_time: number;
}

/** Coerce the stored stringified assistant id back to a number, tolerating the
 *  null/empty-string cases that arise when no advanced application is bound. */
function toAdvancedAppId(v: string | null): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/** Map a Terminology parent row to the snake_case terminology-list shape.
 *  `otherWordsMap` groups children by pid (parent.id → [child.word]);
 *  `datasourceNamesMap` + `advancedAppNamesMap` are batch-lookups the service
 *  pre-builds for the distinct ids in the page (avoids N+1 per row). */
export function toTerminologySnake(
  row: TerminologyRow,
  otherWordsMap: Map<number, string[]>,
  datasourceNamesMap: Map<number, string>,
  advancedAppNamesMap: Map<number, string>,
): TerminologySnake {
  const dsIds = Array.isArray(row.datasourceIds) ? row.datasourceIds : [];
  const dsNames = dsIds
    .map((id) => datasourceNamesMap.get(id))
    .filter((n): n is string => typeof n === 'string' && n.length > 0);
  const advAppId = toAdvancedAppId(row.advancedApplication);
  const advAppName =
    advAppId != null ? (advancedAppNamesMap.get(advAppId) ?? null) : null;
  return {
    id: row.id,
    word: row.word,
    description: row.description,
    other_words: otherWordsMap.get(row.id) ?? [],
    specific_ds: row.specificDs,
    datasource_ids: dsIds,
    datasource_names: dsNames,
    enabled: row.enabled,
    advanced_application: advAppId,
    advanced_application_name: advAppName,
    create_time: row.createdAt.getTime(),
  };
}
