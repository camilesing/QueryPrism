import { PrismaService } from '../database/prisma.service';
import { VectorService } from './vector.service';

type RawQuery = jest.Mock<Promise<unknown>, [string, ...unknown[]]>;
type RawExecute = jest.Mock<Promise<number>, [string, ...unknown[]]>;

interface PrismaMock {
  $queryRawUnsafe: RawQuery;
  $executeRawUnsafe: RawExecute;
  $transaction: jest.Mock;
}

/** Mock PrismaService: init probes return a live extension/schema, pg_attribute
 *  lookups return no table, and every other query is empty unless a test
 *  overrides it. */
function makePrisma(): PrismaMock {
  const query: RawQuery = jest.fn((sql: string) => {
    if (sql.includes('pg_extension'))
      return Promise.resolve([{ extversion: '0.8.7' }]);
    if (sql.includes('information_schema.schemata'))
      return Promise.resolve([{ ok: 1 }]);
    return Promise.resolve([]);
  });
  const execute: RawExecute = jest.fn(() => Promise.resolve(1));
  const prisma: PrismaMock = {
    $queryRawUnsafe: query,
    $executeRawUnsafe: execute,
    $transaction: jest.fn(
      (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) =>
        fn({ $queryRawUnsafe: query, $executeRawUnsafe: execute }),
    ),
  };
  return prisma;
}

