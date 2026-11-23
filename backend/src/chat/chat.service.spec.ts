// ChatService spec — verifies the Phase 5 SSE pipeline orchestration. The
// three LLM generators are faked as async-iterables (`asyncFrom`,
// to dodge `require-await` on empty async generators); DatasourceService /
// PrismaService are jest.Mocks. Assertions cover BOTH the yielded SSE event
// sequence AND the ChatRecord/ChatLog persistence side-effects.
// Every call runs inside requestContextStorage.run(...) so currentOid resolves.
import {
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QuotaExceededError } from '../quota/quota.service';
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
      updateMany: jest.fn(),
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

  // MetaDataImprove M7: no subject in unit context → budget checks skipped.
  // Tests that exercise charging override currentSubject and assert these.
  const quota = {
    currentSubject: jest.fn().mockReturnValue(null),
    assertUnderBudget: jest.fn().mockResolvedValue(undefined),
    reserveChars: jest.fn().mockResolvedValue(undefined),
    chargeChars: jest.fn().mockResolvedValue(undefined),
  };

  // MetaDataImprove M2: no effective semantics by default (empty maps →
  // rule 2 never narrows; individual tests override per-case). Alias
  // expansion is identity by default — per-test overrides simulate aliases.
  const semanticService = {
    effectiveAnnotations: jest
      .fn()
      .mockResolvedValue({ tableMeanings: {}, fieldNotes: {} }),
    expandKeywordsByAliases: jest.fn((k: string) => Promise.resolve(k)),
  };

  // MetaDataImprove M4: no metric/naming matches by default (empty text →
  // no injection; individual tests override per-case).
  const metricService = {
    matchDefinitions: jest
      .fn()
      .mockResolvedValue({ text: '', atomicTableNames: [], matched: 0 }),
  };
  const standardService = {
    namingTemplateFor: jest.fn().mockResolvedValue(''),
  };

  const service = new ChatService(
    prisma as unknown as PrismaService,
    datasourceService as unknown as DatasourceService,
    aiQuestionService as unknown as AiQuestionService,
    generatorService as unknown as GeneratorService,
    sqlSafety as unknown as SqlSafetyService,
    rowPermissionService as unknown as RowPermissionService,
    semanticService as never,
    metricService as never,
    standardService as never,
    audit as unknown as AuditService,
    config as unknown as ConfigService,
    // MetaDataImprove M7: no subject in unit context → budget checks skipped.
    quota as never,
  );
  return {
    service,
    prisma,
    datasourceService,
    aiQuestionService,
    generatorService,
    rowPermissionService,
    sqlSafety,
    audit,
    config,
    semanticService,
    quota,
    metricService,
    standardService,
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
  m.prisma.chatRecord.update.mockResolvedValue({
    id: 100,
    clarifyRound: 1,
  });
  // Clarify answers claim the pending row; the default matches the happy path.
  m.prisma.chatRecord.updateMany.mockResolvedValue({ count: 1 });
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
      // The real generator streams the JSON envelope as content deltas —
      // runPredict must accumulate it WITHOUT forwarding it to the client.
      {
        type: 'content',
        delta:
          '{"predict":"上升趋势","predict_data":[{"label":"x","value":1}]}',
      },
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

/** Pending clarify fixture for resume-claim tests; `round` mirrors the
 *  committed clarifyRound the answer token must match. */
function pendingClarifyRecord(round = 1) {
  return {
    id: 100,
    chatId: 1,
    oid: 1,
    createBy: 1,
    question: '统计一下',
    clarify: {
      record_id: 100,
      round,
      question: '统计一下',
      max_select: 3,
      candidates: [{ table_id: 1, table_name: 'users', comment: '' }],
    },
    clarifyStatus: 'pending',
    clarifyRound: round,
  };
}

const types = (events: ChatSseEvent[]) => events.map((e) => e.type).join(',');

describe('ChatService pipeline (runPipeline / regenerate)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  // --- 3fd6fa86 keyword-extraction pre-step wiring -------------------------
  it('extracts keywords → expands via semantic aliases → persists → recalls with them', async () => {
    const m = makeService();
    happyMocks(m);
    m.semanticService.expandKeywordsByAliases.mockResolvedValue(
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
    // expansion ran for the question's datasource
    expect(m.semanticService.expandKeywordsByAliases).toHaveBeenCalledWith(
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

    expect(m.semanticService.expandKeywordsByAliases).not.toHaveBeenCalled();
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

  it('keyword extraction always runs — a stale keyword_enabled row cannot switch it off', async () => {
    const m = makeService();
    happyMocks(m);
    // The parameter no longer exists; a leftover row (saved before the
    // migration removed the key) must be ignored, not honoured.
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'embedding.keyword_enabled', value: 'false' },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    expect(m.generatorService.extractKeywords).toHaveBeenCalledTimes(1);
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询所有用户',
      expect.objectContaining({ keywords: '用户,订单' }),
    );
  });

  it('semantic.enabled=false persists the raw keywords without alias expansion', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'semantic.enabled', value: 'false' },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    expect(m.semanticService.expandKeywordsByAliases).not.toHaveBeenCalled();
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        extractedKeywords: '用户,订单',
        expandedKeywords: '用户,订单',
      },
    });
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

  it('reserves prompt chars before the stream and charges content after', async () => {
    const m = makeService();
    happyMocks(m);
    const subject = { type: 'user' as const, id: 7 };
    m.quota.currentSubject.mockReturnValue(subject);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 'abcd' },
          ],
        },
        // reasoning is NOT part of the character budget.
        { type: 'reasoning', delta: 'thinking' },
        { type: 'content', delta: 'xy' },
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

    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    // The 4-char prompt is reserved before the provider stream starts; the
    // 2-char output is charged after it ends.
    expect(m.quota.reserveChars).toHaveBeenCalledWith(1, subject, 4);
    expect(m.quota.chargeChars).toHaveBeenCalledWith(1, subject, 2);
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

  it('injects effective semantics even when the schema is not narrowed', async () => {
    const m = makeService();
    happyMocks(m);
    // One recalled table → the rule-2 cap is not exceeded, so the old code
    // skipped semantics entirely. The final decoration step must still load
    // them — and pass the keyword-matched part to the prompt.
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);
    const semantics = {
      tableMeanings: { users: '用户主表' },
      fieldNotes: {
        'users.id': { role: 'dimension', meaning: '用户 ID' },
      },
      // the default extraction yields 用户,订单 — the table is named by ALIAS
      tableAliases: { users: ['用户'] },
    };
    m.semanticService.effectiveAnnotations.mockResolvedValue(semantics);

    await run(1, () => collect(m.service.runPipeline(1, '查询用户')));

    expect(m.semanticService.effectiveAnnotations).toHaveBeenCalledWith(1, [
      'users',
    ]);
    // exact-keyword gate: the table meaning passes, the unnamed field does not
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({
        semantics: { tableMeanings: { users: '用户主表' }, fieldNotes: {} },
      }),
    );
  });

  it('injects NO curated semantics for tables/fields the keywords do not name', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: { users: '用户主表' },
      fieldNotes: {
        'users.id': { role: 'dimension', meaning: '用户 ID' },
      },
      tableAliases: { users: ['会员'] },
      fieldAliases: { 'users.id': ['编号'] },
    });

    // keywords are 用户,订单 — none equals users / 会员 / id / 编号
    await run(1, () => collect(m.service.runPipeline(1, '查询所有用户')));

    expect(m.semanticService.effectiveAnnotations).toHaveBeenCalled();
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({
        semantics: { tableMeanings: {}, fieldNotes: {} },
      }),
    );
  });

  it('injects NO curated semantics when keyword extraction yields nothing', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: { users: '用户主表' },
      fieldNotes: {},
      // the table name WOULD match a keyword — if there were any
      tableAliases: { users: ['用户'] },
    });
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: [] },
        { type: 'content', delta: 'EMPTY' },
        { type: 'result', data: { keywords: 'EMPTY' } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询所有用户')),
    );

    // Known limitation, pinned: no keywords → no semantic decoration at all.
    expect(types(events)).toContain('finish');
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({
        semantics: { tableMeanings: {}, fieldNotes: {} },
      }),
    );
  });

  it('need_clarify carries meanings, candidate_tables and a preselect set', async () => {
    const m = makeService();
    happyMocks(m);
    // Four recalled candidates; one semantic row is enough to narrow rule 2
    // to users, leaving the other three as candidate_tables prompt entries.
    // Rule 2 only engages below the recall width — pin the cap to 1.
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'semantic.max_tables', value: '1' },
    ]);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tables: [
        {
          id: 1,
          tableName: 'users',
          tableComment: '用户表',
          customComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 2,
          tableName: 'orders',
          tableComment: '订单表',
          customComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 3,
          tableName: 'products',
          tableComment: '商品表',
          customComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 4,
          tableName: 'payments',
          tableComment: '支付表',
          customComment: null,
          checked: true,
          fields: [],
        },
      ],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
      { id: 3, tableName: 'products', checked: true },
      { id: 4, tableName: 'payments', checked: true },
    ]);
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: {
        users: '用户主表',
        orders: '订单主表',
        products: '商品主表',
        payments: '支付流水',
      },
      fieldNotes: {},
      // keywords are 用户,订单 → only orders is named (by alias)
      tableAliases: { orders: ['订单'] },
    });
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '需要订单表 join',
            sql: '',
            tables: ['orders'],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '统计一下整体情况')),
    );

    const clarify = events.find((e) => e.type === 'clarify');
    expect(clarify).toBeDefined();
    expect(clarify!.data.reason).toBe('需要订单表 join');
    expect(clarify!.data.candidates).toEqual([
      {
        table_id: 1,
        table_name: 'users',
        comment: '用户表',
        meaning: '用户主表',
      },
      {
        table_id: 2,
        table_name: 'orders',
        comment: '订单表',
        meaning: '订单主表',
      },
      {
        table_id: 3,
        table_name: 'products',
        comment: '商品表',
        meaning: '商品主表',
      },
      {
        table_id: 4,
        table_name: 'payments',
        comment: '支付表',
        meaning: '支付流水',
      },
    ]);
    // Current schema (users) + the LLM's requested table (orders).
    expect(clarify!.data.suggested_table_ids).toEqual([1, 2]);

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls[0][0] as {
      tableIds?: number[];
      candidateTables?: string;
    };
    expect(sqlCtx.tableIds).toEqual([1]);
    // Prompt block follows the exact-keyword gate: orders is named by the
    // keyword 订单 (alias) so its curated meaning shows; products was never
    // named, so the line falls back to the DB comment.
    expect(sqlCtx.candidateTables).toContain('- orders: 订单主表');
    expect(sqlCtx.candidateTables).toContain('- products: 商品表');
    expect(sqlCtx.candidateTables).not.toContain('- products: 商品主表');
    expect(sqlCtx.candidateTables).not.toContain('- users:');
    // the clarify card shown to the USER still carries every meaning
    expect(
      (clarify!.data.candidates as Array<{ meaning?: string }>).every(
        (c) => !!c.meaning,
      ),
    ).toBe(true);
  });

  it('skips candidate_tables when recall degrades to all checked tables', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.recallTables.mockResolvedValue([]);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '缺少字段',
            sql: '',
            tables: ['users'],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询用户')));

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls[0][0] as {
      candidateTables?: string;
    };
    expect(sqlCtx.candidateTables).toBeUndefined();
  });

  // MetaDataImprove M1: max_select is part of the clarify contract, not just
  // a frontend hint — the resume endpoint rejects over-picks.
  it('rejects a clarify answer exceeding the pending max_select', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      chatId: 1,
      oid: 1,
      createBy: 1,
      question: '统计一下',
      clarify: {
        record_id: 100,
        question: '统计一下',
        max_select: 1,
        candidates: [
          { table_id: 1, table_name: 'users', comment: '' },
          { table_id: 2, table_name: 'orders', comment: '' },
        ],
      },
      clarifyStatus: 'pending',
    });

    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1, 2] })),
      ),
    ).rejects.toThrow('最多只能选择 1 张表');
    // The rejected answer is not persisted.
    expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
  });

  // MetaDataImprove M1 multi-round: every supplement is replayed into the
  // next run's question and persisted as `texts` (legacy rows only have
  // `text`, so the fallback path is covered here).
  it('accumulates supplement texts across clarify rounds on resume', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 100,
      chatId: 1,
      oid: 1,
      createBy: 1,
      question: '统计一下',
      clarify: {
        record_id: 100,
        round: 1,
        question: '统计一下',
        max_select: 3,
        candidates: [{ table_id: 1, table_name: 'users', comment: '' }],
      },
      clarifyStatus: 'pending',
      clarifyRound: 1,
      clarifyAnswer: { text: '上一轮说明' },
    });

    await run(1, () =>
      collect(
        m.service.resumeClarified(100, {
          tableIds: [1],
          text: '这一轮说明',
          round: 1,
        }),
      ),
    );

    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({
        question: '统计一下\n上一轮说明\n这一轮说明',
      }),
    );
    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 100,
          oid: 1,
          clarifyStatus: 'pending',
          clarifyRound: 1,
        },
        data: expect.objectContaining({
          clarifyStatus: 'answered',
          clarifyAnswer: expect.objectContaining({
            texts: ['上一轮说明', '这一轮说明'],
          }),
        }),
      }),
    );
  });

  // The picked-table resume used to skip keyword extraction as "wasted". The
  // keywords are now the ONLY match source for metrics / naming rules / the
  // semantic prompt decoration, so the call must run there as well.
  it('a picked-table resume still extracts keywords and matches on them', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'content', delta: '支付金额' }]),
    );

    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
    );

    expect(types(events)).toContain('finish');
    expect(m.generatorService.extractKeywords).toHaveBeenCalledTimes(1);
    // the picked table replaced recall …
    expect(m.datasourceService.recallTables).not.toHaveBeenCalled();
    // … but the metric matcher still received the freshly extracted keywords
    expect(m.metricService.matchDefinitions).toHaveBeenCalledWith(
      1,
      new Set(['支付金额']),
      5,
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { extractedKeywords: '支付金额', expandedKeywords: '支付金额' },
    });
  });

  // Double-click / network retry: the conditional claim is the answer's only
  // writer, so exactly one request runs the pipeline and the other gets the
  // same 400 as an already-settled record.
  it('claims a pending clarify answer only once (concurrent resumes)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    let pending = true;
    m.prisma.chatRecord.updateMany.mockImplementation(
      (args: {
        where: {
          id?: number;
          oid?: number;
          clarifyStatus?: string;
          clarifyRound?: number;
        };
      }) => {
        const where = args.where;
        if (where.id !== 100 || where.oid !== 1) {
          return Promise.resolve({ count: 0 });
        }
        // Model the DB: only the predicates actually supplied are enforced, so
        // dropping one from the claim silently widens the match instead of
        // failing. `clarifyStatus` must still be pending when asked for it.
        if (
          where.clarifyStatus !== undefined &&
          (where.clarifyStatus !== 'pending' || !pending)
        ) {
          return Promise.resolve({ count: 0 });
        }
        if (where.clarifyRound !== undefined && where.clarifyRound !== 1) {
          return Promise.resolve({ count: 0 });
        }
        pending = false;
        return Promise.resolve({ count: 1 });
      },
    );

    const results = await run(1, () =>
      Promise.allSettled([
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ]),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(BadRequestException);
    // Only the winner reached the SQL step.
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledTimes(1);
  });

  // Pre-token clients (deployed frontend/API consumers) omit `round`; the
  // fallback claim must still be single-writer.
  it('legacy resumes without a round token are still claimed once', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    let pending = true;
    m.prisma.chatRecord.updateMany.mockImplementation(
      (args: {
        where: {
          id?: number;
          oid?: number;
          clarifyStatus?: string;
          clarifyRound?: number;
        };
      }) => {
        const where = args.where;
        if (where.id !== 100 || where.oid !== 1) {
          return Promise.resolve({ count: 0 });
        }
        if (
          where.clarifyStatus !== undefined &&
          (where.clarifyStatus !== 'pending' || !pending)
        ) {
          return Promise.resolve({ count: 0 });
        }
        if (where.clarifyRound !== undefined && where.clarifyRound !== 1) {
          return Promise.resolve({ count: 0 });
        }
        pending = false;
        return Promise.resolve({ count: 1 });
      },
    );

    const results = await run(1, () =>
      Promise.allSettled([
        collect(m.service.resumeClarified(100, { tableIds: [1] })),
        collect(m.service.resumeClarified(100, { tableIds: [1] })),
      ]),
    );

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(BadRequestException);
    const where = m.prisma.chatRecord.updateMany.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('clarifyRound');
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledTimes(1);
  });

  // A card rendered for an older round must not resume the newer pending one:
  // the stalled older answer would otherwise run the pipeline against the
  // wrong schema subset.
  it('rejects a stale clarify round without running the pipeline', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(2));
    m.prisma.chatRecord.updateMany.mockImplementation(
      (args: { where: { clarifyRound?: number } }) =>
        Promise.resolve({
          count:
            args.where.clarifyRound === undefined ||
            args.where.clarifyRound === 2
              ? 1
              : 0,
        }),
    );

    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow('不在待澄清状态');

    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 100,
          oid: 1,
          clarifyStatus: 'pending',
          clarifyRound: 1,
        }),
      }),
    );
    expect(m.aiQuestionService.buildSqlContext).not.toHaveBeenCalled();
  });

  // Skip is an answer too: it must go through the same pinned claim, or a
  // double-clicked skip could resume twice.
  it('claims the pending round on a skip answer', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(2));

    await run(1, () =>
      collect(m.service.resumeClarified(100, { skip: true, round: 2 })),
    );

    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clarifyRound: 2 }),
        data: expect.objectContaining({
          clarifyStatus: 'skipped',
          clarifyAnswer: expect.objectContaining({ skip: true }),
        }),
      }),
    );
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalled();
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
    // A pause spends one clarify round: the counter increments first, then the
    // payload stores the post-increment token the resume must echo. Other
    // pipeline steps also update the record, so match by shape and order.
    const updates = m.prisma.chatRecord.update.mock.calls.map(
      (call) =>
        call[0] as {
          data?: {
            clarifyRound?: unknown;
            clarify?: { round?: number };
            clarifyStatus?: string;
          };
        },
    );
    const incrementAt = updates.findIndex((u) => u.data?.clarifyRound != null);
    const payloadAt = updates.findIndex(
      (u) => u.data?.clarifyStatus === 'pending' && u.data?.clarify != null,
    );
    expect(incrementAt).toBeGreaterThanOrEqual(0);
    expect(payloadAt).toBeGreaterThan(incrementAt);
    expect(updates[incrementAt].data?.clarifyRound).toEqual({
      increment: 1,
    });
    expect(updates[payloadAt].data?.clarify?.round).toBe(1);
    // The SSE frame carries the same token the persisted payload has.
    expect(clarify!.data.round).toBe(1);
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

  it('runPredict streams reasoning + parsed prose, never the raw JSON envelope', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toBe(
      'id,info,predict-result,predict-result,predict-success,predict_finish',
    );
    // Frame 1: live thinking; frame 2: the parsed prose as ONE content frame.
    expect(events[2].data).toEqual({ reasoning_content: '预测中' });
    expect(events[3].data).toEqual({ content: '上升趋势' });
    // Regression: the raw JSON envelope must never reach the visible stream.
    for (const e of events) {
      expect(JSON.stringify(e.data)).not.toContain('predict_data');
    }
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        // `predict` is the frontend's thinking slot — persist the reasoning
        // (live sessions accumulate it there), NOT the prose (which would
        // duplicate predictContent after reload).
        predict: '预测中',
        predictContent: '上升趋势',
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
      'id,info,predict-result,predict-result,predict-success,predict_finish',
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

// ─────────────────────────────────────────────────────────────────────────────
// Coverage extension: clarify payload parsers, pipeline/regenerate/resume
// error edges, secondary flows, runCore deep arms, CRUD 404s and helpers.
// All blocks APPEND to the suites above; the harness (makeService /
// happyMocks / run-ALS) is unchanged except makeService now also exposes the
// metric/standard mocks so M4 arms can be overridden per-test.
// ─────────────────────────────────────────────────────────────────────────────

/** Flush pending microtasks + one macrotask tick so fire-and-forget audit /
 *  guess-question writes settle before assertions. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('ChatService clarify payload defensive parsers (module-level)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  // clarifyCandidates: null / array / non-object payloads degrade to "no
  // candidates", so table picks are rejected as invalid instead of throwing.
  it.each([
    ['null payload', null],
    ['array payload', [1, 2]],
    ['candidates not an array', { candidates: 'nope' }],
    ['no candidates key', { max_select: 3 }],
  ])(
    'rejects table picks when the clarify payload is corrupt (%s)',
    async (_label, clarify) => {
      const m = makeService();
      happyMocks(m);
      m.prisma.chatRecord.findFirst.mockResolvedValue({
        ...pendingClarifyRecord(),
        clarify,
      });

      // Supplement text keeps the "answer required" guard quiet so the invalid
      // TABLE PICK is what gets rejected.
      await expect(
        run(1, () =>
          collect(
            m.service.resumeClarified(100, {
              tableIds: [1],
              text: '说明',
              round: 1,
            }),
          ),
        ),
      ).rejects.toThrow('所选表不在澄清候选列表中');
      // Rejected before the claim — nothing persisted.
      expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
    },
  );

  it('skips corrupt candidate entries and keeps the well-formed one', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(),
      clarify: {
        round: 1,
        max_select: 3,
        candidates: [
          null,
          42,
          'users',
          [],
          { table_id: '1', table_name: 'users' }, // id not a number → dropped
          { table_id: 2 }, // name missing → dropped
          { table_name: 'orders' }, // id missing → dropped
          { table_id: 9, table_name: 'real' }, // the one valid entry
        ],
      },
    });
    // The datasource must still have table 9 checked (stale-pick guard).
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tables: [{ id: 9, tableName: 'real', checked: true, fields: [] }],
    });

    await run(1, () =>
      collect(m.service.resumeClarified(100, { tableIds: [9], round: 1 })),
    );

    // Only id 9 survived parsing, so the pick is valid and the resume runs.
    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clarifyAnswer: expect.objectContaining({ table_ids: [9] }),
        }),
      }),
    );
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ tableIds: [9] }),
    );
  });

  // clarifyMaxSelect: a corrupt/legacy max_select degrades to null → no cap.
  it.each([
    ['zero', 0],
    ['negative', -2],
    ['non-integer string', 'many'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'treats max_select=%s as absent (no cap enforced)',
    async (_label, maxSelect) => {
      const m = makeService();
      happyMocks(m);
      m.prisma.chatRecord.findFirst.mockResolvedValue({
        ...pendingClarifyRecord(),
        clarify: {
          round: 1,
          max_select: maxSelect as number,
          candidates: [
            { table_id: 1, table_name: 'users', comment: '' },
            { table_id: 2, table_name: 'orders', comment: '' },
          ],
        },
      });
      // Both picked tables must exist + be checked (stale-pick guard).
      m.datasourceService.findOne.mockResolvedValue({
        id: 1,
        name: 'main',
        type: 'sqlite',
        tables: [
          { id: 1, tableName: 'users', checked: true, fields: [] },
          { id: 2, tableName: 'orders', checked: true, fields: [] },
        ],
      });

      // Both picks would exceed a numeric cap of 1, but the corrupt value means
      // no cap → the resume proceeds instead of 400ing.
      await run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1, 2], round: 1 })),
      );

      expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clarifyStatus: 'answered' }),
        }),
      );
    },
  );

  it('floor()s a fractional max_select before enforcing it', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(),
      clarify: {
        round: 1,
        max_select: 1.9,
        candidates: [
          { table_id: 1, table_name: 'users', comment: '' },
          { table_id: 2, table_name: 'orders', comment: '' },
        ],
      },
    });

    // floor(1.9) = 1 → two picks are over the cap.
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1, 2], round: 1 })),
      ),
    ).rejects.toThrow('最多只能选择 1 张表');
  });

  // clarifyAnswerTexts: corrupt `texts` entries are dropped, whitespace-only
  // strings discarded, and a legacy single `text` used when texts is empty.
  it('filters non-string/blank prior texts and accumulates the new answer text', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(),
      clarifyAnswer: { texts: [42, '   ', '上一轮说明'] },
    });

    await run(1, () =>
      collect(m.service.resumeClarified(100, { text: '这一轮', round: 1 })),
    );

    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clarifyAnswer: expect.objectContaining({
            text: '这一轮',
            texts: ['上一轮说明', '这一轮'],
            // no picks → table_ids/table_names omitted
            table_ids: undefined,
            table_names: undefined,
            skip: undefined,
          }),
        }),
      }),
    );
  });

  it('falls back to the legacy single text and drops it when blank', async () => {
    const m = makeService();
    happyMocks(m);
    // Legacy row shape: only `text` (whitespace → no prior texts at all).
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(),
      clarifyAnswer: { text: '   ' },
    });

    await run(1, () =>
      collect(m.service.resumeClarified(100, { text: '说明', round: 1 })),
    );

    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          clarifyAnswer: expect.objectContaining({ texts: ['说明'] }),
        }),
      }),
    );
  });
});

describe('ChatService resumeClarified validation edges', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('404s when the record does not exist', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.resumeClarified(999, { skip: true }))),
    ).rejects.toThrow(NotFoundException);
  });

  it('400s when the record is no longer pending', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(),
      clarifyStatus: 'answered',
    });
    await expect(
      run(1, () => collect(m.service.resumeClarified(100, { tableIds: [1] }))),
    ).rejects.toThrow(BadRequestException);
    expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
  });

  it('400s when the answer carries neither picks, text nor skip', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    await expect(
      run(1, () => collect(m.service.resumeClarified(100, {}))),
    ).rejects.toThrow('请选择候选表、填写补充说明，或选择跳过');
  });

  it('400s when every picked table is outside the offered pool', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    await expect(
      run(1, () =>
        collect(
          m.service.resumeClarified(100, {
            tableIds: [77, 88],
            text: '说明',
            round: 1,
          }),
        ),
      ),
    ).rejects.toThrow('所选表不在澄清候选列表中');
  });

  it('404s when the owning chat disappeared', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('400s (pre-claim) when picks exist but the chat has no datasource', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
    });
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow('请先选择数据源');
    expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
  });

  it('400s (pre-claim) on a stale pick the datasource no longer has checked', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      // table 1 exists but is unchecked (a sync unchecked it after the pause)
      tables: [{ id: 1, tableName: 'users', checked: false, fields: [] }],
    });
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow('所选表不在澄清候选列表中');
    expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
  });

  it('rejects with the localized quota message when the budget is spent', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.assertUnderBudget.mockRejectedValue(new QuotaExceededError(500));
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow('500 字');
    // Rejected before the claim → the record stays pending and retryable.
    expect(m.prisma.chatRecord.updateMany).not.toHaveBeenCalled();
  });

  it('re-throws non-quota budget check failures untouched', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.assertUnderBudget.mockRejectedValue(new Error('quota db down'));
    await expect(
      run(1, () =>
        collect(m.service.resumeClarified(100, { tableIds: [1], round: 1 })),
      ),
    ).rejects.toThrow('quota db down');
  });

  it('a skip answer on a datasource-less chat fails after the claim', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      origin: null,
    });

    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { skip: true, round: 1 })),
    );

    // skip → no picks → the stale-pick guard is bypassed, the claim happens,
    // then the stream fails with datasourceRequired.
    expect(m.prisma.chatRecord.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ clarifyStatus: 'skipped' }),
      }),
    );
    expect(types(events)).toBe('id,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '请先选择数据源',
    );
  });

  it('fails with unsupportedEngine when the bound datasource type has no engine', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'mongodb',
      tables: [{ id: 1, tableName: 'users', checked: true, fields: [] }],
    });

    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { skip: true, round: 1 })),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '不支持的数据源类型',
    );
    expect(types(events)).toBe('id,error,finish');
  });

  it('contains a mid-stream failure: error + finish + record marked failed', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.datasourceService.findOne.mockRejectedValue(new Error('ds down'));

    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { skip: true, round: 1 })),
    );

    expect(types(events)).toBe('id,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'ds down',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: 'ds down' },
    });
  });

  // Multi-round option pool: ids from the previous round's candidate list are
  // re-offered, but only when they resolve to a CHECKED table that is not
  // already in this round's pool (by id or by name).
  it('drops prior-round candidates that are missing, unchecked, or name-duplicates', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(1),
      clarify: {
        round: 1,
        max_select: 3,
        // 1 = already in this run's pool; 2 = unchecked; 3 = duplicate name of
        // a pool table; 77 = not in the datasource at all.
        candidates: [
          { table_id: 1, table_name: 'users', comment: '' },
          { table_id: 2, table_name: 'logs', comment: '' },
          { table_id: 3, table_name: 'users', comment: '' },
          { table_id: 77, table_name: 'ghost', comment: '' },
        ],
      },
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        { id: 1, tableName: 'users', checked: true, fields: [] },
        { id: 2, tableName: 'logs', checked: false, fields: [] },
        { id: 3, tableName: 'users', checked: true, fields: [] },
      ],
    });

    // Text-only answer: no forced picks, so the run must complete normally
    // even though every prior candidate was filtered out of the option pool.
    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { text: '查用户', round: 1 })),
    );

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('clarify');
  });
});

describe('ChatService runPipeline entry + select_datasource edges', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('fails the record with the localized quota message when the budget is spent', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.assertUnderBudget.mockRejectedValue(new QuotaExceededError(1000));

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe('id,question,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '今日 LLM 交互字数预算（1000 字）已用完，请明天再试或联系管理员调整',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: {
        finish: true,
        error: events.find((e) => e.type === 'error')!.data.content,
      },
    });
    // Failed before any LLM call was made.
    expect(m.generatorService.extractKeywords).not.toHaveBeenCalled();
    expect(m.generatorService.generateSql).not.toHaveBeenCalled();
  });

  it('re-throws non-quota entry-check failures as a normal pipeline error', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.assertUnderBudget.mockRejectedValue(new Error('quota db down'));

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe('id,question,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'quota db down',
    );
  });

  it('select_datasource streams messages/content/usage and records the chosen ds', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      engineType: null,
      title: '新对话',
      origin: 0,
      recommendedQuestion: ['已缓存推荐'],
    });
    m.datasourceService.findAll.mockResolvedValue([
      { id: 2, name: 'ds2', description: '销售库', type: 'sqlite' },
    ]);
    m.aiQuestionService.buildForSelectDatasource.mockReturnValue({});
    const usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7 };
    m.generatorService.selectDatasource.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 's' },
          ],
        },
        { type: 'reasoning', delta: 'picking' },
        { type: 'content', delta: 'ds2' },
        { type: 'usage', usage },
        { type: 'result', data: { datasourceId: 2 } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询订单')),
    );

    // Both delta kinds are forwarded as datasource-result frames.
    const dsFrames = events.filter((e) => e.type === 'datasource-result');
    expect(dsFrames.map((e) => e.data)).toEqual(
      expect.arrayContaining([
        { reasoning_content: 'picking' },
        { content: 'ds2' },
      ]),
    );
    // A non-null description flows through as-is; usage lands in the endLog.
    expect(m.aiQuestionService.buildForSelectDatasource).toHaveBeenCalledWith({
      question: '查询订单',
      datasources: [{ id: 2, name: 'ds2', description: '销售库' }],
      lang: 'zh-CN',
    });
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenUsage: usage }),
      }),
    );
    // Chosen ds + engine bound onto the chat, then the closed loop completes.
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { datasourceId: 2, engineType: 'SQLite' },
    });
    expect(types(events)).toContain('finish');
  });

  it('fails with datasourceNotSelected when select_datasource returns no result', async () => {
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
    m.datasourceService.findAll.mockResolvedValue([]);
    m.aiQuestionService.buildForSelectDatasource.mockReturnValue({});
    m.generatorService.selectDatasource.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'result', data: null }]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe('id,question,info,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '未能选择数据源',
    );
  });

  it('contains a select_datasource generator crash (log marked errored, error frame)', async () => {
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
    m.datasourceService.findAll.mockResolvedValue([]);
    m.aiQuestionService.buildForSelectDatasource.mockReturnValue({});
    m.generatorService.selectDatasource.mockImplementation(() => {
      throw new Error('selector LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'selector LLM down',
    );
    // The started CHOOSE_DATASOURCE log row is marked errored.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('fails with unsupportedEngine for a datasource type with no engine mapping', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'mongodb',
      tables: [{ id: 1, tableName: 'users', checked: true, fields: [] }],
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe('id,question,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '不支持的数据源类型',
    );
    // No engine → nothing bound onto the chat.
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('skips the re-bind chat.update when datasource and engine are already bound', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '自定义标题',
      origin: null,
      recommendedQuestion: ['已缓存推荐'],
    });
    // No brief + no chartType → also exercises the "nothing to adopt" arms.
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: true,
            sql: 'SELECT 1',
            tables: [],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toBe(
      'id,question,datasource,info,sql,info,sql-data,info,chart-result,chart,finish',
    );
    // No re-bind, no title adoption, no brief frame.
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'brief')).toBe(false);
    // brief '' → sqlAnswer/brief/chartType persist as null.
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { sql: 'SELECT 1', sqlAnswer: null, brief: null, chartType: null },
    });
  });
});

describe('ChatService regenerate edges', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('404s when the chat is missing', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.regenerate(1, 50))),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s when the source record is missing', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.regenerate(1, 50))),
    ).rejects.toThrow(NotFoundException);
  });

  it('fails with datasourceRequired when the chat has no bound datasource', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      origin: null,
      title: '新对话',
    });
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });
    m.prisma.chatRecord.create.mockResolvedValue({ id: 101, chatId: 1 });

    const events = await run(1, () => collect(m.service.regenerate(1, 50)));

    expect(types(events)).toBe('id,regenerate_record_id,question,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '请先选择数据源',
    );
  });

  it('fails with unsupportedEngine for an unmapped datasource type', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'mongodb',
      tables: [{ id: 1, tableName: 'users', checked: true, fields: [] }],
    });

    const events = await run(1, () => collect(m.service.regenerate(1, 50)));

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '不支持的数据源类型',
    );
  });

  it('contains a datasource load failure: error + finish + record marked failed', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });
    m.prisma.chatRecord.create.mockResolvedValue({ id: 101, chatId: 1 });
    m.datasourceService.findOne.mockRejectedValue(new Error('ds down'));

    const events = await run(1, () => collect(m.service.regenerate(1, 50)));

    expect(types(events)).toBe('id,regenerate_record_id,question,error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'ds down',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: { finish: true, error: 'ds down' },
    });
  });
});

describe('ChatService analysis / predict edges', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('runAnalysis 404s when the chat is missing', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.runAnalysis(1, 100))),
    ).rejects.toThrow(NotFoundException);
  });

  it('runAnalysis errors when the chat has no datasource (secondary ctx precondition)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
    });

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(types(events)).toBe('id,error,analysis_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '请先选择数据源',
    );
  });

  it('runAnalysis errors on an unsupported engine (secondary ctx precondition)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'mongodb',
      tables: [],
    });

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '不支持的数据源类型',
    );
    expect(types(events)).toBe('id,error,analysis_finish');
  });

  it('runAnalysis reports analysisNoResult when the generator returns null', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };
    m.generatorService.generateAnalysis.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: [] },
        { type: 'usage', usage },
        { type: 'result', data: null },
      ]),
    );

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(types(events)).toBe('id,info,error,analysis_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '分析生成未返回结果',
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: '分析生成未返回结果' },
    });
    // The generator call still completed cleanly — endLog (not triggerLogError)
    // with the usage snapshot and no error flag.
    expect(m.prisma.chatLog.update).toHaveBeenCalledTimes(1);
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ tokenUsage: usage }),
      }),
    );
  });

  it('runAnalysis survives an audit failure (fire-and-forget, warn only)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.audit.record.mockRejectedValue(new Error('audit down'));
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));
    await flush();

    expect(types(events)).toContain('analysis_finish');
    expect(warn).toHaveBeenCalledWith('audit failed: audit down');
    warn.mockRestore();
  });

  it('runPredict 404s on a missing chat and on a missing record', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.runPredict(1, 100))),
    ).rejects.toThrow(NotFoundException);

    const m2 = makeService();
    happyMocks(m2);
    m2.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m2.service.runPredict(1, 100))),
    ).rejects.toThrow(NotFoundException);
  });

  it('runPredict fails with predict-failed when the record has no SQL result', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sql: null, sqlExecResult: null }),
    );

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toBe('id,error,predict-failed,predict_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '该记录缺少SQL执行结果，无法分析',
    );
  });

  it('runPredict reports predictNoResult when the generator returns null', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.generatorService.generatePredict.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: [] },
        {
          type: 'usage',
          usage: { promptTokens: 9, completionTokens: 1, totalTokens: 10 },
        },
        { type: 'result', data: null },
      ]),
    );

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toBe('id,info,predict-failed,predict_finish');
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: '预测生成未返回结果' },
    });
  });

  it('runPredict persists predict: null when no reasoning was streamed', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    // Content + result but NO reasoning event → reasoning '' → predict null.
    m.generatorService.generatePredict.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'content',
          delta: '{"predict":"平稳","predict_data":[]}',
        },
        {
          type: 'result',
          data: { predict: '平稳', predictData: [] },
        },
      ]),
    );

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toContain('predict-success');
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { predict: null, predictContent: '平稳', predictData: [] },
    });
  });

  it('runPredict survives an audit failure (fire-and-forget, warn only)', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.audit.record.mockRejectedValue(new Error('audit down'));
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));
    await flush();

    expect(types(events)).toContain('predict-success');
    expect(warn).toHaveBeenCalledWith('audit failed: audit down');
    warn.mockRestore();
  });

  it('runAnalysisByRid resolves chatId from rid and delegates to runAnalysis', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () => collect(m.service.runAnalysisByRid(100)));

    expect(types(events)).toBe(
      'id,info,analysis-result,analysis-result,analysis_finish',
    );
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operate: 'ANALYSIS' }),
      }),
    );
  });

  it('runPredictByRid resolves chatId from rid and delegates to runPredict', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const events = await run(1, () => collect(m.service.runPredictByRid(100)));

    expect(types(events)).toBe(
      'id,info,predict-result,predict-result,predict-success,predict_finish',
    );
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operate: 'PREDICT_DATA' }),
      }),
    );
  });

  it('runAnalysisByRid 404s when the rid is unknown', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => collect(m.service.runAnalysisByRid(999))),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('ChatService runCore deep arms (sql result shapes / clarify budget / metrics)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('fails with sqlGenNoResult when the result event carries null data', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'result', data: null }]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 生成未返回结果',
    );
  });

  it('fails with sqlGenFailed when success is false (no clarify request)', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            sql: '',
            tables: [],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 生成失败',
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL',
        }),
      }),
    );
  });

  it('fails with sqlEmpty when success is true but the SQL text is empty', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: true,
            sql: '',
            tables: [],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 为空',
    );
    expect(m.datasourceService.execSql).not.toHaveBeenCalled();
  });

  it('falls back to sqlSafetyFailed when a violation carries no reason', async () => {
    const m = makeService();
    happyMocks(m);
    m.sqlSafety.validate.mockReturnValue({ ok: false, tables: [] });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 安全校验失败',
    );
  });

  it('need_clarify on a spent round budget fails honestly instead of re-asking', async () => {
    const m = makeService();
    happyMocks(m);
    // The record already paused once (clarifyRound 1) and clarify.max_rounds
    // defaults to 1 → rounds >= max → the re-ask cannot happen.
    m.prisma.chatRecord.create.mockResolvedValue({
      id: 100,
      chatId: 1,
      oid: 1,
      question: '查询',
      clarifyRound: 1,
    });
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '还差订单表',
            sql: '',
            tables: ['orders'],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '当前选定的表不足以回答该问题，请调整所选表后重试',
    );
    expect(types(events)).not.toContain('clarify');
    // The LLM call itself succeeded — endLog (clean), not triggerLogError.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reasoningContent: null }),
      }),
    );
  });

  it('need_clarify with a non-array tables field suggests nothing', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '缺少字段',
            sql: '',
            tables: 'not-an-array',
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    const clarify = events.find((e) => e.type === 'clarify');
    expect(clarify).toBeDefined();
    expect(clarify!.data.suggested_table_ids).toBeUndefined();
    expect(clarify!.data.reason).toBe('缺少字段');
  });

  it('need_clarify suggests only the matched tables when the stuffed set exceeds max_select', async () => {
    const m = makeService();
    happyMocks(m);
    // max_select 1 while TWO tables get stuffed → the stuffed set cannot be
    // represented in the suggestion → only the LLM-named table is suggested.
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'clarify.max_select', value: '1' },
      { name: 'semantic.enabled', value: 'false' },
    ]);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        { id: 1, tableName: 'users', checked: true, fields: [] },
        { id: 2, tableName: 'orders', checked: true, fields: [] },
      ],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
    ]);
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '需要订单',
            sql: '',
            tables: ['orders'],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查数据')),
    );

    const clarify = events.find((e) => e.type === 'clarify');
    expect(clarify).toBeDefined();
    // stuffed {1,2} > max_select 1 → suggestion collapses to matched [2].
    expect(clarify!.data.suggested_table_ids).toEqual([2]);
    expect(clarify!.data.max_select).toBe(1);
  });

  it('injects matched metric text and force-stuffs its checked atomic tables', async () => {
    const m = makeService();
    happyMocks(m);
    m.metricService.matchDefinitions.mockResolvedValue({
      text: '<metric_definitions>订单量口径</metric_definitions>',
      // 'users' already recalled; 'orders' gets force-stuffed; 'ghost' is not
      // a table in the datasource and must be ignored.
      atomicTableNames: ['users', 'orders', 'ghost'],
      matched: 2,
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        { id: 1, tableName: 'users', checked: true, fields: [] },
        { id: 2, tableName: 'orders', checked: true, fields: [] },
        { id: 3, tableName: 'logs', checked: false, fields: [] },
      ],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查订单量')));

    // The matcher receives the turn's KEYWORD SET (default extraction:
    // 用户,订单), never the raw question — exact-keyword matching is its job.
    expect(m.metricService.matchDefinitions).toHaveBeenCalledWith(
      1,
      new Set(['用户', '订单']),
      5,
    );
    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as {
      tableIds?: number[];
      metrics?: string;
    };
    expect(sqlCtx.metrics).toBe(
      '<metric_definitions>订单量口径</metric_definitions>',
    );
    // orders (2) appended after the recalled users (1).
    expect(sqlCtx.tableIds).toEqual([1, 2]);
  });

  it('injects naming rules and skips the metric matcher when metric is disabled', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'metric.enabled', value: 'false' },
    ]);
    m.standardService.namingTemplateFor.mockResolvedValue(
      '<naming_rules>标准</naming_rules>',
    );

    await run(1, () => collect(m.service.runPipeline(1, '查订单')));

    expect(m.metricService.matchDefinitions).not.toHaveBeenCalled();
    expect(m.standardService.namingTemplateFor).toHaveBeenCalledWith(
      expect.any(Set),
      5,
    );
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({
        namingRules: '<naming_rules>标准</naming_rules>',
      }),
    );
  });

  it('naming terms = the turn keywords plus the STUFFED schema metadata', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        {
          id: 1,
          tableName: 'users',
          tableComment: '用户表',
          customComment: null,
          checked: true,
          fields: [
            {
              fieldName: 'id',
              fieldComment: null,
              customComment: '用户ID',
              checked: true,
            },
            // hidden from the LLM → not offered as a naming term
            {
              fieldName: 'pwd',
              fieldComment: '密码',
              customComment: null,
              checked: false,
            },
          ],
        },
        // recalled away → not stuffed → its metadata is not offered either
        {
          id: 2,
          tableName: 'logs',
          tableComment: '日志',
          customComment: null,
          checked: true,
          fields: [],
        },
      ],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查订单')));

    // default extraction 用户,订单 + names and EFFECTIVE comments (custom
    // wins) of the stuffed table's checked fields, all lowercased
    expect(m.standardService.namingTemplateFor).toHaveBeenCalledWith(
      new Set(['用户', '订单', 'users', '用户表', 'id', '用户id']),
      5,
    );
  });

  it('skips the whole metric/naming block when both are disabled', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'metric.enabled', value: 'false' },
      { name: 'naming.enabled', value: 'false' },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查订单')));

    expect(m.metricService.matchDefinitions).not.toHaveBeenCalled();
    expect(m.standardService.namingTemplateFor).not.toHaveBeenCalled();
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: '', namingRules: '' }),
    );
  });

  it('a metric dictionary failure degrades to no injection (pipeline succeeds)', async () => {
    const m = makeService();
    happyMocks(m);
    m.metricService.matchDefinitions.mockRejectedValue(
      new Error('metric db down'),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查订单')),
    );

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ metrics: '' }),
    );
  });

  it('drops recall ids that resolve to no table or an unchecked table', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        { id: 1, tableName: 'users', checked: true, fields: [] },
        { id: 2, tableName: 'logs', checked: false, fields: [] },
      ],
    });
    // 99 does not exist in the datasource; 2 exists but is unchecked.
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 99, tableName: 'ghost', checked: true },
      { id: 2, tableName: 'logs', checked: false },
    ]);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    // Neither id can be stuffed into a schema; the turn still completes.
    expect(types(events)).toContain('finish');
    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as {
      tableIds?: number[];
    };
    expect(sqlCtx.tableIds).toEqual([99, 2]);
  });

  it('rule-2 narrowing keeps explicitly named/comment-mentioned tables', async () => {
    const m = makeService();
    happyMocks(m);
    // Rule 2 only engages below the recall width — pin the cap to 1.
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'semantic.max_tables', value: '1' },
    ]);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        {
          id: 1,
          tableName: 'users',
          tableComment: '用户表',
          customComment: null,
          checked: true,
          fields: [],
        },
        {
          id: 2,
          tableName: 'orders',
          tableComment: '订单表',
          customComment: null,
          checked: true,
          fields: [],
        },
        // No comments at all → the requiredIds comment fallback hits ''.
        {
          id: 4,
          tableName: 'stats',
          tableComment: null,
          customComment: null,
          checked: true,
          fields: [],
        },
      ],
    });
    // 4 candidates > semantic.max_tables 1 → rule 2 engages. id 99 is not in
    // the datasource (the "table missing" requiredIds arm).
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
      { id: 4, tableName: 'stats', checked: true },
      { id: 99, tableName: 'ghost', checked: true },
    ]);
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: { users: '用户主表', orders: '订单主表', stats: '统计表' },
      fieldNotes: {},
    });

    // The question names `users` explicitly and mentions the orders COMMENT.
    await run(1, () =>
      collect(m.service.runPipeline(1, '统计users和订单表的数量')),
    );

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as {
      tableIds?: number[];
    };
    // Both explicitly carried tables survive the semantic cap; ghost (99) is
    // not in the datasource so it can never be required.
    expect(sqlCtx.tableIds).toEqual([1, 2]);
  });

  it('rule 2 does NOT narrow at the default cap (a Top-3-sized set ≤ 3)', async () => {
    const m = makeService();
    happyMocks(m);
    const table = (id: number, tableName: string) => ({
      id,
      tableName,
      tableComment: null,
      customComment: null,
      checked: true,
      fields: [],
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [table(1, 'users'), table(2, 'orders'), table(3, 'products')],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
      { id: 3, tableName: 'products', checked: true },
    ]);
    // only ONE candidate has a meaning — enough to narrow under the old cap
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: { users: '用户主表' },
      fieldNotes: {},
    });

    // the question names `users` → the clarify gate stays closed
    await run(1, () => collect(m.service.runPipeline(1, '统计users的数量')));

    // No pre-gate candidate load: the only semantic read is the final
    // decoration, and every recalled table stays stuffed.
    expect(m.semanticService.effectiveAnnotations).toHaveBeenCalledTimes(1);
    expect(m.semanticService.effectiveAnnotations).toHaveBeenCalledWith(1, [
      'users',
      'orders',
      'products',
    ]);
    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as { tableIds?: number[] };
    expect(sqlCtx.tableIds).toEqual([1, 2, 3]);
  });
});

describe('ChatService row-permission filter deep arms', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('folds filter reasoning/content/usage into the sql log and keeps the original SQL on a null filter result', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    const usage = { promptTokens: 7, completionTokens: 8, totalTokens: 15 };
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [],
        },
        { type: 'reasoning', delta: 'merging' },
        { type: 'content', delta: '{"sql":' },
        { type: 'usage', usage },
        { type: 'result', data: null },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    // Null filterResult (unparseable) → fall through with the ORIGINAL SQL.
    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM users',
    );
    expect(events.filter((e) => e.type === 'sql')).toHaveLength(1);
    // Filter reasoning/content fold into the same sql log row; the filter
    // usage fills in because generateSql emitted none.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reasoningContent: 'thinkingmerging',
          tokenUsage: usage,
        }),
      }),
    );
  });

  it('keeps the original SQL when the filter re-gen succeeds without SQL text', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'result', data: { success: true, sql: '' } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(m.datasourceService.execSql).toHaveBeenCalledWith(
      1,
      'SELECT * FROM users',
    );
    expect(events.filter((e) => e.type === 'sql')).toHaveLength(1);
  });

  it('fails the record when the re-generated filtered SQL fails re-safety', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'result', data: { success: true, sql: 'DROP TABLE users' } },
      ]),
    );
    // 1st validate: original SQL ok. 2nd validate: filtered SQL rejected.
    m.sqlSafety.validate
      .mockReturnValueOnce({ ok: true, tables: ['users'] })
      .mockReturnValueOnce({ ok: false, tables: [], reason: '禁止删除表' });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toContain('error');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '禁止删除表',
    );
    expect(m.datasourceService.execSql).not.toHaveBeenCalled();
    // The sql log row is errored under the filter operate tag.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL_WITH_PERMISSIONS',
        }),
      }),
    );
  });

  it('falls back to filterSafetyFailed when the re-safety rejection has no reason', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'result', data: { success: true, sql: 'DELETE FROM users' } },
      ]),
    );
    m.sqlSafety.validate
      .mockReturnValueOnce({ ok: true, tables: ['users'] })
      .mockReturnValueOnce({ ok: false, tables: [] });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '行权限 SQL 安全校验失败',
    );
  });

  it('renders non-Error exec failures via String()', async () => {
    const m = makeService();
    happyMocks(m);
    m.datasourceService.execSql.mockRejectedValue('raw string failure');

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'SQL 执行失败: raw string failure',
    );
  });
});

describe('ChatService chart step + quota charging + guess-question warmer', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('streams chart content deltas and skips persistence when no chart result', async () => {
    const m = makeService();
    happyMocks(m);
    const usage = { promptTokens: 2, completionTokens: 2, totalTokens: 4 };
    m.generatorService.generateChart.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 's' },
          ],
        },
        { type: 'content', delta: 'chart-text' },
        { type: 'usage', usage },
        { type: 'result', data: null },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    // Content deltas stream as chart-result frames; no chart event and no
    // chart persistence because chartResult is null — the turn still finishes.
    expect(types(events)).toBe(
      'id,question,datasource,info,sql-result,sql,brief,info,sql-data,info,chart-result,finish',
    );
    expect(events.find((e) => e.type === 'chart-result')!.data).toEqual({
      content: 'chart-text',
    });
    expect(
      m.prisma.chatRecord.update.mock.calls.some(
        (c) =>
          (c[0] as { data: Record<string, unknown> }).data.chart !== undefined,
      ),
    ).toBe(false);
    // Chart endLog carries the appended-AI messages + the usage snapshot.
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tokenUsage: usage,
          messages: [
            { type: 'system', queryprism_system: false, content: 's' },
            { type: 'ai', queryprism_system: false, content: 'chart-text' },
          ],
        }),
      }),
    );
  });

  it('skips the char reservation for an empty prompt and charges output only', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: [] }, // 0 chars → nothing reserved
        { type: 'content', delta: 'ab' },
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

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    expect(m.quota.reserveChars).not.toHaveBeenCalled();
    expect(m.quota.chargeChars).toHaveBeenCalledWith(
      1,
      { type: 'user', id: 7 },
      2,
    );
  });

  it('reserves only once across repeated messages events', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    const msg = [{ type: 'system', queryprism_system: false, content: 'abcd' }];
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'messages', messages: msg },
        { type: 'messages', messages: msg },
        {
          type: 'result',
          data: {
            success: true,
            sql: 'SELECT 1',
            tables: [],
            chartType: 'table',
            brief: '',
          },
        },
      ]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    expect(m.quota.reserveChars).toHaveBeenCalledTimes(1);
    expect(m.quota.reserveChars).toHaveBeenCalledWith(
      1,
      { type: 'user', id: 7 },
      4,
    );
  });

  it('survives a failing output charge (warn only, pipeline unaffected)', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.chargeChars.mockRejectedValue(new Error('charge write failed'));
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );
    await flush();

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(warn).toHaveBeenCalledWith(
      'quota output charge failed: charge write failed',
    );
    warn.mockRestore();
  });

  it('rethrows a mid-stream quota exhaustion localized at the top-level catch', async () => {
    const m = makeService();
    happyMocks(m);
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    // The keyword-extraction pre-step reserves first and blows the budget.
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 'abcdef' },
          ],
        },
      ]),
    );
    m.quota.reserveChars.mockRejectedValue(new QuotaExceededError(300));

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toContain('error');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '今日 LLM 交互字数预算（300 字）已用完，请明天再试或联系管理员调整',
    );
  });

  it('renders non-Error pipeline failures via String()', async () => {
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
    m.datasourceService.findAll.mockRejectedValue('raw string boom');

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'raw string boom',
    );
  });

  it('warms the recommended-question cache on first success (fire-and-forget)', async () => {
    const m = makeService();
    happyMocks(m);
    // Not yet cached → the background warmer runs after the finish frame.
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    // No prior finished question → the warmer recalls with the empty string.
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );
    await flush();
    await flush();

    expect(types(events)).toContain('finish');
    expect(m.generatorService.generateGuessQuestion).toHaveBeenCalled();
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { recommendedQuestion: ['推荐1'] },
    });
  });

  it('skips the cache write when the guess returns no questions', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'result', data: null }]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询')));
    await flush();
    await flush();

    expect(m.generatorService.generateGuessQuestion).toHaveBeenCalled();
    expect(m.prisma.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recommendedQuestion: expect.anything(),
        }),
      }),
    );
  });

  it('treats a spent budget in the warmer as a silent skip', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    // The guess call's own reservation blows the budget (the extraction
    // pre-step emits no messages event, so nothing reserved before it).
    m.quota.reserveChars.mockRejectedValueOnce(new QuotaExceededError(300));
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 'x' },
          ],
        },
        { type: 'result', data: { questions: ['q1'] } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );
    await flush();
    await flush();

    expect(types(events)).not.toContain('error');
    expect(m.prisma.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recommendedQuestion: expect.anything(),
        }),
      }),
    );
  });

  it('aborts the warmer silently when the datasource engine is unsupported', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    // The main flow resolves sqlite (3 findOne calls); the warmer's 4th call
    // sees an unmapped type → engine null → early return.
    let calls = 0;
    const sqliteDs = {
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [{ id: 1, tableName: 'users', checked: true, fields: [] }],
    };
    m.datasourceService.findOne.mockImplementation(() => {
      calls += 1;
      return Promise.resolve(
        calls <= 3 ? sqliteDs : { ...sqliteDs, type: 'mongodb' },
      );
    });

    await run(1, () => collect(m.service.runPipeline(1, '查询')));
    await flush();
    await flush();

    expect(m.generatorService.generateGuessQuestion).not.toHaveBeenCalled();
    expect(m.prisma.chat.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          recommendedQuestion: expect.anything(),
        }),
      }),
    );
  });
});

describe('ChatService CRUD + record-read error branches', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it.each([
    ['findOne', (s: ChatService) => s.findOne(1)],
    ['getWithData', (s: ChatService) => s.getWithData(1)],
    ['rename', (s: ChatService) => s.rename(1, 't')],
    ['renameBrief', (s: ChatService) => s.renameBrief(1, 'b')],
    ['remove', (s: ChatService) => s.remove(1)],
    ['getRecommendQuestions', (s: ChatService) => s.getRecommendQuestions(1)],
  ])('%s 404s on a missing chat', async (_name, call) => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue(null);
    await expect(run(1, () => call(m.service))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('renameBrief updates both title and brief together', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({ id: 1, oid: 1 });
    m.prisma.chat.update.mockResolvedValue({ id: 1 });

    await run(1, () => m.service.renameBrief(1, '销售看板'));

    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { title: '销售看板', brief: '销售看板' },
    });
  });

  it.each([
    ['getRecordData', (s: ChatService) => s.getRecordData(1, 9)],
    ['getRecordDataLive', (s: ChatService) => s.getRecordDataLive(1, 9)],
    ['getPredictData', (s: ChatService) => s.getPredictData(1, 9)],
    ['getRecordLogs', (s: ChatService) => s.getRecordLogs(1, 9)],
    ['getRecordUsage', (s: ChatService) => s.getRecordUsage(1, 9)],
    ['getRecordLogHistory', (s: ChatService) => s.getRecordLogHistory(9)],
    ['exportRecordExcel', (s: ChatService) => s.exportRecordExcel(1, 9)],
  ])('%s 404s on a missing record', async (_name, call) => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(run(1, () => call(m.service))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('getRecordData returns the empty shape when no result was persisted', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sqlExecResult: null }),
    );

    const data = await run(1, () => m.service.getRecordData(1, 100));

    expect(data).toEqual({ fields: [], fields_info: null, data: [] });
  });

  it('getRecordDataLive 400s when the chat has no datasource', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
    });
    await expect(
      run(1, () => m.service.getRecordDataLive(1, 100)),
    ).rejects.toThrow(BadRequestException);
  });

  it('getRecordChartData returns raw rows + truncation flag + chartType', async () => {
    const m = makeService();
    // config.get returns undefined → limitRows falls back to the 500 default.
    m.config.get.mockImplementation(() => undefined);
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({
        sqlExecResult: { columns: ['n'], rows },
        chartType: 'bar',
      }),
    );

    const shape = await run(1, () => m.service.getRecordChartData(1, 100));

    expect(shape).toEqual({
      columns: ['n'],
      rows,
      truncated: true, // rows.length 500 >= limitRows 500
      chartType: 'bar',
    });
  });

  it('getRecordChartData degrades to empty rows with truncated=false', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ sqlExecResult: null, chartType: null }),
    );

    const shape = await run(1, () => m.service.getRecordChartData(1, 100));

    expect(shape).toEqual({
      columns: [],
      rows: [],
      truncated: false,
      chartType: null,
    });
  });

  it('getPredictData coerces a corrupt stored payload to []', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(
      sourceRecord({ predictData: 'not-a-list' }),
    );
    const data = await run(1, () => m.service.getPredictData(1, 100));
    expect(data).toEqual([]);
  });

  it('findChatIdByRecord resolves the chat id (and 404s when missing)', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue({ chatId: 7 });

    const chatId = await run(1, () => m.service.findChatIdByRecord(100));
    expect(chatId).toBe(7);
    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        id: 100,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      select: { chatId: true },
    });

    m.prisma.chatRecord.findFirst.mockResolvedValue(null);
    await expect(
      run(1, () => m.service.findChatIdByRecord(999)),
    ).rejects.toThrow(NotFoundException);
  });

  it('exportRecordExcel falls back to the latest record when rid is omitted', async () => {
    const m = makeService();
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());

    const buf = await run(1, () => m.service.exportRecordExcel(1));

    expect(m.prisma.chatRecord.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(Buffer.isBuffer(buf)).toBe(true);
  });

  it('getRecentQuestions filters by datasource and skips null questions', async () => {
    const m = makeService();
    m.prisma.chatRecord.findMany.mockResolvedValue([
      { question: null },
      { question: 'q1' },
      { question: 'q1' },
    ]);

    const res = await run(1, () => m.service.getRecentQuestions(3));

    expect(m.prisma.chatRecord.findMany).toHaveBeenCalledWith({
      where: {
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
        chat: { datasourceId: 3 },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { question: true },
    });
    expect(res).toEqual({ questions: ['q1'] });
  });

  it('getRecommendQuestions returns empty lists for a datasource-less chat', async () => {
    const m = makeService();
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      recommendedQuestion: null,
    });

    const res = await run(1, () => m.service.getRecommendQuestions(1));

    expect(res).toEqual({ questions: [], recommended: [] });
    expect(m.prisma.dsRecommendedProblem.findMany).not.toHaveBeenCalled();
  });
});

describe('ChatService runRecommendQuestions edges', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('emits the empty terminal when the chat is missing or datasource-less', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: 'q',
    });
    m.prisma.chat.findFirst.mockResolvedValue(null);

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );
    expect(types(events)).toBe('recommended_question,finish');
    expect(events[0].data).toEqual({ content: '[]' });

    const m2 = makeService();
    happyMocks(m2);
    m2.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: 'q',
    });
    m2.prisma.chat.findFirst.mockResolvedValue({ datasourceId: null });

    const events2 = await run(1, () =>
      collect(m2.service.runRecommendQuestions(100)),
    );
    expect(types(events2)).toBe('recommended_question,finish');
    expect(m2.generatorService.generateGuessQuestion).not.toHaveBeenCalled();
  });

  it('emits the empty terminal when the datasource engine is unsupported', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: 'q',
    });
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'mongodb',
      tables: [],
    });

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe('recommended_question,finish');
    expect(events[0].data).toEqual({ content: '[]' });
    expect(m.generatorService.generateGuessQuestion).not.toHaveBeenCalled();
  });

  it('localizes a quota exhaustion raised mid-stream', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: '查询',
    });
    m.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m.quota.reserveChars.mockRejectedValue(new QuotaExceededError(200));
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'messages',
          messages: [
            { type: 'system', queryprism_system: false, content: 'x' },
          ],
        },
        { type: 'result', data: { questions: ['q1'] } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe('error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '今日 LLM 交互字数预算（200 字）已用完，请明天再试或联系管理员调整',
    );
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });

  it('renders non-Error generator failures via String()', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: '查询',
    });
    m.generatorService.generateGuessQuestion.mockImplementation(() => {
      // deliberate non-Error throw: exercises the String(e) arm
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'raw string boom';
    });

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe('error,finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'raw string boom',
    );
  });

  it('emits the empty terminal and skips persistence when no questions come back', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: '查询',
    });
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'result', data: null }]),
    );

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );

    expect(types(events)).toBe('recommended_question,finish');
    expect(events[0].data).toEqual({ content: '[]' });
    expect(m.prisma.chat.update).not.toHaveBeenCalled();
  });
});

describe('ChatService helpers (ALS guards, history rounds, chat cap, keyword sentinels)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('throws UnauthorizedException when no request context carries the oid', async () => {
    const m = makeService();
    await expect(m.service.findAll()).rejects.toThrow(UnauthorizedException);
  });

  it('throws UnauthorizedException when the context user has no id', async () => {
    const m = makeService();
    await expect(
      requestContextStorage.run(
        { user: { account: 'noid', oid: 1, language: 'zh-CN' } } as never,
        () => m.service.findOne(1),
      ),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('falls back to English when the profile language is absent', async () => {
    const m = makeService();
    happyMocks(m);
    // Kana is neither zh nor en → detectLang falls back to the profile
    // language, which is missing here → 'en'.
    await requestContextStorage.run(
      { user: { id: 1, account: 'tester', oid: 1 } } as never,
      () => collect(m.service.runPipeline(1, 'こんにちは')),
    );

    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en' }),
    );
  });

  it('history rounds replay clarify answers and every sqlAnswer/brief/sql fallback', async () => {
    const m = makeService();
    happyMocks(m);
    // historyRounds falls back to 3 when the config value is missing.
    m.config.get.mockImplementation((key: string) =>
      key === 'chat.historyRounds' ? undefined : 20,
    );
    m.prisma.chatRecord.findMany.mockResolvedValue([
      // sql fallback (sqlAnswer + brief both null) + plain question round
      {
        question: 'q1',
        sqlAnswer: null,
        brief: null,
        sql: 'SELECT 1',
        clarifyAnswer: null,
      },
      // brief fallback + picked table names (mixed with junk) + legacy text
      {
        question: 'q2',
        sqlAnswer: null,
        brief: 'b2',
        sql: null,
        clarifyAnswer: { table_names: ['users', 9, null], text: 't2' },
      },
      // no answer at all (all null) + a string clarifyAnswer (corrupt)
      {
        question: 'q3',
        sqlAnswer: null,
        brief: null,
        sql: null,
        clarifyAnswer: 'corrupt',
      },
      // sqlAnswer primary + multi-round texts with junk entries
      {
        question: 'q4',
        sqlAnswer: 'a4',
        brief: null,
        sql: null,
        clarifyAnswer: { texts: [42, '   ', 'ok4'] },
      },
      // array clarifyAnswer (corrupt) → plain question
      {
        question: 'q5',
        sqlAnswer: null,
        brief: null,
        sql: null,
        clarifyAnswer: [],
      },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as {
      history: Array<{ role: string; content: string }>;
    };
    // The loader treats the (desc-ordered) mock rows as newest-first and
    // replays them chronologically reversed.
    expect(sqlCtx.history).toEqual([
      { role: 'user', content: 'q5' },
      { role: 'user', content: 'q4（ok4）' },
      { role: 'assistant', content: 'a4' },
      { role: 'user', content: 'q3' },
      { role: 'user', content: 'q2（涉及表：users；t2）' },
      { role: 'assistant', content: 'b2' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'SELECT 1' },
    ]);
  });

  it('maintainChatLimit deletes the oldest surplus chats over the cap', async () => {
    const m = makeService();
    m.datasourceService.findOne.mockResolvedValue({ id: 1, type: 'sqlite' });
    m.prisma.chat.create.mockResolvedValue({ id: 5, oid: 1 });
    m.prisma.chatRecord.create.mockResolvedValue({ id: 51 });
    // No saved chat.chatLimit row → default 20; 21 chats → 1 surplus.
    m.config.get.mockImplementation(() => undefined);
    m.prisma.chat.count.mockResolvedValue(21);
    m.prisma.chat.findMany.mockResolvedValue([{ id: 99 }]);

    await run(1, () => m.service.start());

    expect(m.prisma.chat.findMany).toHaveBeenCalledWith({
      where: { oid: 1, createBy: 1 },
      orderBy: { updatedAt: 'asc' },
      take: 1,
    });
    expect(m.prisma.chat.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [99] } },
    });
  });

  it('maintainChatLimit skips the delete when the surplus query comes back empty', async () => {
    const m = makeService();
    m.prisma.chat.create.mockResolvedValue({ id: 5, oid: 1 });
    m.prisma.chat.count.mockResolvedValue(3); // > limit 2
    m.prisma.chat.findMany.mockResolvedValue([]);
    m.config.get.mockImplementation((key: string) =>
      key === 'chat.chatLimit' ? 2 : undefined,
    );

    await run(1, () => m.service.start());

    expect(m.prisma.chat.deleteMany).not.toHaveBeenCalled();
  });

  it('keyword extraction returns null for the ERROR:NOT_DATA_QUERY sentinel', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        { type: 'content', delta: 'ERROR:NOT_DATA_QUERY:闲聊' },
      ]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '你好呀')));

    // The sentinel is not a rejection: recall runs with the raw question and
    // nothing is persisted.
    expect(m.semanticService.expandKeywordsByAliases).not.toHaveBeenCalled();
    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '你好呀',
      expect.objectContaining({ keywords: null }),
    );
    expect(
      m.prisma.chatRecord.update.mock.calls.some(
        (c) =>
          (c[0] as { data: Record<string, unknown> }).data.extractedKeywords !==
          undefined,
      ),
    ).toBe(false);
  });

  it('keyword extraction with no content delta degrades to raw-question recall', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'reasoning', delta: 'thinking only' }]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    expect(m.datasourceService.recallTables).toHaveBeenCalledWith(
      1,
      '查询',
      expect.objectContaining({ keywords: null }),
    );
  });

  it('keyword extraction renders non-Error failures via String() in the warn', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockImplementation(() => {
      // deliberate non-Error throw: exercises the String(e) arm
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'raw kw boom';
    });
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(warn).toHaveBeenCalledWith(
      'keyword extraction failed, recalling with the raw question: raw kw boom',
    );
    warn.mockRestore();
  });

  it('findOne returns the loaded chat on the happy path', async () => {
    const m = makeService();
    const chat = { id: 1, oid: 1, title: 't' };
    m.prisma.chat.findFirst.mockResolvedValue(chat);

    const found = await run(1, () => m.service.findOne(1));

    expect(found).toBe(chat);
    expect(m.prisma.chat.findFirst).toHaveBeenCalledWith({
      where: {
        id: 1,
        oid: 1,
        OR: [{ createBy: 1 }, { createBy: null }],
      },
      include: {
        datasource: { include: { tables: { include: { fields: true } } } },
        records: { orderBy: { createdAt: 'asc' } },
      },
    });
  });
});

describe('ChatService mid-stream generator failures + fire-and-forget catches', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('runAnalysis contains a generator crash: log errored + error frame + analysis_finish', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.generatorService.generateAnalysis.mockImplementation(() => {
      throw new Error('analysis LLM down');
    });

    const events = await run(1, () => collect(m.service.runAnalysis(1, 100)));

    expect(types(events)).toBe('id,info,error,analysis_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'analysis LLM down',
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
    expect(m.prisma.chatRecord.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: { finish: true, error: 'analysis LLM down' },
    });
  });

  it('runPredict contains a generator crash: log errored + predict-failed + finish', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.generatorService.generatePredict.mockImplementation(() => {
      throw new Error('predict LLM down');
    });

    const events = await run(1, () => collect(m.service.runPredict(1, 100)));

    expect(types(events)).toBe('id,info,error,predict-failed,predict_finish');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'predict LLM down',
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('a filter-generator crash errors under the GENERATE_SQL_WITH_PERMISSIONS tag', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockImplementation(() => {
      throw new Error('filter LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'filter LLM down',
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          operate: 'GENERATE_SQL_WITH_PERMISSIONS',
        }),
      }),
    );
  });

  it('a chart-generator crash errors the chart log and fails the record', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.generateChart.mockImplementation(() => {
      throw new Error('chart LLM down');
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toContain('error');
    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      'chart LLM down',
    );
    expect(m.prisma.chatLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ operate: 'GENERATE_CHART' }),
      }),
    );
    expect(m.prisma.chatLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          error: true,
          endedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('the runCore finish audit failure only warns', async () => {
    const m = makeService();
    happyMocks(m);
    m.audit.record.mockRejectedValue(new Error('audit down'));
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );
    await flush();

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(warn).toHaveBeenCalledWith('audit failed: audit down');
    warn.mockRestore();
  });

  it('a non-quota guess-warmer crash is rethrown into the void-catch warn', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    m.generatorService.generateGuessQuestion.mockImplementation(() => {
      throw new Error('guess LLM down');
    });
    const warn = jest
      .spyOn(
        (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );
    await flush();
    await flush();

    // The main turn is unaffected; the warmer's crash only logs.
    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
    expect(warn).toHaveBeenCalledWith('guess failed: guess LLM down');
    warn.mockRestore();
  });

  it('re-offers a surviving prior-round candidate in the clarify options', async () => {
    const m = makeService();
    happyMocks(m);
    // Multi-round clarify: the record already paused once (round 1) but the
    // budget (max_rounds 2) still has room, so the gate may ask again.
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'clarify.max_rounds', value: '2' },
    ]);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      ...pendingClarifyRecord(1),
      clarify: {
        round: 1,
        max_select: 3,
        // payments (4) is checked and outside this run's recall pool → it
        // survives into the option list; ghost (77) does not exist.
        candidates: [
          { table_id: 4, table_name: 'payments', comment: '' },
          { table_id: 77, table_name: 'ghost', comment: '' },
        ],
      },
    });
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        { id: 1, tableName: 'users', checked: true, fields: [] },
        { id: 2, tableName: 'orders', checked: true, fields: [] },
        { id: 3, tableName: 'products', checked: true, fields: [] },
        { id: 4, tableName: 'payments', checked: true, fields: [] },
      ],
    });
    // Recall narrows to 3 candidates; nothing explicitly mentioned → the gate
    // fires and the offered pool = recall + prior round's payments.
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
      { id: 3, tableName: 'products', checked: true },
    ]);

    const events = await run(1, () =>
      collect(
        m.service.resumeClarified(100, { text: '统计一下数量', round: 1 }),
      ),
    );

    const clarify = events.find((e) => e.type === 'clarify');
    expect(clarify).toBeDefined();
    const names = clarify!.data.candidates.map(
      (c: { table_name: string }) => c.table_name,
    );
    expect(names).toEqual(['users', 'orders', 'products', 'payments']);
  });
});

// The remaining arms: unknown LLM event types falling through the dispatch
// chains, non-Error rejections rendered via String() in the fire-and-forget
// catches, and a few helper fallbacks (findAll limit, recent-question cap,
// history extras absent, metric force-stuff with nothing to add).
describe('ChatService remaining dispatch/catch arms', () => {
  beforeEach(() => setI18n(createTestI18n()));

  const bogus = { type: 'bogus' } as unknown as LlmGenEvent;

  it('ignores unknown generator event types in the select-datasource loop', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: null,
      engineType: null,
      title: '新对话',
      origin: 0,
      recommendedQuestion: ['已缓存推荐'],
    });
    m.datasourceService.findAll.mockResolvedValue([
      { id: 2, name: 'ds2', description: null, type: 'sqlite' },
    ]);
    m.aiQuestionService.buildForSelectDatasource.mockReturnValue({});
    m.generatorService.selectDatasource.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
        { type: 'result', data: { datasourceId: 2 } },
      ]),
    );
    m.datasourceService.findOne.mockResolvedValue({
      id: 2,
      name: 'ds2',
      type: 'sqlite',
      tables: [{ id: 5, tableName: 'orders', checked: true, fields: [] }],
    });

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询订单')),
    );

    // The unknown event is skipped silently; the run still completes.
    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
  });

  it('ignores unknown event types in the analysis and predict loops', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
    m.generatorService.generateAnalysis.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
        { type: 'result', data: { analysis: '分析' } },
      ]),
    );
    m.generatorService.generatePredict.mockReturnValue(
      asyncFrom<LlmGenEvent>([bogus, { type: 'result', data: null }]),
    );

    const analysis = await run(1, () => collect(m.service.runAnalysis(1, 100)));
    expect(types(analysis)).toContain('analysis_finish');

    const predict = await run(1, () => collect(m.service.runPredict(1, 100)));
    expect(types(predict)).toContain('predict_finish');
  });

  it('ignores unknown event types in the sql, chart and keyword loops', async () => {
    const m = makeService();
    happyMocks(m);
    m.generatorService.extractKeywords.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
        {
          type: 'usage',
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        },
        { type: 'content', delta: '用户' },
      ]),
    );
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
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
    m.generatorService.generateChart.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
        { type: 'result', data: { chartType: 'bar', config: {} } },
      ]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
  });

  it('ignores unknown event types in the recommend + guess loops', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      chatId: 1,
      question: 'q',
    });
    m.generatorService.generateGuessQuestion.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        bogus,
        { type: 'result', data: { questions: ['q1'] } },
      ]),
    );
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });

    const events = await run(1, () =>
      collect(m.service.runRecommendQuestions(100)),
    );
    expect(types(events)).toBe('recommended_question,finish');

    // The warmer (same generator) also drains the bogus event unharmed.
    await run(1, () => collect(m.service.runPipeline(1, '查询')));
    await flush();
    await flush();
    expect(m.prisma.chat.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { recommendedQuestion: ['q1'] },
    });
  });

  it('renders non-Error audit/metric/charge rejections via String() in warns', async () => {
    // runCore finish audit
    const m1 = makeService();
    happyMocks(m1);
    m1.audit.record.mockRejectedValue('raw audit boom');
    const warn1 = jest
      .spyOn(
        (m1.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await run(1, () => collect(m1.service.runPipeline(1, '查询')));
    await flush();
    expect(warn1).toHaveBeenCalledWith('audit failed: raw audit boom');
    warn1.mockRestore();

    // metric dictionary
    const m2 = makeService();
    happyMocks(m2);
    m2.metricService.matchDefinitions.mockRejectedValue('raw metric boom');
    const warn2 = jest
      .spyOn(
        (m2.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await run(2, () => collect(m2.service.runPipeline(1, '查询')));
    expect(warn2).toHaveBeenCalledWith(
      'metric definitions skipped: raw metric boom',
    );
    warn2.mockRestore();

    // quota output charge
    const m3 = makeService();
    happyMocks(m3);
    m3.quota.currentSubject.mockReturnValue({ type: 'user', id: 7 });
    m3.quota.chargeChars.mockRejectedValue('raw charge boom');
    const warn3 = jest
      .spyOn(
        (m3.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await run(1, () => collect(m3.service.runPipeline(1, '查询')));
    await flush();
    expect(warn3).toHaveBeenCalledWith(
      'quota output charge failed: raw charge boom',
    );
    warn3.mockRestore();

    // guess warmer
    const m4 = makeService();
    happyMocks(m4);
    m4.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: 0,
      recommendedQuestion: null,
    });
    m4.generatorService.generateGuessQuestion.mockImplementation(() => {
      // deliberate non-Error throw: exercises the String(e) arm
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'raw guess boom';
    });
    const warn4 = jest
      .spyOn(
        (m4.service as unknown as { logger: { warn: jest.Mock } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    await run(1, () => collect(m4.service.runPipeline(1, '查询')));
    await flush();
    await flush();
    expect(warn4).toHaveBeenCalledWith('guess failed: raw guess boom');
    warn4.mockRestore();

    // analysis + predict audits
    for (const generator of ['generateAnalysis', 'generatePredict'] as const) {
      const m = makeService();
      happyMocks(m);
      m.prisma.chatRecord.findFirst.mockResolvedValue(sourceRecord());
      m.audit.record.mockRejectedValue('raw audit boom');
      const warn = jest
        .spyOn(
          (m.service as unknown as { logger: { warn: jest.Mock } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const events =
        generator === 'generateAnalysis'
          ? await run(1, () => collect(m.service.runAnalysis(1, 100)))
          : await run(1, () => collect(m.service.runPredict(1, 100)));
      await flush();
      expect(types(events)).not.toContain('error');
      expect(warn).toHaveBeenCalledWith('audit failed: raw audit boom');
      warn.mockRestore();
    }
  });

  it('skips metric force-stuff when recall degraded or nothing new is atomic', async () => {
    // Recall degraded (tableIds undefined): the metric text is injected but
    // the force-stuff block is skipped entirely.
    const m1 = makeService();
    happyMocks(m1);
    m1.datasourceService.recallTables.mockResolvedValue([]);
    m1.metricService.matchDefinitions.mockResolvedValue({
      text: '<metric_definitions>口径</metric_definitions>',
      atomicTableNames: ['users'],
      matched: 1,
    });
    await run(1, () => collect(m1.service.runPipeline(1, '查订单量')));
    const ctx1 = m1.aiQuestionService.buildSqlContext.mock.calls.at(-1)![0] as {
      tableIds?: number[];
      metrics?: string;
    };
    expect(ctx1.metrics).toBe('<metric_definitions>口径</metric_definitions>');
    expect(ctx1.tableIds).toBeUndefined();

    // Recall hit users and the metric's only atomic table is already stuffed
    // → extraIds is empty → tableIds unchanged.
    const m2 = makeService();
    happyMocks(m2);
    m2.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
    ]);
    m2.metricService.matchDefinitions.mockResolvedValue({
      text: '<metric_definitions>口径</metric_definitions>',
      atomicTableNames: ['users'],
      matched: 1,
    });
    await run(1, () => collect(m2.service.runPipeline(1, '查订单量')));
    const ctx2 = m2.aiQuestionService.buildSqlContext.mock.calls.at(-1)![0] as {
      tableIds?: number[];
    };
    expect(ctx2.tableIds).toEqual([1]);
  });

  it('skips naming injection when naming is disabled but metrics stay on', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'naming.enabled', value: 'false' },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查订单')));

    expect(m.metricService.matchDefinitions).toHaveBeenCalled();
    expect(m.standardService.namingTemplateFor).not.toHaveBeenCalled();
    expect(m.aiQuestionService.buildSqlContext).toHaveBeenCalledWith(
      expect.objectContaining({ namingRules: '' }),
    );
  });

  it('uses the default filter failure message when the re-gen gives none', async () => {
    const m = makeService();
    happyMocks(m);
    m.rowPermissionService.isNormalUser.mockReturnValue(true);
    m.rowPermissionService.getRowFilters.mockResolvedValue([
      { table: 'users', filter: '(`age` > 18)' },
    ]);
    m.generatorService.generateFilter.mockReturnValue(
      asyncFrom<LlmGenEvent>([{ type: 'result', data: { success: false } }]),
    );

    const events = await run(1, () =>
      collect(m.service.runPipeline(1, '查询')),
    );

    expect(events.find((e) => e.type === 'error')!.data.content).toBe(
      '行权限过滤条件生成失败',
    );
  });

  it('renders a bare candidate_tables line for options with no meaning/comment', async () => {
    const m = makeService();
    happyMocks(m);
    // Rule 2 only engages below the recall width — pin the cap to 1 (2 > 1).
    m.prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'semantic.max_tables', value: '1' },
    ]);
    m.datasourceService.findOne.mockResolvedValue({
      id: 1,
      name: 'main',
      type: 'sqlite',
      tableRelation: [],
      tables: [
        {
          id: 1,
          tableName: 'users',
          tableComment: '用户表',
          customComment: null,
          checked: true,
          fields: [],
        },
        // No comments at all → the rendered line is just `- orders`.
        {
          id: 2,
          tableName: 'orders',
          tableComment: null,
          customComment: null,
          checked: true,
          fields: [],
        },
      ],
    });
    m.datasourceService.recallTables.mockResolvedValue([
      { id: 1, tableName: 'users', checked: true },
      { id: 2, tableName: 'orders', checked: true },
    ]);
    // Semantics cover only users → rule 2 narrows the schema to [1]; orders
    // stays out of the stuffed set and is offered as a candidate.
    m.semanticService.effectiveAnnotations.mockResolvedValue({
      tableMeanings: { users: '用户主表' },
      fieldNotes: {},
    });
    m.generatorService.generateSql.mockReturnValue(
      asyncFrom<LlmGenEvent>([
        {
          type: 'result',
          data: {
            success: false,
            needClarify: true,
            reason: '需要订单',
            sql: '',
            tables: ['orders'],
            chartType: '',
            brief: '',
          },
        },
      ]),
    );

    await run(1, () => collect(m.service.runPipeline(1, '统计一下整体情况')));

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls[0][0] as {
      tableIds?: number[];
      candidateTables?: string;
    };
    expect(sqlCtx.tableIds).toEqual([1]);
    expect(sqlCtx.candidateTables).toBe('- orders');
  });

  it('thread a null chat origin through regenerate and resume into runCore', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '用户查询',
      origin: null,
      recommendedQuestion: ['已缓存推荐'],
    });
    m.prisma.chatRecord.findFirst.mockResolvedValue({
      id: 50,
      chatId: 1,
      question: '查询所有用户',
    });

    const events = await run(1, () => collect(m.service.regenerate(1, 50)));
    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
  });

  it('resumes with a null-origin chat through runCore', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findFirst.mockResolvedValue(pendingClarifyRecord(1));
    m.prisma.chat.findFirst.mockResolvedValue({
      id: 1,
      oid: 1,
      datasourceId: 1,
      engineType: 'SQLite',
      title: '新对话',
      origin: null,
      recommendedQuestion: ['已缓存推荐'],
    });

    const events = await run(1, () =>
      collect(m.service.resumeClarified(100, { skip: true, round: 1 })),
    );
    expect(types(events)).toContain('finish');
    expect(types(events)).not.toContain('error');
  });

  it('findAll honors an explicit limit argument', async () => {
    const m = makeService();
    const ts = (s: string) => new Date(s);
    m.prisma.chat.findMany.mockResolvedValue([
      { id: 1, createdAt: ts('2026-01-03'), records: undefined },
      {
        id: 2,
        createdAt: ts('2026-01-02'),
        records: [{ createdAt: ts('2026-01-05') }],
      },
      { id: 3, createdAt: ts('2026-01-04'), records: [] },
    ]);

    const res = await run(1, () => m.service.findAll(2));

    // records undefined coalesces to the chat's own createdAt; the explicit
    // limit caps the result.
    expect(res.map((c: { id: number }) => c.id)).toEqual([2, 3]);
  });

  it('caps recent questions at 20 and stops scanning', async () => {
    const m = makeService();
    m.prisma.chatRecord.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ question: `q${i}` })),
    );

    const res = await run(1, () => m.service.getRecentQuestions());

    expect(res.questions).toHaveLength(20);
    expect(res.questions[0]).toBe('q0');
    expect(res.questions.at(-1)).toBe('q19');
  });

  it('findAll falls back to the default cap when the config value is absent', async () => {
    const m = makeService();
    m.config.get.mockImplementation(() => undefined);
    m.prisma.chat.findMany.mockResolvedValue(
      Array.from({ length: 22 }, (_, i) => ({
        id: i + 1,
        createdAt: new Date(2026, 0, i + 1),
        records: [],
      })),
    );

    const res = await run(1, () => m.service.findAll());

    // No explicit limit + no config row → hardcoded default 20.
    expect(res).toHaveLength(20);
  });

  it('history extras collapse to the plain question when the answer is skip-only', async () => {
    const m = makeService();
    happyMocks(m);
    m.prisma.chatRecord.findMany.mockResolvedValue([
      {
        question: 'q6',
        sqlAnswer: 'a6',
        brief: null,
        sql: null,
        // A valid clarify answer OBJECT with no table names and no texts.
        clarifyAnswer: { skip: true },
      },
    ]);

    await run(1, () => collect(m.service.runPipeline(1, '查询')));

    const sqlCtx = m.aiQuestionService.buildSqlContext.mock.calls.at(
      -1,
    )![0] as {
      history: Array<{ role: string; content: string }>;
    };
    expect(sqlCtx.history).toEqual([
      { role: 'user', content: 'q6' },
      { role: 'assistant', content: 'a6' },
    ]);
  });
});
