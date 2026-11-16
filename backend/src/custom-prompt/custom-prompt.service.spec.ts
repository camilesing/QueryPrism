// CustomPromptService unit tests: oid-scoped per-type CRUD (snake_case wire
// shape) + the POST-body list-filter contract ({ name?, ds_list?,
// adv_list? }) + Excel
// export/template (light — full importExcel coverage via e2e, mirroring
// terminology spec). Prisma mocked; the workspace oid comes from running
// calls inside the real RequestContext AsyncLocalStorage.
import { requestContextStorage } from '../common/context/request-context';
import { CustomPromptService } from './custom-prompt.service';
import { Prisma, type CustomPrompt } from '@prisma/client';
import ExcelJS from 'exceljs';
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

// ─────────────────────────────────────────────────────────────────────────
// Extended coverage (appended): upsert validation arms (workspace-ds check,
// defaults, JsonNull), page clamping + strict id parsing, export/template
// cell contents (round-tripped through ExcelJS), the full importExcel
// matrix (corrupt file, missing sheet, validation failures, natural-key
// upsert, flag parsing, worksheet fallback), the no-workspace guard, and
// the remaining findCustomPrompts matching arms.
// ─────────────────────────────────────────────────────────────────────────

describe('CustomPromptService — extended', () => {
  let prisma: MockPrisma;
  let importWrite: jest.Mock;

  beforeEach(() => setI18n(createTestI18n()));
  beforeEach(() => {
    prisma = makePrisma();
    importWrite = jest.fn().mockResolvedValue('custom-prompt_x_error.xlsx');
    // Sane defaults for the name-map builders (individual tests override).
    prisma.datasource.findMany.mockResolvedValue([]);
    prisma.assistant.findMany.mockResolvedValue([]);
    prisma.customPrompt.findMany.mockResolvedValue([]);
  });

  function svc() {
    return new CustomPromptService(
      prisma as unknown as never,
      { write: importWrite } as never,
    );
  }

  /** Build an xlsx upload buffer (header + the given data rows). */
  async function xlsx(
    rows: (string | number | null)[][],
    sheetName = 'custom_prompt',
  ): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(['Prompt name', 'Prompt content', 'ds?', 'Datasource', 'Adv']);
    for (const r of rows) ws.addRow(r);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Load a produced buffer and return every row as 5 string columns. */
  async function readXlsx(buf: Buffer): Promise<(string | null)[][]> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const ws = wb.getWorksheet('custom_prompt');
    expect(ws).toBeDefined();
    const out: (string | null)[][] = [];
    ws!.eachRow((row) => {
      out.push(
        [1, 2, 3, 4, 5].map((c) => {
          const v = row.getCell(c).value as string | number | boolean | null;
          return v == null ? null : String(v);
        }),
      );
    });
    return out;
  }

  // --- upsert validation arms ------------------------------------------

  describe('upsert (extended)', () => {
    it('rejects datasource ids that do not exist in the current workspace', async () => {
      prisma.datasource.count.mockResolvedValue(0);
      await expect(
        withUser(1, () =>
          svc().upsert({
            type: 'GENERATE_SQL',
            name: 'x',
            specific_ds: true,
            datasource_ids: [5],
          }),
        ),
      ).rejects.toThrow(/数据源不存在/);
      expect(prisma.customPrompt.create).not.toHaveBeenCalled();
    });

    it('dedupes datasource_ids before the workspace validation', async () => {
      prisma.customPrompt.create.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL' }),
      );
      await withUser(1, () =>
        svc().upsert({
          type: 'GENERATE_SQL',
          name: 'x',
          datasource_ids: [5, 5, 7],
        }),
      );
      expect(prisma.datasource.count).toHaveBeenCalledWith({
        where: { id: { in: [5, 7] }, oid: 1 },
      });
      expect(
        prisma.customPrompt.create.mock.calls[0][0].data.datasourceIds,
      ).toEqual([5, 7]);
    });

    it('create defaults: blank prompt → null, specific_ds omitted → false, no adv app → null, no ids → JsonNull', async () => {
      prisma.customPrompt.create.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL' }),
      );
      await withUser(1, () =>
        svc().upsert({
          type: 'GENERATE_SQL',
          name: '  padded  ',
          prompt: '   ',
        }),
      );
      const data = prisma.customPrompt.create.mock.calls[0][0].data;
      expect(data.name).toBe('padded');
      expect(data.prompt).toBeNull();
      expect(data.specificDs).toBe(false);
      expect(data.advancedApplication).toBeNull();
      expect(data.datasourceIds).toBe(Prisma.JsonNull);
    });

    it('update path persists JsonNull when datasource_ids is emptied', async () => {
      prisma.customPrompt.findFirst.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL' }),
      );
      prisma.customPrompt.update.mockResolvedValue(
        cp({ id: 9, type: 'GENERATE_SQL' }),
      );
      await withUser(1, () =>
        svc().upsert({
          id: 9,
          type: 'GENERATE_SQL',
          name: 'x',
          datasource_ids: [],
        }),
      );
      expect(
        prisma.customPrompt.update.mock.calls[0][0].data.datasourceIds,
      ).toBe(Prisma.JsonNull);
    });

    it('a whitespace-only name is rejected (trim guard)', async () => {
      await expect(
        withUser(1, () => svc().upsert({ type: 'GENERATE_SQL', name: '   ' })),
      ).rejects.toThrow(/不能为空/);
      expect(prisma.customPrompt.create).not.toHaveBeenCalled();
    });
  });

  // --- page clamping + strict filter parsing ----------------------------

  describe('page (extended)', () => {
    function fiveRows(): CustomPrompt[] {
      const rows: CustomPrompt[] = [];
      for (let i = 1; i <= 5; i++) {
        rows.push(cp({ id: i, type: 'GENERATE_SQL', name: `n${i}` }));
      }
      return rows;
    }

    it('clamps currentPage <= 0 to 1 and pageSize to at least 1', async () => {
      prisma.customPrompt.findMany.mockResolvedValue(fiveRows());
      const out = await withUser(1, () => svc().page('GENERATE_SQL', 0, 0));
      expect(out.current_page).toBe(1);
      expect(out.page_size).toBe(1);
      expect(out.data.map((d) => d.id)).toEqual([1]);
    });

    it('clamps a page request beyond total_pages onto the last page', async () => {
      prisma.customPrompt.findMany.mockResolvedValue(fiveRows());
      const out = await withUser(1, () => svc().page('GENERATE_SQL', 99, 2));
      expect(out.total_pages).toBe(3);
      expect(out.current_page).toBe(3);
      expect(out.data.map((d) => d.id)).toEqual([5]);
    });

    it('empty result → total_pages 0, current_page 1, data []', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const out = await withUser(1, () => svc().page('GENERATE_SQL', 4, 10));
      expect(out).toEqual({
        current_page: 1,
        page_size: 10,
        total_count: 0,
        total_pages: 0,
        data: [],
      });
    });

    it('a whitespace-only keyword produces no OR clause', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      await withUser(1, () =>
        svc().page('GENERATE_SQL', 1, 10, { name: '   ' }),
      );
      expect(prisma.customPrompt.findMany.mock.calls[0][0].where).toEqual({
        oid: 1,
        type: 'GENERATE_SQL',
      });
    });

    it('ds_list entries are strictly parsed: numeric strings kept, junk dropped', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
        }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [6],
        }),
        cp({
          id: 3,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [7],
        }),
      ]);
      // '5' parses; 'x'/null/1.5 are dropped; 6 passes through.
      const out = await withUser(1, () =>
        svc().page('GENERATE_SQL', 1, 10, {
          ds_list: ['5', 'x', null, 1.5, 6] as never,
        }),
      );
      expect(out.total_count).toBe(2);
      expect(out.data.map((d) => d.id)).toEqual([1, 2]);
    });
  });

  // --- export/template cell contents ------------------------------------

  describe('exportAll + getTemplate (extended)', () => {
    it('exportAll honors the name keyword in the query (OR clause)', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      await withUser(1, () =>
        svc().exportAll('GENERATE_SQL', { name: 'kw', ds_list: ['5'] }),
      );
      expect(prisma.customPrompt.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          type: 'GENERATE_SQL',
          OR: [
            { name: { contains: 'kw', mode: 'insensitive' } },
            { prompt: { contains: 'kw', mode: 'insensitive' } },
          ],
        },
        orderBy: { createTime: 'desc' },
      });
    });

    it('writes one row per filtered prompt with Y/N flags and resolved names', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          name: 'scoped',
          prompt: 'p1',
          specificDs: true,
          datasourceIds: [5, 6],
          advancedApplication: '9',
        }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          name: 'global',
          prompt: null,
          specificDs: false,
        }),
      ]);
      prisma.datasource.findMany.mockResolvedValue([
        { id: 5, name: 'dsA' },
        { id: 6, name: 'dsB' },
      ]);
      prisma.assistant.findMany.mockResolvedValue([{ id: 9, name: 'Adv' }]);
      const rows = await readXlsx(
        await withUser(1, () => svc().exportAll('GENERATE_SQL')),
      );
      // Headers localize to the caller's profile language (zh-CN user here).
      expect(rows).toEqual([
        [
          '提示词名称',
          '提示词内容',
          '是否限定数据源',
          '生效数据源',
          '高级应用',
        ],
        ['scoped', 'p1', 'Y', 'dsA, dsB', 'Adv'],
        ['global', '', 'N', '', ''],
      ]);
    });

    it('getTemplate carries the 5 headers + the English example row', async () => {
      const rows = await readXlsx(await svc().getTemplate());
      expect(rows).toEqual([
        [
          'Prompt name',
          'Prompt content',
          '是否限定数据源',
          'Datasource',
          'Advanced application',
        ],
        [
          'Example SQL prompt',
          'Generate a SQL query for the user question: {{question}}',
          'N',
          '',
          '',
        ],
      ]);
    });
  });

  // --- importExcel (the full matrix) ------------------------------------

  describe('importExcel', () => {
    it('rejects a corrupt upload with an actionable BadRequest', async () => {
      await expect(
        withUser(1, () =>
          svc().importExcel('GENERATE_SQL', Buffer.from('not a zip file')),
        ),
      ).rejects.toThrow(/Excel 文件解析失败/);
    });

    it('a workbook with no worksheet → the zero summary', async () => {
      const wb = new ExcelJS.Workbook();
      const empty = Buffer.from(await wb.xlsx.writeBuffer());
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', empty),
      );
      expect(out).toEqual({
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      });
    });

    it('imports a valid row: resolves ds names + advanced app, creates with ids', async () => {
      prisma.datasource.findMany.mockResolvedValue([
        { id: 5, name: 'dsA' },
        { id: 6, name: 'dsB' },
      ]);
      prisma.assistant.findMany.mockResolvedValue([{ id: 9, name: 'Adv' }]);
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([['imp1', 'p1', 'Y', 'dsA, dsB', 'Adv']]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out).toEqual({
        success_count: 1,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 1,
        error_excel_filename: null,
      });
      expect(prisma.customPrompt.create).toHaveBeenCalledTimes(1);
      const data = prisma.customPrompt.create.mock.calls[0][0].data;
      expect(data.oid).toBe(1);
      expect(data.type).toBe('GENERATE_SQL'); // from the path segment
      expect(data.name).toBe('imp1');
      expect(data.specificDs).toBe(true);
      expect(data.datasourceIds).toEqual([5, 6]);
      expect(data.advancedApplication).toBe('9');
      expect(importWrite).not.toHaveBeenCalled();
    });

    it('re-importing an existing name takes the update path and counts a duplicate', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([{ id: 3, name: 'imp1' }]);
      prisma.customPrompt.findFirst.mockResolvedValue(
        cp({ id: 3, type: 'GENERATE_SQL', name: 'imp1' }),
      );
      prisma.customPrompt.update.mockResolvedValue(
        cp({ id: 3, type: 'GENERATE_SQL' }),
      );
      const upload = await xlsx([['imp1', 'p1', 'N', '', '']]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out.success_count).toBe(1);
      expect(out.duplicate_count).toBe(1);
      expect(out.failed_count).toBe(0);
      expect(prisma.customPrompt.update).toHaveBeenCalledTimes(1);
      expect(prisma.customPrompt.update.mock.calls[0][0].where).toEqual({
        id: 3,
      });
      expect(
        prisma.customPrompt.update.mock.calls[0][0].data.datasourceIds,
      ).toBe(Prisma.JsonNull);
    });

    it('fails a row whose datasource name is unknown and writes the error file', async () => {
      prisma.datasource.findMany.mockResolvedValue([{ id: 5, name: 'dsA' }]);
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([['bad', 'p', 'Y', 'nope', '']]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out.success_count).toBe(0);
      expect(out.failed_count).toBe(1);
      expect(out.original_count).toBe(1);
      expect(out.error_excel_filename).toBe('custom-prompt_x_error.xlsx');
      expect(prisma.customPrompt.create).not.toHaveBeenCalled();
      expect(importWrite).toHaveBeenCalledTimes(1);
      expect(importWrite).toHaveBeenCalledWith({
        prefix: 'custom-prompt',
        headers: ['名称', '提示词', '指定数据源', '数据源', '高级应用'],
        rows: [['bad', 'p', 'Y', 'nope', '']],
        messages: [expect.stringContaining('nope')],
      });
    });

    it('fails a row whose advanced application name is unknown', async () => {
      prisma.assistant.findMany.mockResolvedValue([]);
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([['adv', 'p', 'N', '', 'Ghost App']]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out.failed_count).toBe(1);
      expect(out.success_count).toBe(0);
      expect(importWrite.mock.calls[0][0].messages[0]).toContain('Ghost App');
      expect(importWrite.mock.calls[0][0].messages[0]).toContain('高级应用');
    });

    it('resolves advanced_application even when specific_ds is false (P2-4 round-trip)', async () => {
      prisma.assistant.findMany.mockResolvedValue([{ id: 9, name: 'Adv' }]);
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([['adv', 'p', 'N', '', 'Adv']]);
      await withUser(1, () => svc().importExcel('GENERATE_SQL', upload));
      expect(
        prisma.customPrompt.create.mock.calls[0][0].data.advancedApplication,
      ).toBe('9');
    });

    it('skips blank-name rows entirely (counted neither way)', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([
        ['', 'ghost', 'N', '', ''],
        ['ok', 'p', 'N', '', ''],
      ]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out.original_count).toBe(1);
      expect(out.success_count).toBe(1);
      expect(out.failed_count).toBe(0);
    });

    it('specific_ds flags parse case-insensitively; non-specific rows ignore ds names', async () => {
      prisma.datasource.findMany.mockResolvedValue([]); // nothing resolvable
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([
        ['a', 'p', 'yes', 'whatever', ''],
        ['b', 'p', 'TRUE', 'whatever', ''],
        ['c', 'p', 'N', 'whatever', ''],
      ]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      // a + b are specific_ds → unresolvable 'whatever' → failures;
      // c is not specific → names ignored → success.
      expect(out.success_count).toBe(1);
      expect(out.failed_count).toBe(2);
      expect(prisma.customPrompt.create).toHaveBeenCalledTimes(1);
      expect(prisma.customPrompt.create.mock.calls[0][0].data.name).toBe('c');
    });

    it('falls back to the first worksheet when none is named custom_prompt', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([]);
      const upload = await xlsx([['fb', 'p', 'N', '', '']], 'Sheet1');
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out.success_count).toBe(1);
      expect(out.original_count).toBe(1);
    });

    it('an all-blank sheet skips the existing-name lookup entirely', async () => {
      const upload = await xlsx([['', '', '', '', '']]);
      const out = await withUser(1, () =>
        svc().importExcel('GENERATE_SQL', upload),
      );
      expect(out).toEqual({
        success_count: 0,
        failed_count: 0,
        duplicate_count: 0,
        original_count: 0,
        error_excel_filename: null,
      });
      // records.length === 0 → no customPrompt.findMany preload query
      expect(prisma.customPrompt.findMany).not.toHaveBeenCalled();
    });
  });

  // --- workspace guard ----------------------------------------------------

  describe('currentOid guard', () => {
    it('throws Unauthorized outside a request context (no resolvable workspace)', async () => {
      await expect(svc().page('GENERATE_SQL', 1, 10)).rejects.toThrow(
        /Cannot determine the current workspace/,
      );
      await expect(
        svc().upsert({ type: 'GENERATE_SQL', name: 'x' }),
      ).rejects.toThrow(/Cannot determine the current workspace/);
      await expect(svc().exportAll('GENERATE_SQL')).rejects.toThrow(
        /Cannot determine the current workspace/,
      );
    });
  });

  // --- findCustomPrompts remaining arms -----------------------------------

  describe('findCustomPrompts (extended)', () => {
    it('without a dsId, ds-specific prompts never match', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({ id: 1, type: 'GENERATE_SQL', specificDs: false, prompt: 'g' }),
        cp({
          id: 2,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: [5],
          prompt: 's',
        }),
      ]);
      const res = await svc().findCustomPrompts('GENERATE_SQL', 1);
      expect(res.customPromptText).toBe('g');
      expect(res.promptList.map((p) => p.id)).toEqual([1]);
    });

    it('a non-array datasourceIds JSON value is treated as no match', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({
          id: 1,
          type: 'GENERATE_SQL',
          specificDs: true,
          datasourceIds: { '5': 5 },
          prompt: 's',
        }),
      ]);
      const res = await svc().findCustomPrompts('GENERATE_SQL', 1, 5);
      expect(res.customPromptText).toBe('');
      expect(res.promptList).toEqual([]);
    });

    it('blank/null prompt bodies are dropped from the text but stay in promptList', async () => {
      prisma.customPrompt.findMany.mockResolvedValue([
        cp({ id: 1, type: 'GENERATE_SQL', specificDs: false, prompt: null }),
        cp({ id: 2, type: 'GENERATE_SQL', specificDs: false, prompt: '   ' }),
        cp({ id: 3, type: 'GENERATE_SQL', specificDs: false, prompt: 'real' }),
      ]);
      const res = await svc().findCustomPrompts('GENERATE_SQL', 1);
      expect(res.customPromptText).toBe('real');
      expect(res.promptList).toHaveLength(3);
    });
  });

  // --- remove guard -------------------------------------------------------

  describe('remove (extended)', () => {
    it('a non-array body is a no-op returning []', async () => {
      const out = await withUser(1, () => svc().remove(undefined as never));
      expect(out).toEqual([]);
      expect(prisma.customPrompt.deleteMany).not.toHaveBeenCalled();
    });
  });
});