function sqlCalls(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

describe('VectorService (pgvector)', () => {
  let prisma: PrismaMock;
  let service: VectorService;

  beforeEach(async () => {
    prisma = makePrisma();
    service = new VectorService(prisma as unknown as PrismaService);
    await service.onModuleInit();
  });

  it('is available after init when extension + schema exist', () => {
    expect(service.available).toBe(true);
  });

  it('disables itself when pgvector is missing', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('pg_extension') ? [] : [{ ok: 1 }]),
    );
    const disabled = new VectorService(prisma as unknown as PrismaService);
    await disabled.onModuleInit();

    expect(disabled.available).toBe(false);
    await disabled.upsert('terminology', 1, [1, 0]);
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
    await expect(disabled.search('terminology', [1, 0])).resolves.toEqual([]);
  });

  it('disables itself when the vector_store schema is missing', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('pg_extension')
          ? [{ extversion: '0.8.7' }]
          : sql.includes('information_schema.schemata')
            ? []
            : [],
      ),
    );
    const disabled = new VectorService(prisma as unknown as PrismaService);
    await disabled.onModuleInit();
    expect(disabled.available).toBe(false);
  });

  it('creates the partitioned table + HNSW index then upserts', async () => {
    await service.upsert('terminology', 1, [0.1, 0.2, 0.3]);

    const executed = sqlCalls(prisma.$executeRawUnsafe);
    expect(
      executed.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS')),
    ).toBe(true);
    expect(
      executed.some((sql) =>
        sql.includes('USING hnsw (embedding vector_cosine_ops)'),
      ),
    ).toBe(true);
    expect(executed.some((sql) => sql.includes('ON CONFLICT (id)'))).toBe(true);

    const insert = prisma.$executeRawUnsafe.mock.calls.find((call) =>
      String(call[0]).includes('ON CONFLICT (id)'),
    );
    expect(insert?.[1]).toBe(1);
    expect(insert?.[2]).toBe('[0.1,0.2,0.3]');
  });

  it('searches with the pgvector cosine operator and maps rows', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension')) {
        return Promise.resolve([{ extversion: '0.8.7' }]);
      }
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve([{ ok: 1 }]);
      }
      if (sql.includes('<=>')) {
        return Promise.resolve([
          { id: 2, distance: 0.1 },
          { id: '3', distance: '0.4' },
        ]);
      }
      return Promise.resolve([]);
    });

    const hits = await service.search('terminology', [0.1, 0.2], 2);

    expect(hits).toEqual([
      { id: 2, distance: 0.1 },
      { id: 3, distance: 0.4 },
    ]);
    const search = prisma.$queryRawUnsafe.mock.calls.find((call) =>
      String(call[0]).includes('<=>'),
    );
    expect(String(search?.[0])).toContain('"vector_store"."vec_terminology"');
    expect(search?.[1]).toBe('[0.1,0.2]');
    expect(search?.[2]).toBe(2);
  });

  it('returns [] when the collection table does not exist', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension')) {
        return Promise.resolve([{ extversion: '0.8.7' }]);
      }
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve([{ ok: 1 }]);
      }
      if (sql.includes('<=>')) {
        const err = new Error('relation does not exist') as Error & {
          code: string;
        };
        err.code = '42P01';
        return Promise.reject(err);
      }
      return Promise.resolve([]);
    });

    await expect(service.search('terminology', [1, 0])).resolves.toEqual([]);
  });

  /** What Prisma 6 actually throws for a failed raw query: P2010 with the
   *  driver SQLSTATE in meta.code (never a top-level 42P01). */
  function prismaUndefinedTable(): Error {
    const err = new Error(
      'Raw query failed. Code: `42P01`. Message: `relation does not exist`',
    ) as Error & { code: string; meta: { code: string } };
    err.code = 'P2010';
    err.meta = { code: '42P01' };
    return err;
  }

  it('search returns [] for the Prisma-wrapped missing-table error (P2010)', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension')) {
        return Promise.resolve([{ extversion: '0.8.7' }]);
      }
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve([{ ok: 1 }]);
      }
      if (sql.includes('<=>')) return Promise.reject(prismaUndefinedTable());
      return Promise.resolve([]);
    });

    await expect(service.search('terminology', [1, 0])).resolves.toEqual([]);
  });

  it('remove is a no-op for the Prisma-wrapped missing-table error (P2010)', async () => {
    prisma.$executeRawUnsafe.mockRejectedValueOnce(prismaUndefinedTable());
    await expect(service.remove('terminology', 7)).resolves.toBeUndefined();
  });

  it('search still rethrows other P2010 failures', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension')) {
        return Promise.resolve([{ extversion: '0.8.7' }]);
      }
      if (sql.includes('information_schema.schemata')) {
        return Promise.resolve([{ ok: 1 }]);
      }
      if (sql.includes('<=>')) {
        const err = new Error('syntax error') as Error & {
          code: string;
          meta: { code: string };
        };
        err.code = 'P2010';
        err.meta = { code: '42601' };
        return Promise.reject(err);
      }
      return Promise.resolve([]);
    });

    await expect(service.search('terminology', [1, 0])).rejects.toThrow(
      'syntax error',
    );
  });

  it('remove deletes by id; clear drops the table', async () => {
    await service.remove('terminology', 7);
    await service.clear('terminology');

    const executed = sqlCalls(prisma.$executeRawUnsafe);
    expect(executed.some((sql) => sql.includes('DELETE FROM'))).toBe(true);
    expect(executed.some((sql) => sql.includes('DROP TABLE IF EXISTS'))).toBe(
      true,
    );
  });

  it('rejects a dimension change for an existing collection', async () => {
    await service.upsert('terminology', 1, [0.1, 0.2, 0.3]);
    await expect(
      service.upsert('terminology', 2, [0.1, 0.2, 0.3, 0.4]),
    ).rejects.toThrow(/dimension mismatch/i);
  });

  it('rejects non-finite / empty vectors', async () => {
    await expect(
      service.upsert('terminology', 1, [0.1, Number.NaN]),
    ).rejects.toThrow(/non-finite/);
    await expect(service.upsert('terminology', 1, [])).rejects.toThrow(
      /empty embedding/,
    );
  });

  it('rejects unknown collections', async () => {
    await expect(service.search('unknown', [1, 0])).rejects.toThrow(
      /Unknown vector collection/,
    );
  });

  it('honours an explicitly configured EMBEDDING_DIMENSION', async () => {
    const sized = new VectorService(
      prisma as unknown as PrismaService,
      {
        get: () => 3,
      } as never,
    );
    await sized.onModuleInit();
    await expect(sized.upsert('terminology', 1, [1, 0])).rejects.toThrow(
      /EMBEDDING_DIMENSION=3/,
    );
    await expect(sized.search('terminology', [1, 0, 0, 0])).rejects.toThrow(
      /EMBEDDING_DIMENSION=3/,
    );
  });

  // ─────────────── tail-sweep: degradation + dimension-recovery arms ───────────────

  it('remove and clear are silent no-ops when the service is disabled', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      Promise.resolve(sql.includes('pg_extension') ? [] : []),
    );
    const disabled = new VectorService(prisma as unknown as PrismaService);
    await disabled.onModuleInit();
    expect(disabled.available).toBe(false);

    await expect(disabled.remove('terminology', 1)).resolves.toBeUndefined();
    await expect(disabled.clear('terminology')).resolves.toBeUndefined();
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('remove rethrows non-missing-table errors', async () => {
    prisma.$executeRawUnsafe.mockRejectedValueOnce(
      new Error('connection lost'),
    );
    await expect(service.remove('terminology', 7)).rejects.toThrow(
      'connection lost',
    );
  });

  it('remove rethrows a non-object rejection (isUndefinedTable guard)', async () => {
    prisma.$executeRawUnsafe.mockRejectedValueOnce('raw string failure');
    await expect(service.remove('terminology', 7)).rejects.toBe(
      'raw string failure',
    );
  });

  it('onModuleInit catches a non-Error probe failure and disables the service', async () => {
    prisma.$queryRawUnsafe.mockRejectedValueOnce('probe blew up');
    const degraded = new VectorService(prisma as unknown as PrismaService);
    await expect(degraded.onModuleInit()).resolves.toBeUndefined();
    expect(degraded.available).toBe(false);
  });

  it('onModuleInit catches an Error probe failure (schema read) and disables the service', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) =>
      sql.includes('pg_extension')
        ? Promise.resolve([{ extversion: '0.8.7' }])
        : Promise.reject(new Error('catalog read failed')),
    );
    const degraded = new VectorService(prisma as unknown as PrismaService);
    await expect(degraded.onModuleInit()).resolves.toBeUndefined();
    expect(degraded.available).toBe(false);
  });

  it('ensureTable rejects a non-positive / non-integer dimension', async () => {
    const ensure = (
      service as unknown as {
        ensureTable: (c: string, dim: number) => Promise<void>;
      }
    ).ensureTable.bind(service);
    await expect(ensure('terminology', 0)).rejects.toThrow(
      /Invalid embedding dimension/,
    );
    await expect(ensure('terminology', 2.5)).rejects.toThrow(
      /Invalid embedding dimension/,
    );
  });

  it('a repeat upsert with the same dimension skips the DDL entirely', async () => {
    await service.upsert('terminology', 1, [0.1, 0.2, 0.3]);
    const ddlAfterFirst = sqlCalls(prisma.$executeRawUnsafe).filter((sql) =>
      sql.includes('CREATE'),
    ).length;
    await service.upsert('terminology', 2, [0.4, 0.5, 0.6]);
    const ddlAfterSecond = sqlCalls(prisma.$executeRawUnsafe).filter((sql) =>
      sql.includes('CREATE'),
    ).length;
    expect(ddlAfterSecond).toBe(ddlAfterFirst); // cached dim → no new DDL
    const inserts = sqlCalls(prisma.$executeRawUnsafe).filter((sql) =>
      sql.includes('ON CONFLICT (id)'),
    );
    expect(inserts).toHaveLength(2);
  });

  it('upsert routes the INSERT through an explicit transaction client', async () => {
    const txExecute = jest.fn(() => Promise.resolve(1));
    const tx = { $executeRawUnsafe: txExecute };
    await service.upsert('terminology', 9, [0.1, 0.2], tx as never);
    expect(txExecute).toHaveBeenCalledTimes(1);
    expect(String(txExecute.mock.calls[0][0])).toContain('ON CONFLICT (id)');
    expect(txExecute.mock.calls[0][1]).toBe(9);
  });

  it('init recovers an existing table dimension and guards later upserts', async () => {
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension'))
        return Promise.resolve([{ extversion: '0.8.7' }]);
      if (sql.includes('information_schema.schemata'))
        return Promise.resolve([{ ok: 1 }]);
      if (sql.includes('pg_attribute'))
        return Promise.resolve([{ type: 'vector(7)' }]);
      return Promise.resolve([]);
    });
    const recovered = new VectorService(prisma as unknown as PrismaService);
    await recovered.onModuleInit();
    // recovered dim (=7) mismatches the upsert vector (=2)
    await expect(
      recovered.upsert('terminology', 1, [0.1, 0.2]),
    ).rejects.toThrow(/column expects 7/);
  });

  it('a table that already exists with the same dim skips CREATE TABLE (index still ensured)', async () => {
    // init sees NO table (nothing recovered into the dims cache); the table
    // only appears for ensureTable's in-transaction lookup
    let tableExists = false;
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension'))
        return Promise.resolve([{ extversion: '0.8.7' }]);
      if (sql.includes('information_schema.schemata'))
        return Promise.resolve([{ ok: 1 }]);
      if (sql.includes('pg_attribute'))
        return Promise.resolve(tableExists ? [{ type: 'vector(2)' }] : []);
      return Promise.resolve([]);
    });
    const fresh = new VectorService(prisma as unknown as PrismaService);
    await fresh.onModuleInit();
    tableExists = true;

    await fresh.upsert('terminology', 1, [0.5, 0.5]);

    const executed = sqlCalls(prisma.$executeRawUnsafe);
    expect(
      executed.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS')),
    ).toBe(false);
    expect(
      executed.some((sql) => sql.includes('CREATE INDEX IF NOT EXISTS')),
    ).toBe(true);
    expect(executed.some((sql) => sql.includes('ON CONFLICT (id)'))).toBe(true);
  });

  it('a table appearing between init and upsert with a different dim is rejected in the DDL transaction', async () => {
    // init sees NO table (dims stays empty), then the pg_attribute lookup
    // inside ensureTable's transaction finds an existing vector(3) column
    let tableExists = false;
    prisma.$queryRawUnsafe.mockImplementation((sql: string) => {
      if (sql.includes('pg_extension'))
        return Promise.resolve([{ extversion: '0.8.7' }]);
      if (sql.includes('information_schema.schemata'))
        return Promise.resolve([{ ok: 1 }]);
      if (sql.includes('pg_attribute'))
        return Promise.resolve(tableExists ? [{ type: 'vector(3)' }] : []);
      return Promise.resolve([]);
    });
    const fresh = new VectorService(prisma as unknown as PrismaService);
    await fresh.onModuleInit(); // no table yet → nothing recovered
    tableExists = true; // the table appears before the upsert's DDL check

    await expect(fresh.upsert('terminology', 1, [0.1, 0.2])).rejects.toThrow(
      /column expects 3, got 2/,
    );
  });
});

