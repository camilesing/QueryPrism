// permission-snake-mapper spec — Phase 10d cycle 5. Verifies the
// snake_case wire shape the frontend (api/permissions.ts +
// views/system/permission/index.vue) reads. The mapper is reverse-engineered
// purely from the frontend contract.
//
// The frontend reads:
//   - getList() → bare array of rule groups, each {id, name, permissions:[item], users:[uid]}
//   - item (row):   {id, name, type:'row', ds_id, ds_name, table_id, table_name, tree}
//       — handleRowPermission reads `tree` (object or string, frontend handles both)
//   - item (column): {id, name, type:'column', ds_id, ds_name, table_id, table_name, permission_list}
//       — handleColumnPermission reads `permission_list` (array of {field_id, field_name, field_comment, enable})
//   The save body persists `expression_tree` (JSON string, row) + `permissions` (JSON string, column) +
//   `permission_list:[]` (always empty on save, in-memory alias dropped). So the mapper parses the stored
//   JSON strings back to `tree` (object) + `permission_list` (array) on read. The mapper emits both
//   `tree` + `permission_list` regardless of type — the frontend branches on `type` so only reads the
//   relevant one (row→tree, column→permission_list).
import {
  toPermissionGroupSnake,
  toPermissionItemSnake,
  type PermissionItemRow,
  type PermissionGroupRow,
} from './permission-snake-mapper';

function item(
  partial: Partial<PermissionItemRow> & { id: number; type: string },
): PermissionItemRow {
  return {
    rulesId: 1,
    name: 'rule-1',
    dsId: 10,
    dsName: 'orders_ds',
    tableId: 20,
    tableName: 'orders',
    expressionTree: null,
    permissions: null,
    createTime: new Date('2026-07-26T00:00:00Z'),
    ...partial,
  };
}

function group(
  partial: Partial<PermissionGroupRow> & { id: number; name: string },
): PermissionGroupRow {
  return {
    oid: 1,
    userList: null,
    permissions: [],
    createTime: new Date('2026-07-26T00:00:00Z'),
    ...partial,
  };
}

describe('toPermissionItemSnake', () => {
  it('emits all 9 snake fields with correct values + types', () => {
    const out = toPermissionItemSnake(
      item({
        id: 5,
        name: 'orders row rule',
        type: 'row',
        dsId: 10,
        dsName: 'orders_ds',
        tableId: 20,
        tableName: 'orders',
        expressionTree: '{"logic":"and","items":[]}',
        permissions:
          '[{"field_id":1,"field_name":"id","field_comment":"ID","enable":true}]',
      }),
    );
    expect(out).toEqual({
      id: 5,
      name: 'orders row rule',
      type: 'row',
      ds_id: 10,
      ds_name: 'orders_ds',
      table_id: 20,
      table_name: 'orders',
      tree: { logic: 'and', items: [] }, // parsed from expressionTree string
      permission_list: [
        { field_id: 1, field_name: 'id', field_comment: 'ID', enable: true },
      ], // parsed from permissions string
    });
    // exactly 9 fields — no expression_tree/permissions raw strings leaked
    expect(Object.keys(out).sort()).toEqual(
      [
        'ds_id',
        'ds_name',
        'id',
        'name',
        'permission_list',
        'table_id',
        'table_name',
        'tree',
        'type',
      ].sort(),
    );
  });

  it('tree parsed from expressionTree; {} when null/empty/invalid', () => {
    expect(
      toPermissionItemSnake(item({ id: 1, type: 'row', expressionTree: null }))
        .tree,
    ).toEqual({});
    expect(
      toPermissionItemSnake(item({ id: 2, type: 'row', expressionTree: '' }))
        .tree,
    ).toEqual({});
    expect(
      toPermissionItemSnake(item({ id: 3, type: 'row', expressionTree: '   ' }))
        .tree,
    ).toEqual({});
    expect(
      toPermissionItemSnake(
        item({ id: 4, type: 'row', expressionTree: 'not-json' }),
      ).tree,
    ).toEqual({}); // invalid JSON → safe default {}
    expect(
      toPermissionItemSnake(
        item({
          id: 5,
          type: 'row',
          expressionTree: '{"logic":"or","items":[1]}',
        }),
      ).tree,
    ).toEqual({ logic: 'or', items: [1] });
  });

  it('permission_list parsed from permissions; [] when null/empty/invalid', () => {
    expect(
      toPermissionItemSnake(item({ id: 1, type: 'column', permissions: null }))
        .permission_list,
    ).toEqual([]);
    expect(
      toPermissionItemSnake(item({ id: 2, type: 'column', permissions: '' }))
        .permission_list,
    ).toEqual([]);
    expect(
      toPermissionItemSnake(
        item({ id: 3, type: 'column', permissions: 'nope' }),
      ).permission_list,
    ).toEqual([]);
    expect(
      toPermissionItemSnake(
        item({
          id: 4,
          type: 'column',
          permissions: '[{"field_id":7,"enable":false}]',
        }),
      ).permission_list,
    ).toEqual([{ field_id: 7, enable: false }]);
  });

  it('ds_id/ds_name/table_id/table_name null-safe', () => {
    const out = toPermissionItemSnake(
      item({
        id: 1,
        type: 'row',
        dsId: null,
        dsName: null,
        tableId: null,
        tableName: null,
      }),
    );
    expect(out.ds_id).toBeNull();
    expect(out.ds_name).toBeNull();
    expect(out.table_id).toBeNull();
    expect(out.table_name).toBeNull();
  });

  it('emits both tree + permission_list regardless of type (frontend branches on type)', () => {
    // row item still emits permission_list (parsed from permissions, may be [])
    const rowOut = toPermissionItemSnake(
      item({ id: 1, type: 'row', permissions: '[]' }),
    );
    expect(rowOut.permission_list).toEqual([]);
    expect(rowOut.tree).toEqual({});

    // column item still emits tree (parsed from expressionTree, may be {})
    const colOut = toPermissionItemSnake(
      item({ id: 2, type: 'column', expressionTree: '{}' }),
    );
    expect(colOut.tree).toEqual({});
    expect(colOut.permission_list).toEqual([]);
  });
});

