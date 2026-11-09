// ChatService spec — verifies the Phase 5 SSE pipeline orchestration. The
// three LLM generators are faked as async-iterables (`asyncFrom`,
// to dodge `require-await` on empty async generators); DatasourceService /
// PrismaService are jest.Mocks. Assertions cover BOTH the yielded SSE event
// sequence AND the ChatRecord/ChatLog persistence side-effects.
// Every call runs inside requestContextStorage.run(...) so currentOid resolves.
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatService } from './chat.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { PrismaService } from '../database/prisma.service';
import { DatasourceService } from '../datasource/datasource.service';
import { AiQuestionService } from '../llm/ai-question.service';
import { GeneratorService, type LlmGenEvent } from '../llm/generator.service';
import { SqlSafetyService } from './sql-safety.service';
import { RowPermissionService } from '../permission/row-permission.service';
import { AuditService } from '../audit/audit.service';
import { OperationModule, OperationType } from '../audit/operation.enum';
import {
  requestContextStorage,
  type RequestContextData,
} from '../common/context/request-context';
import type { ChatSseEvent } from './chat-sse-event';

// --- async-iterable helper (object form: no `async function*` so ESLint's
//     require-await stays quiet) -------------------------------------------
function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: () =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false as const, value: items[i++] }),
      };
    },
  };
}

async function collect(
  gen: AsyncGenerator<ChatSseEvent>,
): Promise<ChatSseEvent[]> {
  const out: ChatSseEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** Run `fn` inside a request context for the given workspace oid. */
function run<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    {
      user: { id: 1, account: 'tester', oid, language: 'zh-CN' },
    } satisfies RequestContextData,
    fn,
  );
}

/** Mock shapes — every referenced method is redeclared as `jest.Mock` so
 *  expect(...).toHaveBeenCalledWith / .mockResolvedValue stay typed. (jest.
 *  Mocked<T> is shallow and leaves real method types that trip unbound-method
 *  when referenced — this explicit Omit+redeclare is the codebase pattern, see
 *  ai-question.service.spec.ts.) Plain object mocks (prisma, generatorService,
 *  sqlSafety, audit, config) are left to infer — their jest.fn() members are
 *  already jest.Mock, so the matcher APIs work without a named type. */
type DatasourceServiceMock = Omit<
  DatasourceService,
  'findAll' | 'findOne' | 'execSql' | 'recallTables'
> & {
  findAll: jest.Mock;
  findOne: jest.Mock;
  execSql: jest.Mock;
  recallTables: jest.Mock;
};

type AiQuestionServiceMock = Omit<
  AiQuestionService,
  | 'buildSqlContext'
  | 'buildForResult'
  | 'buildForSelectDatasource'
  | 'buildFilterContext'
  | 'buildForKeywords'
> & {
  buildSqlContext: jest.Mock;
  buildForResult: jest.Mock;
  buildForSelectDatasource: jest.Mock;
  buildFilterContext: jest.Mock;
  buildForKeywords: jest.Mock;
};

type RowPermissionServiceMock = Omit<
  RowPermissionService,
  'isNormalUser' | 'getRowFilters'
> & {
  isNormalUser: jest.Mock;
  getRowFilters: jest.Mock;
};

function makeService() {
  const prisma = {
    // Interactive transactions run the callback against this same mock, so
    // tx.* calls are asserted through the normal chat/chatRecord mocks.
    $transaction: jest.fn(),
    chat: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
    chatRecord: {
      create: jest.fn(),
      update: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    chatLog: { create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    dsRecommendedProblem: { findMany: jest.fn() },
    // 9e6070e8 task snapshots: no saved embedding.* rows → env defaults
    systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (client: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );

  const datasourceService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    execSql: jest.fn(),
    recallTables: jest.fn(),
  } as unknown as DatasourceServiceMock;

  const aiQuestionService = {
    buildSqlContext: jest.fn(),
    buildForResult: jest.fn(),
    buildForSelectDatasource: jest.fn(),
    buildFilterContext: jest.fn(),
    buildForKeywords: jest.fn().mockReturnValue({}),
  } as unknown as AiQuestionServiceMock;

  const generatorService = {
    selectDatasource: jest.fn(),
    generateSql: jest.fn(),
    generateChart: jest.fn(),
    generateAnalysis: jest.fn(),
    generatePredict: jest.fn(),
    generateGuessQuestion: jest.fn(),
    generateFilter: jest.fn(),
    extractKeywords: jest.fn(),
  };

  // 3fd6fa86: identity expansion by default — per-test overrides simulate
  // synonym groups.
  const terminologyService = {
    expandWithTerminology: jest.fn((k: string) => Promise.resolve(k)),
  };

  // RowPermissionService — isNormalUser defaults false so the happy-path
  // admin (test user id=1) bypasses the filter step (getRowFilters never
  // called). Per-test overrides flip isNormalUser→true + seed getRowFilters.
  const rowPermissionService = {
    isNormalUser: jest.fn(() => false),
    getRowFilters: jest.fn().mockResolvedValue([]),
  } as unknown as RowPermissionServiceMock;

  const sqlSafety = {
    validate: jest.fn(),
    extractTableNames: jest.fn().mockReturnValue([]),
  };
  const audit = {
    record: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'chat.chatLimit') return 20;
      if (key === 'chat.limitRows') return 500;
      if (key === 'chat.historyRounds') return 3;
      return undefined;
    }),
  };

  const service = new ChatService(
    prisma as unknown as PrismaService,
    datasourceService as unknown as DatasourceService,
    aiQuestionService as unknown as AiQuestionService,
    generatorService as unknown as GeneratorService,
    sqlSafety as unknown as SqlSafetyService,
    rowPermissionService as unknown as RowPermissionService,
    terminologyService as never,
    // MetaDataImprove M2: no effective semantics by default (empty maps →
    // rule 2 never narrows; individual tests override per-case).
    {
      effectiveAnnotations: jest
        .fn()
        .mockResolvedValue({ tableMeanings: {}, fieldNotes: {} }),
    } as never,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
  );
  return {
    service,
    prisma,
    datasourceService,
    aiQuestionService,
    generatorService,
    terminologyService,
    rowPermissionService,
    sqlSafety,
    audit,
    config,
  };
}

