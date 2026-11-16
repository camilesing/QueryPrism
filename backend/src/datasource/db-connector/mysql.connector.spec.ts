// Unit spec for MysqlConnector. mysql2/promise pools are LAZY (createPool
// opens no socket), so the constructor runs safely with dummy config; each
// test then swaps the private pool for a stub — the same pattern as
// postgres.connector.spec.ts. pool.query is faked in the mysql2/promise
// shape: it resolves [rows, fields].
import { MysqlConnector } from './mysql.connector';
import type { ConnectionConfig, FieldMeta } from './db-connector.interface';

const CFG: ConnectionConfig = {
  host: 'db.local',
  port: 3306,
  user: 'reader',
  pwd: 'secret',
  db: 'shop',
};

interface FakePool {
  query: jest.Mock;
  end: jest.Mock;
}

/** Build a connector and replace its private pool with a recording stub. */
function makeConnector(cfg: ConnectionConfig = CFG) {
  const connector = new MysqlConnector(cfg);
  const pool: FakePool = {
    query: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  };
  (connector as unknown as { pool: FakePool }).pool = pool;
  return { connector, pool };
}

/** mysql2/promise query() resolves `[rows, fields]`. */
function ok(rows: unknown[], fields: Array<{ name: string }> = []) {
  return Promise.resolve([rows, fields]);
}

