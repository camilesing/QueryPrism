import {
  toQueryPrismDataShape,
  toQueryPrismListShape,
} from './queryprism-data-shape';

describe('toQueryPrismDataShape', () => {
  it('converts array-of-arrays into objects keyed by column name', () => {
    const got = toQueryPrismDataShape({
      columns: ['id', 'name'],
      rows: [
        [1, 'a'],
        [2, 'b'],
      ],
    });
    expect(got.fields).toEqual(['id', 'name']);
    expect(got.fields_info).toBeNull();
    expect(got.data).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(got.sql).toBeUndefined();
  });

  it('keeps sparse rows (undefined values pass through)', () => {
    const got = toQueryPrismDataShape({
      columns: ['a', 'b'],
      rows: [[1, undefined]],
    });
    expect(got.data[0]).toEqual({ a: 1 }); // Object.fromEntries drops undefined
  });

  it('includes the sql field when provided', () => {
    const got = toQueryPrismDataShape(
      { columns: ['a'], rows: [[1]] },
      'select 1',
    );
    expect(got.sql).toBe('select 1');
  });

  it('returns empty fields/data for an empty result', () => {
    const got = toQueryPrismDataShape({ columns: [], rows: [] });
    expect(got.fields).toEqual([]);
    expect(got.data).toEqual([]);
  });
});

describe('toQueryPrismListShape', () => {
  it('passes through an array of objects', () => {
    expect(toQueryPrismListShape([{ a: 1 }, { a: 2 }])).toEqual([
      { a: 1 },
      { a: 2 },
    ]);
  });

  it('filters non-object entries from a mixed array', () => {
    expect(toQueryPrismListShape([{ a: 1 }, null, [1, 2], 'x'])).toEqual([
      { a: 1 },
    ]);
  });

  it('converts a {columns, rows} QueryResult into objects', () => {
    expect(
      toQueryPrismListShape({
        columns: ['x', 'y'],
        rows: [
          [1, 2],
          [3, 4],
        ],
      }),
    ).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });

  it('returns [] for null / unknown shapes', () => {
    expect(toQueryPrismListShape(null)).toEqual([]);
    expect(toQueryPrismListShape(undefined)).toEqual([]);
    expect(toQueryPrismListShape('not-a-list')).toEqual([]);
    expect(toQueryPrismListShape({ only: 'partial' })).toEqual([]);
  });
});