/** Wire every mock to the happy-path (chat already has a sqlite datasource). */
function happyMocks(m: ReturnType<typeof makeService>) {
  m.prisma.chat.findFirst.mockResolvedValue({
    id: 1,
    oid: 1,
    datasourceId: 1,
    engineType: null,
    title: '新对话',
    origin: 0,
    // Pre-cached so the fire-and-forget generateAndCacheGuessQuestions no-ops
    // (deterministic: it won't call chat.update for recommendedQuestion).
    recommendedQuestion: ['已缓存推荐'],
  });
  m.prisma.chat.update.mockResolvedValue({ id: 1 });
  m.prisma.chatRecord.create.mockResolvedValue({
    id: 100,
    chatId: 1,
    oid: 1,
    question: '查询所有用户',
    datasourceId: 1,
  });
  m.prisma.chatRecord.update.mockResolvedValue({ id: 100 });
  m.prisma.chatRecord.findMany.mockResolvedValue([]); // no prior history
  m.prisma.chatLog.create.mockResolvedValue({ id: 1 });
  m.prisma.chatLog.update.mockResolvedValue({ id: 1 });
  // Record-level crash bulk-update path.
  m.prisma.chatLog.updateMany.mockResolvedValue({ count: 0 });
  m.datasourceService.findOne.mockResolvedValue({
    id: 1,
    name: 'main',
    type: 'sqlite',
    tables: [{ id: 1, tableName: 'users', checked: true, fields: [] }],
  });
  m.datasourceService.recallTables.mockResolvedValue([]); // → tableIds undefined
  m.aiQuestionService.buildSqlContext.mockResolvedValue({ engine: 'SQLite' });
  m.aiQuestionService.buildForResult.mockResolvedValue({ engine: 'SQLite' });
  m.generatorService.generateSql.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'reasoning', delta: 'thinking' },
      {
        type: 'result',
        data: {
          success: true,
          sql: 'SELECT * FROM users',
          tables: ['users'],
          chartType: 'bar',
          brief: '查询用户列表',
        },
      },
    ]),
  );
  m.sqlSafety.validate.mockReturnValue({ ok: true, tables: ['users'] });
  m.datasourceService.execSql.mockResolvedValue({
    columns: ['id', 'name'],
    rows: [[1, '张三']],
  });
  // 3fd6fa86: the keyword-extraction pre-step streams a plain-text answer
  // (comma-separated keywords; never JSON).
  m.generatorService.extractKeywords.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'messages', messages: [] },
      { type: 'content', delta: '用户,订单' },
      { type: 'result', data: { keywords: '用户,订单' } },
    ]),
  );
  m.generatorService.generateChart.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'reasoning', delta: 'charting' },
      {
        type: 'result',
        data: {
          chartType: 'bar',
          config: { xField: 'id', yField: 'name' },
        },
      },
    ]),
  );
  // Phase 5b generators (used by analysis/predict/guess; seeded here so any
  // fire-and-forget guess call resolves instead of throwing on an unmocked fn).
  m.generatorService.generateAnalysis.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'reasoning', delta: '分析中' },
      { type: 'content', delta: '这是分析' },
      { type: 'result', data: { analysis: '这是分析' } },
    ]),
  );
  m.generatorService.generatePredict.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'reasoning', delta: '预测中' },
      {
        type: 'result',
        data: { predict: '上升趋势', predictData: [{ label: 'x', value: 1 }] },
      },
    ]),
  );
  m.generatorService.generateGuessQuestion.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      { type: 'result', data: { questions: ['推荐1'] } },
    ]),
  );
  // generateFilter default — admin bypass means it's never called on
  // the happy path, but seed it so an unmocked filter test doesn't throw.
  m.generatorService.generateFilter.mockReturnValue(
    asyncFrom<LlmGenEvent>([
      {
        type: 'result',
        data: { success: true, sql: 'SELECT * FROM users WHERE 1=1' },
      },
    ]),
  );
  m.aiQuestionService.buildFilterContext.mockResolvedValue({
    engine: 'SQLite',
  });
  // extractTableNames returns the SQL's tables (happy path: users).
  m.sqlSafety.extractTableNames.mockReturnValue(['users']);
  m.prisma.dsRecommendedProblem.findMany.mockResolvedValue([
    { id: 1, question: '示例问题' },
  ]);
}

const types = (events: ChatSseEvent[]) => events.map((e) => e.type).join(',');