/** Integration test against a real PostgreSQL+pgvector database.
 *  Enable with PG_VECTOR_TEST=1 after `pnpm prisma:deploy`. */
const describePg =
  process.env.PG_VECTOR_TEST === '1' ? describe : describe.skip;

describePg('VectorService (real pgvector)', () => {
  let prisma: PrismaService;
  let service: VectorService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    service = new VectorService(prisma);
    await service.onModuleInit();
    expect(service.available).toBe(true);
  });

  afterAll(async () => {
    for (const collection of [
      'terminology',
      'data_training',
      'datasource',
      'table',
    ] as const) {
      await service.clear(collection);
    }
    await prisma.$disconnect();
  });

  it('orders hits by cosine distance and overwrites/deletes', async () => {
    await service.clear('terminology');
    await service.upsert('terminology', 1, [1, 0, 0]);
    await service.upsert('terminology', 2, [0, 1, 0]);
    await service.upsert('terminology', 3, [0.9, 0.1, 0]);

    let hits = await service.search('terminology', [1, 0, 0], 3);
    expect(hits.map((h) => h.id)).toEqual([1, 3, 2]);
    expect(hits[0].distance).toBeCloseTo(0, 5);

    await service.upsert('terminology', 1, [0, 0, 1]);
    hits = await service.search('terminology', [0, 0, 1], 3);
    expect(hits[0]).toMatchObject({ id: 1 });

    await service.remove('terminology', 1);
    hits = await service.search('terminology', [0, 0, 1], 3);
    expect(hits.map((h) => h.id)).not.toContain(1);
  });
});
