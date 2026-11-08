// CustomPromptService unit tests: oid-scoped per-type CRUD (snake_case wire
// shape) + the POST-body list-filter contract ({ name?, ds_list?,
// adv_list? }) + Excel
// export/template (light — full importExcel coverage via e2e, mirroring
// terminology spec). Prisma mocked; the workspace oid comes from running
// calls inside the real RequestContext AsyncLocalStorage.
import { requestContextStorage } from '../common/context/request-context';
import { CustomPromptService } from './custom-prompt.service';
import type { CustomPrompt } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  customPrompt: {
    create: jest.Mock;
    update: jest.Mock;
    deleteMany: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
  };
  datasource: { findMany: jest.Mock; count: jest.Mock };
  assistant: { findMany: jest.Mock };
};

function makeService(prisma: MockPrisma) {
  return new CustomPromptService(
    prisma as unknown as never,
    {
      write: jest.fn().mockResolvedValue('custom-prompt_x_error.xlsx'),
    } as never,
  );
}

function cp(
  partial: Partial<CustomPrompt> & { id: number; type: string },
): CustomPrompt {
  return {
    oid: 1,
    name: 'prompt',
    prompt: 'SELECT 1',
    specificDs: false,
    datasourceIds: null,
    advancedApplication: null,
    createTime: new Date('2026-07-26T00:00:00Z'),
    updatedAt: new Date('2026-07-26T00:00:00Z'),
    ...partial,
  };
}