describe('MysqlConnector', () => {
  describe('constructor', () => {
    /** Inspect the REAL lazy pool's merged connection config. */
    function connectionConfigFor(cfg: ConnectionConfig) {
      const connector = new MysqlConnector(cfg);
      const internals = connector as unknown as {
        pool: {
          pool: { config: { connectionConfig: Record<string, unknown> } };
        };
      };
      return internals.pool.pool.config.connectionConfig;
    }

    it('maps ConnectionConfig keys onto the mysql2 pool options', () => {
      expect(connectionConfigFor(CFG)).toMatchObject({
        host: 'db.local',
        port: 3306,
        user: 'reader',
        password: 'secret',
        database: 'shop',
      });
    });

    it('omits ssl when cfg.ssl is falsy', () => {
      expect(connectionConfigFor(CFG).ssl).toBe(false);
    });

    it('enables ssl when cfg.ssl is truthy', () => {
      const cc = connectionConfigFor({ ...CFG, ssl: true });
      expect(cc.ssl).toEqual(expect.objectContaining({}));
    });

    it('close() ends the pool', async () => {
      const { connector, pool } = makeConnector();
      await connector.close();
      expect(pool.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVersion', () => {
    it('returns the version string', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ v: '8.0.34' }]));
      await expect(connector.getVersion()).resolves.toBe('8.0.34');
      expect(pool.query).toHaveBeenCalledWith('SELECT VERSION() AS v');
    });

    it('returns an empty string when the version cell is not a string', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ v: null }]));
      await expect(connector.getVersion()).resolves.toBe('');
    });

    it('returns an empty string when there are no rows', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([]));
      await expect(connector.getVersion()).resolves.toBe('');
    });
  });

  describe('testConnection', () => {
    it('reports success with the server version', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ v: '8.0.34' }]));
      await expect(connector.testConnection()).resolves.toEqual({
        success: true,
        message: 'MySQL 连接成功',
        version: '8.0.34',
      });
    });

    it('reports failure with the Error message on rejection', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(connector.testConnection()).resolves.toEqual({
        success: false,
        message: 'MySQL 连接失败: ECONNREFUSED',
      });
    });

    it('stringifies a non-Error rejection', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockRejectedValue('nope');
      await expect(connector.testConnection()).resolves.toEqual({
        success: false,
        message: 'MySQL 连接失败: nope',
      });
    });
  });

  describe('getSchemas', () => {
    it('returns an empty list (MySQL has no schema layer)', async () => {
      const { connector } = makeConnector();
      await expect(connector.getSchemas()).resolves.toEqual([]);
    });
  });

  describe('getTables', () => {
    it('queries information_schema with cfg.db as the schema', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() =>
        ok([
          { tableName: 'orders', tableComment: '销售订单' },
          { tableName: 'users', tableComment: '' },
        ]),
      );
      await expect(connector.getTables()).resolves.toEqual([
        { tableName: 'orders', tableComment: '销售订单' },
        { tableName: 'users', tableComment: null },
      ]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(String(sql)).toContain('information_schema.TABLES');
      expect(params).toEqual(['shop']);
    });

    it('falls back to SELECT DATABASE() when cfg.db is missing', async () => {
      const { connector, pool } = makeConnector({ host: 'db.local' });
      pool.query
        .mockImplementationOnce(() => ok([{ d: 'resolved_db' }]))
        .mockImplementationOnce(() => ok([]));
      await connector.getTables();
      expect(pool.query.mock.calls[0]).toEqual(['SELECT DATABASE() AS d']);
      // second call binds the resolved schema, not undefined
      expect(pool.query.mock.calls[1][1]).toEqual(['resolved_db']);
    });

    it('binds an empty schema string when DATABASE() returns NULL', async () => {
      const { connector, pool } = makeConnector({ host: 'db.local' });
      pool.query
        .mockImplementationOnce(() => ok([{ d: null }]))
        .mockImplementationOnce(() => ok([]));
      await connector.getTables();
      expect(pool.query.mock.calls[1][1]).toEqual(['']);
    });

    it('propagates a query error', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockRejectedValue(new Error('boom'));
      await expect(connector.getTables()).rejects.toThrow('boom');
    });
  });

  describe('getFields', () => {
    it('maps information_schema rows onto FieldMeta', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() =>
        ok([
          {
            columnName: 'id',
            columnType: 'int',
            columnComment: '',
            isPrimaryKey: 1,
            fieldIndex: 1,
          },
          {
            columnName: 'name',
            columnType: 'varchar(64)',
            columnComment: '姓名',
            isPrimaryKey: '0',
            fieldIndex: 2,
          },
        ]),
      );
      const fields: FieldMeta[] = await connector.getFields('users');
      expect(fields).toEqual([
        {
          fieldName: 'id',
          fieldType: 'int',
          fieldComment: null,
          isPrimaryKey: true,
          fieldIndex: 1,
        },
        {
          fieldName: 'name',
          fieldType: 'varchar(64)',
          fieldComment: '姓名',
          isPrimaryKey: false,
          fieldIndex: 2,
        },
      ]);
      const [sql, params] = pool.query.mock.calls[0];
      expect(String(sql)).toContain('information_schema.COLUMNS');
      expect(params).toEqual(['shop', 'users']);
    });

    it('treats a numeric-string PRI flag as primary key', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() =>
        ok([
          {
            columnName: 'id',
            columnType: 'int',
            columnComment: null,
            isPrimaryKey: '1',
            fieldIndex: 1,
          },
        ]),
      );
      const fields = await connector.getFields('users');
      expect(fields[0]?.isPrimaryKey).toBe(true);
    });
  });

  describe('execSql read-only guard', () => {
    it.each([
      'INSERT INTO t VALUES (1)',
      'UPDATE t SET a=1',
      'DELETE FROM t',
      'DROP TABLE t',
    ])('rejects "%s"', async (sql) => {
      const { connector, pool } = makeConnector();
      await expect(connector.execSql(sql)).rejects.toThrow(
        'datasource.query_only',
      );
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('rejects a keyword that is only a prefix of an identifier', async () => {
      const { connector } = makeConnector();
      // SELECTED lacks the \b boundary after SELECT → not read-only.
      await expect(connector.execSql('SELECTED gibberish')).rejects.toThrow(
        'datasource.query_only',
      );
    });

    it.each([
      'select 1',
      'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
      'SHOW TABLES',
      'EXPLAIN SELECT 1',
      'DESCRIBE t',
      'PRAGMA foo',
    ])('accepts the read-only prefix "%s" (case-insensitive)', async (sql) => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await expect(connector.execSql(sql)).resolves.toEqual({
        columns: [],
        rows: [],
      });
    });
  });

  describe('execSql LIMIT handling (real appendLimit)', () => {
    it('appends LIMIT n to an unbounded SELECT', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await connector.execSql('SELECT a FROM t', 500);
      expect(pool.query.mock.calls[0][0]).toBe('SELECT a FROM t LIMIT 500');
    });

    it('strips a trailing semicolon before appending', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await connector.execSql('SELECT a FROM t;', 500);
      expect(pool.query.mock.calls[0][0]).toBe('SELECT a FROM t LIMIT 500');
    });

    it('does not double-LIMIT a statement that already limits', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await connector.execSql('SELECT a FROM t LIMIT 10', 500);
      expect(pool.query.mock.calls[0][0]).toBe('SELECT a FROM t LIMIT 10');
    });

    it('leaves the SQL untouched when no limit is given', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await connector.execSql('SELECT a FROM t');
      expect(pool.query.mock.calls[0]).toEqual(['SELECT a FROM t']);
    });
  });

  describe('execSql row mapping', () => {
    it('orders values by the field metadata columns', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() =>
        ok([{ b: 2, a: 1 }], [{ name: 'a' }, { name: 'b' }]),
      );
      await expect(connector.execSql('SELECT a, b FROM t')).resolves.toEqual({
        columns: ['a', 'b'],
        rows: [[1, 2]],
      });
    });

    it('derives columns from the first row when fields are empty', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ b: 2, a: 1 }], []));
      await expect(connector.execSql('SELECT a, b FROM t')).resolves.toEqual({
        columns: ['b', 'a'],
        rows: [[2, 1]],
      });
    });

    it('tolerates a row array whose first entry is undefined (sparse rows)', async () => {
      const { connector, pool } = makeConnector();
      // length > 0 passes the guard but records[0] is undefined → ?? {} arm.
      pool.query.mockImplementation(() => ok([undefined], []));
      await expect(connector.execSql('SELECT a FROM t')).resolves.toEqual({
        columns: [],
        rows: [[]],
      });
    });

    it('keeps empty columns when fields and rows are both empty', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await expect(
        connector.execSql('SELECT a FROM t WHERE 0=1'),
      ).resolves.toEqual({ columns: [], rows: [] });
    });

    it('propagates query errors', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockRejectedValue(new Error('bad SQL'));
      await expect(connector.execSql('SELECT 1')).rejects.toThrow('bad SQL');
    });
  });

  describe('getTableSampleData', () => {
    it('samples with the default limit of 3 rows', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ a: 1 }], [{ name: 'a' }]));
      await connector.getTableSampleData('orders');
      expect(pool.query.mock.calls[0]).toEqual([
        'SELECT * FROM ?? LIMIT ?',
        ['orders', 3],
      ]);
      await expect(
        connector.getTableSampleData('orders'),
      ).resolves.toHaveLength(1);
    });

    it('honours a custom limit', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([], []));
      await connector.getTableSampleData('orders', 7);
      expect(pool.query.mock.calls[0][1]).toEqual(['orders', 7]);
    });
  });

  describe('sampleDistinct', () => {
    it('scans a bounded window and returns the distinct values', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([{ v: 'a' }, { v: 'b' }]));
      await expect(
        connector.sampleDistinct('orders', 'status', 100),
      ).resolves.toEqual(['a', 'b']);
      const [sql, params] = pool.query.mock.calls[0];
      expect(String(sql)).toBe(
        'SELECT DISTINCT v FROM (SELECT ?? AS v FROM ?? LIMIT ?) s',
      );
      expect(params).toEqual(['status', 'orders', 100]);
    });

    it('floors a fractional scan window', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([]));
      await connector.sampleDistinct('orders', 'status', 10.9);
      expect(pool.query.mock.calls[0][1]).toEqual(['status', 'orders', 10]);
    });

    it('clamps a sub-1 scan window to 1 row', async () => {
      const { connector, pool } = makeConnector();
      pool.query.mockImplementation(() => ok([]));
      await connector.sampleDistinct('orders', 'status', 0);
      expect(pool.query.mock.calls[0][1]).toEqual(['status', 'orders', 1]);
      await connector.sampleDistinct('orders', 'status', -5);
      expect(pool.query.mock.calls[1][1]).toEqual(['status', 'orders', 1]);
    });
  });
});