describe('ChatService pipeline (runPipeline / regenerate)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  // --- 3fd6fa86 keyword-extraction pre-step wiring -------------------------
  it('extracts keywords → expands via terminology → persists → recalls with them', async () => {
    const m = makeService();
    happyMocks(m);
    m.terminologyService.expandWithTerminology.mockResolvedValue(
      '用户,订单,会员',
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    // extraction logged + keywords persisted on the record
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operate: 'EXTRACT_KEYWORDS' }),
      }),
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        extractedKeywords: '用户,订单',
        expandedKeywords: '用户,订单,会员',
      },
    });
    // expansion ran with the workspace oid
    expect(m.terminologyService.expandWithTerminology).toHaveBeenCalledWith(
      '用户,订单',
      1,
    );
    // the fused recall received the EXPANDED keywords + a config snapshot
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询所有用户',
      expect.objectContaining({ keywords: '用户,订单,会员' }),
    );
  });

  it('EMPTY extraction degrades to raw-question recall (no persistence)', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: [] },
        { type: 'content', delta: 'EMPTY' },
        { type: 'result', data: { keywords: 'EMPTY' } },
      ]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    expect(m.terminologyService.expandWithTerminology).not.toHaveBeenCalled();
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询所有用户',
      expect.objectContaining({ keywords: null }),
    );
  });

  it('a keyword-extraction failure never breaks the pipeline', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockImplementation(() => {
      throw new Error('LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );
    // the turn still completes end-to-end
    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询所有用户',
      expect.objectContaining({ keywords: null }),
    );
  });

  it('skips the extraction step when keywordEnabled is off', async () => {
    const m = makeService();
    happyMocks(m);
    // saved parameter row: keyword_enabled=false (env default is true)
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'embedding.keyword_enabled', value: 'false' },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    expect(m.generatorService.extractKeywords).not.toHaveBeenCalled();
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询所有用户',
      expect.objectContaining({ keywords: null }),
    );
  });

  it('runs the full closed-loop pipeline (chat with datasource)', async () => {
    const m = makeService();
    happyMocks(m);
    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );

    expect(types(events)).toBe(
      'id,question,datasource,info,sql-result,sql,brief,info,sql-data,info,chart-result,chart,finish',
    );
    // The live `chart` frame carries the chart object as a JSON string
    // (same shape as record.chart) — the frontend JSON.parse()s it directly.
    expect(events.find((e) => e.type === 'chart')!.data).toEqual({
      content: JSON.stringify({
        type: 'bar',
        title: '',
        axis: {
          x: { name: 'id', value: 'id' },
          y: [{ name: 'name', value: 'name' }],
        },
      }),
    });
    // record created up-front (exact — impl passes only chatId/oid/question)
    expect(m.prisma.chatRecord.create).toHaveBeenCalledWith({
      data: { chatId: 1, oid: 1, createBy: 1, question: '查询所有用户' },
    });
    // sql + brief persisted
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        sql: 'SELECT * FROM users',
        sqlAnswer: '查询用户列表',
        brief: '查询用户列表',
        chartType: 'bar',
      },
    });
    // exec result persisted (sqlExecResult + data both carry the query result)
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        sqlExecResult: { columns: ['id', 'name'], rows: [[1, '张三']] },
        data: { columns: ['id', 'name'], rows: [[1, '张三']] },
      },
    });
    // chart persisted as a chart object (the shape the Vue frontend
    // parses from record.chart / the SSE chart event)
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        chart: {
          type: 'bar',
          title: '',
          axis: {
            x: { name: 'id', value: 'id' },
            y: [{ name: 'name', value: 'name' }],
          },
        },
        chartType: 'bar',
        chartAnswer: '{"xField":"id","yField":"name"}',
      },
    });
    // finish (success → error cleared)
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: null },
    });
    // Two-phase lifecycle: start INSERT (operate + error:false +
    // startedAt, NO reasoning/endedAt) then end UPDATE (reasoning + endedAt).
    // +1 EXTRACT_KEYWORDS pre-step row.
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(3);
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatRecordId: 100,
          operate: 'GENERATE_SQL',
          error: false,
          localOperation: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatRecordId: 100,
          operate: 'GENERATE_CHART',
          error: false,
          localOperation: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(3);
    // sql endLog carries the operate override (GENERATE_SQL — no filter ran
    // on the admin happy path) + the accumulated reasoning + endedAt.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          reasoningContent: 'thinking',
          operate: 'GENERATE_SQL',
          endedAt: expect.any(Date),
        }),
      }),
    );
    // chart endLog has no operate override (chart step never changes tag).
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          reasoningContent: 'charting',
          endedAt: expect.any(Date),
        }),
      }),
    );
    // engine bound onto the chat (engineType was null)
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { datasourceId: 1, engineType: 'SQLite' },
    });
    // title adopted from brief (still default "新对话")
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: '查询用户列表', brief: '查询用户列表' },
    });
    // audit (fire-and-forget, success)
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        module: OperationModule.CHAT,
        type: OperationType.CREATE,
        status: 'success',
      }),
    );
    // sql-data payload (no inline columns/rows — frontend GETs the data)
    expect(events.find((e) => e.type === 'sql-data')!.data).toEqual({
      content: 'execute-success',
    });
  });

  it('runs select_datasource when the chat has no bound datasource', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      engineType: null,
      title: '新对话',
      origin: 0,
    });
    m.datasourceService.findAll.mockResolvedValue([
      { id: 2, name: 'ds2', description: null, type: 'sqlite' },
    ]);
    m.aiQuestionService.buildForSelectDatasource.mockReturnValue({
      engine: 'MySQL',
    });
    m.generatorService.selectDatasource.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'reasoning', delta: 'picking' },
        { type: 'result', data: { datasourceId: 2 } },
      ]),
    );
    m.datasourceService.findOne.mockResolvedValue({
      id: 2,
      name: 'ds2',
      type: 'sqlite',
      tables: [{ id: 5, tableName: 'orders', checked: true, fields: [] }],
    });
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'reasoning', delta: 'thinking' },
        {
          type: 'result',
          data: {
            success: true,
            sql: 'SELECT * FROM orders',
            tables: ['orders'],
            chartType: 'table',
            brief: '查询订单',
          },
        },
      ]),
    );
    m.sqlSafety.validate.mockReturnValue({ ok: true, tables: ['orders'] });
    m.datasourceService.execSql.mockResolvedValue({
      columns: ['id'],
      rows: [[1]],
    });
    m.generatorService.generateChart.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: { chartType: 'table', config: { type: 'table' } },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询订单')),
    );

    expect(types(events)).toBe(
      'id,question,info,datasource-result,datasource,info,sql-result,sql,brief,info,sql-data,info,chart,finish',
    );
    // select_datasource options built from findAll (null description →
    // undefined); lang detected from the han question text
    expect(m.aiQuestionService.buildForSelectDatasource).toHaveBeenCalledWith({
      question: '查询订单',
      datasources: [{ id: 2, name: 'ds2', description: undefined }],
      lang: 'zh-CN',
    });
    // chosen datasource + engine bound onto chat
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { datasourceId: 2, engineType: 'SQLite' },
    });
    expect(events.find((e) => e.type === 'datasource')!.data).toEqual({
      id: 2,
      datasource_name: 'ds2',
      engine_type: 'SQLite',
    });
    // CHOOSE_DATASOURCE log tagged + local-op=false (LLM step)
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'CHOOSE_DATASOURCE',
          error: false,
          localOperation: false,
        }),
      }),
    );
  });

  it('stops at a SQL safety violation (no exec / no chart)', async () => {
    const m = makeService();
    happyMocks(m);
    m.sqlSafety.validate.mockReturnValue({
      ok: false,
      tables: [],
      reason: '表 secrets 不在允许的白名单内',
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查秘密')),
    );

    expect(types(events)).toBe(
      'id,question,datasource,info,sql-result,sql,brief,error,finish',
    );
    expect(m.datasourceService.execSql).not.toHaveBeenCalled();
    expect(m.generatorService.generateChart).not.toHaveBeenCalled();
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '表 secrets 不在允许的白名单内',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: '表 secrets 不在允许的白名单内' },
    });
    // The started row (create, error=false) is marked failed via
    // triggerLogError (update, error=true + operate + endedAt) on check_sql
    // failure.
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'GENERATE_SQL',
          error: false,
          localOperation: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL',
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('stops at a SQL exec error (no chart)', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.execSql.mockRejectedValue(
      new Error('connection refused'),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe(
      'id,question,datasource,info,sql-result,sql,brief,info,error,finish',
    );
    expect(m.generatorService.generateChart).not.toHaveBeenCalled();
    const msg = events.find((e) => e.type === 'error')!.data.content;
    expect(msg).toContain('SQL 执行失败');
    expect(msg).toContain('connection refused');
    // SQL-exec failure → startLog (create, error=false) then
    // triggerLogError (update, error=true + operate + endedAt).
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'GENERATE_SQL',
          error: false,
          localOperation: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL',
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('errors when generateSql returns no result event', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'reasoning', delta: 'thinking' }]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe(
      'id,question,datasource,info,sql-result,error,finish',
    );
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 生成未返回结果',
    );
    expect(m.sqlSafety.validate).not.toHaveBeenCalled();
    // SQL-gen failure → startLog (create, error=false) then
    // triggerLogError (update, error=true + operate + endedAt).
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'GENERATE_SQL',
          error: false,
          localOperation: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL',
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('threads recalled tableIds into buildSqlContext when recall hits', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 7, tableName: 'users', checked: true },
      { id: 9, tableName: 'orders', checked: true },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: [7, 9] }),
    );
    // buildForResult gets the same narrowed schema
    expect(m.aiQuestionService.buildForResult).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: [7, 9] }),
    );
  });

  // MetaDataImprove M3: the relation editor's X6 cells resolve into FK edges
  // (M3.1) and a ≤2-hop bridge table joins the stuffed schema (M3.2) so the
  // LLM can write users←orders→products joins without hallucinating.
  it('stuffs the ≤2-hop bridge table connecting two recalled tables', async () => {
    const m = makeService();
    happyMocks(m);
    const now = new Date();
    // users(7) / products(8) / orders(9); orders is the only connector.
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      // Raw graph.toJSON().cells as TableRelationship.vue saves them.
      tableRelation: [
        {
          id: 9,
          shape: 'er-rect',
          attrs: { label: { text: 'orders' } },
          ports: {
            items: [
              { id: 91, attrs: { portNameLabel: { text: 'user_id' } } },
              { id: 92, attrs: { portNameLabel: { text: 'product_id' } } },
            ],
          },
        },
        {
          id: 7,
          shape: 'er-rect',
          attrs: { label: { text: 'users' } },
          ports: {
            items: [{ id: 71, attrs: { portNameLabel: { text: 'id' } } }],
          },
        },
        {
          id: 8,
          shape: 'er-rect',
          attrs: { label: { text: 'products' } },
          ports: {
            items: [{ id: 81, attrs: { portNameLabel: { text: 'id' } } }],
          },
        },
        {
          id: 'e1',
          shape: 'edge',
          source: { cell: 9, port: 91 },
          target: { cell: 7, port: 71 },
        },
        {
          id: 'e2',
          shape: 'edge',
          source: { cell: 9, port: 92 },
          target: { cell: 8, port: 81 },
        },
      ],
      tables: [
        {
          id: 7,
          tableName: 'users',
          checked: true,
          fields: [{ id: 71, fieldName: 'id', checked: true }],
        },
        {
          id: 8,
          tableName: 'products',
          checked: true,
          fields: [{ id: 81, fieldName: 'id', checked: true }],
        },
        {
          id: 9,
          tableName: 'orders',
          checked: true,
          fields: [
            { id: 91, fieldName: 'user_id', checked: true },
            { id: 92, fieldName: 'product_id', checked: true },
          ],
        },
      ],
      createdAt: now,
    });
    // Recall surfaced only the two end tables.
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 7, tableName: 'users', checked: true },
      { id: 8, tableName: 'products', checked: true },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询用户和商品')));

    // Bridge id 9 appended after the recalled pair.
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: [7, 8, 9] }),
    );
  });

  it('clarify options include the bridge connecting two pool candidates', async () => {
    const m = makeService();
    happyMocks(m);
    const now = new Date();
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [
        {
          fromTable: 'orders',
          fromField: 'user_id',
          toTable: 'users',
          toField: 'id',
        },
        {
          fromTable: 'orders',
          fromField: 'product_id',
          toTable: 'products',
          toField: 'id',
        },
      ],
      tables: [
        {
          id: 1,
          tableName: 'users',
          customComment: null,
          tableComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 2,
          tableName: 'products',
          customComment: null,
          tableComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 3,
          tableName: 'orders',
          customComment: null,
          tableComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 4,
          tableName: 'payments',
          customComment: null,
          tableComment: null,
          checked: true,
          fields: [],
        },
      ],
      createdAt: now,
    });
    // 3 candidates, none explicitly mentioned → the M1 gate fires.
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'products', checked: true },
      { id: 4, tableName: 'payments', checked: true },
    ]);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '统计一下数量')),
    );

    const clarify = events.find((e) => e.type === 'clarify');
    expect(clarify).toBeDefined();
    // orders joins the pickable options beyond the recall pool
    const names = clarify!.data.candidates.map(
      (c: { table_name: string }) => c.table_name,
    );
    expect(names).toContain('orders');
    expect(m.aiQuestionService.buildSqlContext).not.toHaveBeenCalled();
  });

  it('regenerate creates a new record linked back to the source', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '用户查询',
      origin: 0,
      recommendedQuestion: ['已缓存推荐'],
    });
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });
    m.prisma.chatRecord.create.mockResolvedValue({
      id: 101,
      chatId: 1,
      oid: 1,
      question: '查询所有用户',
      datasourceId: 1,
    });

    const events = await run(1, () =>
      collect(m.service.regenerate(1, 50, undefined)),
    );

    expect(types(events)).toBe(
      'id,regenerate_record_id,question,datasource,info,sql-result,sql,brief,info,sql-data,info,chart-result,chart,finish',
    );
    expect(m.prisma.chatRecord.create).toHaveBeenCalledWith({
      data: {
        chatId: 1,
        oid: 1,
        createBy: 1,
        question: '查询所有用户',
        regenerateRecordId: 50,
      },
    });
    // engine already bound → no re-bind update; title already custom → no title update
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the chat is missing / wrong oid', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.runPipeline(1, '查询'))),
    ).rejects.toThrow(NotFoundException);
  });
});