describe('toPermissionGroupSnake', () => {
  it('emits all 4 snake fields; permissions array mapped; users from userList', () => {
    const out = toPermissionGroupSnake(
      group({
        id: 100,
        name: 'orders admins',
        userList: [1, 2, 3],
        permissions: [
          item({
            id: 1,
            rulesId: 100,
            type: 'row',
            name: 'row-rule',
            expressionTree: '{"logic":"and","items":[]}',
          }),
          item({
            id: 2,
            rulesId: 100,
            type: 'column',
            name: 'col-rule',
            permissions: '[{"field_id":1,"enable":true}]',
          }),
        ],
      }),
    );
    expect(out).toEqual({
      id: 100,
      name: 'orders admins',
      permissions: [
        {
          id: 1,
          name: 'row-rule',
          type: 'row',
          ds_id: 10,
          ds_name: 'orders_ds',
          table_id: 20,
          table_name: 'orders',
          tree: { logic: 'and', items: [] },
          permission_list: [],
        },
        {
          id: 2,
          name: 'col-rule',
          type: 'column',
          ds_id: 10,
          ds_name: 'orders_ds',
          table_id: 20,
          table_name: 'orders',
          tree: {},
          permission_list: [{ field_id: 1, enable: true }],
        },
      ],
      users: [1, 2, 3],
    });
    expect(Object.keys(out).sort()).toEqual(
      ['id', 'name', 'permissions', 'users'].sort(),
    );
  });

  it('users [] when userList null/non-array; coerces Json array to number[]', () => {
    expect(
      toPermissionGroupSnake(group({ id: 1, name: 'g', userList: null })).users,
    ).toEqual([]);
    expect(
      toPermissionGroupSnake(
        group({ id: 2, name: 'g', userList: 'oops' as any }),
      ).users,
    ).toEqual([]);
    expect(
      toPermissionGroupSnake(group({ id: 3, name: 'g', userList: [1, '2', 3] }))
        .users,
    ).toEqual([1, 2, 3]); // numeric strings coerced to numbers
  });

  it('permissions [] when relation empty', () => {
    const out = toPermissionGroupSnake(
      group({ id: 1, name: 'g', permissions: [] }),
    );
    expect(out.permissions).toEqual([]);
  });
});
