// Chat clarify e2e — MetaDataImprove M1 rule 1 (ask-to-narrow). Overrides the
// LLM/datasource/safety providers with deterministic fakes (SSE-block pattern
// from chat.e2e-spec) and drives the three answer paths end to end:
//   1. ambiguous question over >= threshold checked tables → SSE `clarify`
//      frame, record stays finish:false + clarifyStatus:'pending', no SQL
//   2. table-pick answer → SAME record resumes through sql/chart/finish, the
//      schema context is narrowed to the picked table ids
//   3. skip answer → resumes with the pre-clarify behavior (all candidates)
// plus the 400 guards (empty answer / not pending / tables outside the pool).
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
      // non-JSON frame (heartbeat) — skip
    }
  }
  throw new Error('recordId not found in SSE stream');
}

/** Parse SSE frames into typed events. */
function sseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice('data:'.length)) as Record<string, unknown>);
}

// 4 checked tables, none named by the ambiguous question below.
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

describe('Chat clarify (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  /** Captured by the faked buildSqlContext — asserts the narrowed subset. */
  let capturedTableIds: number[] | undefined;

  beforeEach(async () => {
    capturedTableIds = undefined;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        // EMPTY sentinel → keyword extraction degrades to the raw question
        // (no LLM call in the fake).
        extractKeywords: () =>
          asyncFrom<LlmGenEvent>([{ type: 'content', delta: 'EMPTY' }]),
        generateSql: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT 1',
                tables: [],
                chartType: 'table',
                brief: 'clarify e2e',
              },
            },
          ]),
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
        // Capture the tableIds the SQL context was narrowed to.
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
        // Empty recall → the candidate pool is every checked table.
        recallTables: () => Promise.resolve([]),
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
  });

  afterEach(async () => {
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

  it('pauses with a clarify frame over >= threshold unnamed candidate tables', async () => {
    const chatId = await startChat();
    try {
      const res = await ask(chatId);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const frames = sseFrames(res.text);
      const clarify = frames.find((f) => f.type === 'clarify');
      expect(clarify).toBeDefined();
      // All four checked tables are offered (recall degraded to all-checked).
      expect(clarify!.candidates).toHaveLength(4);
      expect(clarify!.max_select).toBe(3);
      // The pipeline stopped BEFORE generate_sql.
      expect(frames.some((f) => f.type === 'sql')).toBe(false);
      expect(frames.some((f) => f.type === 'finish')).toBe(true);

      const rid = recordIdFromSse(res.text);
      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyStatus).toBe('pending');
      expect(record!.finish).toBe(false);
      expect(record!.sql).toBeNull();
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('does not ask when the question explicitly names a table', async () => {
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '查一下sales_order的金额');
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('"type":"clarify"');
      expect(res.text).toContain('"type":"sql"');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('resumes the same record narrowed to the picked tables', async () => {
    const chatId = await startChat();
    try {
      const q = await ask(chatId);
      const rid = recordIdFromSse(q.text);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [1, 2] });
      expect(res.status).toBe(200);
      const frames = sseFrames(res.text);
      // Same record id re-emitted, then the normal tail.
      expect(frames.find((f) => f.type === 'id')).toMatchObject({ id: rid });
      expect(frames.some((f) => f.type === 'sql')).toBe(true);
      expect(frames.some((f) => f.type === 'chart')).toBe(true);
      expect(frames.some((f) => f.type === 'finish')).toBe(true);

      // The SQL context was narrowed to exactly the picked tables.
      expect(capturedTableIds).toEqual([1, 2]);

      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyStatus).toBe('answered');
      expect(record!.finish).toBe(true);
      expect(record!.clarifyAnswer).toMatchObject({
        table_ids: [1, 2],
        table_names: ['sales_order', 'crm_customer'],
      });
      expect(record!.sql).toBe('SELECT 1');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('skip answer resumes with the pre-clarify behavior', async () => {
    const chatId = await startChat();
    try {
      const q = await ask(chatId);
      const rid = recordIdFromSse(q.text);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ skip: true });
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(res.text).not.toContain('"type":"clarify"');
      // No forced subset — recall's undefined result = all checked tables.
      expect(capturedTableIds).toBeUndefined();

      const record = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(record!.clarifyStatus).toBe('skipped');
      expect(record!.finish).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('rejects an empty answer and a table outside the candidate pool (400)', async () => {
    const chatId = await startChat();
    try {
      const q = await ask(chatId);
      const rid = recordIdFromSse(q.text);

      const empty = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({});
      expect(empty.status).toBe(400);
      expect(typeof empty.text).toBe('string');

      const foreign = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ table_ids: [999] });
      expect(foreign.status).toBe(400);

      // The record is still pending after the rejections.
      const still = await prisma.chatRecord.findUnique({ where: { id: rid } });
      expect(still!.clarifyStatus).toBe('pending');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('rejects a clarify answer on a record that is not pending (400)', async () => {
    const chatId = await startChat();
    try {
      // Explicit table name → no clarify pause, record finishes normally.
      const q = await ask(chatId, '查一下sales_order的金额');
      const rid = recordIdFromSse(q.text);

      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/clarify`)
        .set(TOKEN_HEADER, token)
        .send({ skip: true });
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toContain('text/plain');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });
});