// Reply language follows the question text (detect-language): every context
// builder receives the detected lang and the SSE info/error frames come from
// chat-messages in that language. The test user's profile is zh-CN (run),
// so an English question proves detection overrides the profile.
describe('ChatService reply language follows the question', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('an English question threads lang=en through every builder + English info frames', async () => {
    const m = makeService();
    happyMocks(m);
    const events = await run(1, () =>
      collect(m.service.runPipeline(1, 'Show all users')),
    );

    // All status frames are English for the whole turn.
    const infos = events
      .filter((e) => e.type === 'info')
      .map((e) => e.data.msg);
    expect(infos).toEqual([
      'Generating SQL',
      'Executing SQL',
      'Generating chart',
    ]);
    expect(m.aiQuestionService.buildForKeywords).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en' }),
    );
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en' }),
    );
    expect(m.aiQuestionService.buildForResult).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en' }),
    );
  });

  it('a Chinese question keeps zh-CN frames (profile default, no regression)', async () => {
    const m = makeService();
    happyMocks(m);
    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );

    const infos = events
      .filter((e) => e.type === 'info')
      .map((e) => e.data.msg);
    expect(infos).toEqual(['正在生成SQL', '正在执行SQL', '正在生成图表']);
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'zh-CN' }),
    );
  });

  it('error frames follow the question language too', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'reasoning', delta: 'thinking' }]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, 'Show all users')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL generation returned no result',
    );
  });

  it('a Japanese question falls back to the profile language', async () => {
    const m = makeService();
    happyMocks(m);
    await run(1, () => collect(m.service.runPipeline(1, '売上を教えて')));

    // Kana is not zh/en → fallback = profile language (zh-CN for this user).
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'zh-CN' }),
    );
  });

  it('runAnalysis follows the source question language', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ question: 'Show all users' }),
    );

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    const infos = events
      .filter((e) => e.type === 'info')
      .map((e) => e.data.msg);
    expect(infos).toEqual(['Generating analysis']);
    expect(m.aiQuestionService.buildForResult).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en', customPromptType: 'ANALYSIS' }),
    );
  });
});

describe('ChatService CRUD (oid-scoped)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('start creates a chat + first_chat record and enforces the cap', async () => {
    const m = makeService();
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
    });
    m.prisma.chat.create.mockResolvedValue({ id: 5, oid: 1, title: '新对话' });
    m.prisma.chatRecord.create.mockResolvedValue({
      id: 51,
      chatId: 5,
      oid: 1,
      question: '',
      firstChat: true,
      finish: true,
    });
    m.prisma.chat.count.mockResolvedValue(1);

    const chat = await run(1, () => m.service.start({ datasourceId: 1 }));

    expect(m.prisma.chat.create).toHaveBeenCalledWith({
      data: {
        oid: 1,
        createBy: 1,
        datasourceId: 1,
        engineType: 'SQLite',
        title: '新对话',
        brief: '新对话',
        origin: 0,
      },
    });
    // create_chat seeds a finished first_chat record so the frontend
    // shows the input box on a brand-new chat.
    expect(m.prisma.chatRecord.create).toHaveBeenCalledWith({
      data: {
        chatId: 5,
        oid: 1,
        createBy: 1,
        question: '',
        firstChat: true,
        finish: true,
      },
    });
    expect(chat.id).toBe(5);
    expect(chat.records).toHaveLength(1);
    expect(chat.datasource?.name).toBe('main');
    expect(m.prisma.chat.count).toHaveBeenCalledWith({
      where: { oid: 1, createBy: 1 },
    });
  });

  it('start without a datasource creates no placeholder record', async () => {
    const m = makeService();
    m.prisma.chat.create.mockResolvedValue({ id: 6, oid: 1 });
    m.prisma.chat.count.mockResolvedValue(1);

    const chat = await run(1, () => m.service.start());

    expect(m.datasourceService.findOne).not.toHaveBeenCalled();
    expect(m.prisma.chatRecord.create).not.toHaveBeenCalled();
    expect(chat.records).toEqual([]);
    expect(chat.datasource).toBeNull();
  });

  it('findAll is oid-scoped and sorts by the newest record time', async () => {
    const m = makeService();
    const ts = (s: string) => new Date(s);
    m.prisma.chat.findMany.mockResolvedValue([
      { id: 1, createdAt: ts('2026-01-01'), records: [] },
      {
        id: 2,
        createdAt: ts('2026-01-02'),
        records: [{ createdAt: ts('2026-03-01') }],
      },
      {
        id: 3,
        createdAt: ts('2026-02-01'),
        records: [{ createdAt: ts('2026-02-15') }],
      },
    ]);

    const res = await run(1, () => m.service.findAll());

    // e58d1822: fetch-all (no SQL orderBy) then JS-sort by coalesce(newest
    // record time, chat create_time) desc.
    expect(m.prisma.chat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          oid: 1,
          OR: [{ createBy: 1 }, { createBy: null }],
        },
        include: expect.objectContaining({
          records: { take: 1, orderBy: { createdAt: 'desc' } },
        }),
      }),
    );
    expect(res.map((c: { id: number }) => c.id)).toEqual([2, 3, 1]);
  });

  it('findOne 404s on a wrong oid', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue(null);

    await expect(run(2, () => m.service.findOne(1))).rejects.toThrow(
      NotFoundException,
    );
    expect(m.prisma.chat.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 1,
          oid: 2,
          OR: [{ createBy: 1 }, { createBy: null }],
        },
      }),
    );
  });

  it('getWithData includes each record logs (excluding recommend-questions)', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({ id: 1 });

    await run(1, () => m.service.getWithData(1));

    expect(m.prisma.chat.findFirst).toHaveBeenCalledWith({
      where: {
        id: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        datasource: { include: { tables: { include: { fields: true } } } },
        records: {
          orderBy: { createdAt: 'asc' },
          include: {
            logs: {
              where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
            },
          },
        },
      },
    });
  });

  it('rename updates the title', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({ id: 1, oid: 1, title: 'old' });
    m.prisma.chat.update.mockResolvedValue({ id: 1, title: 'new' });

    const chat = await run(1, () => m.service.rename(1, 'new'));

    expect(chat.title).toBe('new');
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: 'new' },
    });
  });

  it('remove deletes the chat', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({ id: 1, oid: 1 });
    m.prisma.chat.delete.mockResolvedValue({ id: 1 });

    const res = await run(1, () => m.service.remove(1));

    expect(res).toEqual({ success: true });
    expect(m.prisma.chat.delete).toHaveBeenCalledWith({ where: { id: 1 } });
  });
});

