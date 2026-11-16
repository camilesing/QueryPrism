import { BadRequestException } from '@nestjs/common';
import { DbConnectorFactory } from './db-connector.factory';
import { PostgresConnector } from './postgres.connector';
import { encryptFrontendConfig } from '../frontend-config-crypto';

describe('DbConnectorFactory', () => {
  const factory = new DbConnectorFactory({
    get: (key: string) =>
      key === 'DATABASE_URL'
        ? 'postgresql://u:p@localhost:5432/queryprism'
        : key === 'excel.storeSchema'
          ? 'excel_store'
          : undefined,
  } as never);

  it("accepts the frontend's `pg` alias and normalises form keys", async () => {
    const connector = factory.create({
      type: 'pg',
      configuration: encryptFrontendConfig({
        host: 'db.local',
        port: '5433',
        username: 'reader',
        password: 'secret',
        database: 'analytics',
        dbSchema: 'reporting',
      }),
    });

    expect(connector).toBeInstanceOf(PostgresConnector);
    const internals = connector as unknown as {
      pool: { options: Record<string, unknown> };
      schema: string;
    };
    expect(internals.pool.options).toMatchObject({
      host: 'db.local',
      port: 5433,
      user: 'reader',
      password: 'secret',
      database: 'analytics',
    });
    expect(internals.schema).toBe('reporting');
    await connector.close();
  });

  it('also accepts `postgres` as an alias', () => {
    const connector = factory.create({
      type: 'postgres',
      configuration: encryptFrontendConfig({ host: 'h', db: 'd' }),
    });
    expect(connector).toBeInstanceOf(PostgresConnector);
    void connector.close();
  });

  it('rejects unsupported types', () => {
    expect(() =>
      factory.create({ type: 'oracle', configuration: null }),
    ).toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// Appended coverage for the remaining creation/normalisation branches (mysql /
// sqlite / excel engines, decrypt/encrypt round-trips, port coercion,
// withConnector lifecycle). Append-only: the tests above stay untouched.
// ---------------------------------------------------------------------------
import { MysqlConnector } from './mysql.connector';
import { SqliteConnector } from './sqlite.connector';
import { ExcelConnector } from './excel.connector';
import { PostgresConnector } from './postgres.connector';
import { decryptFrontendConfig } from '../frontend-config-crypto';

/** A ConfigService stub configurable per DATABASE_URL answer.
 *  Pass `null` to make ConfigService answer undefined (NOT `undefined`,
 *  which would re-trigger the default parameter). */
function makeFactory(
  databaseUrl: string | null = 'postgresql://u:p@localhost:5432/queryprism',
) {
  return new DbConnectorFactory({
    get: (key: string) =>
      key === 'DATABASE_URL'
        ? (databaseUrl ?? undefined)
        : key === 'excel.storeSchema'
          ? 'excel_store'
          : undefined,
  } as never);
}

describe('DbConnectorFactory.create engine branches', () => {
  it('builds a MysqlConnector from decrypted + normalised config', async () => {
    const connector = makeFactory().create({
      type: 'mysql',
      configuration: encryptFrontendConfig({
        host: 'db.local',
        port: '3307',
        username: 'reader',
        password: 'secret',
        database: 'shop',
        ssl: true,
      }),
    });
    expect(connector).toBeInstanceOf(MysqlConnector);
    const cc = (
      connector as unknown as {
        pool: {
          pool: { config: { connectionConfig: Record<string, unknown> } };
        };
      }
    ).pool.pool.config.connectionConfig;
    expect(cc).toMatchObject({
      host: 'db.local',
      port: 3307,
      user: 'reader',
      password: 'secret',
      database: 'shop',
    });
    expect(cc.ssl).toEqual(expect.objectContaining({}));
    await connector.close();
  });

  it('matches the type case-insensitively ("MYSQL")', () => {
    const connector = makeFactory().create({
      type: 'MYSQL',
      configuration: encryptFrontendConfig({ host: 'h' }),
    });
    expect(connector).toBeInstanceOf(MysqlConnector);
    void connector.close();
  });

  it('builds a SqliteConnector (cfg.db drives the file path)', async () => {
    const connector = makeFactory().create({
      type: 'sqlite',
      configuration: encryptFrontendConfig({ db: ':memory:' }),
    });
    expect(connector).toBeInstanceOf(SqliteConnector);
    await expect(connector.getVersion()).resolves.toMatch(/^SQLite /);
    await connector.close();
  });

  it('rejects an empty type string', () => {
    expect(() =>
      makeFactory().create({ type: '', configuration: null }),
    ).toThrow(BadRequestException);
  });
});

describe('DbConnectorFactory.create excel branch', () => {
  function excelConnector(sheets: unknown, databaseUrl?: string | null) {
    const connector = makeFactory(databaseUrl).create({
      type: 'excel',
      configuration: encryptFrontendConfig(
        typeof sheets === 'string' ? { sheets } : { sheets },
      ),
    });
    expect(connector).toBeInstanceOf(ExcelConnector);
    return connector as unknown as {
      tableNames: string[];
      inner: PostgresConnector;
    };
  }

  it('collects sheet tableNames and dedupes, dropping invalid entries', () => {
    const connector = excelConnector([
      { tableName: 'sheet1' },
      { tableName: 'sheet1' }, // duplicate → deduped
      { tableName: '' }, // empty string dropped
      { tableName: 5 }, // non-string dropped
      { other: true }, // object without tableName → undefined dropped
      'bare-string', // non-object item dropped
      null,
    ]);
    expect(connector.tableNames).toEqual(['sheet1']);
    void connector.inner.close();
  });

  it('parses sheets given as a JSON string', () => {
    const connector = excelConnector(
      JSON.stringify([{ tableName: 'a' }, { tableName: 'b' }]),
    );
    expect(connector.tableNames).toEqual(['a', 'b']);
    void connector.inner.close();
  });

  it('returns [] for an unparseable sheets JSON string', () => {
    const connector = excelConnector('{not json');
    expect(connector.tableNames).toEqual([]);
    void connector.inner.close();
  });

  it('returns [] when the config has no sheets at all', () => {
    const connector = excelConnector(undefined);
    expect(connector.tableNames).toEqual([]);
    void connector.inner.close();
  });

  it('connects to the app DB with URL-decoded credentials and default port', () => {
    const connector = excelConnector(
      [],
      'postgresql://u%40x:p%20w@localhost/qpdb',
    );
    const options = (
      connector.inner as unknown as {
        pool: { options: Record<string, unknown> };
      }
    ).pool.options;
    expect(options).toMatchObject({
      host: 'localhost',
      port: 5432, // URL without port → default
      user: 'u@x', // decodeURIComponent
      password: 'p w',
      database: 'qpdb',
    });
    void connector.inner.close();
  });

  it('falls back to process.env.DATABASE_URL when ConfigService has none', () => {
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://envu:envp@envhost/envdb';
    try {
      const connector = excelConnector([], null);
      expect(
        (
          connector.inner as unknown as {
            pool: { options: Record<string, unknown> };
          }
        ).pool.options,
      ).toMatchObject({ host: 'envhost', database: 'envdb' });
      void connector.inner.close();
    } finally {
      if (prev === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = prev;
    }
  });

  it('throws BadRequest when no DATABASE_URL is configured anywhere', () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      expect(() => excelConnector([], null)).toThrow(/DATABASE_URL 未配置/);
    } finally {
      if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
  });

  it('throws BadRequest for an unparseable DATABASE_URL', () => {
    expect(() => excelConnector([], 'not a valid url')).toThrow(
      BadRequestException,
    );
  });

  it("defaults the store schema to 'excel_store' when ConfigService has none", () => {
    // ConfigService answers NOTHING here — both excel.storeSchema and the
    // DATABASE_URL come from process.env fallbacks/defaults.
    const bareFactory = new DbConnectorFactory({
      get: (key: string) =>
        key === 'DATABASE_URL'
          ? 'postgresql://u:p@localhost:5432/qp'
          : undefined,
    } as never);
    const connector = bareFactory.create({
      type: 'excel',
      configuration: encryptFrontendConfig({ sheets: [] }),
    });
    const internals = connector as unknown as {
      inner: { schema: string };
    };
    expect(internals.inner.schema).toBe('excel_store');
    void (connector as unknown as ExcelConnector).close();
  });
});

describe('DbConnectorFactory config crypto helpers', () => {
  it('decryptConfiguration returns {} for null/undefined', () => {
    const factory = makeFactory();
    expect(factory.decryptConfiguration(null)).toEqual({});
    expect(factory.decryptConfiguration(undefined)).toEqual({});
  });

  it('decryptConfiguration returns {} for tampered/wrong-key ciphertext', () => {
    const factory = makeFactory();
    expect(factory.decryptConfiguration('not-valid-base64!!')).toEqual({});
    expect(
      factory.decryptConfiguration('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
    ).toEqual({});
  });

  it('decryptConfiguration round-trips a frontend ciphertext', () => {
    const factory = makeFactory();
    const ciphertext = encryptFrontendConfig({
      host: 'h',
      db: 'd',
      port: 5432,
    });
    expect(factory.decryptConfiguration(ciphertext)).toEqual({
      host: 'h',
      db: 'd',
      port: 5432,
    });
  });

  it('encryptConfiguration returns null for empty/absent configs', () => {
    const factory = makeFactory();
    expect(factory.encryptConfiguration(null)).toBeNull();
    expect(factory.encryptConfiguration(undefined)).toBeNull();
    expect(factory.encryptConfiguration({})).toBeNull();
  });

  it('encryptConfiguration output decrypts back (deterministic ECB)', () => {
    const factory = makeFactory();
    const ciphertext = factory.encryptConfiguration({ host: 'h' });
    expect(typeof ciphertext).toBe('string');
    expect(decryptFrontendConfig(ciphertext)).toEqual({ host: 'h' });
    // ECB without IV → deterministic: same plaintext, same ciphertext
    expect(factory.encryptConfiguration({ host: 'h' })).toBe(ciphertext);
  });
});

describe('DbConnectorFactory port normalisation', () => {
  function pgPortFor(cfg: Record<string, unknown>): unknown {
    const connector = makeFactory().create({
      type: 'pg',
      configuration: encryptFrontendConfig(cfg),
    });
    const options = (
      connector as unknown as {
        pool: { options: Record<string, unknown> };
      }
    ).pool.options;
    void connector.close();
    return options.port;
  }

  it('converts a numeric string port', () => {
    expect(pgPortFor({ port: '5433' })).toBe(5433);
  });

  it('leaves a numeric port untouched', () => {
    expect(pgPortFor({ port: 5432 })).toBe(5432);
  });

  it('does NOT convert a whitespace-only port string (pinned)', () => {
    expect(pgPortFor({ port: '   ' })).toBe('   ');
  });

  it('leaves an absent port undefined', () => {
    expect(pgPortFor({ host: 'h' })).toBeUndefined();
  });
});

describe('DbConnectorFactory.withConnector lifecycle', () => {
  it('runs fn with the connector and closes it afterwards', async () => {
    const closeSpy = jest
      .spyOn(MysqlConnector.prototype, 'close')
      .mockResolvedValue(undefined);
    try {
      const result = await makeFactory().withConnector(
        { type: 'mysql', configuration: encryptFrontendConfig({ host: 'h' }) },
        async (connector) => {
          expect(connector).toBeInstanceOf(MysqlConnector);
          await Promise.resolve(); // satisfy require-await: fn is awaited
          return 42;
        },
      );
      expect(result).toBe(42);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('still closes the connector when fn throws', async () => {
    const closeSpy = jest
      .spyOn(MysqlConnector.prototype, 'close')
      .mockResolvedValue(undefined);
    try {
      await expect(
        makeFactory().withConnector(
          {
            type: 'mysql',
            configuration: encryptFrontendConfig({ host: 'h' }),
          },
          () => Promise.reject(new Error('boom')),
        ),
      ).rejects.toThrow('boom');
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });
});
