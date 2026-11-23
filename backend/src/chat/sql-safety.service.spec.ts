import { SqlSafetyService } from './sql-safety.service';

describe('SqlSafetyService', () => {
  let svc: SqlSafetyService;

  beforeEach(() => {
    svc = new SqlSafetyService();
  });

  describe('extractTableNames', () => {
    it('extracts a single FROM table', () => {
      expect(svc.extractTableNames('SELECT * FROM users')).toEqual(['users']);
    });

    it('extracts FROM and JOIN tables', () => {
      const r = svc.extractTableNames(
        'SELECT * FROM users u JOIN orders o ON u.id = o.uid',
      );
      expect(r).toEqual(expect.arrayContaining(['users', 'orders']));
      expect(r).toHaveLength(2);
    });

    it('extracts tables from subqueries in WHERE', () => {
      const r = svc.extractTableNames(
        'SELECT * FROM users WHERE id IN (SELECT uid FROM logs)',
      );
      expect(r).toEqual(expect.arrayContaining(['users', 'logs']));
      expect(r).toHaveLength(2);
    });

    it('extracts the base table of a derived-table subquery', () => {
      expect(
        svc.extractTableNames('SELECT count(*) FROM (SELECT * FROM users) sub'),
      ).toEqual(['users']);
    });

    it('excludes CTE names but keeps their base tables', () => {
      const r = svc.extractTableNames(
        'WITH active AS (SELECT id FROM users WHERE status = 1) ' +
          'SELECT * FROM active JOIN orders ON active.id = orders.uid',
      );
      expect(r).toEqual(expect.arrayContaining(['users', 'orders']));
      expect(r).not.toContain('active');
    });

    it('strips the schema qualifier (db.table)', () => {
      expect(svc.extractTableNames('SELECT * FROM mydb.users')).toEqual([
        'users',
      ]);
    });

    it('handles multi-statement SQL', () => {
      const r = svc.extractTableNames('SELECT * FROM a; SELECT * FROM b');
      expect(r).toEqual(expect.arrayContaining(['a', 'b']));
      expect(r).toHaveLength(2);
    });

    it('throws on unparseable SQL', () => {
      expect(() => svc.extractTableNames('SELECT FROM WHERE')).toThrow();
    });

    it('keeps a schema-qualified table whose bare name equals a CTE name', () => {
      // `public.orders` is a real table, never the CTE `orders`
      expect(
        svc.extractTableNames(
          'WITH orders AS (SELECT 1) SELECT * FROM public.orders',
        ),
      ).toEqual(['orders']);
    });

    it('throws on MySQL executable comments, which hide text from the parser', () => {
      expect(() =>
        svc.extractTableNames('SELECT * FROM users /*! , secret */', 'mysql'),
      ).toThrow();
    });
  });

  describe('validate', () => {
    const allowed = ['users', 'orders', 'logs'];

    it('accepts a read-only SELECT on whitelisted tables', () => {
      const r = svc.validate('SELECT * FROM users WHERE id = 1', allowed);
      expect(r.ok).toBe(true);
      expect(r.tables).toEqual(expect.arrayContaining(['users']));
    });

    it('accepts a read-only CTE SELECT on whitelisted tables', () => {
      const r = svc.validate(
        'WITH active AS (SELECT id FROM users WHERE status = 1) ' +
          'SELECT * FROM active JOIN orders ON active.id = orders.uid',
        allowed,
      );
      expect(r.ok).toBe(true);
    });

    it('rejects INSERT', () => {
      const r = svc.validate("INSERT INTO users (name) VALUES ('x')", allowed);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/仅允许|查询/);
    });

    it('rejects DELETE', () => {
      const r = svc.validate('DELETE FROM users WHERE id = 1', allowed);
      expect(r.ok).toBe(false);
    });

    it('rejects UPDATE', () => {
      const r = svc.validate(
        "UPDATE users SET name = 'x' WHERE id = 1",
        allowed,
      );
      expect(r.ok).toBe(false);
    });

    it('rejects a SELECT on a non-whitelisted table', () => {
      const r = svc.validate('SELECT * FROM secrets', allowed);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/secrets|不在允许|白名单/);
    });

    it('rejects malformed SQL', () => {
      const r = svc.validate('SELECT FROM WHERE', allowed);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/解析失败|parse/i);
    });

    it('rejects a schema-qualified table whose bare name equals a CTE name', () => {
      // The whitelist (and the row-permission lookup) used to skip
      // `public.orders` because `orders` is also a CTE of the statement.
      const r = svc.validate(
        'WITH orders AS (SELECT 1 AS a) SELECT * FROM public.orders',
        ['users'],
        'postgresql',
      );
      expect(r.ok).toBe(false);
      // the unqualified CTE reference itself stays virtual
      expect(
        svc.validate('WITH orders AS (SELECT 1 AS a) SELECT * FROM orders', [
          'users',
        ]).ok,
      ).toBe(true);
    });

    it('rejects MySQL executable comments, which hide tables from the parser', () => {
      const r = svc.validate(
        'SELECT * FROM users /*! , secret */',
        allowed,
        'mysql',
      );
      expect(r.ok).toBe(false);
    });

    it('rejects a multi-statement string whatever case the parser reports', () => {
      // node-sql-parser lists the second statement's type in upper case
      // (`DROP`), which a lower-case-only denylist used to miss.
      expect(svc.validate('SELECT 1; DROP TABLE users', allowed).ok).toBe(
        false,
      );
      expect(svc.validate('SELECT 1; LOCK TABLE users', allowed).ok).toBe(
        false,
      );
    });

    it('rejects SELECT ... INTO, which creates a table', () => {
      expect(
        svc.validate('SELECT * INTO orders_backup FROM orders', allowed).ok,
      ).toBe(false);
    });

    it('strips markdown fences before validating', () => {
      const r = svc.validate('```sql\nSELECT * FROM users\n```', allowed);
      expect(r.ok).toBe(true);
    });

    it('compares table names case-insensitively', () => {
      const r = svc.validate('SELECT * FROM Users WHERE x = 1', allowed);
      expect(r.ok).toBe(true);
    });

    it('deduplicates repeated table references', () => {
      const r = svc.validate(
        'SELECT * FROM users u JOIN users u2 ON u.id = u2.id',
        allowed,
      );
      expect(r.ok).toBe(true);
      expect(r.tables).toEqual(['users']);
    });
  });

  describe('dialect-aware parsing', () => {
    const allowed = ['users', 'orders'];

    it('accepts PostgreSQL NULLS LAST for a pg datasource', () => {
      const r = svc.validate(
        'SELECT id, ROW_NUMBER() OVER (ORDER BY score DESC NULLS LAST) AS rn ' +
          'FROM users LIMIT 10',
        allowed,
        'pg',
      );
      expect(r.ok).toBe(true);
      expect(r.tables).toEqual(['users']);
    });

    it('extracts tables from PostgreSQL cast syntax', () => {
      expect(
        svc.extractTableNames(
          'SELECT count(*) FROM orders WHERE created_at::date = now()::date',
          'postgresql',
        ),
      ).toEqual(['orders']);
    });

    it('treats Excel datasources as PostgreSQL', () => {
      const r = svc.validate(
        'SELECT * FROM users ORDER BY id DESC NULLS LAST',
        allowed,
        'excel',
      );
      expect(r.ok).toBe(true);
    });

    it('falls back to the default grammar for EXPLAIN', () => {
      const r = svc.validate('EXPLAIN SELECT * FROM users', allowed, 'pg');
      expect(r.ok).toBe(true);
    });
  });
});