/** A finished source record with SQL + result, used by the 5b analysis/predict
 *  pipelines and the record-read endpoints. */
function sourceRecord(extra: Record<string, unknown> = {}) {
  return {
    id: 100,
    chatId: 1,
    oid: 1,
    question: '查询所有用户',
    sql: 'SELECT * FROM users',
    sqlExecResult: { columns: ['id', 'name'], rows: [[1, '张三']] },
    ...extra,
  };
}

describe('ChatService Phase 5b (analysis / predict / quick-cmd / reads)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('runAnalysis streams analysis + persists in-place on the source record', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(types(events)).toBe(
      'id,info,analysis-result,analysis-result,analysis_finish',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { analysis: '这是分析' },
    });
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(1);
    // ANALYSIS operate tag + error=false (startLog INSERT)
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'ANALYSIS',
          error: false,
          localOperation: false,
        }),
      }),
    );
    // endLog UPDATE writes the accumulated reasoning + endedAt.
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          reasoningContent: '分析中',
          endedAt: expect.any(Date),
        }),
      }),
    );
    expect(m.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ detail: '生成分析' }),
    );
  });

  it('runPredict streams predict + persists predict/predictData in-place', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toBe(
      'id,info,predict-result,predict-success,predict_finish',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        predict: '上升趋势',
        predictData: [{ label: 'x', value: 1 }],
      },
    });
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(1);
    // PREDICT_DATA operate tag + error=false (startLog INSERT)
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'PREDICT_DATA',
          error: false,
          localOperation: false,
        }),
      }),
    );
    // endLog UPDATE writes the accumulated reasoning + endedAt.
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          reasoningContent: '预测中',
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('runAnalysis fails when the record has no SQL result', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sql: null, sqlExecResult: null }),
    );

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(types(events)).toBe('id,error,analysis_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '该记录缺少SQL执行结果，无法分析',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: '该记录缺少SQL执行结果，无法分析' },
    });
  });

  it('runAnalysis 404s on a missing record', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.runAnalysis(1, 999))),
    ).rejects.toThrow(NotFoundException);
  });

  it('quick-cmd /analysis <rid> dispatches to runAnalysis', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '/analysis 100')),
    );
    expect(types(events)).toBe(
      'id,info,analysis-result,analysis-result,analysis_finish',
    );
  });

  it('quick-cmd /regenerate <rid> dispatches to regenerate', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '/regenerate 50')),
    );
    expect(types(events)).toBe(
      'id,regenerate_record_id,question,datasource,info,sql-result,sql,brief,info,sql-data,info,chart-result,chart,finish',
    );
  });

  it('quick-cmd /predict <rid> dispatches to runPredict', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '/predict 100')),
    );
    expect(types(events)).toBe(
      'id,info,predict-result,predict-success,predict_finish',
    );
  });

  it('quick-cmd without a rid yields an error + finish (no record created)', async () => {
    const m = makeService();
    happyMocks(m);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '/analysis')),
    );
    expect(types(events)).toBe('error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '请指定记录ID，如 /analysis 100',
    );
    expect(m.prisma.chatRecord.create).not.toHaveBeenCalled();
  });

  it('a plain question still runs the normal pipeline (not dispatched)', async () => {
    const m = makeService();
    happyMocks(m);
    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );
    // Normal pipeline yields sql, proving the quick-cmd branch was skipped.
    expect(types(events)).toContain('sql');
    expect(m.prisma.chatRecord.create).toHaveBeenCalledWith({
      data: { chatId: 1, oid: 1, createBy: 1, question: '查询所有用户' },
    });
  });

  it('getRecordData returns the persisted query result', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const data = await run(1, () => m.service.getRecordData(1, 100));

    // Wire shape — {fields, fields_info, data}
    // where data is an array of row objects. fields_info is null (MCB's
    // connector lacks per-column type info; the chart renderer guards it).
    expect(data).toEqual({
      fields: ['id', 'name'],
      fields_info: null,
      data: [{ id: 1, name: '张三' }],
    });
    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        id: 100,
        chatId: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
    });
  });

  it('getRecordDataLive re-runs execSql against the live DB', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
    });
    m.datasourceService.execSql.mockResolvedValue({
      columns: ['id'],
      rows: [[1], [2]],
    });

    const data = await run(1, () => m.service.getRecordDataLive(1, 100));

    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM users',
    );
    // Wire shape — no `sql` field, data as
    // array of row objects.
    expect(data).toEqual({
      fields: ['id'],
      fields_info: null,
      data: [{ id: 1 }, { id: 2 }],
    });
  });

  it('getRecordDataLive 400s when the record has no SQL', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sql: null }),
    );
    await expect(
      run(1, () => m.service.getRecordDataLive(1, 100)),
    ).rejects.toThrow(BadRequestException);
  });

  it('getPredictData returns the persisted predict payload', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ predictData: [{ label: 'x', value: 9 }] }),
    );
    const data = await run(1, () => m.service.getPredictData(1, 100));
    expect(data).toEqual([{ label: 'x', value: 9 }]);
  });

  it('getRecordLogs maps each ChatLog row', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z');
    const endedAt = new Date('2026-01-01T00:00:05Z');
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      logs: [
        {
          id: 1,
          messages: null,
          reasoningContent: '思考',
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          startedAt,
          endedAt,
        },
      ],
    });

    const logs = await run(1, () => m.service.getRecordLogs(1, 100));

    expect(logs).toEqual([
      {
        id: 1,
        messages: null,
        reasoningContent: '思考',
        tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        startedAt,
        endedAt,
      },
    ]);
  });

  it('getRecordUsage returns the ChatLogHistory shape with steps:[]', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T00:00:05Z');
    const t2 = new Date('2026-01-01T00:00:10Z');
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      createdAt: t0,
      updatedAt: t2,
      logs: [
        {
          startedAt: t0,
          endedAt: t1,
          tokenUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        },
        {
          startedAt: t1,
          endedAt: t2,
          tokenUsage: {
            promptTokens: 20,
            completionTokens: 5,
            totalTokens: 25,
          },
        },
        // Last step still running (endedAt null) + no tokenUsage: contributes
        // neither to duration nor total_tokens; finish_time is null because the
        // last log's endedAt is null.
        { startedAt: t2, endedAt: null, tokenUsage: null },
      ],
    });

    const usage = await run(1, () => m.service.getRecordUsage(1, 100));

    // Usage wire shape: aggregates still computed; steps is [].
    expect(usage).toEqual({
      start_time: t0.toISOString(),
      finish_time: null,
      duration: 10, // (t1-t0) + (t2-t1) = 5 + 5; last step skipped (no endedAt)
      total_tokens: 40, // 15 + 25; last step skipped (no tokenUsage)
      steps: [],
    });
  });

  it('getRecentQuestions dedupes + caps', async () => {
    const m = makeService();
    m.prisma.chatRecord.findMany.mockResolvedValue([
      { question: 'q1' },
      { question: 'q2' },
      { question: 'q1' },
      { question: '' },
    ]);

    const res = await run(1, () => m.service.getRecentQuestions());

    expect(res).toEqual({ questions: ['q1', 'q2'] });
    expect(m.prisma.chatRecord.findMany).toHaveBeenCalledWith({
      where: {
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { question: true },
    });
  });

  it('getRecommendQuestions merges cached LLM questions + seeded problems', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      recommendedQuestion: ['缓存推荐'],
    });
    m.prisma.dsRecommendedProblem.findMany.mockResolvedValue([
      { id: 7, question: '示例问题' },
    ]);

    const res = await run(1, () => m.service.getRecommendQuestions(1));

    expect(res).toEqual({
      questions: ['缓存推荐'],
      recommended: [{ id: 7, question: '示例问题' }],
    });
  });

  it('exportRecordExcel returns an xlsx Buffer for a given record', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const buf = await run(1, () => m.service.exportRecordExcel(1, 100));

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('exportRecordExcel 400s when the record has no data', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sqlExecResult: null }),
    );
    await expect(
      run(1, () => m.service.exportRecordExcel(1, 100)),
    ).rejects.toThrow(BadRequestException);
  });
});

