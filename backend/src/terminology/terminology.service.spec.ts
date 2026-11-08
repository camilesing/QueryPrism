// TerminologyService unit tests: hybrid recall merge + template rendering +
// embedding lifecycle + the parity CRUD surface (upsert / batch remove).
// Prisma/Vector/Embedding are mocked; the workspace oid is provided by running
// calls inside the real RequestContext AsyncLocalStorage.
import { requestContextStorage } from '../common/context/request-context';
import { Prisma } from '@prisma/client';
import { TerminologyService } from './terminology.service';
import type { Terminology } from '@prisma/client';

// RequestContext.getUser() reads the AsyncLocalStorage store; these helpers
// establish it for a test without spinning up the Nest middleware.
function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  terminology: {
    create: jest.Mock;
    createMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    delete: jest.Mock;
    deleteMany: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  datasource: { findMany: jest.Mock };
  assistant: { findMany: jest.Mock };
  // 9e6070e8: task snapshots read SystemVariable (no saved rows → defaults)
  systemVariable: { findMany: jest.Mock };
  $transaction: jest.Mock;
};
type MockVector = {
  available: boolean;
  upsert: jest.Mock;
  remove: jest.Mock;
  search: jest.Mock;
};
type MockEmbedding = {
  available: boolean;
  embed: jest.Mock;
};

function makeService(
  prisma: MockPrisma,
  vector: MockVector,
  embedding: MockEmbedding,
) {
  return new TerminologyService(
    prisma as unknown as never,
    vector as unknown as never,
    embedding as unknown as never,
    { write: jest.fn().mockResolvedValue('terminology_x_error.xlsx') } as never,
  );
}

function term(
  partial: Partial<Terminology> & { id: number; word: string },
): Terminology {
  return {
    oid: 1,
    pid: null,
    description: null,
    embedding: null,
    specificDs: false,
    datasourceIds: null,
    enabled: true,
    advancedApplication: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function makePrisma(): MockPrisma {
  const prisma: MockPrisma = {
    terminology: {
      create: jest.fn(),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
    },
    datasource: { findMany: jest.fn().mockResolvedValue([]) },
    assistant: { findMany: jest.fn().mockResolvedValue([]) },
    systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
    // Array form → Promise.all; interactive form → callback on this client.
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: MockPrisma) => unknown)(prisma)
      : Promise.all(arg as unknown[]),
  );
  return prisma;
}

