import { assertSingleStatement, isMultiStatement } from './single-statement';

describe('single-statement guard', () => {
  it.each([
    'SELECT 1',
    'SELECT 1;',
    'SELECT 1 ;  ',
    "SELECT ';' AS a, 'a;b' AS b FROM t",
    'SELECT "a;b" FROM t',
    'SELECT `a;b` FROM t',
    'SELECT $$ ; $$ AS a',
    'SELECT $fn$ ; DROP TABLE x ; $fn$ AS a',
    'SELECT 1 -- ; trailing comment',
    'SELECT 1 /* ; block comment */',
    'SELECT 1;\n-- only a comment after the separator',
    'SELECT 1; /* only a comment */',
    "SELECT 'it''s ; fine' AS a",
    'WITH x AS (SELECT 1) SELECT * FROM x;',
    "SELECT '{\"a\":1}'::jsonb #> '{a}'",
    "SELECT '{\"a\":1;\"b\":2}'::jsonb ->> 'a' AS a, ';' AS sep",
  ])('accepts one statement: %s', (sql) => {
    expect(isMultiStatement(sql)).toBe(false);
    expect(() => assertSingleStatement(sql)).not.toThrow();
  });

  it.each([
    'SELECT 1; DROP TABLE orders; SELECT 1',
    'SELECT 1; SELECT 2',
    'SELECT 1 ;; SELECT 2',
    'SELECT 1; -- comment\n SELECT 2',
    'SELECT 1; /* comment */ SELECT 2',
    "SELECT '\\'; DROP TABLE orders; SELECT '",
    "SELECT E'\\''; DROP TABLE orders; SELECT 1",
    "SELECT '{\"a\":1}'::jsonb #> '{a}'; DROP TABLE t; SELECT 1",
    'SELECT 1--1; DROP TABLE t',
    'SELECT 1 # comment\n; DROP TABLE t',
    'SELECT 1 /*! ; DROP TABLE t */',
    'SELECT 1 /* /* nested */ ; still rejected */',
    'WITH x AS (SELECT 1) SELECT * FROM x; DELETE FROM x',
  ])('rejects more than one statement: %s', (sql) => {
    expect(isMultiStatement(sql)).toBe(true);
    expect(() => assertSingleStatement(sql)).toThrow('datasource.query_only');
  });
});
