// TerminologyService unit tests: hybrid recall merge + template rendering +
// embedding lifecycle + the parity CRUD surface (upsert / batch remove).
// Prisma/Vector/Embedding are mocked; the workspace oid is provided by running
// calls inside the real RequestContext AsyncLocalStorage.
import { requestContextStorage } from '../common/context/request-context';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { TerminologyService } from './terminology.service';
import type { Terminology } from '@prisma/client';
import { cellText } from '../common/import-export/helpers';
import { tr } from '../common/i18n/translate';
import { resolveEmbeddingConfig } from '../common/config/embedding-config';

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
  datasource: { findMany: jest.Mock; count: jest.Mock };
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
  // P2-4 batch import path (safeEmbedBatch); default = all-null embeddings.
  embedBatch: jest.Mock;
};
type MockImportError = { write: jest.Mock };

function makeService(
  prisma: MockPrisma,
  vector: MockVector,
  embedding: MockEmbedding,
  // Optional so failure-path tests can capture the error-workbook write.
  importError: MockImportError = {
    write: jest.fn().mockResolvedValue('terminology_x_error.xlsx'),
  },
) {
  return new TerminologyService(
    prisma as unknown as never,
    vector as unknown as never,
    embedding as unknown as never,
    importError as unknown as never,
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
    datasource: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
    },
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
    embedding = {
      available: true,
      embed: jest.fn(),
      // Deterministic default: every row degrades to a null embedding.
      embedBatch: jest
        .fn()
        .mockImplementation((texts: string[]) => texts.map(() => null)),
    };
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

  // ─────────────── appended coverage: page pager + list filters ───────────────

  describe('page (parity pager)', () => {
    it('returns the pager shape with derived other_words/ds/adv names', async () => {
      // Call 1 = parents (where pid: null); call 2 = children (pid: {in}).
      prisma.terminology.findMany.mockImplementation(
        (args?: { where?: { pid?: unknown } }) => {
          const pid = args?.where?.pid;
          if (pid && typeof pid === 'object') {
            return Promise.resolve([
              { pid: 1, word: '营收' },
              { pid: 1, word: '营业收入' },
            ]);
          }
          return Promise.resolve([
            term({
              id: 1,
              word: '收入',
              description: '收入定义',
              specificDs: true,
              datasourceIds: [5],
              advancedApplication: '7',
            }),
            term({ id: 2, word: '成本' }),
          ]);
        },
      );
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([{ id: 7, name: 'bot' }]);
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.page(1, 10));
      expect(res).toMatchObject({
        current_page: 1,
        page_size: 10,
        total_count: 2,
        total_pages: 1,
      });
      expect(res.data[0]).toMatchObject({
        id: 1,
        word: '收入',
        other_words: ['营收', '营业收入'],
        specific_ds: true,
        datasource_ids: [5],
        datasource_names: ['sales'],
        advanced_application: 7,
        advanced_application_name: 'bot',
      });
      expect(typeof res.data[0].create_time).toBe('number');
      expect(res.data[1]).toMatchObject({
        id: 2,
        other_words: [],
        datasource_names: [],
        advanced_application: null,
        advanced_application_name: null,
        specific_ds: false,
      });
      // parents query is workspace-scoped, parents-only, no keyword OR.
      expect(prisma.terminology.findMany.mock.calls[0][0].where).toEqual({
        oid: 1,
        pid: null,
      });
    });

    it('ds_list/adv_list post-filter the parents in memory', async () => {
      const parents = [
        term({
          id: 1,
          word: 'a',
          specificDs: true,
          datasourceIds: [5],
          advancedApplication: '7',
        }),
        term({ id: 2, word: 'b', specificDs: true, datasourceIds: [99] }),
        term({ id: 3, word: 'c', specificDs: false }),
      ];
      // Same rows for the children fetch — their pid is null so
      // buildOtherWordsMap skips them (other_words stays []).
      prisma.terminology.findMany.mockResolvedValue(parents);
      const svc = makeService(prisma, vector, embedding);
      expect(
        (await withUser(1, () => svc.page(1, 10))).data.map((r) => r.id),
      ).toEqual([1, 2, 3]);
      // ds filter keeps global rows + rows scoped to a listed datasource.
      expect(
        (await withUser(1, () => svc.page(1, 10, undefined, [5]))).data.map(
          (r) => r.id,
        ),
      ).toEqual([1, 3]);
      // adv filter keeps only rows bound to a listed advanced application.
      expect(
        (await withUser(1, () => svc.page(1, 10, undefined, [], [7]))).data.map(
          (r) => r.id,
        ),
      ).toEqual([1]);
    });

    it('clamps page/page_size and applies the word filter', async () => {
      prisma.terminology.findMany.mockResolvedValue([]); // no matches
      const svc = makeService(prisma, vector, embedding);
      const none = await withUser(1, () => svc.page(99, 3, '收入'));
      expect(none).toMatchObject({
        current_page: 1, // clamped: total_pages 0
        page_size: 10, // Math.max(10, 3)
        total_count: 0,
        total_pages: 0,
        data: [],
      });
      expect(prisma.terminology.findMany.mock.calls[0][0].where.OR).toEqual([
        { word: { contains: '收入', mode: 'insensitive' } },
        { description: { contains: '收入', mode: 'insensitive' } },
      ]);
      // whitespace-only word → no OR branch.
      await withUser(1, () => svc.page(0, 10, '   '));
      const wsCall = prisma.terminology.findMany.mock.calls[1][0];
      expect(wsCall.where.OR).toBeUndefined();
      // fractional page/page_size are floored; page 2 of 26 rows @ 25.
      const rows26 = Array.from({ length: 26 }, (_, i) =>
        term({ id: i + 1, word: `w${i}` }),
      );
      prisma.terminology.findMany.mockResolvedValue(rows26);
      const pg = await withUser(1, () => svc.page(2.9, 25.9));
      expect(pg).toMatchObject({
        current_page: 2,
        page_size: 25,
        total_count: 26,
        total_pages: 2,
      });
      expect(pg.data).toHaveLength(1); // row 26 only
    });
  });

  // ─────────────── appended coverage: upsert validation arms ───────────────

  describe('upsert validation arms', () => {
    it('rejects a blank word with 400 before any write', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ word: '   ' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.terminology.create).not.toHaveBeenCalled();
    });

    it('rejects datasource_ids that do not resolve in the workspace', async () => {
      prisma.datasource.count.mockResolvedValue(1); // 2 ids sent → mismatch
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () =>
          svc.upsert({ word: 'w', specific_ds: true, datasource_ids: [5, 6] }),
        ),
      ).rejects.toThrow('术语引用的数据源不存在或不属于当前工作空间');
    });

    it('dedupes datasource_ids and stringifies advanced_application', async () => {
      prisma.datasource.count.mockResolvedValue(1);
      prisma.terminology.create.mockResolvedValue(term({ id: 12, word: 'w' }));
      embedding.available = false;
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({
          word: 'w',
          specific_ds: true,
          datasource_ids: [5, 5],
          advanced_application: 42,
        }),
      );
      const data = prisma.terminology.create.mock.calls[0][0].data;
      expect(data.datasourceIds).toEqual([5]); // Set-deduped
      expect(data.advancedApplication).toBe('42'); // String? column
      expect(data.enabled).toBe(true); // default
    });

    it('rejects a word duplicated with one of its synonyms', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ word: '收入', other_words: ['收入'] })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.terminology.create).not.toHaveBeenCalled();
    });

    it('rejects a word colliding with an existing row', async () => {
      prisma.terminology.findMany.mockResolvedValue([{ word: '已有词' }]);
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ word: '收入' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.terminology.create).not.toHaveBeenCalled();
    });

    it('update arm: an id outside this workspace → 404', async () => {
      prisma.terminology.findMany.mockResolvedValue([]); // no dup conflict
      prisma.terminology.findFirst.mockResolvedValue(null); // not owned
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ id: 5, word: '收入' })),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.terminology.update).not.toHaveBeenCalled();
    });
  });

  // ─────────────── appended coverage: setEnabled + remove degradation ───────────────

  describe('setEnabled', () => {
    it('toggles the parent + its children and echoes the pair', async () => {
      prisma.terminology.findFirst.mockResolvedValue(
        term({ id: 3, word: 'w' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.setEnabled(3, false));
      expect(res).toEqual({ id: 3, enabled: false });
      expect(prisma.terminology.updateMany).toHaveBeenCalledWith({
        where: { oid: 1, OR: [{ id: 3 }, { pid: 3 }] },
        data: { enabled: false },
      });
    });

    it('unknown id → 404', async () => {
      prisma.terminology.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.setEnabled(404, true)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove (vector degradation)', () => {
    it('a vector.remove failure is logged and the rest still removed', async () => {
      vector.remove.mockRejectedValueOnce(new Error('v down'));
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([3, 4]));
      expect(vector.remove).toHaveBeenCalledTimes(2);
      expect(res).toEqual([{ id: 3 }, { id: 4 }]);
    });

    it('skips vector cleanup entirely when the index is unavailable', async () => {
      vector.available = false;
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.remove([3]));
      expect(prisma.terminology.deleteMany).toHaveBeenCalled();
      expect(vector.remove).not.toHaveBeenCalled();
    });
  });

  describe('workspace guard (currentOid)', () => {
    it('rejects with 401 when no user context exists', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(svc.page(1, 10)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─────────────── appended coverage: Excel export + template ───────────────

  describe('exportAll', () => {
    it('writes the filtered parents to a 6-column workbook', async () => {
      prisma.terminology.findMany.mockImplementation(
        (args?: { where?: { pid?: unknown } }) => {
          const pid = args?.where?.pid;
          if (pid && typeof pid === 'object') {
            return Promise.resolve([{ pid: 1, word: '营收' }]);
          }
          return Promise.resolve([
            term({
              id: 1,
              word: '收入',
              description: '收入定义',
              specificDs: true,
              datasourceIds: [5],
              advancedApplication: '7',
            }),
            term({ id: 2, word: '成本' }),
          ]);
        },
      );
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([{ id: 7, name: 'bot' }]);
      const svc = makeService(prisma, vector, embedding);
      const buf = await withUser(1, () => svc.exportAll());
      expect(Buffer.isBuffer(buf)).toBe(true);
      const wb = new ExcelJS.Workbook();
      type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
      await wb.xlsx.load(buf as unknown as LoadParam);
      const ws = wb.getWorksheet('terminology');
      expect(ws).toBeDefined();
      // headers render through the same tr() the service used.
      expect(cellText(ws!.getCell(1, 1).value)).toBe(
        tr('terminology.col_word'),
      );
      expect(cellText(ws!.getCell(1, 6).value)).toBe(
        tr('terminology.col_advanced_application'),
      );
      // specific-ds row: synonyms joined, names resolved, N flag.
      expect(cellText(ws!.getCell(2, 1).value)).toBe('收入');
      expect(cellText(ws!.getCell(2, 2).value)).toBe('营收');
      expect(cellText(ws!.getCell(2, 3).value)).toBe('收入定义');
      expect(cellText(ws!.getCell(2, 4).value)).toBe('sales');
      expect(cellText(ws!.getCell(2, 5).value)).toBe('N');
      expect(cellText(ws!.getCell(2, 6).value)).toBe('bot');
      // global row: empty datasource + Y flag + no advanced application.
      expect(cellText(ws!.getCell(3, 2).value)).toBe('');
      expect(cellText(ws!.getCell(3, 4).value)).toBe('');
      expect(cellText(ws!.getCell(3, 5).value)).toBe('Y');
      expect(cellText(ws!.getCell(3, 6).value)).toBe('');
    });

    it('applies the word filter to the export query', async () => {
      prisma.terminology.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.exportAll('收入'));
      expect(prisma.terminology.findMany.mock.calls[0][0].where.OR).toEqual([
        { word: { contains: '收入', mode: 'insensitive' } },
        { description: { contains: '收入', mode: 'insensitive' } },
      ]);
    });
  });

  describe('getTemplate', () => {
    it('renders the 2 hardcoded example rows behind the tr() headers', async () => {
      const svc = makeService(prisma, vector, embedding);
      const buf = await svc.getTemplate();
      const wb = new ExcelJS.Workbook();
      type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
      await wb.xlsx.load(buf as unknown as LoadParam);
      const ws = wb.getWorksheet('terminology');
      expect(cellText(ws!.getCell(1, 1).value)).toBe(
        tr('terminology.col_word'),
      );
      expect(cellText(ws!.getCell(2, 1).value)).toBe('收入');
      expect(cellText(ws!.getCell(2, 2).value)).toBe('营收, 营业收入');
      expect(cellText(ws!.getCell(2, 4).value)).toBe('sales');
      expect(cellText(ws!.getCell(2, 5).value)).toBe('N');
      expect(cellText(ws!.getCell(3, 1).value)).toBe('成本');
      expect(cellText(ws!.getCell(3, 5).value)).toBe('Y');
    });
  });

  // ─────────────── appended coverage: Excel import (uploadExcel) ───────────────

  describe('importExcel', () => {
    const HEADER = [
      '术语名称',
      '同义词',
      '术语描述',
      '生效数据源',
      '全部数据源',
      '高级应用',
    ];

    /** Build an in-memory terminology workbook buffer. */
    async function termWorkbook(
      rows: string[][],
      sheet = 'terminology',
    ): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(sheet);
      rows.forEach((r) => ws.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    it('rejects a corrupt upload with an actionable 400', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.importExcel(Buffer.from('this is not a zip'))),
      ).rejects.toThrow('Excel 文件解析失败');
    });

    it('returns zeros for a sheetless workbook', async () => {
      const empty = new ExcelJS.Workbook();
      const buf = Buffer.from(await empty.xlsx.writeBuffer());
      const svc = makeService(prisma, vector, embedding);
      expect(await withUser(1, () => svc.importExcel(buf))).toEqual({
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      });
    });

    it('header-only file → zero records (no preload, no embed batch)', async () => {
      const buf = await termWorkbook([HEADER]);
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.original_count).toBe(0);
      expect(res.error_excel_filename).toBeNull();
      expect(prisma.terminology.findMany).not.toHaveBeenCalled();
      expect(embedding.embedBatch).not.toHaveBeenCalled();
    });

    it('imports creates + updates + failures with one batched embed + error workbook', async () => {
      const buf = await termWorkbook([
        HEADER,
        ['收入', '营收, 营业收入', '收入描述', 'sales', 'N', 'bot'],
        ['成本', '', '', '', 'Y', ''],
        ['坏行', '', '', 'ghost', 'N', ''],
        ['adv行', '', '', '', 'Y', 'nope'],
        // blank word → skipped, counted neither way
        ['', '同义词', '', '', 'N', ''],
      ]);
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([{ id: 7, name: 'bot' }]);
      prisma.datasource.count.mockResolvedValue(1); // sales resolves + validates
      // Existing-word preload: only '成本' exists → it takes the update path.
      prisma.terminology.findMany.mockImplementation(
        (args?: { where?: { pid?: unknown; word?: unknown } }) =>
          args?.where?.pid === null && args?.where?.word
            ? Promise.resolve([{ id: 50, word: '成本' }])
            : Promise.resolve([]), // dup-scope check inside upsert: clean
      );
      prisma.terminology.findFirst.mockResolvedValue({ id: 50 }); // ownership
      prisma.terminology.update.mockResolvedValue(
        term({ id: 50, word: '成本' }),
      );
      prisma.terminology.create.mockResolvedValue(
        term({ id: 60, word: '收入' }),
      );
      embedding.embedBatch.mockResolvedValue([[0.1], [0.2], null, null]);
      const importError: MockImportError = {
        write: jest.fn().mockResolvedValue('terminology_batch_error.xlsx'),
      };
      const svc = makeService(prisma, vector, embedding, importError);

      const res = await withUser(1, () => svc.importExcel(buf));

      expect(res).toEqual({
        success_count: 2,
        failed_count: 2,
        duplicate_count: 1,
        original_count: 4, // blank row skipped
        error_excel_filename: 'terminology_batch_error.xlsx',
      });
      // ONE batched embedding round-trip over `word\ndescription` texts.
      expect(embedding.embedBatch).toHaveBeenCalledTimes(1);
      expect(embedding.embedBatch).toHaveBeenCalledWith([
        '收入\n收入描述',
        '成本',
        '坏行',
        'adv行',
      ]);
      expect(embedding.embed).not.toHaveBeenCalled(); // precomputed wins
      // created row: resolved ids + precomputed embedding + synonyms.
      const createData = prisma.terminology.create.mock.calls[0][0].data;
      expect(createData).toMatchObject({
        word: '收入',
        description: '收入描述',
        specificDs: true,
        datasourceIds: [5],
        advancedApplication: '7',
        embedding: [0.1],
      });
      const children = prisma.terminology.createMany.mock.calls[0][0]
        .data as Array<{ pid: number; word: string }>;
      expect(children.map((c) => [c.pid, c.word])).toEqual([
        [60, '营收'],
        [60, '营业收入'],
      ]);
      // duplicate row: update path + old children replaced.
      expect(prisma.terminology.update).toHaveBeenCalledWith({
        where: { id: 50 },
        data: expect.objectContaining({ word: '成本', embedding: [0.2] }),
      });
      expect(prisma.terminology.deleteMany).toHaveBeenCalledWith({
        where: { pid: 50 },
      });
      // vector sync used the precomputed embeddings.
      expect(vector.upsert).toHaveBeenCalledWith('terminology', 60, [0.1]);
      expect(vector.upsert).toHaveBeenCalledWith('terminology', 50, [0.2]);
      // failures → error workbook with the original row content + messages.
      expect(importError.write).toHaveBeenCalledTimes(1);
      const payload = importError.write.mock.calls[0][0];
      expect(payload.prefix).toBe('terminology');
      expect(payload.headers).toHaveLength(6);
      expect(payload.rows).toEqual([
        ['坏行', '', '', 'ghost', 'N', ''],
        ['adv行', '', '', '', 'Y', 'nope'],
      ]);
      // tr() is unwired in this spec → the i18n key itself is the message.
      expect(payload.messages[0]).toBe('common.ds_named_not_found');
      expect(payload.messages[1]).toBe('高级应用「nope」不存在');
    });

    it('falls back to the first worksheet and parses the all_data_sources variants', async () => {
      const buf = await termWorkbook(
        [
          HEADER,
          ['w1', '', '', '', 'Y', ''],
          ['w2', '', '', '', 'yes', ''],
          ['w3', '', '', '', 'true', ''],
          ['w4', '', '', '', 'N', ''],
        ],
        'fallback-sheet',
      );
      embedding.available = false; // batch degrades to nulls → vector.remove
      prisma.terminology.create.mockImplementation(
        (args: { data: { word: string } }) =>
          Promise.resolve(term({ id: 70, word: args.data.word })),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res).toEqual({
        success_count: 4,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 4,
        error_excel_filename: null,
      });
      const specific = prisma.terminology.create.mock.calls.map(
        (c) => (c[0] as { data: { specificDs: boolean } }).data.specificDs,
      );
      // Y/yes/true → all datasources (false); anything else (N) → specific.
      expect(specific).toEqual([false, false, false, true]);
      // null embeddings → vector REMOVE per saved row (ILIKE-only recall).
      expect(vector.remove).toHaveBeenCalledTimes(4);
      expect(vector.upsert).not.toHaveBeenCalled();
    });

    it('batch embedding failure degrades every row to a null embedding', async () => {
      const buf = await termWorkbook([HEADER, ['独词', '', '', '', 'Y', '']]);
      embedding.embedBatch.mockRejectedValue(new Error('api down'));
      prisma.terminology.create.mockResolvedValue(
        term({ id: 80, word: '独词' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.success_count).toBe(1);
      expect(prisma.terminology.create.mock.calls[0][0].data.embedding).toBe(
        Prisma.JsonNull,
      );
      expect(vector.remove).toHaveBeenCalledWith('terminology', 80);
    });
  });

  // ─────────────── appended coverage: recall edge arms + embedding failure ───────────────

  describe('recall (edge arms)', () => {
    it('embedding provider failure degrades to ILIKE-only', async () => {
      const a = term({ id: 1, word: 'a' });
      embedding.embed.mockRejectedValue(new Error('embed down'));
      vector.search.mockReturnValue([{ id: 9, distance: 0.1 }]);
      prisma.terminology.findMany.mockResolvedValueOnce([a]); // ILIKE
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('a', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
    });

    it('drops cosine hits below the similarity threshold (no id fetch)', async () => {
      const a = term({ id: 1, word: 'a' });
      embedding.embed.mockResolvedValue([0.5]);
      vector.search.mockReturnValue([{ id: 9, distance: 0.9 }]); // 0.1 < 0.4
      prisma.terminology.findMany.mockResolvedValueOnce([a]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('a', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
      // only the ILIKE findMany ran — the cosine id fetch was skipped.
      expect(prisma.terminology.findMany).toHaveBeenCalledTimes(1);
    });

    it('maps a synonym-child hit back to its parent term', async () => {
      embedding.available = false;
      const child = term({ id: 21, word: '营收', pid: 20 });
      const parent = term({ id: 20, word: '收入' });
      prisma.terminology.findMany
        .mockResolvedValueOnce([child]) // ILIKE hit the synonym row
        .mockResolvedValueOnce([parent]); // parent fetch by pid
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('营收', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([20]);
      expect(result[0].pid).toBeNull();
    });

    it('drops an orphan child whose parent is missing or disabled', async () => {
      embedding.available = false;
      const child = term({ id: 21, word: '营收', pid: 20 });
      prisma.terminology.findMany
        .mockResolvedValueOnce([child])
        .mockResolvedValueOnce([]); // parent fetch: nothing enabled
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('营收', undefined, 5));
      expect(result).toEqual([]);
    });

    it('excludes specific-ds terms when no datasource context exists', async () => {
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([
        term({ id: 1, word: 'g', specificDs: false }),
        term({ id: 2, word: 'nullIds', specificDs: true, datasourceIds: null }),
        term({ id: 3, word: 's', specificDs: true, datasourceIds: [10] }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('x', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
    });

    it('drops a cosine hit whose row fetch misses (byId miss)', async () => {
      embedding.embed.mockResolvedValue([0.5]);
      vector.search.mockReturnValue([{ id: 3, distance: 0.2 }]); // passes 0.4
      const a = term({ id: 1, word: 'a' });
      prisma.terminology.findMany
        .mockResolvedValueOnce([a]) // ILIKE
        .mockResolvedValueOnce([]); // cosine id fetch finds nothing
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('a', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
    });

    it('uses the passed cfg snapshot and defaults topK from it', async () => {
      const cfg = await resolveEmbeddingConfig(prisma as unknown as never);
      prisma.systemVariable.findMany.mockClear();
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([]);
      const svc = makeService(prisma, vector, embedding);
      // no topK → cfg.terminologyTopCount (5) drives take = 4 × 5.
      await withUser(1, () => svc.recall('x', undefined, undefined, cfg));
      expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
      expect(prisma.terminology.findMany.mock.calls[0][0].take).toBe(20);
    });
  });

  describe('getTerminologyTemplate (advancedApplication arm)', () => {
    it('includes advancedApplication and omits a null description', async () => {
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([
        term({ id: 1, word: 'w', description: null, advancedApplication: '7' }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const xml = await withUser(1, () =>
        svc.getTerminologyTemplate('w', undefined, 5),
      );
      expect(xml).toBe(
        '<terminologies>\n' +
          '  <terminology word="w" advancedApplication="7" />\n' +
          '</terminologies>',
      );
    });
  });

  describe('embedding failure on upsert', () => {
    it('stores a null embedding + removes the stale vector instead of failing', async () => {
      embedding.embed.mockRejectedValue(new Error('embed boom'));
      prisma.terminology.create.mockResolvedValue(term({ id: 30, word: 'x' }));
      const svc = makeService(prisma, vector, embedding);
      const saved = await withUser(1, () => svc.upsert({ word: 'x' }));
      expect(saved.id).toBe(30);
      expect(prisma.terminology.create.mock.calls[0][0].data.embedding).toBe(
        Prisma.JsonNull,
      );
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.remove).toHaveBeenCalledWith('terminology', 30);
    });
  });

  // ─────────────── appended coverage round 2: non-Error degradations ───────────────

  describe('non-Error degradation arms', () => {
    it('remove: a non-Error vector rejection still completes the batch', async () => {
      vector.remove.mockRejectedValueOnce('plain failure');
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([3]));
      expect(res).toEqual([{ id: 3 }]);
    });

    it('importExcel: a non-Error upsert failure lands in the error workbook', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('terminology');
      ws.addRow(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
      ws.addRow(['词', '', '', '', 'Y', '']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      // The transaction rejects with a plain string → String(e) arm.
      prisma.$transaction.mockRejectedValueOnce('plain failure');
      const importError: MockImportError = {
        write: jest.fn().mockResolvedValue('terminology_plain_error.xlsx'),
      };
      const svc = makeService(prisma, vector, embedding, importError);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.failed_count).toBe(1);
      expect(importError.write.mock.calls[0][0].messages).toEqual([
        'plain failure',
      ]);
    });

    it('safeEmbedBatch: a non-Error batch rejection degrades to nulls', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('terminology');
      ws.addRow(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
      ws.addRow(['独词2', '', '', '', 'Y', '']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      embedding.embedBatch.mockRejectedValue('plain batch failure');
      prisma.terminology.create.mockResolvedValue(
        term({ id: 81, word: '独词2' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.success_count).toBe(1);
      expect(prisma.terminology.create.mock.calls[0][0].data.embedding).toBe(
        Prisma.JsonNull,
      );
    });

    it('syncVector: vector unavailable → no index traffic at all', async () => {
      vector.available = false;
      embedding.available = false;
      prisma.terminology.create.mockResolvedValue(term({ id: 31, word: 'x' }));
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.upsert({ word: 'x' }));
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.remove).not.toHaveBeenCalled();
    });

    it('syncVector: a non-Error throw is swallowed', async () => {
      embedding.available = false;
      prisma.terminology.create.mockResolvedValue(term({ id: 32, word: 'x' }));
      vector.remove.mockImplementation(() => {
        // deliberate non-Error throw: exercises the String(e) warn arm
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain boom';
      });
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ word: 'x' })),
      ).resolves.toMatchObject({ id: 32 });
    });

    it('recall: a non-Error embed rejection degrades to ILIKE-only', async () => {
      embedding.embed.mockRejectedValue('plain boom');
      prisma.terminology.findMany.mockResolvedValueOnce([
        term({ id: 1, word: 'a' }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('a', undefined, 5));
      expect(result.map((t) => t.id)).toEqual([1]);
    });

    it('recall: a specific-ds term with null datasource_ids never matches', async () => {
      embedding.available = false;
      prisma.terminology.findMany.mockResolvedValueOnce([
        term({ id: 2, word: 'nullIds', specificDs: true, datasourceIds: null }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      // Array.isArray(null) is false → ids [] → no match even with ds context.
      expect(await withUser(1, () => svc.recall('nullIds', 10, 5))).toEqual([]);
    });
  });

  describe('expandWithTerminology (edge arms)', () => {
    it('returns the input for an empty keyword list or a null oid', async () => {
      const svc = makeService(prisma, vector, embedding);
      expect(await svc.expandWithTerminology('  ,  ', 1)).toBe('  ,  ');
      expect(await svc.expandWithTerminology('订单', null as never)).toBe(
        '订单',
      );
      expect(prisma.terminology.findMany).not.toHaveBeenCalled();
    });

    it('tolerates null words on parent and child rows', async () => {
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: null },
        { id: 2, pid: 1, word: null },
      ]);
      const svc = makeService(prisma, vector, embedding);
      expect(await svc.expandWithTerminology('订单', 1)).toBe('订单');
    });

    it('a keyword hitting a childless parent expands nothing', async () => {
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: '独父' },
      ]);
      const svc = makeService(prisma, vector, embedding);
      // parent word already among the keywords; no children to fold in.
      expect(await svc.expandWithTerminology('独父', 1)).toBe('独父');
    });

    it('breaks the pid and outer keyword loops once the cap is reached', async () => {
      // 'x' hits two groups: group 1 (12 children) fills the 10-keyword cap,
      // the pid-loop break fires on group 2, and 'zzz' hits the outer break.
      prisma.terminology.findMany.mockResolvedValue([
        { id: 1, pid: null, word: 'p1' },
        ...Array.from({ length: 12 }, (_, i) => ({
          id: 10 + i,
          pid: 1,
          word: i === 0 ? 'x' : `c${i}`,
        })),
        { id: 2, pid: null, word: 'x' }, // second group shares the keyword
      ]);
      const svc = makeService(prisma, vector, embedding);
      const out = await svc.expandWithTerminology('x,zzz', 1);
      expect(out.split(',')).toHaveLength(10);
      expect(out.startsWith('x,zzz,p1,c1')).toBe(true);
    });

    it('a non-Error prisma rejection degrades to the original keywords', async () => {
      prisma.terminology.findMany.mockRejectedValue('plain db failure');
      const svc = makeService(prisma, vector, embedding);
      expect(await svc.expandWithTerminology('订单', 1)).toBe('订单');
    });
  });
});
