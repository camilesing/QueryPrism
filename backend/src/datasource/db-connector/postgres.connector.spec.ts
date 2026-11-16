import { PostgresConnector } from './postgres.connector';

describe('PostgresConnector.getSchemas', () => {
  it('lists user schemas from pg_namespace (system catalogs excluded)', async () => {
    const connector = new PostgresConnector({
      host: 'db.local',
      db: 'analytics',
    });
    const query = jest.fn().mockResolvedValue({
      rows: [{ nspname: 'dwd' }, { nspname: 'public' }],
    });
    const end = jest.fn().mockResolvedValue(undefined);
    // The pool is private; swap it for a stub so no real connection is made.
    (connector as unknown as { pool: unknown }).pool = { query, end };

    await expect(connector.getSchemas()).resolves.toEqual(['dwd', 'public']);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('pg_namespace');
    expect(sql).toContain('pg_catalog');
    await connector.close();
  });
});

describe('PostgresConnector search_path option', () => {
  /** The libpq startup `options` string the pool was built with. */
  function optionsFor(schema?: string): { options: string; schema: string } {
    const connector = new PostgresConnector({ host: 'db.local', schema });
    const internals = connector as unknown as {
      pool: { options: { options: string } };
      schema: string;
    };
    return {
      options: internals.pool.options.options,
      schema: internals.schema,
    };
  }

  it('defaults to public', () => {
    expect(optionsFor(undefined)).toEqual({
      options: '-c search_path="public"',
      schema: 'public',
    });
  });

  it('keeps schemas with dashes/dots instead of silently using public', () => {
    expect(optionsFor('sales-2024')).toEqual({
      options: '-c search_path="sales-2024"',
      schema: 'sales-2024',
    });
  });

  it('preserves case (an unquoted GUC value would be downcased)', () => {
    expect(optionsFor('MySchema').options).toBe('-c search_path="MySchema"');
  });

  it('escapes whitespace so a name cannot smuggle extra -c settings', () => {
    const { options, schema } = optionsFor('x -c statement_timeout=1');
    expect(schema).toBe('x -c statement_timeout=1');
    // every space backslash-escaped → the server's option splitter keeps
    // the whole value as ONE token of the search_path setting
    expect(options).toBe('-c search_path="x\\ -c\\ statement_timeout=1"');
  });

  it('doubles embedded quotes and escapes backslashes', () => {
    expect(optionsFor('a"b\\c').options).toBe('-c search_path="a""b\\\\c"');
  });
});

// ─────────────── tail-sweep: getVersion/testConnection/getTables/getFields/
// execSql/sample arms — the private pool is swapped for a stub like above ───────────────

function stubbed(connector: PostgresConnector): {
  query: jest.Mock;
  end: jest.Mock;
} {
  const query = jest.fn();
  const end = jest.fn().mockResolvedValue(undefined);
  (connector as unknown as { pool: unknown }).pool = { query, end };
  return { query, end };
}

describe('PostgresConnector.getVersion / testConnection', () => {
  it('returns the server version string', async () => {
    const connector = new PostgresConnector({ host: 'db.local', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [{ v: 'PostgreSQL 18.1' }] });
    await expect(connector.getVersion()).resolves.toBe('PostgreSQL 18.1');
    expect(String(query.mock.calls[0][0])).toBe('SELECT version() AS v');
  });

  it('returns an empty string when version() yields no rows', async () => {
    const connector = new PostgresConnector({ host: 'db.local', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [] });
    await expect(connector.getVersion()).resolves.toBe('');
  });

  it('testConnection succeeds with the resolved version', async () => {
    const connector = new PostgresConnector({ host: 'db.local', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [{ v: 'PostgreSQL 18.1' }] });
    await expect(connector.testConnection()).resolves.toEqual({
      success: true,
      message: 'PostgreSQL 连接成功',
      version: 'PostgreSQL 18.1',
    });
  });

  it('testConnection maps an Error failure to its message', async () => {
    const connector = new PostgresConnector({ host: 'db.local', db: 'a' });
    const { query } = stubbed(connector);
    query.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await connector.testConnection();
    expect(res.success).toBe(false);
    expect(res.message).toContain('ECONNREFUSED');
  });

  it('testConnection maps a non-Error failure to the generic message', async () => {
    const connector = new PostgresConnector({ host: 'db.local', db: 'a' });
    const { query } = stubbed(connector);
    query.mockRejectedValue('boom');
    const res = await connector.testConnection();
    expect(res.success).toBe(false);
    expect(res.message).toContain('未知错误');
  });
});

