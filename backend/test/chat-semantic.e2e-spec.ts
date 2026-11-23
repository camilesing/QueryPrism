// Chat semantic e2e — MetaDataImprove M2 rule 2: effective table semantics
// narrow the stuffed schema to semantic.max_tables and the LLM's need_clarify
// contract reuses the M1 clarify flow. Rule 2 only engages BELOW the recall
// width (Top-3), so the narrowing cases pin semantic.max_tables = 1. On the
// prompt side a curated meaning is injected only when an extracted keyword
// equals the table name or one of its aliases (exact-keyword gate). The
// LLM/datasource/safety providers are faked (SSE-block pattern);
// SemanticService is REAL (real Prisma rows seeded per case) so the priority
// resolution and the alias expansion run.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { DatasourceService } from './../src/datasource/datasource.service';
import { AiQuestionService } from './../src/llm/ai-question.service';
import { GeneratorService } from './../src/llm/generator.service';
import type { LlmGenEvent } from './../src/llm/generator.service';
import { SqlSafetyService } from './../src/chat/sql-safety.service';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

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

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

function recordIdFromSse(text: string): number {
  for (const frame of text.split('\n\n')) {
    if (!frame.startsWith('data:')) continue;
    try {
      const ev = JSON.parse(frame.slice('data:'.length)) as {
        type?: string;
        id?: number;
      };
      if (ev.type === 'id' && typeof ev.id === 'number') return ev.id;
    } catch {
      // heartbeat frame — skip
    }
  }
  throw new Error('recordId not found in SSE stream');
}

function sseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice('data:'.length)) as Record<string, unknown>);
}

// recall returns the 3-table ranked subset the semantics narrow from.
const FAKE_TABLES = [
  {
    id: 1,
    tableName: 'sales_order',
    tableComment: '销售订单',
    customComment: null,
    checked: true,
    fields: [],
  },
  {
    id: 2,
    tableName: 'crm_customer',
    tableComment: '客户信息',
    customComment: null,
    checked: true,
    fields: [],
  },
  {
    id: 3,
    tableName: 'inv_stock',
    tableComment: '库存记录',
    customComment: null,
    checked: true,
    fields: [],
  },
  {
    id: 4,
    tableName: 'fin_payment',
    tableComment: '支付流水',
    customComment: null,
    checked: true,
    fields: [],
  },
];

