// audit-snake-mapper — Phase 10c cycle 3 §82/§88. Maps a SystemLog row to the
// snake_case shape the frontend reads (views/system/audit/index.vue:286-
// 335 `scope.row.*`). Applied in the controller layer (§77/§88).
//
// The frontend reads 12 fields per row (reverse-engineered from the template):
//   - id (stringified)
//   - operation_type_name  ← row.type (capitalized display; no backend i18n —
//                            §104 deviation, reconcile in 10d)
//   - operation_detail_info ← row.detail
//   - user_name             ← row.operator
//   - resource_name         ← row.resources[0]?.name (relation snapshot)
//   - operation_status      ← row.status normalized to 'success'/'failed'
//                             (legacy 'fail' → 'failed'; data-migration also
//                             rewrites 'fail'→'failed' in the schema)
//   - operation_status_name ← capitalized status display
//   - ip_address            ← row.ipAddress (nullable; null when the write
//                             side didn't capture — pre-cycle-3 rows)
//   - create_time           ← row.createdAt epoch-ms (formatTimestamp reads
//                             a number, matching cycle 1 apikey create_time)
//   - oid_name              ← Workspace.name looked up by row.oid via the
//                             caller-supplied map; '-1' when null/unknown
//                             (frontend renders '-1' as '-')
//   - oid                   ← stringified row.oid ('' when null)
//   - error_message         ← row.errorMessage ('' when null; shown in a
//                             drawer on failed rows)
//   - remark                ← row.remark ('' when null; template doesn't
//                             display but the wire shape carries it)
//
// `oidNameMap` is built by the service (batch-lookup Workspace names for the
// distinct oids in the page) and passed in — keeps the mapper a pure function
// (no prisma calls) consistent with cycles 1/2.

/** Subset of the SystemLog prisma row the mapper reads. Structural type —
 *  accepts the prisma include shape ({ resources: { name }[] }). */
export interface AuditLogRow {
  id: number;
  module: string;
  type: string;
  status: string; // 'success' | 'failed' (post-migration; 'fail' tolerated)
  operatorId: number | null;
  operator: string | null;
  detail: string | null;
  createdAt: Date;
  oid: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  executionTime: number | null;
  errorMessage: string | null;
  requestMethod: string | null;
  requestPath: string | null;
  remark: string | null;
  resources?: { name: string | null }[];
}

/** The snake_case list/get shape the frontend audit table reads (12 fields). */
export interface AuditLogSnake {
  id: string;
  operation_type_name: string;
  operation_detail_info: string;
  user_name: string;
  resource_name: string;
  operation_status: 'success' | 'failed';
  operation_status_name: string;
  ip_address: string | null;
  create_time: number;
  oid_name: string;
  oid: string;
  error_message: string;
  remark: string;
}

/** Capitalize the first letter for a display name (no-op on empty strings).
 *  There is no backend i18n service, so a localized capitalize stands in
 *  (§104 deviation). */
function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Map a SystemLog row to the snake_case audit-list shape.
 *  `oidNameMap` maps workspace id → name (service pre-builds it). */
export function toAuditLogSnake(
  row: AuditLogRow,
  oidNameMap: Map<number, string>,
): AuditLogSnake {
  // Normalize status: anything non-'success' → 'failed'. Covers legacy 'fail'
  // rows that somehow escaped the data migration, plus defensive handling.
  const status: 'success' | 'failed' =
    row.status === 'success' ? 'success' : 'failed';
  const oidName = row.oid != null ? (oidNameMap.get(row.oid) ?? '-1') : '-1';
  return {
    id: String(row.id),
    operation_type_name: capitalize(row.type),
    operation_detail_info: row.detail ?? '',
    user_name: row.operator ?? '',
    resource_name: row.resources?.[0]?.name ?? '',
    operation_status: status,
    operation_status_name: capitalize(status),
    ip_address: row.ipAddress ?? null,
    create_time: row.createdAt.getTime(),
    oid_name: oidName,
    oid: row.oid != null ? String(row.oid) : '',
    error_message: row.errorMessage ?? '',
    remark: row.remark ?? '',
  };
}