// runRecommendQuestions LIVE LLM stream (replaces the MVP
// cache-read stub): forward
// reasoning/content deltas as `recommended_question_result`, capture the
// parsed GuessResult, persist Chat.recommendedQuestion, emit one terminal
// `recommended_question` (content = JSON.stringify(string[])), then finish.
// articles_number truncates the result post-generation (safety net; the
// template also gets a {articles_number} placeholder).
describe('ChatService Phase 10e §79 (runRecommendQuestions live LLM stream)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  // Record found: returns {chatId, question} for the rid (datasourceId lives
  // on the Chat, not the ChatRecord — see schema).
  function recordFound() {
    return { chatId: 1, question: '查询所有用户' };
  }

  it('streams recommended_question_result deltas + terminal recommended_question + persists', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(recordFound());
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'reasoning', delta: '推测中' },
        { type: 'content', delta: '["q1"' },
        { type: 'content', delta: ',"q2"]' },
        { type: 'result', data: { questions: ['q1', 'q2'] } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe(
      'recommended_question_result,recommended_question_result,recommended_question_result,recommended_question,finish',
    );
    // Delta frames forward reasoning_content + content (mirrors analysis-result).
    expect(events[0].data).toEqual({ reasoning_content: '推测中' });
    expect(events[1].data).toEqual({ content: '["q1"' });
    expect(events[2].data).toEqual({ content: ',"q2"]' });
    // Terminal: content is a JSON-array string starting [ and ending ].
    expect(events[3].data).toEqual({ content: '["q1","q2"]' });
    // Persisted onto Chat.recommendedQuestion (string[]).
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { recommendedQuestion: ['q1', 'q2'] },
    });
  });

  it('emits empty terminal recommended_question when record not found', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(999)),
    );

    expect(types(events)).toBe('recommended_question,finish');
    expect(events[0].data).toEqual({ content: '[]' });
    expect(m.generatorService.generateGuessQuestion).not.toHaveBeenCalled();
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('emits error + finish on LLM exception (no terminal recommended_question)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(recordFound());
    m.generatorService.generateGuessQuestion.mockImplementation(() => {
      throw new Error('LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe('error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'LLM down',
    );
    // No terminal recommended_question on error.
    expect(events.some((e) => e.type === 'recommended_question')).toBe(false);
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('truncates questions to articles_number + persists the truncated array', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(recordFound());
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'result', data: { questions: ['q1', 'q2', 'q3', 'q4', 'q5'] } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100, 3)),
    );

    expect(types(events)).toBe('recommended_question,finish');
    // Truncated to the first 3 (articles_number safety net; template also gets
    // {articles_number} but LLMs aren't reliably count-accurate).
    expect(events[0].data).toEqual({ content: '["q1","q2","q3"]' });
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { recommendedQuestion: ['q1', 'q2', 'q3'] },
    });
  });
});

describe('ChatService Phase 11A §111 (runtime row-permission filter)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('non-admin + matching rule → executes the filtered SQL + tags GENERATE_SQL_WITH_PERMISSIONS', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: true,
            sql: 'SELECT * FROM `users` WHERE `age` > 18',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询成年用户')),
    );

    // The filtered SQL is what gets executed (not the original).
    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM `users` WHERE `age` > 18',
    );
    // The filtered SQL is re-yielded as the second `sql` event.
    const sqlEvents = events.filter((e) => e.type === 'sql');
    expect(sqlEvents.length).toBe(2);
    expect(sqlEvents[1].data).toEqual({
      content: 'SELECT * FROM `users` WHERE `age` > 18',
    });
    // The operate override (GENERATE_SQL → GENERATE_SQL_WITH_PERMISSIONS)
    // is written via endLog UPDATE, not the startLog INSERT. The start INSERT
    // carries the initial 'GENERATE_SQL' tag; endLog overrides it post-filter.
    const createCalls = m.prisma.chatLog.create.mock.calls as Array<
      Array<{ data: { operate?: string } }>
    >;
    const createOperates = createCalls.map((c) => c[0].data.operate);
    expect(createOperates).toContain('GENERATE_SQL'); // startLog initial tag
    const updateCalls = m.prisma.chatLog.update.mock.calls as Array<
      Array<{ data: { operate?: string } }>
    >;
    const updateOperates = updateCalls.map((c) => c[0].data.operate);
    expect(updateOperates).toContain('GENERATE_SQL_WITH_PERMISSIONS'); // endLog override
    // generateFilter was actually invoked (the filter re-gen ran).
    expect(m.generatorService.generateFilter).toHaveBeenCalled();
  });

  it('non-admin + no matching rules → executes the original SQL + tags GENERATE_SQL', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([]); // no rules

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );

    // Original SQL executed; generateFilter never called.
    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM users',
    );
    expect(m.generatorService.generateFilter).not.toHaveBeenCalled();
    // Only one `sql` event (no re-yield).
    expect(events.filter((e) => e.type === 'sql').length).toBe(1);
    // The ChatLog row is tagged GENERATE_SQL. The startLog INSERT
    // carries 'GENERATE_SQL' (no filter ran → endLog keeps the same tag).
    const createCalls = m.prisma.chatLog.create.mock.calls as Array<
      Array<{ data: { operate?: string } }>
    >;
    const createOperates = createCalls.map((c) => c[0].data.operate);
    expect(createOperates).toContain('GENERATE_SQL');
    const updateCalls = m.prisma.chatLog.update.mock.calls as Array<
      Array<{ data: { operate?: string } }>
    >;
    const updateOperates = updateCalls.map((c) => c[0].data.operate);
    expect(updateOperates).not.toContain('GENERATE_SQL_WITH_PERMISSIONS');
  });

  it('non-admin + filter success:false → fails + tags GENERATE_SQL_WITH_PERMISSIONS error', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: 'BAD_SYNTAX!!' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: { success: false, message: 'filter syntax error' },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询用户')),
    );

    // SQL execution never happens (the filter re-gen failed safely).
    expect(m.datasourceService.execSql).not.toHaveBeenCalled();
    // An error + finish event were yielded.
    expect(types(events)).toContain('error');
    expect(events.at(-1)?.type).toBe('finish');
    // The filter-fail path calls triggerLogError (UPDATE) with the
    // GENERATE_SQL_WITH_PERMISSIONS override + error=true + endedAt. The
    // startLog INSERT (create) carries the initial 'GENERATE_SQL' + error=false.
    const updateCalls = m.prisma.chatLog.update.mock.calls as Array<
      Array<{ data: { operate?: string; error?: boolean } }>
    >;
    const sqlLog = updateCalls
      .map((c) => c[0].data)
      .find((d) => d.operate === 'GENERATE_SQL_WITH_PERMISSIONS');
    expect(sqlLog).toBeDefined();
    expect(sqlLog?.error).toBe(true);
  });

  it('MCP-assistant origin (chatOrigin=1) bypasses the row-permission step', async () => {
    const m = makeService();
    happyMocks(m);
    // Chat origin 1 = MCP assistant → chatOrigin !== 1 guard short-circuits.
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: null,
      title: '新对话',
      origin: 1,
      recommendedQuestion: ['已缓存推荐'],
    });

    await run(1, () => collect(m.service.runPipeline(1, '查询用户')));

    // isNormalUser is never consulted (origin guard short-circuits first).
    expect(m.rowPermissionService.isNormalUser).not.toHaveBeenCalled();
    expect(m.rowPermissionService.getRowFilters).not.toHaveBeenCalled();
    // Original SQL executed.
    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM users',
    );
  });
});

