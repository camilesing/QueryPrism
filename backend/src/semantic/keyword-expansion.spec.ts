// Pure semantic-alias keyword expansion — table recall's replacement for the
// removed Terminology synonym groups — plus the exact-keyword gate that
// decides which curated semantics reach the SQL prompt.
import {
  expandKeywordsWithAliases,
  keywordSet,
  matchedAnnotations,
  matchesNameOrAlias,
  type FieldAliasRow,
  type TableAliasRow,
} from './keyword-expansion';

describe('expandKeywordsWithAliases', () => {
  it('folds a table name + aliases in when the table name is mentioned', () => {
    const out = expandKeywordsWithAliases(
      'orders,用户',
      [{ tableName: 'orders', aliases: ['销售单'] }],
      [],
    );
    expect(out).toBe('orders,用户,销售单');
  });

  it('folds the table name + aliases in when an alias is mentioned (case-insensitive)', () => {
    const out = expandKeywordsWithAliases(
      'GMV,用户',
      [{ tableName: 'orders', aliases: ['gmv', '成交额'] }],
      [],
    );
    expect(out).toBe('GMV,用户,orders,成交额');
  });

  it('a field alias hit folds in the owning table + field name', () => {
    const out = expandKeywordsWithAliases(
      '成交额',
      [],
      [
        {
          tableName: 'orders',
          fieldName: 'amount',
          aliases: ['成交额', 'order_amount'],
        },
      ],
    );
    expect(out).toBe('成交额,orders,amount');
  });

  it('dedupes already-present words and preserves the original order', () => {
    const out = expandKeywordsWithAliases(
      'orders,成交额',
      [{ tableName: 'orders', aliases: ['成交额'] }],
      [],
    );
    expect(out).toBe('orders,成交额');
  });

  it('caps the expanded list at maxKeywords (default 10)', () => {
    const aliases = Array.from({ length: 20 }, (_, i) => `a${i + 1}`);
    const out = expandKeywordsWithAliases(
      'a1',
      [{ tableName: 't', aliases }],
      [],
    );
    expect(out.split(',')).toHaveLength(10);
    expect(out.startsWith('a1,t,a2')).toBe(true);
  });

  it('returns the original string when nothing matches', () => {
    expect(
      expandKeywordsWithAliases(
        'nope, nada',
        [{ tableName: 'orders', aliases: ['成交额'] }],
        [{ tableName: 'orders', fieldName: 'amount', aliases: [] }],
      ),
    ).toBe('nope, nada');
  });

  it('returns the original string for an empty keyword list', () => {
    expect(expandKeywordsWithAliases('  ', [{ tableName: 'orders' }], [])).toBe(
      '  ',
    );
    expect(expandKeywordsWithAliases('', [{ tableName: 'orders' }], [])).toBe(
      '',
    );
  });

  it('ignores malformed aliases blobs and blank entries', () => {
    const tables: TableAliasRow[] = [
      { tableName: 'orders', aliases: ['  ', 42, null, '成交额'] },
      { tableName: 'users', aliases: { bad: true } },
    ];
    const fields: FieldAliasRow[] = [
      { tableName: 'orders', fieldName: 'amount', aliases: 'not-an-array' },
    ];
    expect(expandKeywordsWithAliases('成交额', tables, fields)).toBe(
      '成交额,orders',
    );
  });

  it('honors an explicit maxKeywords', () => {
    const out = expandKeywordsWithAliases(
      'a',
      [{ tableName: 'orders', aliases: ['a', 'b', 'c'] }],
      [],
      2,
    );
    expect(out).toBe('a,orders');
  });

  it('folds a whole table group from a field hit only through the table name', () => {
    // A field alias identifies its owner; sibling field aliases must not leak.
    const out = expandKeywordsWithAliases(
      '销售额',
      [{ tableName: 'orders', aliases: ['订单'] }],
      [
        { tableName: 'orders', fieldName: 'amount', aliases: ['销售额'] },
        { tableName: 'orders', fieldName: 'qty', aliases: ['数量'] },
      ],
    );
    expect(out).toBe('销售额,orders,amount');
  });
});

