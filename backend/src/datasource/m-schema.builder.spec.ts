import { buildMSchema, normalizeTableRelation } from './m-schema.builder';

describe('normalizeTableRelation', () => {
  it('passes through a plain array of edges', () => {
    const edges = normalizeTableRelation([
      { fromTable: 'a', fromField: 'b', toTable: 'c', toField: 'd' },
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].fromTable).toBe('a');
  });

  it('unwraps { edges: [...] }', () => {
    const edges = normalizeTableRelation({
      edges: [{ fromTable: 'a', fromField: 'b', toTable: 'c', toField: 'd' }],
    });
    expect(edges).toHaveLength(1);
  });

  it('returns [] for null / undefined / non-array', () => {
    expect(normalizeTableRelation(null)).toEqual([]);
    expect(normalizeTableRelation(undefined)).toEqual([]);
    expect(normalizeTableRelation('nope')).toEqual([]);
    expect(normalizeTableRelation({ edges: 'nope' })).toEqual([]);
  });

  it('drops malformed edges without throwing', () => {
    const edges = normalizeTableRelation([
      { fromTable: 'a', fromField: 'b', toTable: 'c', toField: 'd' },
      { fromTable: 'a' }, // missing fields — drop
      'garbage',
      null,
    ]);
    expect(edges).toHaveLength(1);
  });
});

describe('buildMSchema', () => {
  const baseTable = {
    tableName: 'users',
    tableComment: null,
    customComment: null,
    checked: true,
    fields: [
      {
        fieldName: 'id',
        fieldType: 'INTEGER',
        fieldComment: null,
        customComment: null,
        isPrimaryKey: true,
        fieldIndex: 0,
        checked: true,
      },
      {
        fieldName: 'name',
        fieldType: 'TEXT',
        fieldComment: 'display name',
        customComment: null,
        isPrimaryKey: false,
        fieldIndex: 1,
        checked: true,
      },
      {
        fieldName: 'secret',
        fieldType: 'TEXT',
        fieldComment: null,
        customComment: null,
        isPrimaryKey: false,
        fieldIndex: 2,
        checked: false, // hidden from the LLM
      },
    ],
  };

  it('emits the DB id + schema headers and one line per checked field', () => {
    const out = buildMSchema({
      datasourceName: 'shop',
      tables: [baseTable],
    });
    expect(out).toContain('【DB_ID】 shop');
    expect(out).toContain('【Schema】');
    expect(out).toContain('# Table: users');
    expect(out).toContain('id INTEGER (PK)');
    expect(out).toContain('name TEXT # display name');
    expect(out).not.toContain('secret');
  });

  it('prefers customComment over the DB comment', () => {
    const out = buildMSchema({
      datasourceName: 'shop',
      tables: [
        {
          ...baseTable,
          tableComment: 'db comment',
          customComment: '用户表',
          fields: [],
        },
      ],
    });
    expect(out).toContain('# Table: users # 用户表');
    expect(out).not.toContain('db comment');
  });

  it('orders fields by fieldIndex, falling back to name when null', () => {
    const out = buildMSchema({
      datasourceName: 'shop',
      tables: [
        {
          tableName: 't',
          tableComment: null,
          customComment: null,
          checked: true,
          fields: [
            {
              fieldName: 'zeta',
              fieldType: 'TEXT',
              fieldComment: null,
              customComment: null,
              isPrimaryKey: false,
              fieldIndex: null,
              checked: true,
            },
            {
              fieldName: 'alpha',
              fieldType: 'TEXT',
              fieldComment: null,
              customComment: null,
              isPrimaryKey: false,
              fieldIndex: null,
              checked: true,
            },
          ],
        },
      ],
    });
    const alphaIdx = out.indexOf('alpha');
    const zetaIdx = out.indexOf('zeta');
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('omits unchecked tables entirely', () => {
    const out = buildMSchema({
      datasourceName: 'shop',
      tables: [{ ...baseTable, checked: false }],
    });
    expect(out).not.toContain('# Table: users');
  });

  it('renders the foreign-keys section only when edges exist', () => {
    const withFk = buildMSchema({
      datasourceName: 'shop',
      tables: [baseTable],
      tableRelation: [
        {
          fromTable: 'orders',
          fromField: 'user_id',
          toTable: 'users',
          toField: 'id',
        },
      ],
    });
    expect(withFk).toContain('【Foreign keys】');
    expect(withFk).toContain('orders(user_id) -> users(id)');

    const noFk = buildMSchema({
      datasourceName: 'shop',
      tables: [baseTable],
    });
    expect(noFk).not.toContain('【Foreign keys】');
  });
});

describe('buildMSchema semantics injection (MetaDataImprove M2)', () => {
  const table = {
    tableName: 'sales_order',
    tableComment: 'so header',
    customComment: '自定义备注',
    checked: true,
    fields: [
      {
        fieldName: 'order_status',
        fieldType: 'varchar',
        fieldComment: 'status',
        customComment: null,
        isPrimaryKey: false,
        fieldIndex: 0,
        checked: true,
      },
      {
        fieldName: 'amount',
        fieldType: 'decimal',
        fieldComment: null,
        customComment: '金额',
        isPrimaryKey: false,
        fieldIndex: 1,
        checked: true,
      },
    ],
  };

  it('semantic table meaning beats customComment and DB comment', () => {
    const out = buildMSchema({
      datasourceName: 'ds',
      tables: [table],
      semantics: {
        tableMeanings: { sales_order: '销售订单主表' },
        fieldNotes: {},
      },
    });
    expect(out).toContain('# Table: sales_order # 销售订单主表');
    expect(out).not.toContain('自定义备注');
  });

  it('field note composes role tag + meaning + unit + enum sample', () => {
    const out = buildMSchema({
      datasourceName: 'ds',
      tables: [table],
      semantics: {
        tableMeanings: {},
        fieldNotes: {
          'sales_order.order_status': {
            role: 'dimension',
            meaning: '订单状态',
            enums: ['paid', 'refunded'],
          },
          'sales_order.amount': {
            role: 'metric',
            meaning: '支付金额',
            unit: '元',
          },
        },
      },
    });
    expect(out).toContain(
      'order_status varchar # [维度] 订单状态 (枚举: paid/refunded)',
    );
    expect(out).toContain('amount decimal # [指标] 支付金额 (单位: 元)');
  });

  it('falls back to comments for keys without semantics; unchecked fields untouched', () => {
    const out = buildMSchema({
      datasourceName: 'ds',
      tables: [table],
      semantics: { tableMeanings: {}, fieldNotes: {} },
    });
    expect(out).toContain('# Table: sales_order # 自定义备注');
    expect(out).toContain('order_status varchar # status');
  });
});