describe('ChatService Phase 11C §115(c) (start_log/end_log lifecycle split)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('a mid-stream throw leaves a ChatLog row with error=true + endedAt (gap-c closure)', async () => {
    const m = makeService();
    happyMocks(m);
    // generateSql throws at call time (LLM down). Pre-11C the single-INSERT
    // persistLog created NO row on a mid-stream throw — the gap (c) closed
    // by the start/end split: startLog INSERTs first, the catch triggers the
    // error UPDATE, then re-throws (runPipeline's catch converts to an event).
    m.generatorService.generateSql.mockImplementation(() => {
      throw new Error('LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    // runPipeline's catch yields an error + finish (the throw is contained).
    expect(types(events)).toContain('error');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'LLM down',
    );
    // The row was INSERTed by startLog BEFORE the throw, then marked
    // failed via triggerLogError (UPDATE error=true + endedAt).
    // +1 EXTRACT_KEYWORDS pre-step row (it succeeds before the
    // generate_sql throw).
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(2);
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'GENERATE_SQL',
          error: false,
        }),
      }),
    );
    console.log('UPD', JSON.stringify(m.prisma.chatLog.update.mock.calls));
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(2);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('success path: one row per step with startedAt < endedAt (two-phase, not single INSERT)', async () => {
    const m = makeService();
    happyMocks(m);

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    // Two-phase — startLog INSERT (startedAt, no endedAt) then endLog
    // UPDATE (endedAt). The started row + its end update share the id (mock
    // returns id:1 for both); endedAt >= startedAt on the same logical row.
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(3); // extract + sql + chart
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(3);
    const createCall = m.prisma.chatLog.create.mock.calls[0][0] as {
      data: { startedAt: Date; endedAt?: Date };
    };
    const updateCall = m.prisma.chatLog.update.mock.calls[0][0] as {
      data: { endedAt: Date };
    };
    // startLog INSERT carries startedAt but NO endedAt (single-INSERT would
    // have set both at once).
    expect(createCall.data.startedAt).toBeInstanceOf(Date);
    expect(createCall.data.endedAt).toBeUndefined();
    expect(updateCall.data.endedAt).toBeInstanceOf(Date);
    expect(updateCall.data.endedAt.getTime()).toBeGreaterThanOrEqual(
      createCall.data.startedAt.getTime(),
    );
  });
});

describe('ChatService Phase 11D §115(f)/(g) (tokenUsage + messages column population)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  // Override generateSql to emit the full event set: messages-first +
  // content deltas + a final-chunk usage event. The SQL step's endLog UPDATE
  // should carry both the tokenUsage snapshot AND the post-stream messages
  // list (pre-stream snapshot + appended AI message carrying the streamed text).
  function sqlEvents(usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): LlmGenEvent[] {
    const events: LlmGenEvent[] = [
      {
        type: 'messages',
        messages: [
          {
            type: 'system',
            queryprism_system: false,
            content: 'You are QueryPrism',
          },
          {
            type: 'human',
            queryprism_system: false,
            content: 'how many users?',
          },
        ],
      },
      { type: 'content', delta: 'SELECT ' },
      { type: 'content', delta: '1' },
    ];
    if (usage) events.push({ type: 'usage', usage });
    events.push({
      type: 'result',
      data: {
        success: true,
        sql: 'SELECT 1',
        tables: [],
        chartType: 'table',
        brief: 'one',
      },
    });
    return events;
  }

  it('successful SQL step → sql endLog carries tokenUsage + appended-AI messages', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>(
        sqlEvents({ promptTokens: 12, completionTokens: 34, totalTokens: 46 }),
      ),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    // The final-chunk usage snapshot lands in the sql endLog UPDATE.
    // messages carries the pre-stream list + an appended {type:'ai'}
    // message whose content is the accumulated streamed text.
    // Distinguish the sql endLog from the chart endLog: the SQL step emitted
    // content (not reasoning) → reasoningContent is null + operate is
    // GENERATE_SQL (admin happy path → no filter re-gen).
    const sqlEndLog = m.prisma.chatLog.update.mock.calls.find((c) => {
      const d = (
        c[0] as { data: { reasoningContent?: string; operate?: string } }
      ).data;
      return d.reasoningContent === null && d.operate === 'GENERATE_SQL';
    });
    expect(sqlEndLog).toBeDefined();
    const data = (
      sqlEndLog![0] as {
        data: { tokenUsage?: unknown; messages?: unknown };
      }
    ).data;
    expect(data.tokenUsage).toEqual({
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    });
    // messages is an array ending with the AI message (accumulated content).
    expect(Array.isArray(data.messages)).toBe(true);
    expect(data.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'system', queryprism_system: false }),
        expect.objectContaining({ type: 'human', queryprism_system: false }),
        expect.objectContaining({
          type: 'ai',
          queryprism_system: false,
          content: 'SELECT 1',
        }),
      ]),
    );
    const msgs = data.messages as Array<{ type: string; content: string }>;
    expect(msgs[msgs.length - 1]).toEqual(
      expect.objectContaining({ type: 'ai', content: 'SELECT 1' }),
    );
  });

  it('no usage event → sql endLog tokenUsage undefined (step still succeeds)', async () => {
    const m = makeService();
    happyMocks(m);
    // generateSql emits messages + content + result but NO usage event (LLM
    // didn't populate usage_metadata on the final chunk).
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>(sqlEvents(/* no usage */)),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    // Step completed (finish event present — not an error path).
    expect(events.at(-1)?.type).toBe('finish');
    // No usage event → the sql endLog tokenUsage stays undefined
    // (the column is null in the DB; the UPDATE data omits the truthy value).
    const sqlEndLog = m.prisma.chatLog.update.mock.calls.find((c) => {
      const d = (
        c[0] as { data: { reasoningContent?: string; operate?: string } }
      ).data;
      return d.reasoningContent === null && d.operate === 'GENERATE_SQL';
    });
    expect(sqlEndLog).toBeDefined();
    const data = (
      sqlEndLog![0] as {
        data: { tokenUsage?: unknown };
      }
    ).data;
    expect(data.tokenUsage).toBeUndefined();
  });
});