describe('keywordSet', () => {
  it('lowercases and merges every CSV token, tolerating null/blank inputs', () => {
    expect([
      ...keywordSet('Orders, 用户', 'orders,GMV', null, undefined),
    ]).toEqual(['orders', '用户', 'gmv']);
  });

  it('is empty when extraction yielded nothing', () => {
    expect(keywordSet(null, null).size).toBe(0);
  });
});

describe('matchesNameOrAlias', () => {
  it('hits on an exact name or alias, case-insensitive on both sides', () => {
    const kw = keywordSet('Orders');
    expect(matchesNameOrAlias(kw, 'orders')).toBe(true);
    expect(matchesNameOrAlias(kw, 'sales_order', ['Orders', '销售单'])).toBe(
      true,
    );
    expect(matchesNameOrAlias(new Set(['ORDERS']), 'orders')).toBe(true);
  });

  it('never hits on a substring, a fragment or without keywords', () => {
    const kw = keywordSet('订单,订单明细表');
    expect(matchesNameOrAlias(kw, '订单明细')).toBe(false);
    expect(matchesNameOrAlias(kw, '单')).toBe(false);
    expect(matchesNameOrAlias(new Set(), 'orders', ['销售单'])).toBe(false);
  });
});

describe('matchedAnnotations', () => {
  const annotations = {
    tableMeanings: { orders: '销售订单', users: '用户主表', items: '明细' },
    fieldNotes: {
      'orders.status': { role: 'dimension', meaning: '订单状态' },
      'orders.amount': { role: 'metric', meaning: '订单金额' },
      'users.id': { role: 'dimension', meaning: '用户 ID' },
    },
    tableAliases: { orders: ['订单'], items: ['明细表'] },
    fieldAliases: { 'orders.status': ['状态'] },
  };

  it('keeps only tables/fields whose name or alias equals a keyword', () => {
    const out = matchedAnnotations(annotations, keywordSet('订单,状态,用户'));
    // users is not named by name or alias; amount was never named
    expect(out.tableMeanings).toEqual({ orders: '销售订单' });
    expect(out.fieldNotes).toEqual({
      'orders.status': { role: 'dimension', meaning: '订单状态' },
    });
  });

  it('matches a table through its alias', () => {
    const out = matchedAnnotations(annotations, keywordSet('明细表'));
    expect(out.tableMeanings).toEqual({ items: '明细' });
    expect(out.fieldNotes).toEqual({});
  });

  it('injects nothing without keywords', () => {
    expect(matchedAnnotations(annotations, new Set())).toEqual({
      tableMeanings: {},
      fieldNotes: {},
    });
  });

  it('reads a missing alias map as "no aliases" (bare names only)', () => {
    const bare = { tableMeanings: { orders: '销售订单' }, fieldNotes: {} };
    expect(matchedAnnotations(bare, keywordSet('订单'))).toEqual({
      tableMeanings: {},
      fieldNotes: {},
    });
    expect(
      matchedAnnotations(bare, keywordSet('orders')).tableMeanings,
    ).toEqual({ orders: '销售订单' });
  });

  it('does not mutate the input and survives a table literally named `constructor`', () => {
    expect(Object.keys(annotations.tableMeanings)).toEqual([
      'orders',
      'users',
      'items',
    ]);
    const tricky = {
      tableMeanings: Object.assign(Object.create(null), {
        constructor: '构造表',
      }) as Record<string, string>,
      fieldNotes: {},
    };
    expect(
      matchedAnnotations(tricky, keywordSet('constructor')).tableMeanings,
    ).toEqual({ constructor: '构造表' });
    expect(matchedAnnotations(tricky, new Set()).tableMeanings).toEqual({});
  });
});
