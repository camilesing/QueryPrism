import {
  appendLimit,
  hasTopLevelLimit,
  stripOuterLimit,
  stripTrailingSemicolon,
} from './limit-clause';

describe('limit-clause', () => {
  describe('hasTopLevelLimit', () => {
    it('detects a top-level LIMIT', () => {
      expect(hasTopLevelLimit('SELECT a FROM t LIMIT 10')).toBe(true);
      expect(hasTopLevelLimit('SELECT a FROM t LIMIT 10 OFFSET 5')).toBe(true);
      expect(hasTopLevelLimit('SELECT a FROM t LIMIT 5, 10')).toBe(true);
    });

    it('ignores a LIMIT inside a subquery or CTE — the outer query is unbounded', () => {
      // The old whole-SQL regex saw the inner LIMIT and skipped
      // the append, so the outer aggregation returned unbounded rows.
      expect(
        hasTopLevelLimit('SELECT a FROM (SELECT a FROM t LIMIT 5) x'),
      ).toBe(false);
      expect(
        hasTopLevelLimit('WITH c AS (SELECT a FROM t LIMIT 3) SELECT a FROM c'),
      ).toBe(false);
    });

    it('detects the LIMIT of the outer query over a CTE', () => {
      expect(
        hasTopLevelLimit('WITH c AS (SELECT a FROM t) SELECT a FROM c LIMIT 7'),
      ).toBe(true);
    });

    it('falls back to the regex when the statement does not parse', () => {
      // PRAGMA is read-only-allowed but not SELECT-shaped for the parser.
      expect(hasTopLevelLimit('PRAGMA table_info LIMIT 2')).toBe(true);
      expect(hasTopLevelLimit('PRAGMA table_info(user)')).toBe(false);
    });
  });

  describe('stripTrailingSemicolon', () => {
    it('strips a trailing semicolon with surrounding whitespace', () => {
      expect(stripTrailingSemicolon('SELECT 1 ;\n')).toBe('SELECT 1');
      expect(stripTrailingSemicolon('SELECT 1;; ')).toBe('SELECT 1');
    });

    it('leaves statement-internal semicolons alone', () => {
      expect(stripTrailingSemicolon('SELECT 1')).toBe('SELECT 1');
    });
  });

  describe('appendLimit', () => {
    it('appends to a bare query', () => {
      expect(appendLimit('SELECT a FROM t', 500)).toBe(
        'SELECT a FROM t LIMIT 500',
      );
    });

    it('strips the trailing semicolon before appending', () => {
      expect(appendLimit('SELECT a FROM t;', 500)).toBe(
        'SELECT a FROM t LIMIT 500',
      );
      expect(appendLimit('SELECT a FROM t ;\n', 500)).toBe(
        'SELECT a FROM t LIMIT 500',
      );
    });

    it('keeps the SQL untouched when the outer query already limits', () => {
      expect(appendLimit('SELECT a FROM t LIMIT 10', 500)).toBe(
        'SELECT a FROM t LIMIT 10',
      );
      // inner LIMIT does not suppress the outer append
      expect(
        appendLimit('SELECT a FROM (SELECT a FROM t LIMIT 5) x', 500),
      ).toBe('SELECT a FROM (SELECT a FROM t LIMIT 5) x LIMIT 500');
    });
  });
});

// ─────────────── residual branch arms (coverage tail) ──────────────────────

describe('limit-clause — residual arms (coverage tail)', () => {
  it('hasTopLevelLimit inspects only the FIRST statement of a multi-statement AST', () => {
    // array AST: the LIMIT on the second statement is not the outer limit
    expect(hasTopLevelLimit('SELECT a FROM t; SELECT b FROM u LIMIT 3')).toBe(
      false,
    );
    // ...but a LIMIT on the first statement is
    expect(hasTopLevelLimit('SELECT a FROM t LIMIT 4; SELECT b FROM u')).toBe(
      true,
    );
  });

  it('stripOuterLimit defaults the engine to the parser default dialect', () => {
    // no engine argument → default-arg '' → unknown dialect → opt undefined
    const out = stripOuterLimit('SELECT a FROM t LIMIT 10');
    expect(out).not.toMatch(/limit/i);
    // an unmapped engine name takes the same default-dialect path
    expect(stripOuterLimit('SELECT a FROM t LIMIT 10', 'oracle')).toBe(out);
    // sqlite maps to its own dialect
    expect(stripOuterLimit('SELECT a FROM t LIMIT 10', 'sqlite')).not.toMatch(
      /limit/i,
    );
  });

  it('stripOuterLimit leaves a limit-free multi-statement input untouched', () => {
    const sql = 'SELECT a FROM t; SELECT b FROM u';
    expect(stripOuterLimit(sql, 'postgres')).toBe(sql);
  });

  it('stripOuterLimit strips the first statement limit of a multi-statement AST', () => {
    // array AST with a limit on the first statement → the clone is re-serialized
    // as a single-element array (known sqlify quirk: later statements drop)
    const out = stripOuterLimit(
      'SELECT a FROM t LIMIT 5; SELECT b FROM u',
      'mysql',
    );
    expect(out).not.toMatch(/limit/i);
    expect(out).toMatch(/FROM/i);
  });
});
