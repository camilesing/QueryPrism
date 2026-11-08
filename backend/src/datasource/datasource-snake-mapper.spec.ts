// datasource-snake-mapper spec. The frontend reads the
// datasource list/get rows as snake_case with two server-derived fields:
//   - `type_name`: the DB product's display label, e.g. mysql→'MySQL',
//     pg→'PostgreSQL', sqlServer→'Microsoft SQL Server'. Derived on read
//     (cheap pure lookup) since the Datasource model has no type_name column.
//   - `num`: a "selected/total" snapshot (e.g. "3/10") updated at
//     create/syncTables/chooseTables. The total half requires a live connection
//     to the source DB. There is no `num` column yet, so the mapper
//     derives `String(selectedCount)` from local state for now — the "N/M"
//     faithful format is deferred (migration + stored column + lazy
//     compute). The frontend renders `num` verbatim as a badge, so a bare
//     count is functional.
// Json blobs (configuration encrypted string, table_relation X6 cells,
// recommended_config) pass through verbatim — a global camelToSnake interceptor
// would mangle their inner keys. Applied in the controller, not the
// service, so existing service specs stay green.
import {
  toDatasourceSnake,
  toTableSnake,
  toFieldSnake,
} from './datasource-snake-mapper';

const baseDatasource = {
  id: 1,
  name: 'shop',
  description: '电商数据库',
  type: 'mysql',
  configuration: 'U2FsdGVkX18-this-is-opaque',
  status: 'active',
  tableRelation: {
    cells: [{ shape: 'edge', source: { cell: 'n1' }, target: { cell: 'n2' } }],
  },
  embedding: [0.1, 0.2, 0.3],
  recommendedConfig: { chart: 'bar' },
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
  updatedAt: new Date('2026-07-25T11:00:00.000Z'),
};

const baseTable = {
  id: 100,
  datasourceId: 1,
  tableName: 'orders',
  tableComment: '订单表',
  customComment: '销售订单',
  checked: true,
  embedding: [0.4, 0.5],
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
  updatedAt: new Date('2026-07-25T11:00:00.000Z'),
};

const baseField = {
  id: 1000,
  tableId: 100,
  fieldName: 'user_id',
  fieldType: 'INTEGER',
  fieldComment: '买家 id',
  customComment: '买家',
  isPrimaryKey: false,
  fieldIndex: 1,
  checked: true,
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
  updatedAt: new Date('2026-07-25T11:00:00.000Z'),
};

