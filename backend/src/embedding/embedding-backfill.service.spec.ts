// EmbeddingBackfillService unit tests — backfill lifecycle coverage:
// runtime-switch gating (table_enabled / metric.enabled), null-row discovery
// in batches of 32 with 3 attempts, conditional re-read + input-conditional
// write-back (a concurrent edit or synchronous re-embed wins), in-flight
// dedup, and vec0 sync skip when the vector index is unavailable.
import { Prisma } from '@prisma/client';
import { Logger } from '@nestjs/common';
import { EmbeddingBackfillService } from './embedding-backfill.service';

const DB_NULL = { equals: Prisma.DbNull };

type Row = Record<string, unknown> & { id: number };

type MockPrisma = {
  systemVariable: { findMany: jest.Mock };
  datasource: { findMany: jest.Mock; updateMany: jest.Mock };
  table: { findMany: jest.Mock; updateMany: jest.Mock };
  metricDef: { findMany: jest.Mock; updateMany: jest.Mock };
  $transaction: jest.Mock;
};

function makePrisma(rows: Record<string, Row[]> = {}): MockPrisma {
  const delegate = (list: Row[]) => ({
    // dual use: full scan (no id filter) vs batch re-read (id IN + still NULL)
    findMany: jest.fn((args?: { where?: { id?: { in: number[] } } }) => {
      const ids = args?.where?.id?.in;
      return ids ? list.filter((r) => ids.includes(r.id)) : [...list];
    }),
    updateMany: jest.fn(() => ({ count: 1 })),
  });
  const prisma: MockPrisma = {
    // resolveEmbeddingConfig read: [] → env defaults (table_enabled/metric on)
    systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
    datasource: delegate(rows.datasource ?? []),
    table: delegate(rows.table ?? []),
    metricDef: delegate(rows.metric ?? []),
    // interactive transactions run on the same mocked client
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (client: MockPrisma) => unknown) => fn(prisma),
  );
  return prisma;
}

function makeService(
  prisma: MockPrisma,
  vector: { available: boolean; upsert: jest.Mock },
  embedding: { available: boolean; embedBatch: jest.Mock },
) {
  return new EmbeddingBackfillService(
    prisma as unknown as never,
    embedding as unknown as never,
    vector as unknown as never,
  );
}

