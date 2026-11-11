// regression-policy unit tests — the comparison math is the core of the M6
// suite; every direction/threshold must be pinned.
import {
  buildVerifySql,
  compareCase,
  detectNumericColumns,
  parseVerifyResult,
  sqlTextHash,
  deltaPct,
} from './regression-policy';

describe('deltaPct', () => {
  it('returns 0 for identical values', () => {
    expect(deltaPct(100, 100)).toBe(0);
  });

  it('computes relative growth against the base', () => {
    expect(deltaPct(100, 150)).toBe(50);
    expect(deltaPct(200, 100)).toBe(-50);
  });

  it('treats 0 → positive as +100 (something out of nothing)', () => {
    expect(deltaPct(0, 5)).toBe(100);
    expect(deltaPct(0, 0)).toBe(0);
  });

  it('uses |base| so negative bases still give signed percentages', () => {
    expect(deltaPct(-100, -150)).toBe(-50);
  });
});

describe('compareCase', () => {
  const base = { rowCount: 100, sums: { amount: 1000, qty: 50 } };

  it('passes when everything is within tolerance', () => {
    const d = compareCase(
      base,
      { rowCount: 105, sums: { amount: 1040, qty: 48 } },
      10,
    );
    expect(d.reasons).toEqual([]);
    expect(d.rowCountPct).toBe(5);
    expect(d.sums.amount).toBe(4);
    expect(d.sums.qty).toBe(-4);
  });

  it('flags row-count inflation beyond tolerance (join fan-out)', () => {
    const d = compareCase(
      base,
      { rowCount: 250, sums: { amount: 1010, qty: 50 } },
      10,
    );
    expect(d.reasons).toContain('row_count_inflated');
    expect(d.reasons).not.toContain('row_count_shrunk');
  });

  it('flags sum inflation beyond tolerance (widened caliber)', () => {
    const d = compareCase(
      base,
      { rowCount: 100, sums: { amount: 1500, qty: 50 } },
      10,
    );
    expect(d.reasons).toContain('sum_inflated:amount');
  });

  it('records shrunk direction without calling it inflated', () => {
    const d = compareCase(
      base,
      { rowCount: 50, sums: { amount: 500, qty: 50 } },
      10,
    );
    expect(d.reasons).toContain('row_count_shrunk');
    expect(d.reasons).toContain('sum_shrunk:amount');
  });

  it('flags schema changes in both directions', () => {
    const d = compareCase(
      base,
      { rowCount: 100, sums: { amount: 1000, extra: 3 } },
      10,
    );
    expect(d.reasons).toContain('schema_changed');
    expect(d.newColumns).toEqual(['extra']);
    const d2 = compareCase(base, { rowCount: 100, sums: { amount: 1000 } }, 10);
    expect(d2.reasons).toContain('schema_changed');
    expect(d2.missingColumns).toEqual(['qty']);
  });

  it('zero tolerance flags any nonzero drift', () => {
    const d = compareCase(
      base,
      { rowCount: 101, sums: { amount: 1000, qty: 50 } },
      0,
    );
    expect(d.reasons).toContain('row_count_inflated');
  });
});

describe('buildVerifySql', () => {
  it('wraps the SQL with COUNT and positional SUM aliases', () => {
    expect(buildVerifySql('SELECT a, b FROM t', ['b'], 'postgres')).toBe(
      'SELECT COUNT(*) AS "__cnt", SUM("b") AS "__s0" FROM (SELECT a, b FROM t) AS "__reg_sub"',
    );
  });

  it('quotes mysql identifiers with backticks', () => {
    expect(buildVerifySql('SELECT `o`.a FROM o', ['a'], 'mysql')).toContain(
      'SUM(`a`) AS "__s0"',
    );
  });

  it('works with no numeric columns (row count only)', () => {
    expect(buildVerifySql('SELECT a FROM t', [], 'sqlite')).toBe(
      'SELECT COUNT(*) AS "__cnt" FROM (SELECT a FROM t) AS "__reg_sub"',
    );
  });

  it('escapes embedded double quotes in identifiers', () => {
    const sql = buildVerifySql('SELECT 1', ['we"ird'], 'postgres');
    expect(sql).toContain('SUM("we""ird")');
  });

  it('escapes backticks for mysql and normalizes the engine alias', () => {
    expect(buildVerifySql('SELECT 1', ['we`ird'], 'MySQL')).toContain(
      'SUM(`we``ird`)',
    );
  });

  it('strips the generated outer LIMIT before aggregating', () => {
    const sql = buildVerifySql('SELECT a FROM t LIMIT 1000', [], 'postgres');
    expect(sql).not.toContain('LIMIT');
    expect(sql).toContain('SELECT COUNT(*) AS "__cnt"');
    expect(sql).toContain('SELECT a FROM "t"');
  });

  it('keeps a LIMIT inside a subquery while stripping the outer one', () => {
    const sql = buildVerifySql(
      'SELECT a FROM (SELECT a FROM t LIMIT 5) s LIMIT 1000',
      [],
      'postgres',
    );
    expect(sql).toContain('LIMIT 5');
    expect(sql).not.toContain('LIMIT 1000');
  });

  it('strips a trailing semicolon before wrapping', () => {
    expect(buildVerifySql('SELECT a FROM t;', [], 'sqlite')).toBe(
      'SELECT COUNT(*) AS "__cnt" FROM (SELECT a FROM t) AS "__reg_sub"',
    );
  });
});

describe('detectNumericColumns', () => {
  it('keeps number columns and numeric-string columns, drops the rest', () => {
    const cols = detectNumericColumns(
      ['region', 'amount', 'qty', 'note'],
      [
        ['north', 10, '3', 'abc'],
        ['south', 20.5, '7', '123x'],
      ],
    );
    expect(cols).toEqual(['amount', 'qty']);
  });

  it('skips all-null columns (no basis to SUM)', () => {
    expect(
      detectNumericColumns(
        ['a', 'b'],
        [
          [1, null],
          [2, null],
        ],
      ),
    ).toEqual(['a']);
  });

  it('rejects mixed number/text columns', () => {
    expect(detectNumericColumns(['a'], [[1], ['x']])).toEqual([]);
  });

  it('keeps only the first of duplicated result column names', () => {
    expect(
      detectNumericColumns(
        ['id', 'id'],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toEqual(['id']);
  });
});

describe('parseVerifyResult', () => {
  it('maps the positional verify row back to column names', () => {
    const agg = parseVerifyResult(['amount', 'qty'], {
      columns: ['__cnt', '__s0', '__s1'],
      rows: [[1234, 9876.5, '42']],
    });
    expect(agg).toEqual({ rowCount: 1234, sums: { amount: 9876.5, qty: 42 } });
  });

  it('tolerates an empty result row', () => {
    expect(parseVerifyResult(['a'], { columns: ['__cnt'], rows: [] })).toEqual({
      rowCount: 0,
      sums: {},
    });
  });
});

describe('sqlTextHash', () => {
  it('is whitespace-insensitive but case-sensitive', () => {
    expect(sqlTextHash('SELECT  1')).toBe(sqlTextHash(' SELECT 1 '));
    expect(sqlTextHash('select 1')).not.toBe(sqlTextHash('SELECT 1'));
  });
});
