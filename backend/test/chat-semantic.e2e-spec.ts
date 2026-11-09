// Chat semantic e2e — MetaDataImprove M2 rule 2: effective table semantics
// narrow the stuffed schema to semantic.max_tables (default 1) and the LLM's
// need_clarify contract reuses the M1 clarify flow. The LLM/datasource/
// safety providers are faked (SSE-block pattern); SemanticService is REAL
// (real Prisma rows seeded per case) so the priority resolution runs.
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
  /** Flip the faked generateSql between need_clarify and a normal result. */
  let sqlMode: 'sql' | 'need_clarify';

  beforeEach(async () => {
    capturedTableIds = undefined;
    sqlMode = 'sql';
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        extractKeywords: () =>
          asyncFrom<LlmGenEvent>([{ type: 'content', delta: 'EMPTY' }]),
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
                      tables: [],
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
        buildSqlContext: (ctx: { tableIds?: number[] }) => {
          capturedTableIds = ctx.tableIds;
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
          // ranked recall: 3 candidates (ids 1-3) — semantic.max_tables = 1
          Promise.resolve(FAKE_TABLES.slice(0, 3)),
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
  });

  afterEach(async () => {
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: 1 } })
      .catch(() => undefined);
    await app.close();
  });

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

  it('PERSONAL semantics beat WORKSPACE for the acting user', async () => {
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: 1,
        tableName: 'crm_customer',
        meaning: '空间层含义',
        enabled: true,
      },
    });
    // The seeded admin (uid 1) gets a personal override pointing elsewhere —
    // personal wins, so the narrowed table is the personal one.
    await prisma.tableSemantic.create({
      data: {
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 1,
        datasourceId: 1,
        tableName: 'sales_order',
        meaning: '个人层含义',
        enabled: true,
      },
    });
    const chatId = await startChat();
    try {
      const res = await ask(chatId);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedTableIds).toEqual([1]); // personal sales_order, not ws crm_customer
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