describe('TerminologyService', () => {
  let prisma: MockPrisma;
  let vector: MockVector;
  let embedding: MockEmbedding;

  beforeEach(() => {
    prisma = makePrisma();
    vector = {
      available: true,
      upsert: jest.fn(),
      remove: jest.fn(),
      search: jest.fn(),
    };
    embedding = { available: true, embed: jest.fn() };
  });

  describe('upsert (create branch)', () => {
    it('embeds + upserts the vector when embedding is available', async () => {
      embedding.embed.mockResolvedValue([0.1, 0.2]);
      prisma.terminology.create.mockResolvedValue(
        term({ id: 7, word: '收入' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const row = await withUser(1, () =>
        svc.upsert({ word: '收入', description: '营收定义' }),
      );
      expect(row.id).toBe(7);
      expect(embedding.embed).toHaveBeenCalledWith('收入\n营收定义');
      // The embedding flowed into the vector index — proves it was computed
      // and persisted through the create path.
      expect(vector.upsert).toHaveBeenCalledWith('terminology', 7, [0.1, 0.2]);
    });

    it('skips embedding/vector when no key configured (ILIKE-only)', async () => {
      embedding.available = false;
      prisma.terminology.create.mockResolvedValue(
        term({ id: 8, word: '成本' }),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.upsert({ word: '成本' }));
      expect(embedding.embed).not.toHaveBeenCalled();
      expect(vector.upsert).not.toHaveBeenCalled();
      // embedding stored as the Prisma JsonNull sentinel (SQL NULL), not a
      // JS null (which Prisma rejects for Json columns). mock.calls[i] is the
      // arg-array of the i-th call, so the first arg is calls[0][0].
      const calls = prisma.terminology.create.mock.calls as Array<
        Array<{ data: { embedding: unknown } }>
      >;
      expect(calls[0][0].data.embedding).toBe(Prisma.JsonNull);
    });

    it('vector sync failure does not break upsert', async () => {
      embedding.embed.mockResolvedValue([0.1]);
      prisma.terminology.create.mockResolvedValue(term({ id: 9, word: 'x' }));
      // VectorService.upsert is synchronous; a sync throw is caught by
      // syncVector's try/catch so upsert never fails.
      vector.upsert.mockImplementation(() => {
        throw new Error('vec0 boom');
      });
      const svc = makeService(prisma, vector, embedding);
      // Should not throw despite vector upsert failure.
      const row = await withUser(1, () => svc.upsert({ word: 'x' }));
      expect(row.id).toBe(9);
    });

    it('creates synonym children from other_words (pid = parent.id)', async () => {
      embedding.available = false;
      prisma.terminology.create.mockResolvedValue(
        term({ id: 11, word: '收入' }),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({ word: '收入', other_words: ['营收', '营业收入'] }),
      );
      // createMany is called once with the two non-empty child words, both
      // carrying pid=11.
      const calls = prisma.terminology.createMany.mock.calls as Array<
        Array<{ data: Array<{ pid: number; word: string }> }>
      >;
      expect(calls).toHaveLength(1);
      expect(calls[0][0].data.map((c) => [c.pid, c.word])).toEqual([
        [11, '营收'],
        [11, '营业收入'],
      ]);
    });
  });

  describe('upsert atomicity (one interactive transaction)', () => {
    /** Record every terminology call with whether it ran INSIDE the
     *  interactive transaction callback. */
    function trackTx() {
      let inTx = false;
      const log: Array<[string, boolean]> = [];
      prisma.$transaction.mockImplementation(async (arg: unknown) => {
        if (typeof arg !== 'function') {
          return Promise.all(arg as unknown[]);
        }
        inTx = true;
        try {
          return await (arg as (tx: MockPrisma) => Promise<unknown>)(prisma);
        } finally {
          inTx = false;
        }
      });
      const record = (name: string, value: unknown) => (): Promise<unknown> => {
        log.push([name, inTx]);
        return Promise.resolve(value);
      };
      prisma.terminology.findMany.mockImplementation(record('findMany', []));
      prisma.terminology.findFirst.mockImplementation(
        record('findFirst', term({ id: 5, word: '收入' })),
      );
      prisma.terminology.update.mockImplementation(
        record('update', term({ id: 5, word: '收入' })),
      );
      prisma.terminology.create.mockImplementation(
        record('create', term({ id: 6, word: '收入' })),
      );
      prisma.terminology.deleteMany.mockImplementation(
        record('deleteMany', { count: 1 }),
      );
      prisma.terminology.createMany.mockImplementation(
        record('createMany', { count: 1 }),
      );
      return log;
    }

    it('update branch: dup check, ownership, parent update and child replace all run in the transaction', async () => {
      embedding.available = false;
      const log = trackTx();
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({ id: 5, word: '收入', other_words: ['营收'] }),
      );
      expect(log.map(([name]) => name)).toEqual([
        'findMany',
        'findFirst',
        'update',
        'deleteMany',
        'createMany',
      ]);
      expect(log.every(([, inTx]) => inTx)).toBe(true);
    });

    it('create branch: dup check, parent create and children run in the transaction', async () => {
      embedding.available = false;
      const log = trackTx();
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({ word: '收入', other_words: ['营收'] }),
      );
      expect(log.map(([name]) => name)).toEqual([
        'findMany',
        'create',
        'createMany',
      ]);
      expect(log.every(([, inTx]) => inTx)).toBe(true);
    });
  });

  describe('remove (batch)', () => {
    it('deletes parents + children + the vectors for each id', async () => {
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([3, 4]));
      // WHERE oid AND (id IN [3,4] OR pid IN [3,4]) — covers the parent rows
      // AND their synonym children in one deleteMany, scoped to the caller's
      // workspace (65187019 CWE-639).
      expect(prisma.terminology.deleteMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          OR: [{ id: { in: [3, 4] } }, { pid: { in: [3, 4] } }],
        },
      });
      expect(vector.remove).toHaveBeenCalledWith('terminology', 3);
      expect(vector.remove).toHaveBeenCalledWith('terminology', 4);
      // Returns the ids for the @SystemLog resources callback.
      expect(res).toEqual([{ id: 3 }, { id: 4 }]);
    });

    it('returns [] for an empty id list (no-op)', async () => {
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([]));
      expect(res).toEqual([]);
      expect(prisma.terminology.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('expandWithTerminology (3fd6fa86 synonym expansion)', () => {
    it('a parent-word hit folds in the whole synonym group', async () => {
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: '会员' },
        { id: 2, pid: 1, word: 'VIP用户' },
        { id: 3, pid: 1, word: '注册用户' },
      ]);
      const svc = makeService(prisma, vector, embedding);
      const out = await svc.expandWithTerminology('会员,订单', 1);
      expect(out).toBe('会员,订单,VIP用户,注册用户');
    });

    it('a CHILD-word hit also folds in the parent + siblings', async () => {
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: '会员' },
        { id: 2, pid: 1, word: 'VIP用户' },
        { id: 3, pid: 1, word: '注册用户' },
      ]);
      const svc = makeService(prisma, vector, embedding);
      const out = await svc.expandWithTerminology('VIP用户', 1);
      expect(out).toBe('VIP用户,会员,注册用户');
    });

    it('caps the expansion at 10 keywords and dedupes case-insensitively', async () => {
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: 'a1' },
        ...Array.from({ length: 12 }, (_, i) => ({
          id: 10 + i,
          pid: 1,
          word: `syn${i}`,
        })),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const out = await svc.expandWithTerminology('a1', 1);
      expect(out.split(',')).toHaveLength(10);
    });

    it('no terminology rows / no hit → keywords unchanged', async () => {
      prisma.terminology.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      expect(await svc.expandWithTerminology('订单', 1)).toBe('订单');

      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: '会员' },
      ]);
      expect(await svc.expandWithTerminology('订单', 1)).toBe('订单');
    });

    it('a prisma error degrades to the original keywords', async () => {
      prisma.terminology.findMany.mockRejectedValue(new Error('db down'));
      const svc = makeService(prisma, vector, embedding);
      expect(await svc.expandWithTerminology('订单', 1)).toBe('订单');
    });
  });

  describe('recall (hybrid merge)', () => {
    it('merges cosine hits (first) with ILIKE-only hits, dedupes by id', async () => {
      const a = term({ id: 1, word: '收入' });
      const b = term({ id: 2, word: '营收' });
      const c = term({ id: 3, word: 'revenue' }); // cosine-only
      embedding.embed.mockResolvedValue([0.5]);
      // VectorService.search is synchronous — use mockReturnValue, not
      // mockResolvedValue (which would return a Promise and break .map).
      vector.search.mockReturnValue([{ id: 3, distance: 0.2 }]);
      // First findMany = ILIKE matches [a, b]; second findMany = cosine id fetch [c].
      prisma.terminology.findMany
        .mockResolvedValueOnce([a, b])
        .mockResolvedValueOnce([c]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('收入', undefined, 5));
      // Cosine hit (c) ordered before ILIKE hits (a, b).
      expect(result.map((t) => t.id)).toEqual([3, 1, 2]);
    });

    it('falls back to ILIKE-only when embedding unavailable', async () => {
      embedding.available = false;
      const a = term({ id: 1, word: '收入' });
      prisma.terminology.findMany.mockResolvedValueOnce([a]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('收入', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
      expect(vector.search).not.toHaveBeenCalled();
    });

    it('filters out specificDs terms not matching the active datasource', async () => {
      const global = term({ id: 1, word: 'g', specificDs: false });
      const specificMatch = term({
        id: 2,
        word: 's',
        specificDs: true,
        datasourceIds: [10],
      });
      const specificOther = term({
        id: 3,
        word: 'o',
        specificDs: true,
        datasourceIds: [99],
      });
      prisma.terminology.findMany.mockResolvedValueOnce([
        global,
        specificMatch,
        specificOther,
      ]);
      const svc = makeService(prisma, vector, embedding);
      embedding.available = false;
      const result = await withUser(1, () => svc.recall('x', 10, 5));
      expect(result.map((t) => t.id)).toEqual([1, 2]);
    });

    it('returns [] for an empty query', async () => {
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('  ', undefined, 5));
      expect(result).toEqual([]);
      expect(prisma.terminology.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getTerminologyTemplate', () => {
    it('returns empty string when nothing matched', async () => {
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([]);
      const svc = makeService(prisma, vector, embedding);
      const xml = await withUser(1, () =>
        svc.getTerminologyTemplate('zzz', undefined, 5),
      );
      expect(xml).toBe('');
    });

    it('renders matched terms into an XML block, escaping attributes', async () => {
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([
        term({ id: 1, word: 'a&b', description: '<x>' }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const xml = await withUser(1, () =>
        svc.getTerminologyTemplate('a', undefined, 5),
      );
      expect(xml).toBe(
        '<terminologies>\n' +
          '  <terminology word="a&amp;b" description="&lt;x&gt;" />\n' +
          '</terminologies>',
      );
    });
  });
});