describe('Chat semantic rule 2 (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let capturedTableIds: number[] | undefined;
  /** The semantics buildSqlContext received on the LAST call. */
  let capturedSemantics:
    | { tableMeanings?: Record<string, string>; fieldNotes?: unknown }
    | undefined;
  /** The candidate_tables prompt block buildSqlContext received. */
  let capturedCandidateTables: string | undefined;
  /** How many ranked tables recall returns (1 = no rule-2 narrowing). */
  let recallSlice: number;
  /** Flip the faked generateSql between need_clarify and a normal result. */
  let sqlMode: 'sql' | 'need_clarify';
  /** Tables the faked need_clarify response asks for. */
  let needClarifyTables: string[];
  /** What the faked keyword extraction returns for a turn ('EMPTY' = none). */
  let extractedKeywords: string;

  beforeEach(async () => {
    capturedTableIds = undefined;
    capturedSemantics = undefined;
    capturedCandidateTables = undefined;
    recallSlice = 3;
    sqlMode = 'sql';
    needClarifyTables = [];
    extractedKeywords = 'EMPTY';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        extractKeywords: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'content', delta: extractedKeywords },
          ]),
        generateSql: () =>
          asyncFrom<LlmGenEvent>(
            sqlMode === 'sql'
              ? [
                  {
                    type: 'result',
                    data: {
                      success: true,
                      sql: 'SELECT 1',
                      tables: [],
                      chartType: 'table',
                      brief: 'semantic e2e',
                    },
                  },
                ]
              : [
                  {
                    type: 'result',
                    data: {
                      success: false,
                      needClarify: true,
                      reason: '需要客户表 join',
                      sql: '',
                      tables: needClarifyTables,
                      chartType: '',
                      brief: '',
                    },
                  },
                ],
          ),
        generateChart: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: { chartType: 'table', config: { type: 'table' } },
            },
          ]),
        generateAnalysis: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { analysis: '分析' } },
          ]),
        generatePredict: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { predict: '趋势', predictData: [] } },
          ]),
        generateGuessQuestion: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { questions: ['q1'] } },
          ]),
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'MySQL' }),
        // without this the real extractKeywords step throws before calling the
        // faked generator and silently degrades to "no keywords"
        buildForKeywords: () => ({}),
        buildSqlContext: (ctx: {
          tableIds?: number[];
          candidateTables?: string;
          semantics?: {
            tableMeanings?: Record<string, string>;
            fieldNotes?: unknown;
          };
        }) => {
          capturedTableIds = ctx.tableIds;
          capturedSemantics = ctx.semantics;
          capturedCandidateTables = ctx.candidateTables;
          return { engine: 'SQLite' };
        },
        buildForResult: () => ({ engine: 'SQLite' }),
      })
      .overrideProvider(DatasourceService)
      .useValue({
        findAll: () =>
          Promise.resolve([
            { id: 1, name: 'fake-ds', description: null, type: 'sqlite' },
          ]),
        findOne: () =>
          Promise.resolve({
            id: 1,
            name: 'fake-ds',
            type: 'sqlite',
            tables: FAKE_TABLES,
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
        recallTables: () =>
          // ranked recall: 3 candidates (ids 1-3) — the Top-3 width.
          // Tests can shrink the slice to simulate a single-table hit.
          Promise.resolve(FAKE_TABLES.slice(0, recallSlice)),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({
        validate: () => ({ ok: true, tables: [] }),
        extractTableNames: () => [],
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);
    await prisma.tableSemantic.deleteMany({ where: { datasourceId: 1 } });
    await prisma.systemVariable.deleteMany({
      where: { type: 'parameter', name: 'semantic.max_tables' },
    });
  });

  afterEach(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    await prisma.systemVariable
      .deleteMany({
        where: { type: 'parameter', name: 'semantic.max_tables' },
      })
      .catch(() => undefined);
    await app.close();
  });

  /** Rule 2 only engages below the recall width (a Top-3 recall never
   *  exceeds the default 3) — pin the cap so the 3-candidate recall narrows. */
  async function pinMaxTables(n: number): Promise<void> {
    await prisma.systemVariable.create({
      data: {
        type: 'parameter',
        varType: 'str',
        name: 'semantic.max_tables',
        value: String(n),
      },
    });
  }

  async function startChat(): Promise<number> {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    expect(start.status).toBe(200);
    return (start.body as ApiEnvelope<{ id: number }>).data.id;
  }

  async function ask(chatId: number, question = '统计一下整体情况') {
    return request(app.getHttpServer())
      .post('/api/v1/chat/question')
      .set(TOKEN_HEADER, token)
      .send({ chat_id: chatId, question });
  }

  it('valid semantics narrow the schema to 1 table and skip the clarify gate', async () => {
    await pinMaxTables(1);
    // WORKSPACE-layer meaning for sales_order (oid 1 = the admin's ws).
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '销售订单主表',
        enabled: true,
      },
    });
    const chatId = await startChat();
    try {
      const res = await ask(chatId);
      expect(res.status).toBe(200);
      // Rule 2 resolved the ambiguity — no clarify pause, straight to SQL.
      expect(res.text).not.toContain('"type":"clarify"');
      expect(res.text).toContain('"type":"sql"');
      // The schema context was narrowed to the covered table only.
      expect(capturedTableIds).toEqual([1]);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('at the default cap a Top-3 recall is NOT narrowed and the gate asks instead', async () => {
    // One candidate carries a meaning — enough to narrow under a lower cap.
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '销售订单主表',
        enabled: true,
      },
    });
    const chatId = await startChat();
    try {
      // The question names no table: 3 candidates ≥ clarify.table_threshold 3.
      const res = await ask(chatId);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('"type":"sql"');
      const clarify = sseFrames(res.text).find((f) => f.type === 'clarify');
      expect(clarify).toBeDefined();
      expect(clarify!.candidates).toHaveLength(3);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('PERSONAL semantics beat WORKSPACE for the acting user', async () => {
    await pinMaxTables(1);
    // Same natural key on BOTH layers: only an actual priority inversion
    // would make the WORKSPACE meaning win.
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '空间层含义',
        enabled: true,
      },
    });
    await prisma.tableSemantic.create({
      data: {
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '个人层含义',
        // only the effective (PERSONAL) row's alias list drives the expansion
        aliases: ['销售单'],
        enabled: true,
      },
    });
    // the extractor produced the table ALIAS → the real SemanticService folds
    // `sales_order` in → the table is "named" for the prompt gate
    extractedKeywords = '销售单';
    const chatId = await startChat();
    try {
      const res = await ask(chatId);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([1]);
      expect(capturedSemantics?.tableMeanings).toMatchObject({
        sales_order: '个人层含义',
      });
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('injects table semantics when recall returns just one table', async () => {
    recallSlice = 1;
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '销售订单主表',
        enabled: true,
      },
    });
    // the extractor keeps a concrete table name verbatim
    extractedKeywords = 'sales_order';
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '查一下sales_order');
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([1]);
      expect(capturedSemantics?.tableMeanings).toMatchObject({
        sales_order: '销售订单主表',
      });
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('a table the keywords do NOT name keeps its raw comment (no curated meaning)', async () => {
    recallSlice = 1;
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '销售订单主表',
        enabled: true,
      },
    });
    // the question text names the table, but the extracted keyword does not
    extractedKeywords = '金额';
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '查一下sales_order');
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([1]);
      expect(capturedSemantics?.tableMeanings).toEqual({});
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('LLM need_clarify pauses with the reason; a table pick resumes', async () => {
    sqlMode = 'need_clarify';
    // The question names a table so the M1 gate stays closed; no semantics
    // seeded so rule 2 does not narrow — generate_sql itself asks for more.
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      expect(q.status).toBe(200);
      const frames = sseFrames(q.text);
      const clarify = frames.find((f) => f.type === 'clarify');
      expect(clarify).toBeDefined();
      // The LLM's reason rides along on the payload.
      expect(clarify!.reason).toBe('需要客户表 join');
      // Candidates = the recall subset (ids 1-3), NOT the narrowed schema.
      expect(clarify!.candidates).toHaveLength(3);

      const rid = recordIdFromSse(q.text);
      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyStatus).toBe('pending');

      // Resume with a table pick → the faked generator now returns SQL.
      sqlMode = 'sql';
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [2] });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([2]);
      const finished = await prisma.chatRecord.findUnique({
        where: { id: rid },
      });
      expect(finished!.clarifyStatus).toBe('answered');
      expect(finished!.finish).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('asks a second need_clarify under max_rounds=2 and keeps earlier options', async () => {
    await prisma.systemVariable.deleteMany({
      where: { name: 'clarify.max_rounds' },
    });
    await prisma.systemVariable.create({
      data: {
        type: 'parameter',
        varType: 'int',
        name: 'clarify.max_rounds',
        value: 2,
      },
    });
    sqlMode = 'need_clarify';
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);
      let record = await prisma.chatRecord.findUnique({
        where: { id: rid },
      });
      expect(record!.clarifyRound).toBe(1);

      // Round 1 answer picks one table; the LLM still asks for more and the
      // round budget (2) allows a second pause.
      const second = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [2] });
      expect(second.status).toBe(200);
      const clarify2 = sseFrames(second.text).find((f) => f.type === 'clarify');
      expect(clarify2).toBeDefined();
      expect(clarify2!.reason).toBe('需要客户表 join');
      // The previous round's pool is re-offered, not just the picked subset.
      const names = (clarify2!.candidates as Array<{ table_name: string }>).map(
        (c) => c.table_name,
      );
      expect(names).toEqual(
        expect.arrayContaining(['sales_order', 'crm_customer', 'inv_stock']),
      );

      record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyRound).toBe(2);
      expect(record!.clarifyStatus).toBe('pending');

      // Budget spent → the next answer generates SQL instead of asking again.
      sqlMode = 'sql';
      const third = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [1, 2] });
      expect(third.status).toBe(200);
      expect(third.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([1, 2]);

      record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyRound).toBe(2);
      expect(record!.clarifyStatus).toBe('answered');
      expect(record!.finish).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
      await prisma.systemVariable.deleteMany({
        where: { name: 'clarify.max_rounds' },
      });
    }
  });

  it('skip still suppresses need_clarify under max_rounds=2', async () => {
    await prisma.systemVariable.deleteMany({
      where: { name: 'clarify.max_rounds' },
    });
    await prisma.systemVariable.create({
      data: {
        type: 'parameter',
        varType: 'int',
        name: 'clarify.max_rounds',
        value: 2,
      },
    });
    sqlMode = 'need_clarify';
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);

      // "Just generate" is a user decision: a remaining round budget must not
      // override it with another question.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ skip: true });
      expect(res.status).toBe(200);
      const frames = sseFrames(res.text);
      expect(frames.some((f) => f.type === 'clarify')).toBe(false);
      expect(frames.some((f) => f.type === 'error')).toBe(true);

      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyStatus).toBe('skipped');
      expect(record!.clarifyRound).toBe(1);
      expect(record!.finish).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
      await prisma.systemVariable.deleteMany({
        where: { name: 'clarify.max_rounds' },
      });
    }
  });

  it('need_clarify suggests recalled tables and shows their meanings', async () => {
    await pinMaxTables(1);
    sqlMode = 'need_clarify';
    needClarifyTables = ['crm_customer'];
    await prisma.tableSemantic.createMany({
      data: [
        {
          scope: 'WORKSPACE',
          oid: 1,
          datasourceId: 1,
          tableName: 'sales_order',
          meaning: '销售订单主表',
          enabled: true,
        },
        {
          scope: 'WORKSPACE',
          oid: 1,
          datasourceId: 1,
          tableName: 'crm_customer',
          meaning: '客户主表',
          // the extracted keyword names this table through its alias
          aliases: ['客户'],
          enabled: true,
        },
      ],
    });
    extractedKeywords = '客户';
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      expect(q.status).toBe(200);
      const frames = sseFrames(q.text);
      const clarify = frames.find((f) => f.type === 'clarify');
      expect(clarify).toBeDefined();

      // The clarify card carries the effective semantic for EVERY candidate
      // (not just the table comment) — it is shown to the user, not the LLM.
      const candidates = clarify!.candidates as Array<{
        table_name: string;
        meaning?: string;
      }>;
      expect(
        candidates.find((c) => c.table_name === 'sales_order')?.meaning,
      ).toBe('销售订单主表');
      expect(
        candidates.find((c) => c.table_name === 'crm_customer')?.meaning,
      ).toBe('客户主表');

      // Current schema (sales_order) + the LLM's requested table.
      expect(clarify!.suggested_table_ids).toEqual([1, 2]);

      // The PROMPT block follows the exact-keyword gate: crm_customer is named
      // by the keyword 客户 (alias) so its meaning shows; inv_stock has no
      // semantic and falls back to the comment.
      expect(capturedCandidateTables).toContain('- crm_customer: 客户主表');
      expect(capturedCandidateTables).toContain('- inv_stock: 库存记录');
      expect(capturedCandidateTables).not.toContain('- sales_order:');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('a hand-picked table the keywords do NOT name gets no curated meaning on resume', async () => {
    sqlMode = 'need_clarify';
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'crm_customer',
        meaning: '客户主表',
        enabled: true,
      },
    });
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);

      // forcedTableIds skips rule 2 — but the exact-keyword gate still
      // applies: picking a table in the UI is not "naming" it.
      sqlMode = 'sql';
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [2] });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([2]);
      expect(capturedSemantics?.tableMeanings).toEqual({});
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('injects semantics for a picked table when the resume keywords name it', async () => {
    sqlMode = 'need_clarify';
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'crm_customer',
        meaning: '客户主表',
        enabled: true,
      },
    });
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);

      // The resume is a full run: keyword extraction runs again on the
      // question + supplements, so a supplement naming the table lets its
      // meaning through the gate.
      sqlMode = 'sql';
      extractedKeywords = 'crm_customer';
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [2], text: '只看crm_customer' });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([2]);
      expect(capturedSemantics?.tableMeanings).toMatchObject({
        crm_customer: '客户主表',
      });
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('need_clarify AFTER an answer fails honestly instead of re-asking', async () => {
    sqlMode = 'need_clarify';
    const chatId = await startChat();
    try {
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);

      // The generator keeps asking for more tables even after the user
      // picked — re-asking would loop, so the turn fails with a clear msg.
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [2] });
      expect(res.status).toBe(200);
      const frames = sseFrames(res.text);
      expect(frames.some((f) => f.type === 'error')).toBe(true);
      expect(res.text).not.toContain('"type":"clarify"');
      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.finish).toBe(true);
      expect(record!.error).toContain('不足');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });
});