describe('toDatasourceSnake', () => {
  it('maps scalar fields to snake_case names + ISO create_time', () => {
    const ds = toDatasourceSnake(baseDatasource);
    expect(ds.id).toBe(1);
    expect(ds.name).toBe('shop');
    expect(ds.description).toBe('电商数据库');
    expect(ds.type).toBe('mysql');
    expect(ds.status).toBe('active');
    expect(ds.create_time).toBe('2026-07-25T10:00:00.000Z');
  });

  it('derives type_name from the type via the wire DB label map', () => {
    expect(
      toDatasourceSnake({ ...baseDatasource, type: 'mysql' }).type_name,
    ).toBe('MySQL');
    expect(toDatasourceSnake({ ...baseDatasource, type: 'pg' }).type_name).toBe(
      'PostgreSQL',
    );
    expect(
      toDatasourceSnake({ ...baseDatasource, type: 'sqlServer' }).type_name,
    ).toBe('Microsoft SQL Server');
    expect(toDatasourceSnake({ ...baseDatasource, type: 'ck' }).type_name).toBe(
      'ClickHouse',
    );
    expect(toDatasourceSnake({ ...baseDatasource, type: 'dm' }).type_name).toBe(
      '达梦',
    );
    expect(
      toDatasourceSnake({ ...baseDatasource, type: 'excel' }).type_name,
    ).toBe('Excel/CSV');
  });

  it('derives type_name for QueryPrism backend-only sqlite type', () => {
    expect(
      toDatasourceSnake({ ...baseDatasource, type: 'sqlite' }).type_name,
    ).toBe('SQLite');
  });

  it('falls back to the raw type string for unknown types', () => {
    expect(
      toDatasourceSnake({ ...baseDatasource, type: 'unknown-db' }).type_name,
    ).toBe('unknown-db');
  });

  it('derives num from _count.tables as a string', () => {
    const ds = toDatasourceSnake({
      ...baseDatasource,
      _count: { tables: 7, chats: 3 },
    });
    expect(ds.num).toBe('7');
  });

  it('derives num from tables.length when _count is absent', () => {
    const ds = toDatasourceSnake({
      ...baseDatasource,
      tables: [{ ...baseTable }, { ...baseTable, id: 101 }] as never,
    });
    expect(ds.num).toBe('2');
  });

  it('derives num = "0" when no count is available', () => {
    const ds = toDatasourceSnake(baseDatasource);
    expect(ds.num).toBe('0');
  });

  it('prefers the stored num snapshot (e.g. "3/10") over the derived count', () => {
    const ds = toDatasourceSnake({
      ...baseDatasource,
      num: '3/10',
      _count: { tables: 7, chats: 3 },
    });
    expect(ds.num).toBe('3/10');
  });

  it('falls back to the derived count when the stored num is null', () => {
    const ds = toDatasourceSnake({
      ...baseDatasource,
      num: null,
      _count: { tables: 7, chats: 3 },
    });
    expect(ds.num).toBe('7');
  });

  it('passes configuration through verbatim (encrypted string, no decrypt)', () => {
    const ds = toDatasourceSnake(baseDatasource);
    expect(ds.configuration).toBe('U2FsdGVkX18-this-is-opaque');
  });

  it('passes table_relation through verbatim (no camelToSnake of inner keys)', () => {
    const ds = toDatasourceSnake(baseDatasource);
    expect(ds.table_relation).toEqual({
      cells: [
        { shape: 'edge', source: { cell: 'n1' }, target: { cell: 'n2' } },
      ],
    });
  });

  it('passes recommended_config through verbatim', () => {
    const ds = toDatasourceSnake(baseDatasource);
    expect(ds.recommended_config).toEqual({ chart: 'bar' });
  });
});

describe('toTableSnake', () => {
  it('maps table fields to snake_case + ISO timestamps', () => {
    const t = toTableSnake(baseTable);
    expect(t.id).toBe(100);
    expect(t.table_name).toBe('orders');
    expect(t.table_comment).toBe('订单表');
    expect(t.custom_comment).toBe('销售订单');
    expect(t.checked).toBe(true);
    expect(t.create_time).toBe('2026-07-25T10:00:00.000Z');
    expect(t.update_time).toBe('2026-07-25T11:00:00.000Z');
  });

  it('exposes datasourceId as ds_id; drops embedding (frontend never reads it)', () => {
    const t = toTableSnake(baseTable) as unknown as Record<string, unknown>;
    expect(t.ds_id).toBe(1);
    expect(t.datasourceId).toBeUndefined();
    expect(t.embedding).toBeUndefined();
  });
});

describe('toFieldSnake', () => {
  it('maps field fields to snake_case + ISO timestamps', () => {
    const f = toFieldSnake(baseField);
    expect(f.id).toBe(1000);
    expect(f.field_name).toBe('user_id');
    expect(f.field_type).toBe('INTEGER');
    expect(f.field_comment).toBe('买家 id');
    expect(f.custom_comment).toBe('买家');
    expect(f.is_primary_key).toBe(false);
    expect(f.field_index).toBe(1);
    expect(f.checked).toBe(true);
    expect(f.create_time).toBe('2026-07-25T10:00:00.000Z');
    expect(f.update_time).toBe('2026-07-25T11:00:00.000Z');
  });

  it('exposes tableId as table_id', () => {
    const f = toFieldSnake(baseField) as unknown as Record<string, unknown>;
    expect(f.table_id).toBe(100);
    expect(f.tableId).toBeUndefined();
  });
});
