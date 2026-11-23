// Pure semantic-alias keyword expansion — table recall's replacement for the
// removed Terminology synonym groups.
import {
  expandKeywordsWithAliases,
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