describe('PostgresConnector.getTables / getFields', () => {
  it('maps pg_class rows to TableMeta (comment null passthrough)', async () => {
    const connector = new PostgresConnector({
      host: 'h',
      db: 'a',
      schema: 'dwd',
    });
    const { query } = stubbed(connector);
    query.mockResolvedValue({
      rows: [
        { table_name: 'orders', table_comment: '订单' },
        { table_name: 'users', table_comment: null },
      ],
    });
    await expect(connector.getTables()).resolves.toEqual([
      { tableName: 'orders', tableComment: '订单' },
      { tableName: 'users', tableComment: null },
    ]);
    expect(query.mock.calls[0][1]).toEqual(['dwd']);
  });

  it('maps pg_attribute rows to FieldMeta with primary-key flags', async () => {
    const connector = new PostgresConnector({
      host: 'h',
      db: 'a',
      schema: 's',
    });
    const { query } = stubbed(connector);
    query.mockResolvedValue({
      rows: [
        {
          column_name: 'id',
          column_type: 'integer',
          column_comment: '主键',
          is_primary_key: true,
          ordinal: 1,
        },
        {
          column_name: 'name',
          column_type: 'text',
          column_comment: null,
          is_primary_key: false,
          ordinal: 2,
        },
      ],
    });
    await expect(connector.getFields('orders')).resolves.toEqual([
      {
        fieldName: 'id',
        fieldType: 'integer',
        fieldComment: '主键',
        isPrimaryKey: true,
        fieldIndex: 1,
      },
      {
        fieldName: 'name',
        fieldType: 'text',
        fieldComment: null,
        isPrimaryKey: false,
        fieldIndex: 2,
      },
    ]);
    expect(query.mock.calls[0][1]).toEqual(['s', 'orders']);
  });
});

describe('PostgresConnector.execSql', () => {
  it('rejects non-read statements', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    await expect(
      connector.execSql("DELETE FROM orders WHERE id = 1; -- 'SELECT'"),
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['SELECT', 'WITH', 'SHOW', 'EXPLAIN', 'DESCRIBE'])(
    'executes a %s-prefixed statement',
    async (prefix) => {
      const connector = new PostgresConnector({ host: 'h', db: 'a' });
      const { query } = stubbed(connector);
      query.mockResolvedValue({ rows: [], fields: [] });
      await expect(connector.execSql(`${prefix} 1`)).resolves.toEqual({
        columns: [],
        rows: [],
      });
    },
  );

  it('appends the caller limit to the executed SQL', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [], fields: [] });
    await connector.execSql('select * from t', 100);
    expect(String(query.mock.calls[0][0]).toLowerCase()).toContain('limit 100');
  });

  it('executes the trimmed SQL verbatim when no limit is given', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [], fields: [] });
    await connector.execSql('  select * from t  ');
    expect(String(query.mock.calls[0][0])).toBe('select * from t');
  });

  it('flattens fields + rows into columns and row-major values', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({
      fields: [{ name: 'a' }, { name: 'b' }],
      rows: [
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ],
    });
    await expect(connector.execSql('SELECT a, b FROM t')).resolves.toEqual({
      columns: ['a', 'b'],
      rows: [
        [1, 'x'],
        [2, 'y'],
      ],
    });
  });

  it('derives columns from the first row when the driver reports no fields', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({
      fields: [],
      rows: [{ a: 1, b: null }],
    });
    await expect(connector.execSql('SELECT a, b FROM t')).resolves.toEqual({
      columns: ['a', 'b'],
      rows: [[1, null]],
    });
  });
});

describe('PostgresConnector.getTableSampleData / sampleDistinct', () => {
  it('samples with a quoted identifier and clamped limit', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({
      fields: [{ name: 'a' }],
      rows: [{ a: 1 }, { a: 2 }],
    });
    await expect(connector.getTableSampleData('od"d', 2.9)).resolves.toEqual([
      [1],
      [2],
    ]);
    expect(String(query.mock.calls[0][0])).toBe(
      'SELECT * FROM "od""d" LIMIT 2',
    );
  });

  it('clamps a negative sample limit to 0', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ fields: [], rows: [] });
    await connector.getTableSampleData('t', -5);
    expect(String(query.mock.calls[0][0])).toBe('SELECT * FROM "t" LIMIT 0');
  });

  it('builds a bounded DISTINCT scan and maps values', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [{ v: 'x' }, { v: null }] });
    await expect(
      connector.sampleDistinct('users', 're"gion', 10.5),
    ).resolves.toEqual(['x', null]);
    expect(String(query.mock.calls[0][0])).toBe(
      'SELECT DISTINCT v FROM (SELECT "re""gion" AS v FROM "users" LIMIT 10) s',
    );
  });

  it('clamps the distinct scan to at least 1 row', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ rows: [] });
    await connector.sampleDistinct('t', 'c', 0);
    expect(String(query.mock.calls[0][0])).toContain('LIMIT 1');
  });

  it('close ends the pool', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { end } = stubbed(connector);
    await connector.close();
    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresConnector constructor ssl / default sample limit', () => {
  it('enables relaxed ssl on the pool when cfg.ssl is set', () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a', ssl: true });
    const internals = connector as unknown as {
      pool: { options: { ssl?: unknown; options: string } };
    };
    expect(internals.pool.options.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('getTableSampleData defaults the limit to 3', async () => {
    const connector = new PostgresConnector({ host: 'h', db: 'a' });
    const { query } = stubbed(connector);
    query.mockResolvedValue({ fields: [], rows: [] });
    await connector.getTableSampleData('t');
    expect(String(query.mock.calls[0][0])).toBe('SELECT * FROM "t" LIMIT 3');
  });
});
