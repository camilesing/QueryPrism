// sys-variable-snake-mapper spec — Phase 10c cycle 2 §82/§88/§101. The
// frontend (variables/index.vue:154 `fieldList.value = res.items` for listPage;
// variables/index.vue:72 listAll for permission RowAuth/FilterFiled) reads
// system variables as snake_case rows:
//   - `var_type` (renamed from Prisma camelCase `varType`); values are
//     'text'|'number'|'datetime' (sys_variable admin) — the array `value`
//     shape differs per var_type (text=string[], number=[min,max],
//     datetime=[start,end]).
//   - `value` is ALWAYS a Json array. Passes
//     through verbatim (no camelToSnake of inner keys, §88).
//   - `type` is 'system' (3 built-in non-deletable ids 1-3) | 'custom'.
//   - `id`/`name` pass through unchanged.
// The frontend reads NO `create_time`/`create_by`/`enabled` — those are
// omitted (the frontend ignores the extras; `enabled` was dropped from the
// schema entirely).
import { toSysVariableSnake } from './sys-variable-snake-mapper';

const baseRow = {
  id: 5,
  name: 'favorite_color',
  varType: 'text',
  type: 'custom',
  value: ['red', 'blue'],
  createTime: null,
  createBy: null,
};

describe('toSysVariableSnake', () => {
  it('maps id/name/var_type/value/type to snake_case', () => {
    const out = toSysVariableSnake(baseRow);
    expect(out).toEqual({
      id: 5,
      name: 'favorite_color',
      var_type: 'text',
      value: ['red', 'blue'],
      type: 'custom',
    });
  });

  it('passes the value array through verbatim (no inner camelToSnake, §88)', () => {
    const value = ['name', 'account', 'email'];
    const out = toSysVariableSnake({ ...baseRow, value, varType: 'text' });
    expect(out.value).toBe(value);
    expect(out.value).toEqual(['name', 'account', 'email']);
  });

  it('preserves a number var_type with [min,max] value', () => {
    const out = toSysVariableSnake({
      ...baseRow,
      varType: 'number',
      value: [1, 100],
    });
    expect(out.var_type).toBe('number');
    expect(out.value).toEqual([1, 100]);
  });

  it('preserves a datetime var_type with [start,end] value', () => {
    const out = toSysVariableSnake({
      ...baseRow,
      varType: 'datetime',
      value: ['2026-01-01', '2026-12-31'],
    });
    expect(out.var_type).toBe('datetime');
    expect(out.value).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('preserves type=system (built-in non-deletable)', () => {
    const out = toSysVariableSnake({
      ...baseRow,
      id: 1,
      name: 'Name',
      varType: 'text',
      type: 'system',
      value: ['name'],
    });
    expect(out.type).toBe('system');
    expect(out.id).toBe(1);
  });

  it('does not emit create_time / create_by / enabled (frontend reads none)', () => {
    const out = toSysVariableSnake(baseRow);
    expect(out).not.toHaveProperty('create_time');
    expect(out).not.toHaveProperty('create_by');
    expect(out).not.toHaveProperty('enabled');
  });
});