function makePrisma(): MockPrisma {
  return {
    customPrompt: {
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    datasource: {
      findMany: jest.fn(),
      // Referenced datasource ids resolve in the current workspace.
      count: jest
        .fn()
        .mockImplementation((args: { where: { id: { in: number[] } } }) =>
          Promise.resolve(args.where.id.in.length),
        ),
    },
    assistant: { findMany: jest.fn() },
  };
}

// ────────────────────────────── service ──────────────────────────────

describe('CustomPromptService', () => {
  beforeEach(() => setI18n(createTestI18n()));
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  // --- page -----------------------------------------------------------

  describe('page', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('filters by oid + type, paginates, builds maps, returns full pager shape', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          name: 'a',
          specificDs: false,
          datasourceIds: [],
          advancedApplication: '10',
        }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([{ id: 1, name: 'orders' }]);
      prisma.assistant.findMany.mockResolvedValue([
        { id: 10, name: 'Adv App' },
      ]);
      const out = await withUser(1, () =>
        makeService(prisma).page('GENERATE_SQL', 1, 10, { name: 'a' }),
      );
      expect(prisma.customPrompt.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          type: 'GENERATE_SQL',
          OR: [
            { name: { contains: 'a', mode: 'insensitive' } },
            { prompt: { contains: 'a', mode: 'insensitive' } },
          ],
        },
        orderBy: { createTime: 'desc' },
      });
      expect(out.current_page).toBe(1);
      expect(out.page_size).toBe(10);
      expect(out.total_count).toBe(1);
      expect(out.total_pages).toBe(1);
      expect(out.data).toHaveLength(1);
      expect(out.data[0]).toEqual(
        expect.objectContaining({
          id: 1,
          name: 'a',
          advanced_application: 10,
          advanced_application_name: 'Adv App',
        }),
      );
    });

    it('in-memory dsIds post-filter: specific_ds=false matches; specific_ds=true intersect matches; non-intersect dropped', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: false,
          datasourceIds: [],
        }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
        }),
        cp({
          id: 3,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [7],
        }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      // body { name: 'foo', ds_list: [5] } → keyword 'foo', dsIds [5]
      const out = await withUser(1, () =>
        makeService(prisma).page('GENERATE_SQL', 1, 10, {
          name: 'foo',
          ds_list: [5],
        }),
      );
      expect(prisma.customPrompt.findMany.mock.calls[0][0].where.OR).toEqual([
        { name: { contains: 'foo', mode: 'insensitive' } },
        { prompt: { contains: 'foo', mode: 'insensitive' } },
      ]);
      expect(out.total_count).toBe(2); // row 1 (specificDs=false) + row 2 ([5]∩[5])
      expect(out.data.map((d) => d.id)).toEqual([1, 2]);
    });

    it('adv_list post-filter: advancedApplication ∈ adv_list, AND-combined with ds_list', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({ id: 1, type: 'GENERATE_SQL', advancedApplication: '7' }),
        cp({ id: 2, type: 'GENERATE_SQL', advancedApplication: '8' }),
        cp({ id: 3, type: 'GENERATE_SQL', advancedApplication: null }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      const out = await withUser(1, () =>
        makeService(prisma).page('GENERATE_SQL', 1, 10, { adv_list: [7] }),
      );
      expect(out.total_count).toBe(1);
      expect(out.data.map((d) => d.id)).toEqual([1]);
    });

    it('pagination slices the filtered set (page 2 of 2-per-page, total_pages=3)', async () => {
      const rows: CustomPrompt[] = [];
      for (let i = 1; i <= 5; i++) {
        rows.push(cp({ id: i, type: 'GENERATE_SQL', name: `n${i}` }));
      }
      prisma.customPrompt.findMany.mockResolvedValue(rows);
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      const out = await withUser(1, () =>
        makeService(prisma).page('GENERATE_SQL', 2, 2),
      );
      expect(out.current_page).toBe(2);
      expect(out.page_size).toBe(2);
      expect(out.total_count).toBe(5);
      expect(out.total_pages).toBe(3); // ceil(5/2)
      expect(out.data.map((d) => d.id)).toEqual([3, 4]); // slice(2,4)
    });

    it('no keyword → no OR clause; ds_list-only body filters to dsIds', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
        }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'orders' }]);
      prisma.assistant.findMany.mockResolvedValue([]);
      // body { ds_list: [5] } → keyword '', dsIds [5]
      const out = await withUser(1, () =>
        makeService(prisma).page('GENERATE_SQL', 1, 10, { ds_list: [5] }),
      );
      expect(prisma.customPrompt.findMany.mock.calls[0][0].where).toEqual({
        oid: 1,
        type: 'GENERATE_SQL',
      }); // no OR (no keyword)
      expect(out.total_count).toBe(1); // row matches dsIds [5]
    });
  });

  // --- upsert ---------------------------------------------------------

  describe('upsert', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('create (no id): validates name, generates oid-scoped row, stringifies advanced_application', async () => {
      prisma.customPrompt.create.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL', name: 'new' }),
      );
      const out = await withUser(1, () =>
        makeService(prisma).upsert({
          type: 'GENERATE_SQL',
          name: 'new',
          prompt: 'SELECT 1',
          specific_ds: true,
          datasource_ids: [5],
          advanced_application: 10,
        }),
      );
      expect(out.id).toBe(9);
      const arg = prisma.customPrompt.create.mock.calls[0][0].data;
      expect(arg.oid).toBe(1);
      expect(arg.type).toBe('GENERATE_SQL');
      expect(arg.name).toBe('new');
      expect(arg.prompt).toBe('SELECT 1');
      expect(arg.specificDs).toBe(true);
      expect(arg.datasourceIds).toEqual([5]);
      expect(arg.advancedApplication).toBe('10'); // stringified
    });

    it('update (with id): ownership check, updates fields, returns row', async () => {
      prisma.customPrompt.findFirst.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL', name: 'old' }),
      );
      prisma.customPrompt.update.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL', name: 'new' }),
      );
      const out = await withUser(1, () =>
        makeService(prisma).upsert({
          id: 9,
          type: 'GENERATE_SQL',
          name: 'new',
          prompt: 'SELECT 2',
        }),
      );
      expect(out.name).toBe('new');
      expect(prisma.customPrompt.findFirst).toHaveBeenCalledWith({
        where: { id: 9, oid: 1 },
      });
      const arg = prisma.customPrompt.update.mock.calls[0][0];
      expect(arg.where).toEqual({ id: 9 });
      expect(arg.data.name).toBe('new');
      expect(arg.data.prompt).toBe('SELECT 2');
    });

    it('throws BadRequest when name is empty', async () => {
      await expect(
        withUser(1, () =>
          makeService(prisma).upsert({ type: 'GENERATE_SQL', name: '' }),
        ),
      ).rejects.toThrow(/不能为空/);
      expect(prisma.customPrompt.create).not.toHaveBeenCalled();
    });

    it('throws NotFound when id does not match oid (ownership)', async () => {
      prisma.customPrompt.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () =>
          makeService(prisma).upsert({
            id: 999,
            type: 'GENERATE_SQL',
            name: 'x',
          }),
        ),
      ).rejects.toThrow(/不存在/);
      expect(prisma.customPrompt.update).not.toHaveBeenCalled();
    });
  });

  // --- remove ---------------------------------------------------------

  describe('remove', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('batch deleteMany oid-scoped, returns [{id}] for @SystemLog callback', async () => {
      const out = await withUser(1, () =>
        makeService(prisma).remove([1, 2, 3]),
      );
      expect(out).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
      expect(prisma.customPrompt.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [1, 2, 3] }, oid: 1 },
      });
    });

    it('empty array → [] (no-op, no deleteMany call)', async () => {
      const out = await withUser(1, () => makeService(prisma).remove([]));
      expect(out).toEqual([]);
      expect(prisma.customPrompt.deleteMany).not.toHaveBeenCalled();
    });
  });

  // --- Excel (light — full importExcel coverage via e2e) --------------

  describe('exportAll + getTemplate (light)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('exportAll returns a Buffer', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      prisma.datasource.findMany.mockResolvedValue([]);
      prisma.assistant.findMany.mockResolvedValue([]);
      const buf = await withUser(1, () =>
        makeService(prisma).exportAll('GENERATE_SQL'),
      );
      expect(Buffer.isBuffer(buf)).toBe(true);
    });

    it('getTemplate returns a Buffer', async () => {
      const buf = await makeService(prisma).getTemplate();
      expect(Buffer.isBuffer(buf)).toBe(true);
    });
  });

  // --- runtime matching (findCustomPrompts) ----------------------------
  // Matching semantics: (type, oid) broad query + JS
  // post-filter — ds branch (specificDs=false OR datasourceIds∋dsId) vs
  // assistant branch (advancedApplication=String(assistantId), dsId
  // ignored — assistant runs set no datasource). Returns
  // {customPromptText, promptList} — text is the concatenated prompt bodies
  // (flows into the NL2SQL system prompt); promptList is the raw rows
  // (log-only, surfaces in the messages column).

  describe('findCustomPrompts (§110 runtime matching)', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('returns empty text + empty list when no prompts match', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
      );
      expect(res.customPromptText).toBe('');
      expect(res.promptList).toEqual([]);
    });

    it('matches a global prompt (specificDs=false applies to any ds)', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: false,
          datasourceIds: null,
          prompt: 'be concise',
        }),
      ]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
      );
      expect(res.customPromptText).toBe('be concise');
      expect(res.promptList).toHaveLength(1);
    });

    it('matches a ds-specific prompt when datasourceIds includes dsId', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5, 6],
          prompt: 'use aliases',
        }),
      ]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
      );
      expect(res.customPromptText).toBe('use aliases');
    });

    it('excludes a ds-specific prompt when datasourceIds omits dsId', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 3,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [7, 8],
          prompt: 'use aliases',
        }),
      ]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
      );
      expect(res.customPromptText).toBe('');
      expect(res.promptList).toEqual([]);
    });

    it('matches an assistant prompt (advancedApplication=String(assistantId)) and ignores dsId', async () => {
      // dsId=5 not in datasourceIds:[99], but assistantId=7 → assistant
      // branch matches advancedApplication:'7' regardless of ds.
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 4,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [99],
          advancedApplication: '7',
          prompt: 'assistant rule',
        }),
      ]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
        7,
      );
      expect(res.customPromptText).toBe('assistant rule');
    });

    it('ds+assistant priority: assistant branch wins when assistantId given (ds prompts ignored)', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: false,
          datasourceIds: null,
          prompt: 'global ds prompt',
        }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
          prompt: 'ds-specific prompt',
        }),
        cp({
          id: 3,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [99],
          advancedApplication: '7',
          prompt: 'assistant prompt',
        }),
      ]);
      // assistantId=7 → only the advancedApplication:'7' prompt matches.
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
        7,
      );
      expect(res.customPromptText).toBe('assistant prompt');
      expect(res.promptList).toHaveLength(1);
    });

    it('concatenates multiple matched prompts in DB order, joined by a blank line', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: false,
          datasourceIds: null,
          prompt: 'first',
        }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
          prompt: 'second',
        }),
      ]);
      const res = await makeService(prisma).findCustomPrompts(
        'GENERATE_SQL',
        1,
        5,
      );
      expect(res.customPromptText).toBe('first\n\nsecond');
      expect(res.promptList).toHaveLength(2);
    });

    it('queries by type + oid (the where-clause contract)', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      await makeService(prisma).findCustomPrompts('ANALYSIS', 3, 5);
      expect(prisma.customPrompt.findMany).toHaveBeenCalledWith({
        where: { type: 'ANALYSIS', oid: 3 },
        orderBy: { id: 'asc' },
      });
    });
  });
});