describe('EmbeddingBackfillService', () => {
  let vector: { available: boolean; upsert: jest.Mock };
  let embedding: { available: boolean; embedBatch: jest.Mock };

  beforeEach(() => {
    vector = { available: true, upsert: jest.fn() };
    embedding = { available: true, embedBatch: jest.fn() };
  });

  describe('onModuleInit', () => {
    it('no-ops (does not query) when embedding is unavailable', () => {
      embedding.available = false;
      const prisma = makePrisma();
      const svc = makeService(prisma, vector, embedding);
      svc.onModuleInit();
      expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
      expect(prisma.datasource.findMany).not.toHaveBeenCalled();
    });

    it('runs the backfill when embedding is available', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'crm', description: '客户库' }],
      });
      embedding.embedBatch.mockResolvedValue([[0.1, 0.2]]);
      const svc = makeService(prisma, vector, embedding);
      svc.onModuleInit();
      await new Promise((r) => setImmediate(r));
      expect(prisma.datasource.updateMany).toHaveBeenCalledWith({
        where: {
          id: 1,
          embedding: DB_NULL,
          name: 'crm',
          description: '客户库',
        },
        data: { embedding: [0.1, 0.2] },
      });
      expect(vector.upsert).toHaveBeenCalledWith(
        'datasource',
        1,
        [0.1, 0.2],
        expect.anything(), // the batch transaction client
      );
    });
  });

  describe('run — runtime switch gating', () => {
    it('fills all three collections when both switches are on (env defaults)', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 3, name: 'ds', description: null }],
        table: [
          {
            id: 4,
            tableName: 'orders',
            tableComment: '订单表',
            customComment: '销售单',
          },
        ],
        metric: [{ id: 5, name: '支付金额', aliases: null, description: null }],
      });
      embedding.embedBatch.mockImplementation((texts: string[]) =>
        texts.map(() => [0.5]),
      );
      const result = await makeService(prisma, vector, embedding).run();
      expect(result).toEqual({
        datasource: 1,
        table: 1,
        metric: 1,
      });
      // table text uses the EFFECTIVE comment (custom wins)
      expect(embedding.embedBatch).toHaveBeenNthCalledWith(2, [
        'orders\n销售单',
      ]);
      expect(prisma.table.updateMany).toHaveBeenCalledWith({
        where: {
          id: 4,
          embedding: DB_NULL,
          tableName: 'orders',
          tableComment: '订单表',
          customComment: '销售单',
        },
        data: { embedding: [0.5] },
      });
      expect(vector.upsert).toHaveBeenCalledTimes(3);
    });

    it('skips the metadata half when embedding.table_enabled=false', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 3, name: 'ds', description: null }],
        table: [
          { id: 4, tableName: 't', tableComment: null, customComment: null },
        ],
      });
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'embedding.table_enabled', value: 'false' },
      ]);
      await makeService(prisma, vector, embedding).run();
      expect(prisma.datasource.findMany).not.toHaveBeenCalled();
      expect(prisma.table.findMany).not.toHaveBeenCalled();
    });

    it('skips the metric collection when metric.enabled=false', async () => {
      const prisma = makePrisma({
        metric: [{ id: 5, name: '支付金额', aliases: null, description: null }],
      });
      prisma.systemVariable.findMany.mockResolvedValue([
        { name: 'metric.enabled', value: 'false' },
      ]);
      await makeService(prisma, vector, embedding).run();
      expect(prisma.metricDef.findMany).not.toHaveBeenCalled();
    });

    it('fills metric rows with name + aliases + description text', async () => {
      const prisma = makePrisma({
        metric: [
          {
            id: 5,
            name: '支付金额',
            aliases: ['支付额'],
            description: '订单支付总额',
          },
        ],
      });
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      await makeService(prisma, vector, embedding).runMetrics();
      expect(embedding.embedBatch).toHaveBeenCalledWith([
        '支付金额 支付额\n订单支付总额',
      ]);
      expect(prisma.metricDef.updateMany).toHaveBeenCalledWith({
        where: {
          id: 5,
          embedding: DB_NULL,
          name: '支付金额',
          description: '订单支付总额',
        },
        data: { embedding: [0.5] },
      });
      expect(vector.upsert).toHaveBeenCalledWith(
        'metric_def',
        5,
        [0.5],
        expect.anything(),
      );
    });

    it('returns zeroed counts without querying when embedding is unavailable', async () => {
      embedding.available = false;
      const prisma = makePrisma();
      const result = await makeService(prisma, vector, embedding).run();
      expect(result).toEqual({
        datasource: 0,
        table: 0,
        metric: 0,
      });
      expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
    });
  });

  describe('race protection (conditional write-back)', () => {
    it('does not upsert vec0 when the conditional update matched 0 rows', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      prisma.datasource.updateMany.mockResolvedValue({ count: 0 });
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(prisma.datasource.updateMany).toHaveBeenCalled();
      expect(vector.upsert).not.toHaveBeenCalled();
    });

    it('embeds only rows that are still NULL at batch time (re-read)', async () => {
      const prisma = makePrisma({
        datasource: [
          { id: 1, name: 'a', description: null },
          { id: 2, name: 'b', description: null },
        ],
      });
      // scan sees both; the batch re-read (id IN filter) reports only #2 —
      // #1 was filled by the synchronous upsert path in between
      prisma.datasource.findMany
        .mockResolvedValueOnce([
          { id: 1, name: 'a', description: null },
          { id: 2, name: 'b', description: null },
        ])
        .mockResolvedValueOnce([{ id: 2, name: 'b', description: null }]);
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(embedding.embedBatch).toHaveBeenCalledWith(['b']);
      expect(prisma.datasource.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.datasource.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 2 }) }),
      );
    });

    it('filters rows whose composed text is blank out of the batch call', async () => {
      const prisma = makePrisma({
        datasource: [
          { id: 1, name: '   ', description: '  ' },
          { id: 2, name: 'q', description: null },
        ],
      });
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(embedding.embedBatch).toHaveBeenCalledWith(['q']);
    });
  });

  describe('batching and retries', () => {
    it('splits 33 rows into batches of 32 + 1', async () => {
      const rows = Array.from({ length: 33 }, (_, i) => ({
        id: i + 1,
        name: `w${i + 1}`,
        description: null,
      }));
      const prisma = makePrisma({ datasource: rows });
      embedding.embedBatch.mockImplementation((texts: string[]) =>
        texts.map(() => [0.5]),
      );
      const result = await makeService(prisma, vector, embedding).run();
      expect(result.datasource).toBe(33);
      expect(embedding.embedBatch).toHaveBeenCalledTimes(2);
      expect(embedding.embedBatch.mock.calls[0][0]).toHaveLength(32);
      expect(embedding.embedBatch.mock.calls[1][0]).toHaveLength(1);
      expect(prisma.datasource.updateMany).toHaveBeenCalledTimes(33);
    });

    it('retries a failing batch and succeeds on the third attempt', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      embedding.embedBatch
        .mockRejectedValueOnce(new Error('api 500'))
        .mockRejectedValueOnce(new Error('api 502'))
        .mockResolvedValueOnce([[0.5]]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(embedding.embedBatch).toHaveBeenCalledTimes(3);
      expect(prisma.datasource.updateMany).toHaveBeenCalledTimes(1);
    });

    it('leaves the batch NULL after 3 failures and still completes the run', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      // the datasource batch always fails; the empty table/metric scans succeed
      embedding.embedBatch.mockRejectedValue(new Error('api down'));
      const result = await makeService(prisma, vector, embedding).run();
      expect(result).toEqual({
        datasource: 1, // scanned rows — the write itself failed 3×
        table: 0,
        metric: 0,
      });
      expect(prisma.datasource.updateMany).not.toHaveBeenCalled();
      expect(embedding.embedBatch).toHaveBeenCalledTimes(3);
    });

    it('treats a vector-count mismatch as a batch failure', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      embedding.embedBatch.mockResolvedValue([]); // wrong count
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(embedding.embedBatch).toHaveBeenCalledTimes(3);
      expect(prisma.datasource.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('in-flight dedup', () => {
    it('a second concurrent run of the same collection is skipped', async () => {
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      let release!: (v: number[][]) => void;
      embedding.embedBatch.mockImplementation(
        () =>
          new Promise<number[][]>((r) => {
            release = r;
          }),
      );
      const svc = makeService(prisma, vector, embedding);
      const first = svc.runTablesAndDatasources();
      const second = svc.runTablesAndDatasources();
      // let run #1 pass its awaits and reach the pending embedBatch call
      await new Promise((r) => setImmediate(r));
      release([[0.5]]);
      await Promise.all([first, second]);
      // run #1 alone: one scan + one batch re-read; run #2 skipped the
      // running set so it never scanned again
      expect(prisma.datasource.findMany).toHaveBeenCalledTimes(2);
      expect(embedding.embedBatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('vec0 unavailable', () => {
    it('still persists the Prisma embedding (source of truth), skips upsert', async () => {
      vector.available = false;
      const prisma = makePrisma({
        datasource: [{ id: 1, name: 'a', description: null }],
      });
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(prisma.datasource.updateMany).toHaveBeenCalledTimes(1);
      expect(vector.upsert).not.toHaveBeenCalled();
    });
  });

  describe('atomic write+index (one transaction per batch)', () => {
    /** A mini transactional mock: `written` simulates the committed
     *  embedding column (batch re-reads exclude written rows). Writes that
     *  run outside $transaction commit immediately; writes on the tx client
     *  only commit when the transaction callback resolves. */
    function makeAtomicPrisma(rows: Row[]) {
      const written = new Set<number>();
      const pending = new Set<number>();
      let inTx = false;
      const findMany = jest.fn(
        (args?: { where?: { id?: { in: number[] } } }) => {
          const ids = args?.where?.id?.in;
          return Promise.resolve(
            ids
              ? rows.filter((r) => ids.includes(r.id) && !written.has(r.id))
              : [...rows],
          );
        },
      );
      const updateMany = jest.fn((args: { where?: { id?: number } }) => {
        const id = args.where?.id;
        if (id !== undefined) {
          if (inTx) pending.add(id);
          else written.add(id); // autocommit (the pre-fix behavior)
        }
        return Promise.resolve({ count: 1 });
      });
      const empty = {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      };
      const datasource = { findMany, updateMany };
      const tx = {
        datasource,
        table: empty,
        metricDef: empty,
      };
      const prisma = {
        systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
        ...tx,
        $transaction: jest.fn(
          async (fn: (client: unknown) => Promise<unknown>) => {
            inTx = true;
            pending.clear();
            try {
              const out = await fn(tx);
              for (const id of pending) written.add(id);
              return out;
            } catch (e) {
              pending.clear();
              throw e;
            } finally {
              inTx = false;
            }
          },
        ),
      };
      return { prisma, tx, findMany, updateMany };
    }

    it('commits the Json write and the pgvector upsert in ONE transaction', async () => {
      embedding.embedBatch.mockResolvedValue([[0.1], [0.2]]);
      const { prisma, tx, updateMany } = makeAtomicPrisma([
        { id: 1, name: 'a', description: null },
        { id: 2, name: 'b', description: null },
      ]);
      await makeService(prisma, vector, embedding).runTablesAndDatasources();

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(updateMany).toHaveBeenCalledTimes(2);
      expect(vector.upsert).toHaveBeenCalledTimes(2);
      // every vector upsert received the transaction client
      expect(vector.upsert.mock.calls.every((call) => call[3] === tx)).toBe(
        true,
      );
    });

    it('a failed vector upsert rolls the batch back and the retry re-writes the row', async () => {
      embedding.embedBatch.mockResolvedValue([[0.5]]);
      vector.upsert
        .mockRejectedValueOnce(new Error('vector down'))
        .mockResolvedValue(undefined);
      const { prisma, updateMany } = makeAtomicPrisma([
        { id: 1, name: 'a', description: null },
      ]);

      await makeService(prisma, vector, embedding).runTablesAndDatasources();

      // attempt 1 failed (vector) → the Json write rolled back; attempt 2
      // re-read the still-NULL row and committed BOTH writes — the row was
      // never consumed half-applied.
      expect(updateMany).toHaveBeenCalledTimes(2);
      expect(vector.upsert).toHaveBeenCalledTimes(2);
    });
  });
});

describe('residual arm sweep', () => {
  let vector: { available: boolean; upsert: jest.Mock };
  let embedding: { available: boolean; embedBatch: jest.Mock };

  beforeEach(() => {
    vector = { available: true, upsert: jest.fn() };
    embedding = { available: true, embedBatch: jest.fn() };
  });

  it('onModuleInit logs the Error message when the startup run rejects', async () => {
    const prisma = makePrisma();
    prisma.systemVariable.findMany.mockRejectedValue(new Error('config boom'));
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      makeService(prisma, vector, embedding).onModuleInit();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(errorSpy).toHaveBeenCalledWith(
        'embedding backfill failed: config boom',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('onModuleInit stringifies a non-Error rejection reason', async () => {
    const prisma = makePrisma();
    prisma.systemVariable.findMany.mockRejectedValue('plain failure');
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      makeService(prisma, vector, embedding).onModuleInit();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(errorSpy).toHaveBeenCalledWith(
        'embedding backfill failed: plain failure',
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('runTablesAndDatasources returns early when embedding is unavailable', async () => {
    embedding.available = false;
    const prisma = makePrisma();
    await makeService(prisma, vector, embedding).runTablesAndDatasources();
    expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
    expect(prisma.datasource.findMany).not.toHaveBeenCalled();
  });

  it('runTablesAndDatasources returns early when table_enabled=false', async () => {
    const prisma = makePrisma();
    prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'embedding.table_enabled', value: 'false' },
    ]);
    await makeService(prisma, vector, embedding).runTablesAndDatasources();
    expect(prisma.datasource.findMany).not.toHaveBeenCalled();
  });

  it('runTablesAndDatasources fills both collections when table_enabled', async () => {
    const prisma = makePrisma({
      datasource: [{ id: 3, name: 'ds', description: null }],
      table: [
        { id: 4, tableName: 't', tableComment: 'c', customComment: null },
      ],
    });
    embedding.embedBatch.mockResolvedValue([[0.5]]);
    await makeService(prisma, vector, embedding).runTablesAndDatasources();
    expect(prisma.datasource.findMany).toHaveBeenCalledTimes(2); // scan + re-read
    expect(prisma.table.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.datasource.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.table.updateMany).toHaveBeenCalledTimes(1);
  });

  it('runMetrics returns early when embedding is unavailable', async () => {
    embedding.available = false;
    const prisma = makePrisma();
    await makeService(prisma, vector, embedding).runMetrics();
    expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
    expect(prisma.metricDef.findMany).not.toHaveBeenCalled();
  });

  it('runMetrics returns early when metric.enabled=false', async () => {
    const prisma = makePrisma();
    prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'metric.enabled', value: 'false' },
    ]);
    await makeService(prisma, vector, embedding).runMetrics();
    expect(prisma.metricDef.findMany).not.toHaveBeenCalled();
  });

  it('skips the embed call entirely when every re-read row is blank', async () => {
    const prisma = makePrisma();
    const blank = { id: 1, name: '  ', description: null };
    prisma.datasource.findMany
      .mockResolvedValueOnce([blank]) // scan
      .mockResolvedValueOnce([blank]); // batch re-read: still NULL but blank
    await makeService(prisma, vector, embedding).runTablesAndDatasources();
    expect(embedding.embedBatch).not.toHaveBeenCalled();
    expect(prisma.datasource.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error batch failure in the final warn', async () => {
    const prisma = makePrisma({
      datasource: [{ id: 1, name: 'a', description: null }],
    });
    embedding.embedBatch.mockRejectedValue('provider exploded');
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await makeService(prisma, vector, embedding).runTablesAndDatasources();
      expect(embedding.embedBatch).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('provider exploded'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
