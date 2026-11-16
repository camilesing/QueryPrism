// DataTrainingService unit tests.
// Covers the CRUD (upsert create-branch / remove batch) + the
// live chat-DI recall() (kept verbatim — ai-question.service injects this
// service) + the exceljs export/template/import round-trip with the
// 4-column set (no enabled) + import-result shape.
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { requestContextStorage } from '../common/context/request-context';
import { DataTrainingService } from './data-training.service';
import type { DataTraining } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { resolveEmbeddingConfig } from '../common/config/embedding-config';

function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  dataTraining: {
    create: jest.Mock;
    update: jest.Mock;
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
};

function row(
  p: Partial<DataTraining> & { id: number; question: string },
): DataTraining {
  return {
    oid: 1,
    description: null,
    datasource: null,
    embedding: null,
    enabled: true,
    advancedApplication: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  };
}

type MockImportError = { write: jest.Mock };

function makeService(
  prisma: MockPrisma,
  vector: MockVector,
  embedding: MockEmbedding,
  // Optional so failure-path tests can capture the error-workbook write.
  importError: MockImportError = {
    write: jest.fn().mockResolvedValue('data-training_x_error.xlsx'),
  },
) {
  return new DataTrainingService(
    prisma as unknown as never,
    vector as unknown as never,
    embedding as unknown as never,
    importError as unknown as never,
  );
}

function makePrisma(): MockPrisma {
  return {
    dataTraining: {
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    datasource: {
      findMany: jest.fn(),
      // Referenced datasource ids resolve in the current workspace.
      count: jest.fn().mockResolvedValue(1),
    },
    assistant: { findMany: jest.fn() },
    systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (arr) => Promise.all(arr)),
  };
}

/** Coerce an exceljs cell value to a string (mirrors the service's helper). */
function cellText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.richText))
      return obj.richText
        .map((r) => (r as { text?: unknown }).text ?? '')
        .filter((t): t is string => typeof t === 'string')
        .join('');
    if ('result' in obj) return cellText(obj.result);
    if (typeof obj.text === 'string') return obj.text;
    return '';
  }
  return '';
}

