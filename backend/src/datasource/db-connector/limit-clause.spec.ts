import {
  appendLimit,
  hasTopLevelLimit,
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