describe('ChatService Phase 11E §115(d) save_error_message + (e) GENERATE_RECOMMENDED_QUESTIONS log', () => {
  beforeEach(() => setI18n(createTestI18n()));
  // (d) record-level crash → bulk-mark every dangling ChatLog row errored.
  // TWO UPDATEs on a record-level crash: ChatRecord {error,finish,finish_time}
  // + ChatLog {finish_time,error=true} WHERE pid=rid AND finish_time IS NULL.
  // finishRecord already does the ChatRecord UPDATE; 11E adds the ChatLog
  // bulk-update (gap-d closure).
  it('record-level crash → chatLog.updateMany marks unfinished logs errored + endedAt', async () => {
    const m = makeService();
    happyMocks(m);
    // generateSql throws at call time (LLM down) → runPipeline's catch yields
    // error+finish via the `fail` helper → finishRecord(rid, msg) → the (d)
    // bulk-update fires (error ≠ null guard). The mid-stream-thrown sqlLog row
    // already has endedAt (set by triggerLogError) so the where:endedAt:null
    // filter excludes it — the bulk-update is the safety net for any log that
    // started but never got an endLog/triggerLogError.
    m.generatorService.generateSql.mockImplementation(() => {
      throw new Error('LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'LLM down',
    );
    // bulk-update on every not-yet-finished log for the record.
    expect(m.prisma.chatLog.updateMany).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.updateMany).toHaveBeenCalledWith({
      where: { chatRecordId: 100, endedAt: null },
      data: { error: true, endedAt: expect.any(Date) },
    });
    // The ChatRecord UPDATE (the existing finishRecord body) still fires.
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: 'LLM down' },
    });
  });

  it('success path → chatLog.updateMany NOT called (error=null guard)', async () => {
    const m = makeService();
    happyMocks(m);

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    // The success path calls finishRecord(rid, null) → the bulk-update
    // is gated on error !== null (only fires on the record-crash path).
    // No dangling logs on success — every
    // step's endLog already fired.
    expect(m.prisma.chatLog.updateMany).not.toHaveBeenCalled();
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: null },
    });
  });

  // (e) runRecommendQuestions gets the 11C lifecycle (startLog/endLog/
  // triggerLogError) with operate='GENERATE_RECOMMENDED_QUESTIONS'. On
  // failure, triggerLogError fires on catch (the 11C pattern) — marks the
  // log errored at once instead of leaving it dangling.
  it('runRecommendQuestions success → 1 row operate=GENERATE_RECOMMENDED_QUESTIONS + endLog', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: '查询所有用户',
    });
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 'sys' },
            { type: 'human', queryprism_system: false, content: 'q' },
          ],
        },
        { type: 'content', delta: '["q1","q2"]' },
        {
          type: 'usage',
          usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
        },
        { type: 'result', data: { questions: ['q1', 'q2'] } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    // One ChatLog row INSERTed (startLog) with the recommend-questions tag.
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          chatRecordId: 100,
          operate: 'GENERATE_RECOMMENDED_QUESTIONS',
          error: false,
          localOperation: false,
        }),
      }),
    );
    // endLog UPDATE carries the appended-AI messages +
    // tokenUsage snapshot (reuses the 11D endLog signature).
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          tokenUsage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 },
          endedAt: expect.any(Date),
        }),
      }),
    );
    // messages: the appended-AI message is the last element.
    const endLogCall = m.prisma.chatLog.update.mock.calls[0][0] as {
      data: { messages?: Array<{ type: string; content: string }> };
    };
    expect(Array.isArray(endLogCall.data.messages)).toBe(true);
    const msgs = endLogCall.data.messages!;
    expect(msgs[msgs.length - 1]).toEqual(
      expect.objectContaining({ type: 'ai', content: '["q1","q2"]' }),
    );
    // Terminal + finish still yield (existing behavior unchanged).
    expect(events.at(-1)?.type).toBe('finish');
  });

  it('runRecommendQuestions catch → triggerLogError marks the log errored', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: '查询所有用户',
    });
    m.generatorService.generateGuessQuestion.mockImplementation(() => {
      throw new Error('LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    // startLog INSERTed first (row exists), then triggerLogError on
    // the throw (marks it errored immediately).
    expect(m.prisma.chatLog.create).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operate: 'GENERATE_RECOMMENDED_QUESTIONS',
          error: false,
        }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
    // The existing error+finish yield behavior is preserved.
    expect(types(events)).toBe('error,finish');
    // finishRecord NOT called (the record itself isn't errored — only the
    // recommend-questions step failed; the record's finish/error stay untouched).
    expect(m.prisma.chatRecord.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ finish: true }),
      }),
    );
  });

  // (e) 4 history loaders exclude GENERATE_RECOMMENDED_QUESTIONS from the
  // `logs` include (the recommend-questions
  // log is a background task, not a user-visible step). The actual loaders are
  // getRecordLogs/getRecordUsage/getRecordLogHistory + getWithData. All 4 get
  // the filter for parity-completeness.
  it('getRecordLogHistory → logs include excludes GENERATE_RECOMMENDED_QUESTIONS', async () => {
    const m = makeService();
    // toChatLogHistorySnake reads record.createdAt/updatedAt on the empty-logs
    // path — seed them so the mapper doesn't crash (the assertion is on the
    // findFirst CALL ARGS, not the return shape).
    const ts = new Date('2026-01-01T00:00:00Z');
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      createdAt: ts,
      updatedAt: ts,
      logs: [],
    });

    await run(1, () => m.service.getRecordLogHistory(100));

    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        id: 100,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
  });

  it('getRecordUsage → logs include excludes GENERATE_RECOMMENDED_QUESTIONS', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      logs: [],
    });

    await run(1, () => m.service.getRecordUsage(1, 100));

    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        id: 100,
        chatId: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
  });

  it('getRecordLogs → logs include excludes GENERATE_RECOMMENDED_QUESTIONS', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue({ id: 100, logs: [] });

    await run(1, () => m.service.getRecordLogs(1, 100));

    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        id: 100,
        chatId: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        logs: {
          where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
          orderBy: { startedAt: 'asc' },
        },
      },
    });
  });

  it('getWithData → records.logs include excludes GENERATE_RECOMMENDED_QUESTIONS', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({ id: 1 });

    await run(1, () => m.service.getWithData(1));

    expect(m.prisma.chat.findFirst).toHaveBeenCalledWith({
      where: {
        id: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        datasource: { include: { tables: { include: { fields: true } } } },
        records: {
          orderBy: { createdAt: 'asc' },
          include: {
            logs: {
              where: { operate: { not: 'GENERATE_RECOMMENDED_QUESTIONS' } },
            },
          },
        },
      },
    });
  });
});