describe('DataTrainingService', () => {
  beforeEach(() => setI18n(createTestI18n()));
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

  describe('upsert (create-branch)', () => {
    it('embeds + upserts the vector on create', async () => {
      embedding.embed.mockResolvedValue([0.1, 0.2]);
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 1, question: args.data.question ?? 'q' })),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({ question: 'how many orders?', description: 'count' }),
      );
      // embedding persisted as JSON number[]
      const createCall = prisma.dataTraining.create.mock.calls[0][0] as {
        data: { embedding: number[] };
      };
      expect(createCall.data.embedding).toEqual([0.1, 0.2]);
      // vector upsert called with the new id + embedding
      expect(vector.upsert).toHaveBeenCalledWith(
        'data_training',
        1,
        [0.1, 0.2],
      );
    });

    it('skips embedding when no embedding key is configured', async () => {
      embedding.available = false;
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 2, question: args.data.question ?? 'q' })),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.upsert({ question: 'q' }));
      const createCall = prisma.dataTraining.create.mock.calls[0][0] as {
        data: { embedding: unknown };
      };
      // embedding stored as the Prisma JsonNull sentinel (SQL NULL), not a
      // number[] — mirrors terminology's "skips when no key" assertion.
      expect(createCall.data.embedding).toBe(Prisma.JsonNull);
      expect(vector.upsert).not.toHaveBeenCalled();
    });

    it('does not break create when vector sync throws', async () => {
      embedding.embed.mockResolvedValue([0.3]);
      prisma.dataTraining.create.mockResolvedValue(
        row({ id: 3, question: 'q' }),
      );
      vector.upsert.mockImplementation(() => {
        throw new Error('vec0 down');
      });
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ question: 'q' })),
      ).resolves.toMatchObject({ id: 3 });
    });

    it('stores advancedApplication as String + datasource null', async () => {
      embedding.available = false;
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 4, question: 'q', ...args.data })),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () =>
        svc.upsert({
          question: 'q',
          datasource: null,
          advanced_application: 42,
        }),
      );
      const createCall = prisma.dataTraining.create.mock.calls[0][0] as {
        data: { advancedApplication: string | null; datasource: number | null };
      };
      expect(createCall.data.advancedApplication).toBe('42');
      expect(createCall.data.datasource).toBeNull();
    });
  });

  describe('remove (batch)', () => {
    it('deletes rows + vectors for the given ids', async () => {
      prisma.dataTraining.deleteMany.mockResolvedValue({ count: 2 });
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.remove([1, 2]));
      const call = prisma.dataTraining.deleteMany.mock.calls[0][0] as {
        where: { id: { in: number[] } };
      };
      expect(call.where.id.in).toEqual([1, 2]);
      expect(vector.remove).toHaveBeenCalledWith('data_training', 1);
      expect(vector.remove).toHaveBeenCalledWith('data_training', 2);
      // returns [{id}] for the @SystemLog DELETE callback (mirrors terminology)
      expect(result).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('[] is a no-op returning []', async () => {
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.remove([]));
      expect(result).toEqual([]);
      expect(prisma.dataTraining.deleteMany).not.toHaveBeenCalled();
      expect(vector.remove).not.toHaveBeenCalled();
    });
  });

  describe('recall (datasource-scoped)', () => {
    it('includes global + specific-matching samples via the where-clause', async () => {
      const specific = row({ id: 1, question: 'q1', datasource: 10 });
      const global = row({ id: 2, question: 'q2', datasource: null });
      // ILIKE findMany returns already-scoped rows.
      prisma.dataTraining.findMany.mockResolvedValueOnce([specific, global]);
      const svc = makeService(prisma, vector, embedding);
      embedding.available = false;
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([1, 2]);
      // Verify the where-clause carried the OR datasource scope (AND-nested
      // alongside the keyword OR so neither overwrites the other).
      const calls = prisma.dataTraining.findMany.mock.calls as Array<
        Array<{ where: { AND: Array<{ OR?: unknown; datasource?: unknown }> } }>
      >;
      expect(calls[0][0].where.AND[0].OR).toEqual([
        { datasource: 10 },
        { datasource: null },
      ]);
    });

    it('with no datasourceId scopes to global samples only', async () => {
      const global = row({ id: 2, question: 'q2', datasource: null });
      prisma.dataTraining.findMany.mockResolvedValueOnce([global]);
      const svc = makeService(prisma, vector, embedding);
      embedding.available = false;
      const result = await withUser(1, () => svc.recall('q', undefined, 5));
      expect(result.map((r) => r.id)).toEqual([2]);
      const calls = prisma.dataTraining.findMany.mock.calls as Array<
        Array<{ where: { AND: Array<{ OR?: unknown; datasource?: unknown }> } }>
      >;
      expect(calls[0][0].where.AND[0].datasource).toBeNull();
    });

    it('merges cosine hits before ILIKE-only hits', async () => {
      const a = row({ id: 1, question: 'q1', datasource: 10 });
      const c = row({ id: 3, question: 'semantic', datasource: 10 });
      embedding.embed.mockResolvedValue([0.5]);
      // VectorService.search is synchronous — use mockReturnValue.
      vector.search.mockReturnValue([{ id: 3, distance: 0.2 }]);
      prisma.dataTraining.findMany
        .mockResolvedValueOnce([a]) // ILIKE
        .mockResolvedValueOnce([c]); // cosine id fetch
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([3, 1]);
    });
  });

  describe('Excel export/template/import round-trip', () => {
    it('exports rows to a 4-column xlsx (no enabled) with resolved names', async () => {
      const rows = [
        row({
          id: 1,
          question: 'how many orders?',
          description: 'SELECT count(*) FROM orders',
          datasource: 5,
          advancedApplication: '7',
        }),
      ];
      prisma.dataTraining.findMany.mockResolvedValue(rows);
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([
        { id: 7, name: 'orders-bot' },
      ]);
      const svc = makeService(prisma, vector, embedding);
      const buffer = await withUser(1, () => svc.exportAll());
      expect(Buffer.isBuffer(buffer)).toBe(true);
      const wb = new ExcelJS.Workbook();
      type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
      await wb.xlsx.load(buffer as unknown as LoadParam);
      const ws = wb.getWorksheet('data_training');
      expect(ws).toBeDefined();
      // header row: 问题表述 / 示例SQL / 生效数据源 / 高级应用
      expect(cellText(ws!.getCell(1, 1).value)).toBe('问题表述');
      expect(cellText(ws!.getCell(1, 4).value)).toBe('高级应用');
      // row 2: resolved names
      expect(cellText(ws!.getCell(2, 1).value)).toBe('how many orders?');
      expect(cellText(ws!.getCell(2, 3).value)).toBe('sales');
      expect(cellText(ws!.getCell(2, 4).value)).toBe('orders-bot');
    });

    it('template has 1 sample row with placeholder values', async () => {
      const svc = makeService(prisma, vector, embedding);
      const buffer = await withUser(1, () => svc.getTemplate());
      const wb = new ExcelJS.Workbook();
      type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
      await wb.xlsx.load(buffer as unknown as LoadParam);
      const ws = wb.getWorksheet('data_training');
      expect(cellText(ws!.getCell(2, 1).value)).toBe('查询TEST表内所有ID');
      expect(cellText(ws!.getCell(2, 2).value)).toBe('SELECT id FROM TEST');
      expect(cellText(ws!.getCell(2, 3).value)).toBe('生效数据源1');
      expect(cellText(ws!.getCell(2, 4).value)).toBe('生效高级应用名称');
    });

    it('imports an xlsx: resolves names→ids + returns wire shape', async () => {
      // Build a real xlsx buffer with the 4 columns.
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('data_training');
      ws.addRow(['问题表述', '示例SQL', '生效数据源', '高级应用']);
      ws.addRow([
        'how many orders?',
        'SELECT count(*) FROM orders',
        'sales',
        'orders-bot',
      ]);
      ws.addRow(['top products', '', '', '']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      // name→id resolution maps
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([
        { id: 7, name: 'orders-bot' },
      ]);
      // create() returns the row
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 99, question: args.data.question ?? 'q' })),
      );
      embedding.available = false;
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.importExcel(buf));
      expect(result.success_count).toBe(2);
      expect(result.failed_count).toBe(0);
      expect(result.duplicate_count).toBe(0);
      expect(result.original_count).toBe(2);
      expect(result.error_excel_filename).toBeNull();
      // first row: names resolved to ids
      const first = prisma.dataTraining.create.mock.calls[0][0] as {
        data: { datasource: number | null; advancedApplication: string | null };
      };
      expect(first.data.datasource).toBe(5);
      expect(first.data.advancedApplication).toBe('7');
      // second row: empty names → null
      const second = prisma.dataTraining.create.mock.calls[1][0] as {
        data: { datasource: number | null; advancedApplication: string | null };
      };
      expect(second.data.datasource).toBeNull();
      expect(second.data.advancedApplication).toBeNull();
    });
  });

  // ─────────────── appended coverage: page pager + list filters ───────────────

  describe('page (pager + filters)', () => {
    it('returns the pager shape with resolved ds/adv names', async () => {
      prisma.dataTraining.count.mockResolvedValue(2);
      prisma.dataTraining.findMany.mockResolvedValue([
        row({
          id: 1,
          question: 'q1',
          description: 'd1',
          datasource: 5,
          advancedApplication: '7',
        }),
        row({ id: 2, question: 'q2' }),
      ]);
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
        datasource: 5,
        datasource_name: 'sales',
        question: 'q1',
        advanced_application: 7, // String? column coerced back to a number
        advanced_application_name: 'bot',
      });
      expect(res.data[1]).toMatchObject({
        datasource: null,
        datasource_name: null,
        advanced_application: null,
        advanced_application_name: null,
      });
      // paged query: workspace-scoped where + skip/take.
      const findCall = prisma.dataTraining.findMany.mock.calls[0][0];
      expect(findCall.where).toEqual({ oid: 1 });
      expect(findCall.skip).toBe(0);
      expect(findCall.take).toBe(10);
    });

    it('combines keyword + ds_list + adv_list filters and clamps paging', async () => {
      prisma.dataTraining.count.mockResolvedValue(0);
      prisma.dataTraining.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.page(0, 0, '收入', [5], [7]));
      const findCall = prisma.dataTraining.findMany.mock.calls[0][0];
      expect(findCall.where).toEqual({
        oid: 1,
        OR: [
          { question: { contains: '收入', mode: 'insensitive' } },
          { description: { contains: '收入', mode: 'insensitive' } },
        ],
        datasource: { in: [5] },
        advancedApplication: { in: ['7'] }, // String? column → stringified ids
      });
      expect(findCall.skip).toBe(0); // cp clamped 0 → 1
      expect(findCall.take).toBe(10); // ps clamped 0 → 10
      // whitespace-only keyword → no OR branch.
      await withUser(1, () => svc.page(1, 10, '   '));
      expect(
        prisma.dataTraining.findMany.mock.calls[1][0].where.OR,
      ).toBeUndefined();
      // fractional page/page_size are floored; empty result → 0 pages.
      const res = await withUser(1, () => svc.page(2.5, 3));
      expect(res).toMatchObject({
        current_page: 2,
        page_size: 3,
        total_count: 0,
        total_pages: 0,
        data: [],
      });
      expect(prisma.dataTraining.findMany.mock.calls[2][0].skip).toBe(3);
    });
  });

  // ─────────────── appended coverage: upsert update branch + validation ───────────────

  describe('upsert (update branch + validation)', () => {
    it('updates the row, re-embeds and syncs the vector', async () => {
      embedding.embed.mockResolvedValue([0.2]);
      prisma.dataTraining.findFirst.mockResolvedValue(
        row({ id: 9, question: 'old' }),
      );
      prisma.dataTraining.update.mockResolvedValue(
        row({ id: 9, question: 'q9', enabled: false }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () =>
        svc.upsert({
          id: 9,
          question: ' q9 ',
          description: ' d9 ',
          datasource: 5,
          advanced_application: 42,
          enabled: false,
        }),
      );
      expect(res).toMatchObject({ id: 9, enabled: false });
      expect(embedding.embed).toHaveBeenCalledWith('q9\nd9');
      expect(prisma.dataTraining.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: {
          question: 'q9',
          description: 'd9',
          datasource: 5,
          enabled: false,
          advancedApplication: '42',
          embedding: [0.2],
        },
      });
      expect(vector.upsert).toHaveBeenCalledWith('data_training', 9, [0.2]);
    });

    it('rejects a blank question with 400 before any write', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ question: '   ' })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.dataTraining.create).not.toHaveBeenCalled();
    });

    it('rejects a datasource outside the workspace with 400', async () => {
      prisma.datasource.count.mockResolvedValue(0);
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ question: 'q', datasource: 5 })),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.dataTraining.create).not.toHaveBeenCalled();
    });

    it('unknown id → 404 before any update', async () => {
      prisma.dataTraining.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ id: 404, question: 'q' })),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.dataTraining.update).not.toHaveBeenCalled();
    });

    it('embedding provider failure degrades to a null embedding', async () => {
      embedding.embed.mockRejectedValue(new Error('embed down'));
      prisma.dataTraining.create.mockResolvedValue(
        row({ id: 30, question: 'q' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.upsert({ question: 'q' }));
      expect(res.id).toBe(30);
      expect(prisma.dataTraining.create.mock.calls[0][0].data.embedding).toBe(
        Prisma.JsonNull,
      );
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.remove).toHaveBeenCalledWith('data_training', 30);
    });
  });

  // ─────────────── appended coverage: remove coercion + setEnabled ───────────────

  describe('remove (coercion + degradation)', () => {
    it('coerces string ids to numbers', async () => {
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () =>
        svc.remove(['1', '2'] as unknown as number[]),
      );
      expect(
        prisma.dataTraining.deleteMany.mock.calls[0][0].where.id.in,
      ).toEqual([1, 2]);
      expect(res).toEqual([{ id: 1 }, { id: 2 }]);
    });

    it('a non-array body is a no-op', async () => {
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () =>
        svc.remove(undefined as unknown as number[]),
      );
      expect(res).toEqual([]);
      expect(prisma.dataTraining.deleteMany).not.toHaveBeenCalled();
    });

    it('a vector.remove failure is logged and the rest still removed', async () => {
      vector.remove.mockRejectedValueOnce(new Error('v down'));
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([7, 8]));
      expect(vector.remove).toHaveBeenCalledTimes(2);
      expect(res).toEqual([{ id: 7 }, { id: 8 }]);
    });

    it('skips vector cleanup when the index is unavailable', async () => {
      vector.available = false;
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.remove([7]));
      expect(prisma.dataTraining.deleteMany).toHaveBeenCalled();
      expect(vector.remove).not.toHaveBeenCalled();
    });
  });

  describe('setEnabled', () => {
    it('updates enabled and returns the updated row', async () => {
      prisma.dataTraining.findFirst.mockResolvedValue(
        row({ id: 3, question: 'q' }),
      );
      prisma.dataTraining.update.mockResolvedValue(
        row({ id: 3, question: 'q', enabled: false }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.setEnabled(3, false));
      expect(res).toMatchObject({ id: 3, enabled: false });
      expect(prisma.dataTraining.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: { enabled: false },
      });
    });

    it('unknown id → 404', async () => {
      prisma.dataTraining.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.setEnabled(404, true)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('workspace guard (currentOid)', () => {
    it('rejects with 401 when no user context exists', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(svc.page(1, 10)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ─────────────── appended coverage: recall edge arms + template ───────────────

  describe('recall (edge arms)', () => {
    it('embedding provider failure degrades to ILIKE-only', async () => {
      const a = row({ id: 1, question: 'q1' });
      embedding.embed.mockRejectedValue(new Error('embed down'));
      prisma.dataTraining.findMany.mockResolvedValueOnce([a]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', undefined, 5));
      expect(result.map((r) => r.id)).toEqual([1]);
      expect(vector.search).not.toHaveBeenCalled();
    });

    it('drops below-threshold and unknown-id cosine hits', async () => {
      const a = row({ id: 1, question: 'q1' });
      embedding.embed.mockResolvedValue([0.5]);
      // id 9 is below the 0.4 threshold; id 3 passes but its row fetch misses.
      vector.search.mockReturnValue([
        { id: 9, distance: 0.9 },
        { id: 3, distance: 0.2 },
      ]);
      prisma.dataTraining.findMany
        .mockResolvedValueOnce([a]) // ILIKE
        .mockResolvedValueOnce([]); // cosine id fetch finds nothing
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([1]);
      expect(prisma.dataTraining.findMany).toHaveBeenCalledTimes(2);
    });

    it('skips cosine entirely when the vector index is unavailable', async () => {
      vector.available = false;
      const a = row({ id: 1, question: 'q1' });
      prisma.dataTraining.findMany.mockResolvedValueOnce([a]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([1]);
      expect(embedding.embed).not.toHaveBeenCalled();
      expect(vector.search).not.toHaveBeenCalled();
    });

    it('defaults topK from the config (take = 4 × topK), floor-clamped at 1', async () => {
      embedding.available = false;
      prisma.dataTraining.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.recall('q', 10)); // no topK → default 5
      expect(prisma.dataTraining.findMany.mock.calls[0][0].take).toBe(20);
      await withUser(1, () => svc.recall('q', 10, 0)); // Math.max(1, 0)
      expect(prisma.dataTraining.findMany.mock.calls[1][0].take).toBe(4);
    });

    it('uses the passed cfg snapshot instead of re-reading SystemVariable', async () => {
      const cfg = await resolveEmbeddingConfig(prisma as unknown as never);
      prisma.systemVariable.findMany.mockClear();
      embedding.available = false;
      prisma.dataTraining.findMany.mockResolvedValueOnce([]);
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.recall('q', 10, 5, cfg));
      expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getDataTrainingTemplate', () => {
    it('returns empty string when nothing matched', async () => {
      embedding.available = false;
      prisma.dataTraining.findMany.mockResolvedValueOnce([]);
      const svc = makeService(prisma, vector, embedding);
      expect(await withUser(1, () => svc.getDataTrainingTemplate('zzz'))).toBe(
        '',
      );
    });

    it('renders escaped samples, omitting null descriptions', async () => {
      embedding.available = false;
      prisma.dataTraining.findMany.mockResolvedValueOnce([
        row({ id: 1, question: 'a&b', description: '<x>' }),
        row({ id: 2, question: 'plain', description: null }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const xml = await withUser(1, () => svc.getDataTrainingTemplate('a'));
      expect(xml).toBe(
        '<data_training_examples>\n' +
          '  <data_training question="a&amp;b" description="&lt;x&gt;" />\n' +
          '  <data_training question="plain" />\n' +
          '</data_training_examples>',
      );
    });
  });

  // ─────────────── appended coverage: importExcel edge arms ───────────────

  describe('importExcel (edge arms)', () => {
    const HEADER = ['问题表述', '示例SQL', '生效数据源', '高级应用'];

    /** Build an in-memory data_training workbook buffer. */
    async function dtWorkbook(
      rows: string[][],
      sheet = 'data_training',
    ): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet(sheet);
      rows.forEach((r) => ws.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    }

    it('header-only and sheetless workbooks import zero rows', async () => {
      // name→id maps are built before the loop — keep them resolvable.
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      const zeros = {
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      };
      const headerOnly = await dtWorkbook([HEADER]);
      expect(await withUser(1, () => svc.importExcel(headerOnly))).toEqual(
        zeros,
      );
      // no records → no existing-question preload query.
      expect(prisma.dataTraining.findMany).not.toHaveBeenCalled();
      const empty = new ExcelJS.Workbook();
      const sheetless = Buffer.from(await empty.xlsx.writeBuffer());
      expect(await withUser(1, () => svc.importExcel(sheetless))).toEqual(
        zeros,
      );
    });

    it('re-importing an existing question takes the update path', async () => {
      const buf = await dtWorkbook([HEADER, ['q1', 'SELECT 1', 'sales', '']]);
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.dataTraining.findMany.mockResolvedValueOnce([
        { id: 77, question: 'q1' },
      ]);
      prisma.dataTraining.findFirst.mockResolvedValue(
        row({ id: 77, question: 'q1' }),
      );
      prisma.dataTraining.update.mockResolvedValue(
        row({ id: 77, question: 'q1' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res).toEqual({
        success_count: 1,
        failed_count: 0,
        duplicate_count: 1,
        original_count: 1,
        error_excel_filename: null,
      });
      expect(prisma.dataTraining.update).toHaveBeenCalledWith({
        where: { id: 77 },
        data: expect.objectContaining({ question: 'q1', datasource: 5 }),
      });
      expect(prisma.dataTraining.create).not.toHaveBeenCalled();
    });

    it('a failing row lands in the error workbook with its message', async () => {
      const buf = await dtWorkbook([HEADER, ['q1', 'SELECT 1', 'sales', '']]);
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'sales' }]);
      prisma.assistant.findMany.mockResolvedValue([]);
      // ds name resolves to id 5, then fails the workspace validation inside
      // upsert → the row is collected as a failure instead of aborting.
      prisma.datasource.count.mockResolvedValue(0);
      const importError: MockImportError = {
        write: jest.fn().mockResolvedValue('dt_row_error.xlsx'),
      };
      const svc = makeService(prisma, vector, embedding, importError);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res).toEqual({
        success_count: 0,
        failed_count: 1,
        duplicate_count: 0,
        original_count: 1,
        error_excel_filename: 'dt_row_error.xlsx',
      });
      expect(importError.write).toHaveBeenCalledTimes(1);
      const payload = importError.write.mock.calls[0][0];
      expect(payload.prefix).toBe('data-training');
      expect(payload.headers).toEqual([
        '问题',
        '样例SQL',
        '数据源',
        '高级应用',
      ]);
      expect(payload.rows).toEqual([['q1', 'SELECT 1', 'sales', '']]);
      expect(payload.messages).toHaveLength(1);
    });

    it('coerces rich-text/formula/number/boolean/hyperlink/error cells', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('data_training');
      ws.addRow(HEADER);
      const a = ws.getRow(2);
      a.getCell(1).value = { richText: [{ text: 'rich' }, { text: 'Q' }] };
      a.getCell(2).value = { formula: 'CONCATENATE("a","b")', result: 'ab' };
      a.getCell(3).value = 42; // numeric ds name → '42', unresolved → null
      a.getCell(4).value = { error: '#DIV/0!' }; // '' → null
      const b = ws.getRow(3);
      b.getCell(1).value = { text: 'linkQ', hyperlink: 'http://x' };
      b.getCell(2).value = true; // boolean → 'true'
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 1, question: args.data.question ?? 'q' })),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.success_count).toBe(2);
      const questions = prisma.dataTraining.create.mock.calls.map(
        (c) => (c[0] as { data: { question: string } }).data.question,
      );
      expect(questions).toEqual(['richQ', 'linkQ']);
      const descriptions = prisma.dataTraining.create.mock.calls.map(
        (c) =>
          (c[0] as { data: { description: string | null } }).data.description,
      );
      expect(descriptions).toEqual(['ab', 'true']);
      // unresolved numeric ds name + error-cell adv name → null / null.
      expect(
        prisma.dataTraining.create.mock.calls[0][0].data.datasource,
      ).toBeNull();
      expect(
        prisma.dataTraining.create.mock.calls[0][0].data.advancedApplication,
      ).toBeNull();
    });

    it('falls back to the first worksheet when the sheet is not named data_training', async () => {
      const buf = await dtWorkbook([HEADER, ['q9', '', '', '']], 'other');
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.dataTraining.create.mockResolvedValue(
        row({ id: 90, question: 'q9' }),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.success_count).toBe(1);
      expect(prisma.dataTraining.create.mock.calls[0][0].data.question).toBe(
        'q9',
      );
    });
  });

  // ─────────────── appended coverage: non-Error degradations ───────────────

  describe('non-Error degradation arms', () => {
    it('remove: a non-Error vector rejection still completes the batch', async () => {
      vector.remove.mockRejectedValueOnce('plain failure');
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.remove([7]));
      expect(res).toEqual([{ id: 7 }]);
    });

    it('recall: a non-Error embed rejection degrades to ILIKE-only', async () => {
      embedding.embed.mockRejectedValue('plain boom');
      prisma.dataTraining.findMany.mockResolvedValueOnce([
        row({ id: 1, question: 'q1' }),
      ]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([1]);
    });

    it('syncVector: vector unavailable → no index traffic at all', async () => {
      vector.available = false;
      embedding.available = false;
      prisma.dataTraining.create.mockResolvedValue(
        row({ id: 31, question: 'q' }),
      );
      const svc = makeService(prisma, vector, embedding);
      await withUser(1, () => svc.upsert({ question: 'q' }));
      expect(vector.upsert).not.toHaveBeenCalled();
      expect(vector.remove).not.toHaveBeenCalled();
    });

    it('syncVector: a non-Error throw is swallowed', async () => {
      embedding.available = false;
      prisma.dataTraining.create.mockResolvedValue(
        row({ id: 32, question: 'q' }),
      );
      vector.remove.mockImplementation(() => {
        // deliberate non-Error throw: exercises the String(e) warn arm
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'plain boom';
      });
      const svc = makeService(prisma, vector, embedding);
      await expect(
        withUser(1, () => svc.upsert({ question: 'q' })),
      ).resolves.toMatchObject({ id: 32 });
    });

    it('importExcel: a non-Error upsert failure lands in the error workbook', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('data_training');
      ws.addRow(['问题表述', '示例SQL', '生效数据源', '高级应用']);
      ws.addRow(['q', '', '', '']);
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      // update path rejects with a plain string → String(e) arm of the catch.
      prisma.dataTraining.findMany.mockResolvedValueOnce([
        { id: 5, question: 'q' },
      ]);
      prisma.dataTraining.findFirst.mockResolvedValue(
        row({ id: 5, question: 'q' }),
      );
      prisma.dataTraining.update.mockRejectedValue('plain failure');
      const importError: MockImportError = {
        write: jest.fn().mockResolvedValue('dt_plain_error.xlsx'),
      };
      const svc = makeService(prisma, vector, embedding, importError);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.failed_count).toBe(1);
      expect(importError.write.mock.calls[0][0].messages).toEqual([
        'plain failure',
      ]);
    });
  });

  // ─────────────── appended coverage round 2: remaining arms ───────────────

  describe('edge arms round 2', () => {
    it('recall: an empty query returns [] without querying', async () => {
      const svc = makeService(prisma, vector, embedding);
      expect(await withUser(1, () => svc.recall('   ', 10, 5))).toEqual([]);
      expect(prisma.dataTraining.findMany).not.toHaveBeenCalled();
    });

    it('recall: all cosine hits below threshold → no id fetch', async () => {
      const a = row({ id: 1, question: 'q1', datasource: 10 });
      embedding.embed.mockResolvedValue([0.5]);
      vector.search.mockReturnValue([{ id: 9, distance: 0.9 }]); // 0.1 < 0.4
      prisma.dataTraining.findMany.mockResolvedValueOnce([a]);
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([1]);
      // only the ILIKE findMany ran.
      expect(prisma.dataTraining.findMany).toHaveBeenCalledTimes(1);
    });

    it('recall: duplicate cosine hits and ILIKE overlap dedupe by id', async () => {
      const c = row({ id: 3, question: 'sem', datasource: 10 });
      const a = row({ id: 1, question: 'q1', datasource: 10 });
      embedding.embed.mockResolvedValue([0.5]);
      // same id twice above the threshold → cosine loop dedupes.
      vector.search.mockReturnValue([
        { id: 3, distance: 0.25 },
        { id: 3, distance: 0.3 },
      ]);
      prisma.dataTraining.findMany
        .mockResolvedValueOnce([c, a]) // ILIKE: c overlaps the cosine hit
        .mockResolvedValueOnce([c]); // cosine id fetch
      const svc = makeService(prisma, vector, embedding);
      const result = await withUser(1, () => svc.recall('q', 10, 5));
      expect(result.map((r) => r.id)).toEqual([3, 1]);
    });

    it('upsert: a missing question is treated as empty → 400', async () => {
      const svc = makeService(prisma, vector, embedding);
      await expect(withUser(1, () => svc.upsert({}))).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.dataTraining.create).not.toHaveBeenCalled();
    });

    it('exportAll: null description + unresolved names export as empty cells', async () => {
      // 'abc' is a non-numeric advancedApplication → skipped by the id set,
      // so no assistant lookup happens at all.
      prisma.dataTraining.findMany.mockResolvedValue([
        row({
          id: 1,
          question: 'bare',
          description: null,
          datasource: 999,
          advancedApplication: 'abc',
        }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      const svc = makeService(prisma, vector, embedding);
      const buf = await withUser(1, () => svc.exportAll());
      const wb = new ExcelJS.Workbook();
      type LoadParam = Parameters<(typeof wb.xlsx)['load']>[0];
      await wb.xlsx.load(buf as unknown as LoadParam);
      const ws = wb.getWorksheet('data_training');
      expect(cellText(ws!.getCell(2, 1).value)).toBe('bare');
      expect(cellText(ws!.getCell(2, 2).value)).toBe(''); // null description
      expect(cellText(ws!.getCell(2, 3).value)).toBe(''); // unknown ds id
      expect(cellText(ws!.getCell(2, 4).value)).toBe(''); // non-numeric adv id
    });

    it('importExcel: blank-question rows are skipped; unresolved adv name → null', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('data_training');
      ws.addRow(['问题表述', '示例SQL', '生效数据源', '高级应用']);
      ws.addRow(['q1', '', '', '']);
      ws.addRow(['', 'SELECT 9', '', '']); // blank question → skipped
      ws.addRow(['q2', '', '', 'ghostAdv']); // adv name resolves to nothing
      const buf = Buffer.from(await wb.xlsx.writeBuffer());
      embedding.available = false;
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.dataTraining.create.mockImplementation(
        (args: { data: Partial<DataTraining> }) =>
          Promise.resolve(row({ id: 1, question: args.data.question ?? 'q' })),
      );
      const svc = makeService(prisma, vector, embedding);
      const res = await withUser(1, () => svc.importExcel(buf));
      expect(res.original_count).toBe(2); // blank row counted neither way
      expect(res.success_count).toBe(2);
      // unresolved adv name silently becomes null (import never fails on it).
      expect(
        prisma.dataTraining.create.mock.calls[1][0].data.advancedApplication,
      ).toBeNull();
    });
  });
});
