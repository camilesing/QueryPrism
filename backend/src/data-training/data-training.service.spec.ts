// DataTrainingService unit tests.
// Covers the CRUD (upsert create-branch / remove batch) + the
// live chat-DI recall() (kept verbatim — ai-question.service injects this
// service) + the exceljs export/template/import round-trip with the
// 4-column set (no enabled) + import-result shape.
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { requestContextStorage } from '../common/context/request-context';
import { DataTrainingService } from './data-training.service';
import type { DataTraining } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

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

function makeService(
  prisma: MockPrisma,
  vector: MockVector,
  embedding: MockEmbedding,
) {
  return new DataTrainingService(
    prisma as unknown as never,
    vector as unknown as never,
    embedding as unknown as never,
    {
      write: jest.fn().mockResolvedValue('data-training_x_error.xlsx'),
    } as never,
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
});
