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
