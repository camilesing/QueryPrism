// sys-variable-snake-mapper — Phase 10c cycle 2 §82/§88/§101. Maps a
// SystemVariable row to the snake_case shape the frontend reads
// (variables/index.vue:154 listPage `.items`; :72 listAll for RowAuth/
// FilterFiled permission). Applied in the controller (§77/§88).
//
// The frontend reads 5 fields:
//   - `id` / `name` / `type` pass through unchanged.
//   - `var_type` (renamed from Prisma camelCase `varType`); values are
//     'text'|'number'|'datetime' (sys_variable admin). The reconciled
//     parameter module (parameter.service type='parameter') stores 'str'
//     only, but those rows don't surface in the sys_variable admin page.
//   - `value` is ALWAYS a Json array: text=
//     string[], number=[min,max], datetime=[start,end]. Passes through
//     verbatim — no camelToSnake of inner keys (§88).
//
// `create_time`/`create_by` are omitted (the frontend ignores the extras;
// `enabled` was dropped from the schema entirely).
export interface SysVariableRow {
  id: number;
  name: string;
  varType: string;
  type: string;
  value: unknown; // Json array (text/number/datetime)
  createTime?: Date | null;
  createBy?: number | null;
}

export interface SysVariableSnake {
  id: number;
  name: string;
  var_type: string;
  value: unknown;
  type: string;
}

/** Map a SystemVariable row to the snake_case list/get shape (5 fields). */
export function toSysVariableSnake(row: SysVariableRow): SysVariableSnake {
  return {
    id: row.id,
    name: row.name,
    var_type: row.varType,
    value: row.value,
    type: row.type,
  };
}
