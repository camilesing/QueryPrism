// permission-snake-mapper — Phase 10d cycle 5. Maps DsRules (rule group) +
// DsPermission (rule item) prisma rows to the snake_case shape the frontend
// (api/permissions.ts + views/system/permission/index.vue) reads.
// Applied in the controller layer (§88); the mapper is a pure function,
// reverse-engineered purely from the frontend contract (the frontend is the
// source of truth).
//
// The frontend reads:
//   - getList() → bare array of rule groups, each
//     {id, name, permissions:[item], users:[uid]}  (Card.vue :num="ele.permissions.length"
//     + :type="ele.users.length" → both must be arrays)
//   - item (row):   {id, name, type:'row', ds_id, ds_name, table_id, table_name, tree}
//       — handleRowPermission reads `tree` (object or string, frontend handles both via
//         `typeof tree === 'object' ? tree : JSON.parse(tree)`)
//   - item (column): {id, name, type:'column', ds_id, ds_name, table_id, table_name,
//                     permission_list}  — handleColumnPermission reads `permission_list`
//                     (array of {field_id, field_name, field_comment, enable} — assigned
//                     directly to columnForm.permissions which is iterated)
//
// The save body persists `expression_tree` (JSON string, row) + `permissions` (JSON string,
// column) + `permission_list:[]` (always empty on save, in-memory alias dropped). So the
// mapper parses the stored JSON strings back to `tree` (object) + `permission_list` (array)
// on read. The mapper emits both `tree` + `permission_list` regardless of type — the
// frontend branches on `type` so only reads the relevant one (row→tree, column→permission_list).

import { parseStrictInt } from '../common/utils/parse-int';

/** Subset of the DsPermission prisma row the mapper reads. Structural type. */
export interface PermissionItemRow {
  id: number;
  rulesId: number;
  name: string | null;
  type: string; // 'row' | 'column'
  dsId: number | null;
  dsName: string | null;
  tableId: number | null;
  tableName: string | null;
  // JSON string (Text column). Row: the expression tree {logic, items:[...]}.
  // Column: "{}" (empty). Parsed to `tree` on read.
  expressionTree: string | null;
  // JSON string (Text column). Column: the field list [{field_id, field_name,
  // field_comment, enable}]. Row: "[]" (empty). Parsed to `permission_list` on read.
  permissions: string | null;
  createTime: Date | null;
}

/** Subset of the DsRules prisma row the mapper reads. Structural type. */
export interface PermissionGroupRow {
  id: number;
  oid: number;
  name: string;
  // Json column — array of user ids. Coerced to number[] on read; [] when null/non-array.
  userList: unknown;
  permissions: PermissionItemRow[];
  createTime: Date | null;
}

/** The snake_case item shape the frontend reads (9 fields). */
export interface PermissionItemSnake {
  id: number;
  name: string | null;
  type: string;
  ds_id: number | null;
  ds_name: string | null;
  table_id: number | null;
  table_name: string | null;
  tree: unknown; // parsed from expressionTree; object ({} when null/empty/invalid)
  permission_list: unknown[]; // parsed from permissions; array ([] when null/empty/invalid)
}

/** The snake_case group shape the frontend reads (4 fields). */
export interface PermissionGroupSnake {
  id: number;
  name: string;
  permissions: PermissionItemSnake[];
  users: number[];
}

/** Safe JSON.parse to a default value on null/empty/invalid input. The mapper
 *  never throws — a corrupt stored JSON degrades to the empty default so the
 *  list endpoint stays 200 (mirrors terminology/data-training safe-parse pattern). */
function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (raw == null || raw.trim() === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Coerce a Json column value to a clean number[] (User.id is Int). The stored
 *  value may be a Prisma JsonValue (array of numbers/strings/mixed). P2-1:
 *  strict parse — the old `Number()` + isFinite filter turned [null, '', 1]
 *  into [0, 0, 1], FABRICATING user ids that could silently bind rules to
 *  the wrong accounts. Unparseable entries are dropped instead. */
function toNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const n of v) {
    const parsed = parseStrictInt(n);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function toPermissionItemSnake(
  row: PermissionItemRow,
): PermissionItemSnake {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ds_id: row.dsId,
    ds_name: row.dsName,
    table_id: row.tableId,
    table_name: row.tableName,
    // Row: parsed expression tree {logic, items}. Column: "{}" → {}.
    tree: safeJsonParse(row.expressionTree, {}),
    // Column: parsed field list [{field_id, ...}]. Row: "[]" → [].
    permission_list: safeJsonParse<unknown[]>(row.permissions, []),
  };
}

export function toPermissionGroupSnake(
  rules: PermissionGroupRow,
): PermissionGroupSnake {
  return {
    id: rules.id,
    name: rules.name,
    permissions: rules.permissions.map((p) => toPermissionItemSnake(p)),
    users: toNumberArray(rules.userList),
  };
}
