// Unit spec for SqliteConnector against a REAL in-memory better-sqlite3
// database (native dep already installed; ':memory:' is hermetic and fast —
// no file, no network). Real SQL paths exercise the LIMIT append, PRAGMA
// introspection and error branches. The only stubbed part is a swapped
// private `db` for the stmt.columns()===[] fallback, which a real SQLite
// statement never produces (every SELECT/PRAGMA reports its columns).
import Database from 'better-sqlite3';
import { SqliteConnector } from './sqlite.connector';
import type { FieldMeta } from './db-connector.interface';

type SqliteDatabase = InstanceType<typeof Database>;

/** Grab the private live better-sqlite3 handle (for seeding fixtures). */
function rawDb(connector: SqliteConnector): SqliteDatabase {
  return (connector as unknown as { db: SqliteDatabase }).db;
}

const openConnectors: SqliteConnector[] = [];

/** A connector over a seeded :memory: database (users + loose + sqlite_sequence). */
function makeSeededConnector(): SqliteConnector {
  // cfg.db omitted → exercises the ':memory:' default arm.
  const connector = new SqliteConnector({});
  const db = rawDb(connector);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      age INTEGER
    );
    CREATE TABLE loose (id INTEGER PRIMARY KEY, flag);
  `);
  const insert = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)');
  for (const [name, age] of [
    ['a', 10],
    ['a', 12],
    ['b', 20],
    ['c', 30],
    ['d', 40],
  ] as const) {
    insert.run(name, age);
  }
  openConnectors.push(connector);
  return connector;
}

describe('SqliteConnector', () => {
  afterEach(async () => {
    while (openConnectors.length > 0) {
      const connector = openConnectors.pop();
      if (connector) await connector.close();
    }
  });

  describe('constructor / open failure', () => {
    it('opens :memory: lazily-safe: no throw, version queryable', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getVersion()).resolves.toMatch(/^SQLite \d/);
    });

    it('stashes an open failure instead of throwing (bad directory)', async () => {
      const connector = new SqliteConnector({
        db: '/qp-nonexistent-dir-xyz/test.sqlite',
      });
      await expect(connector.testConnection()).resolves.toMatchObject({
        success: false,
        message: expect.stringContaining('SQLite 连接失败'),
      });
      // query paths re-throw the stored open error
      await expect(connector.getTables()).rejects.toThrow();
      // close() on a null db must not throw (optional-chaining arm)
      await expect(connector.close()).resolves.toBeUndefined();
    });
  });

  describe('getVersion', () => {
    it('returns "SQLite <version>"', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getVersion()).resolves.toMatch(
        /^SQLite \d+\.\d+\.\d+$/,
      );
    });
  });

  describe('testConnection', () => {
    it('reports success with the version', async () => {
      const connector = makeSeededConnector();
      const result = await connector.testConnection();
      expect(result).toEqual({
        success: true,
        message: 'SQLite 连接成功',
        version: expect.stringMatching(/^SQLite /),
      });
    });
  });

  describe('getSchemas', () => {
    it('returns an empty list (SQLite has no schema layer)', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getSchemas()).resolves.toEqual([]);
    });
  });

  describe('getTables', () => {
    it('lists user tables, excludes sqlite_% internals, null comments', async () => {
      const connector = makeSeededConnector();
      // AUTOINCREMENT creates sqlite_sequence — it must be filtered out.
      await expect(connector.getTables()).resolves.toEqual([
        { tableName: 'loose', tableComment: null },
        { tableName: 'users', tableComment: null },
      ]);
    });

    it('reports the stored open error', async () => {
      const connector = new SqliteConnector({
        db: '/qp-nonexistent-dir-xyz/test.sqlite',
      });
      await expect(connector.getTables()).rejects.toThrow(
        /directory does not exist/i,
      );
    });
  });

  describe('getFields', () => {
    it('maps PRAGMA table_info onto FieldMeta (pk flag, cid order)', async () => {
      const connector = makeSeededConnector();
      const fields: FieldMeta[] = await connector.getFields('users');
      expect(fields).toEqual([
        {
          fieldName: 'id',
          fieldType: 'INTEGER',
          fieldComment: null,
          isPrimaryKey: true,
          fieldIndex: 0,
        },
        {
          fieldName: 'name',
          fieldType: 'TEXT',
          fieldComment: null,
          isPrimaryKey: false,
          fieldIndex: 1,
        },
        {
          fieldName: 'age',
          fieldType: 'INTEGER',
          fieldComment: null,
          isPrimaryKey: false,
          fieldIndex: 2,
        },
      ]);
    });

    it('falls back to TEXT for untyped columns', async () => {
      const connector = makeSeededConnector();
      const fields = await connector.getFields('loose');
      expect(fields[1]).toEqual({
        fieldName: 'flag',
        fieldType: 'TEXT',
        fieldComment: null,
        isPrimaryKey: false,
        fieldIndex: 1,
      });
    });

    it('rejects a non-bare identifier table name', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getFields('drop;--')).rejects.toThrow(
        'Invalid table name',
      );
      await expect(connector.getFields('1abc')).rejects.toThrow(
        'Invalid table name',
      );
    });
  });

  describe('execSql read-only guard', () => {
    it.each([
      "INSERT INTO users (name) VALUES ('x')",
      'UPDATE users SET age = 1',
      'DELETE FROM users',
      'DROP TABLE users',
    ])('rejects "%s"', async (sql) => {
      const connector = makeSeededConnector();
      await expect(connector.execSql(sql)).rejects.toThrow(
        'datasource.query_only',
      );
    });

    it.each([
      'select 1',
      'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
      'PRAGMA table_info(users)',
      'EXPLAIN SELECT 1',
    ])('accepts the read-only statement "%s"', async (sql) => {
      const connector = makeSeededConnector();
      const result = await connector.execSql(sql);
      expect(result.columns.length).toBeGreaterThan(0);
    });
  });

  describe('execSql LIMIT handling (real appendLimit)', () => {
    it('appends LIMIT n to an unbounded SELECT (5 seeded rows → 2)', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.execSql('SELECT id FROM users', 2),
      ).resolves.toEqual({
        columns: ['id'],
        rows: [[1], [2]],
      });
    });

    it('keeps the statement’s own LIMIT', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.execSql('SELECT id FROM users LIMIT 3', 100),
      ).resolves.toEqual({ columns: ['id'], rows: [[1], [2], [3]] });
    });

    it('strips a trailing semicolon before appending', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.execSql('SELECT id FROM users;', 1),
      ).resolves.toEqual({ columns: ['id'], rows: [[1]] });
    });

    it('runs the SQL untouched when no limit is given', async () => {
      const connector = makeSeededConnector();
      const result = await connector.execSql('SELECT id FROM users');
      expect(result.rows).toHaveLength(5);
    });

    it('orders values by the statement columns', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.execSql('SELECT age, name FROM users WHERE id = 1'),
      ).resolves.toEqual({ columns: ['age', 'name'], rows: [[10, 'a']] });
    });

    it('propagates a SQL error (missing table)', async () => {
      const connector = makeSeededConnector();
      await expect(connector.execSql('SELECT * FROM nope')).rejects.toThrow(
        /no such table/i,
      );
    });
  });

  describe('getTableSampleData', () => {
    it('samples 3 rows by default out of 5', async () => {
      const connector = makeSeededConnector();
      const rows = await connector.getTableSampleData('users');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toEqual([1, 'a', 10]);
    });

    it('honours a custom limit', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getTableSampleData('users', 2)).resolves.toEqual([
        [1, 'a', 10],
        [2, 'a', 12],
      ]);
    });

    it('rejects a non-bare identifier table name', async () => {
      const connector = makeSeededConnector();
      await expect(connector.getTableSampleData('x--y')).rejects.toThrow(
        'Invalid table name',
      );
    });
  });

  describe('sampleDistinct', () => {
    it('returns distinct values from a bounded window', async () => {
      const connector = makeSeededConnector();
      const values = await connector.sampleDistinct('users', 'name', 100);
      expect([...values].sort()).toEqual(['a', 'b', 'c', 'd']);
    });

    it('floors a fractional scan window (2.9 → first 2 rows, both "a")', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.sampleDistinct('users', 'name', 2.9),
      ).resolves.toEqual(['a']);
    });

    it('clamps a sub-1 scan window to 1 row', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.sampleDistinct('users', 'name', 0),
      ).resolves.toEqual(['a']);
    });

    it('rejects an invalid table-name identifier', async () => {
      const connector = makeSeededConnector();
      await expect(
        connector.sampleDistinct('users; x', 'name', 10),
      ).rejects.toThrow('Invalid table name');
    });

    it('does NOT identifier-validate the field name — quoting makes it a no-such-column error instead', async () => {
      const connector = makeSeededConnector();
      // fieldName goes through quoteIdent only; the quoted garbage becomes a
      // non-existent column, never SQL injection.
      await expect(
        connector.sampleDistinct('users', 'name; DROP TABLE users', 10),
      ).rejects.toThrow(/no such column/i);
    });
  });

  describe('close', () => {
    it('closes the database (subsequent queries fail)', async () => {
      const connector = makeSeededConnector();
      await connector.close();
      // remove from the afterEach cleanup list — already closed
      const idx = openConnectors.indexOf(connector);
      if (idx >= 0) openConnectors.splice(idx, 1);
      await expect(connector.getVersion()).rejects.toThrow();
    });
  });

  describe('testConnection live-ping failure (stubbed db)', () => {
    // A real :memory: db never fails `SELECT 1`, so the catch arm of the
    // ping is only reachable through a swapped handle that throws.
    function pingThrowingConnector(throwable: () => unknown) {
      const connector = new SqliteConnector({});
      (connector as unknown as { db: unknown }).db = {
        prepare: () => {
          throw throwable();
        },
      };
      return connector;
    }

    it('reports failure with the Error message', async () => {
      const connector = pingThrowingConnector(
        () => new Error('disk I/O error'),
      );
      await expect(connector.testConnection()).resolves.toEqual({
        success: false,
        message: 'SQLite 连接失败: disk I/O error',
      });
    });

    it('stringifies a non-Error ping failure', async () => {
      const connector = pingThrowingConnector(() => 'kaput');
      await expect(connector.testConnection()).resolves.toEqual({
        success: false,
        message: 'SQLite 连接失败: kaput',
      });
    });
  });

  describe('columns fallback when stmt.columns() is empty (stubbed db)', () => {
    /** A statement whose columns() is empty but all() returns rows — only
     *  reachable with a stub: real SQLite always reports SELECT columns. */
    function stubbedConnector() {
      const connector = new SqliteConnector({});
      (connector as unknown as { db: unknown }).db = {
        prepare: (_sql: string) => ({
          columns: () => [],
          all: () => [{ a: 1, b: 2 }],
        }),
      };
      return connector;
    }

    it('execSql derives columns from the first row', async () => {
      const connector = stubbedConnector();
      await expect(connector.execSql('SELECT a, b FROM t')).resolves.toEqual({
        columns: ['a', 'b'],
        rows: [[1, 2]],
      });
    });

    it('getTableSampleData derives columns from the first row', async () => {
      const connector = stubbedConnector();
      await expect(connector.getTableSampleData('t', 5)).resolves.toEqual([
        [1, 2],
      ]);
    });
  });
});
