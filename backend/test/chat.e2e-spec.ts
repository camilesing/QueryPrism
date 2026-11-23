// Chat e2e — Phase 9c contract surface. The CRUD block runs against the
// real AppModule + real Prisma (admin token); the SSE block overrides the
// LLM/datasource/safety providers with deterministic fakes so the pipeline
// streams without an API key or live DB, and asserts the SSE transport
// (`data:<json>\n\n` framing, §61) + the controller's pre-stream 404.
//
// §62/§65/§74: routes are rid-only (`/chat/record/:rid/...`), DTOs are
// snake_case (`chat_id`/`question`/`datasource`/`brief`), GET responses are
// snake_case ChatInfoSnake, SSE frames carry `type` in the JSON top-level.
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

interface ChatInfo {
  id: number;
  brief: string | null;
  datasource: number | null;
  datasource_name: string | null;
  ds_type: string | null;
  records: Array<{ id: number; question: string; first_chat: boolean }>;
}

// Object-form async iterable so ESLint's require-await stays quiet (no
// `async function*` without await).
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
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

/** Pull the record id out of the first `id` SSE frame. Phase 9c (§61/§62):
 *  the framing is `data:<json>\n\n` (type merged into the JSON top-level, no
 *  `event:` line). Parsed as JSON (2026-09 QW1: `type` is merged LAST, so a
 *  regex keyed on `"type":"id","id":N` key ORDER no longer matches — the
 *  frontend JSONBig.parse is order-insensitive and so is this). */
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
      // non-JSON frame (comment heartbeat etc.) — skip
    }
  }
  throw new Error('recordId not found in SSE stream');
}

// ---------------------------------------------------------------------------
// CRUD — real services, real Prisma.
// ---------------------------------------------------------------------------
describe('Chat CRUD (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires a token (401 without)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/chat/list');
    expect(res.status).toBe(401);
  });

  it('starts, lists, fetches, renames, and deletes a chat', async () => {
    // start (snake_case body — §65)
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    expect(start.status).toBe(200);
    const chat = (start.body as ApiEnvelope<ChatInfo>).data;
    expect(typeof chat.id).toBe('number');
    // create_chat parity: a datasource-backed chat is seeded with one
    // finished first_chat record + datasource metadata, which is what makes the
    // frontend render its input box instead of the welcome screen.
    expect(chat.records).toHaveLength(1);
    expect(chat.records[0].first_chat).toBe(true);
    expect(chat.datasource_name).toBe('默认数据源');
    expect(chat.ds_type).toBe('sqlite');
    expect(chat.brief).toBe('新对话');

    // list includes it (snake_case ChatInfoSnake — §63)
    const list = await request(app.getHttpServer())
      .get('/api/v1/chat/list')
      .set(TOKEN_HEADER, token);
    expect(list.status).toBe(200);
    const listData = (list.body as ApiEnvelope<ChatInfo[]>).data;
    expect(listData.some((c) => c.id === chat.id)).toBe(true);

    // get one
    const one = await request(app.getHttpServer())
      .get(`/api/v1/chat/${chat.id}`)
      .set(TOKEN_HEADER, token);
    expect(one.status).toBe(200);
    expect((one.body as ApiEnvelope<ChatInfo>).data.id).toBe(chat.id);

    // with_data (records + logs, records carry `data`)
    const wd = await request(app.getHttpServer())
      .get(`/api/v1/chat/${chat.id}/with_data`)
      .set(TOKEN_HEADER, token);
    expect(wd.status).toBe(200);

    // rename (POST /chat/rename, body {id, brief} — returns the brief string)
    const renamed = await request(app.getHttpServer())
      .post('/api/v1/chat/rename')
      .set(TOKEN_HEADER, token)
      .send({ id: chat.id, brief: 'renamed-e2e' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as ApiEnvelope<string>).data).toBe('renamed-e2e');

    // delete (body {id, brief?} — returns 'success')
    const removed = await request(app.getHttpServer())
      .delete(`/api/v1/chat/${chat.id}`)
      .set(TOKEN_HEADER, token)
      .send({ id: chat.id });
    expect(removed.status).toBe(200);
    expect((removed.body as ApiEnvelope<string>).data).toBe('success');

    // now 404
    const after = await request(app.getHttpServer())
      .get(`/api/v1/chat/${chat.id}`)
      .set(TOKEN_HEADER, token);
    expect(after.status).toBe(404);
  });

  it('returns 404 for a missing chat', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/chat/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(404);
    // Phase 9 (§60): error bodies are plain strings, not the old envelope.
    expect(typeof res.text).toBe('string');
  });

  it('rejects a malformed start payload (400)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(typeof res.text).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// SSE — overrides the LLM/datasource/safety providers with deterministic
// fakes so the pipeline streams without a key or live DB.
// ---------------------------------------------------------------------------
describe('Chat SSE (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        selectDatasource: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'reasoning', delta: 'selecting' },
            { type: 'result', data: { datasourceId: 1 } },
          ]),
        generateSql: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'reasoning', delta: 'thinking' },
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT 1',
                tables: [],
                chartType: 'table',
                brief: 'e2e 简述',
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
        // Phase 5b generators seeded to mirror the unit-test payloads so the
        // analysis/predict SSE flows + the fire-and-forget guess cache resolve
        // deterministically without an API key.
        generateAnalysis: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'reasoning', delta: '分析中' },
            { type: 'content', delta: '这是分析' },
            { type: 'result', data: { analysis: '这是分析' } },
          ]),
        generatePredict: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'reasoning', delta: '预测中' },
            {
              type: 'result',
              data: {
                predict: '上升趋势',
                predictData: [{ label: 'x', value: 1 }],
              },
            },
          ]),
        generateGuessQuestion: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { questions: ['推荐1'] } },
          ]),
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'MySQL' }),
        buildSqlContext: () => ({ engine: 'SQLite' }),
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
            tables: [{ id: 1, tableName: 't', checked: true, fields: [] }],
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
        recallTables: () => Promise.resolve([]),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({ validate: () => ({ ok: true, tables: [] }) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
  });

  afterEach(async () => {
    await app.close();
  });

  it('streams text/event-stream with the full pipeline frame sequence', async () => {
    // Start a chat with a bound datasource so select_datasource is skipped.
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '测试问题' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      // §61: framing is `data:{"type":<event>...}\n\n` (type in JSON top-level,
      // no `event:` line). Assert the JSON type substrings for each stage.
      expect(res.text).toContain('"type":"id"');
      expect(res.text).toContain('"type":"question"');
      expect(res.text).toContain('"type":"datasource"');
      expect(res.text).toContain('"type":"sql"');
      expect(res.text).toContain('"type":"sql-data"');
      expect(res.text).toContain('"type":"chart"');
      expect(res.text).toContain('"type":"finish"');
    } finally {
      // Clean up so the seeded DB isn't polluted.
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('emits the chart as a wire-contract chart object and serves it as a JSON string on history load', async () => {
    // Regression (§ chart contract): the frontend JSON.parse()s record.chart
    // and reads type/axis/columns from it. The backend must therefore stream +
    // persist the full chart object (not the raw {xField,yField} mapping)
    // and serialize it to a string in the GET response.
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const q = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '测试问题' });
      expect(q.status).toBe(200);
      const rid = recordIdFromSse(q.text);

      // Parse the SSE frames and pull out the chart event's content (SseWriter
      // merges the event type into the JSON top-level alongside the payload keys).
      const frames = q.text
        .split('\n\n')
        .filter((f) => f.startsWith('data:'))
        .map(
          (f) =>
            JSON.parse(f.slice('data:'.length)) as {
              type?: string;
              content?: string;
            },
        );
      const chartFrame = frames.find((f) => f.type === 'chart');
      expect(chartFrame).toBeDefined();
      const chartObject: unknown = JSON.parse(chartFrame!.content!);
      // The fake generateChart returns chartType=table and the fake query
      // result has one `id` column → the table object lists that column.
      expect(chartObject).toEqual({
        type: 'table',
        title: '',
        columns: [{ name: 'id', value: 'id' }],
      });

      // History load (GET /chat/:id) must return the SAME object as a JSON
      // string — ChartBlock.vue calls JSON.parse(props.message.record.chart).
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token);
      expect(detail.status).toBe(200);
      const records = (
        detail.body as ApiEnvelope<{
          records: Array<{ id: number; chart: unknown }>;
        }>
      ).data.records;
      const record = records.find((r) => r.id === rid);
      expect(record).toBeDefined();
      expect(typeof record!.chart).toBe('string');
      expect(JSON.parse(record!.chart as string)).toEqual(chartObject);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('returns 404 (not SSE) for a question on a missing chat', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/question')
      .set(TOKEN_HEADER, token)
      .send({ chat_id: 999999, question: 'x' });

    expect(res.status).toBe(404);
    // Phase 9 (§60): pre-stream errors return a plain-string body (not SSE,
    // not the old JSON envelope).
    expect(res.headers['content-type']).toContain('text/plain');
    expect(typeof res.text).toBe('string');
  });

  // --- Phase 5b/9c: secondary SSE surfaces + record reads + export ----------

  it('streams the analysis SSE frame sequence over a finished record', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      // Run the full pipeline once so the record has sql + sqlExecResult.
      const q = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '测试问题' });
      expect(q.status).toBe(200);
      const rid = recordIdFromSse(q.text);

      // §74: rid-only route (no chat_id in path).
      const res = await request(app.getHttpServer())
        .post(`/api/v1/chat/record/${rid}/analysis`)
        .set(TOKEN_HEADER, token)
        .send({});

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      expect(res.text).toContain('"type":"id"');
      expect(res.text).toContain('"type":"info"');
      expect(res.text).toContain('"type":"analysis-result"');
      // §62: the analysis stream terminates with `analysis_finish` (underscore),
      // not a `finish` frame.
      expect(res.text).toContain('"type":"analysis_finish"');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('GET record data/predict_data/log/usage return persisted shapes', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const q = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '测试问题' });
      expect(q.status).toBe(200);
      const rid = recordIdFromSse(q.text);

      // Persisted query result (rid-only route — §74).
      const data = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/data`)
        .set(TOKEN_HEADER, token);
      expect(data.status).toBe(200);
      // §117 (prior session): record data returns the wire shape
      // {fields, fields_info, data} (format_json_data) — fields_info is null
      // (no per-column type info; the chart renderer falls back to inference).
      expect((data.body as ApiEnvelope).data).toEqual({
        fields: ['id'],
        fields_info: null,
        data: [{ id: 1 }],
      });

      // No predict run yet → [] (§117 prior session: format_json_list_data
      // coerces null to [] so the predict table renders an empty state).
      const predict = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/predict_data`)
        .set(TOKEN_HEADER, token);
      expect(predict.status).toBe(200);
      expect((predict.body as ApiEnvelope).data).toEqual([]);

      // §74: log now returns the aggregated ChatLogHistory shape (steps[]),
      // not a raw log array.
      const log = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/log`)
        .set(TOKEN_HEADER, token);
      expect(log.status).toBe(200);
      const logData = (log.body as ApiEnvelope<{ steps: unknown[] }>).data;
      expect(Array.isArray(logData.steps)).toBe(true);
      expect(logData.steps.length).toBeGreaterThan(0);

      // Usage mirrors the ChatLogHistory snake_case shape (§117 prior
      // session): no persisted tokenUsage → total_tokens null, duration 0.
      const usage = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/usage`)
        .set(TOKEN_HEADER, token);
      expect(usage.status).toBe(200);
      expect((usage.body as ApiEnvelope).data).toEqual({
        start_time: expect.any(String),
        finish_time: expect.any(String),
        duration: 0,
        total_tokens: null,
        steps: [],
      });
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('GET recent_questions + POST recommend_questions return their shapes', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const q = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '最近的一个问题' });
      expect(q.status).toBe(200);
      const rid = recordIdFromSse(q.text);

      // recent_questions is now datasource-scoped: /chat/recent_questions/:dsid.
      const recent = await request(app.getHttpServer())
        .get('/api/v1/chat/recent_questions/1')
        .set(TOKEN_HEADER, token);
      expect(recent.status).toBe(200);
      expect(
        (recent.body as ApiEnvelope<{ questions: string[] }>).data.questions,
      ).toContain('最近的一个问题');

      // §74: recommend_questions is now a POST SSE route (rid-only). MVP emits
      // a single terminal `recommended_question` frame + finish.
      const rec = await request(app.getHttpServer())
        .post(`/api/v1/chat/recommend_questions/${rid}`)
        .set(TOKEN_HEADER, token)
        .send({});
      expect(rec.status).toBe(200);
      expect(rec.headers['content-type']).toContain('text/event-stream');
      expect(rec.text).toContain('"type":"recommended_question"');
      expect(rec.text).toContain('"type":"finish"');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });

  it('GET export returns an xlsx body for a record', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const q = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question: '测试问题' });
      expect(q.status).toBe(200);
      const rid = recordIdFromSse(q.text);

      // §74: export route is now `/chat/record/:rid/excel/export/:cid`
      // (cid = chatId).
      const res = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/excel/export/${chatId}`)
        .set(TOKEN_HEADER, token);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      expect(res.headers['content-disposition']).toContain('attachment');
      // Non-empty body — express sets Content-Length for the sent Buffer.
      expect(Number(res.headers['content-length'] ?? 0)).toBeGreaterThan(0);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 11A §111 — runtime row-permission filter (non-admin → filtered SQL).
// Boots a REAL non-admin user (id != 1) + seeds DsRules/DsPermission via Prisma
// so the REAL RowPermissionService resolves a row filter; the Generator/
// AiQuestion/Datasource/SqlSafety providers are faked (SSE-block pattern,
// extended with generateFilter/buildFilterContext/extractTableNames) so no live
// LLM call or DB round-trip happens. Asserts the §111 re-yielded `sql` frame
// carries the filtered SQL + the ChatLog row is tagged GENERATE_SQL_WITH_PERMISSIONS.
// ---------------------------------------------------------------------------
describe('Chat SSE §111 row-permission (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let userToken: string; // non-admin (id != 1)
  let prisma: PrismaService;
  let rulesId: number | null;
  let nonAdminAccount: string;

  beforeEach(async () => {
    const uniq = `na${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    nonAdminAccount = `e2e-${uniq}`;
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        selectDatasource: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { datasourceId: 1 } },
          ]),
        // generateSql returns a SQL referencing `users` so extractTableNames
        // (also faked) resolves the seeded row-permission table.
        generateSql: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT * FROM users',
                tables: ['users'],
                chartType: 'table',
                brief: '用户列表',
              },
            },
          ]),
        // §111: the LLM-merged SQL with the WHERE fragment applied. The faked
        // generator bypasses the real LLM — the fragment is pre-baked.
        generateFilter: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT * FROM users WHERE `age` > 18',
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
        buildSqlContext: () => ({ engine: 'MySQL' }),
        buildForResult: () => ({ engine: 'MySQL' }),
        buildFilterContext: () => ({
          engine: 'MySQL',
          sql: 'SELECT * FROM users',
          filter: '[]',
        }),
      })
      .overrideProvider(DatasourceService)
      .useValue({
        findAll: () =>
          Promise.resolve([
            { id: 1, name: 'fake-ds', description: null, type: 'mysql' },
          ]),
        // table id=1 + field id=10 (`age`) — the seeded DsPermission.tableId
        // and the expressionTree field_id both reference these.
        findOne: () =>
          Promise.resolve({
            id: 1,
            name: 'fake-ds',
            type: 'mysql',
            tables: [
              {
                id: 1,
                tableName: 'users',
                checked: true,
                fields: [{ id: 10, fieldName: 'age' }],
              },
            ],
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
        recallTables: () => Promise.resolve([]),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({
        validate: () => ({ ok: true, tables: [] }),
        extractTableNames: () => ['users'],
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);

    // Admin login → create a non-admin user → non-admin login.
    adminToken = await login(app);
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: nonAdminAccount,
        password: 'Init1234!',
        email: `${nonAdminAccount}@e2e.test`,
        name: 'NonAdmin E2E',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: nonAdminAccount, password: 'Init1234!' });
    userToken = (loginRes.body as ApiEnvelope<{ access_token: string }>).data
      .access_token;

    // Seed a row-permission rule for the non-admin user: field `age` (id=10)
    // on table `users` (id=1) must be > 18. expressionTree is the JSON tree
    // shape RowPermissionService.parseTree expects (logic + items).
    const naUser = await prisma.user.findFirst({
      where: { account: nonAdminAccount },
    });
    const naId = naUser!.id;
    const rules = await prisma.dsRules.create({
      data: {
        oid: 1,
        name: `e2e-row-${uniq}`,
        userList: [naId],
        permissions: {
          create: [
            {
              name: 'age-gt-18',
              type: 'row',
              tableId: 1,
              tableName: 'users',
              expressionTree: JSON.stringify({
                logic: 'AND',
                items: [
                  {
                    type: 'item',
                    field_id: 10,
                    term: 'gt',
                    value: '18',
                    value_type: 'string',
                  },
                ],
              }),
              permissions: '[]',
            },
          ],
        },
      },
    });
    rulesId = rules.id;
  });

  afterEach(async () => {
    if (rulesId != null) {
      await prisma.dsRules
        .delete({ where: { id: rulesId } })
        .catch(() => undefined);
    }
    if (nonAdminAccount) {
      await prisma.user
        .deleteMany({ where: { account: nonAdminAccount } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('non-admin user with a row rule → streams the filtered SQL + tags GENERATE_SQL_WITH_PERMISSIONS', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, userToken)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, userToken)
        .send({ chat_id: chatId, question: '查询用户' });
      expect(res.status).toBe(200);
      // §111 re-yields a second `sql` frame carrying the LLM-merged SQL with
      // the WHERE fragment applied. The original SQL has no WHERE clause.
      expect(res.text).toContain('WHERE `age` > 18');
      // The ChatLog row is tagged GENERATE_SQL_WITH_PERMISSIONS (not GENERATE_SQL).
      const rid = recordIdFromSse(res.text);
      const logs = await prisma.chatLog.findMany({
        where: { chatRecordId: rid },
        select: { operate: true },
      });
      expect(
        logs.some((l) => l.operate === 'GENERATE_SQL_WITH_PERMISSIONS'),
      ).toBe(true);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, userToken)
        .send({ id: chatId });
    }
  });

  it('admin user (id=1) bypasses the row-permission step → original SQL + GENERATE_SQL', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, adminToken)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, adminToken)
        .send({ chat_id: chatId, question: '查询用户' });
      expect(res.status).toBe(200);
      // Admin (id=1) → isNormalUser false → §111 block skipped → no WHERE.
      expect(res.text).not.toContain('WHERE `age` > 18');
      const rid = recordIdFromSse(res.text);
      const logs = await prisma.chatLog.findMany({
        where: { chatRecordId: rid },
        select: { operate: true },
      });
      expect(logs.some((l) => l.operate === 'GENERATE_SQL')).toBe(true);
      expect(
        logs.some((l) => l.operate === 'GENERATE_SQL_WITH_PERMISSIONS'),
      ).toBe(false);
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, adminToken)
        .send({ id: chatId });
    }
  });
});

// ---------------------------------------------------------------------------
// §110 custom_prompt runtime matching — REAL AiQuestionService + REAL
// CustomPromptService; the downstream Datasource is mocked so the real
// context assembly runs without live introspection or embedding calls.
// The GeneratorService.generateSql spy captures the assembled ctx; the
// assertion verifies the seeded custom_prompt body reached it.
// ---------------------------------------------------------------------------
describe('Chat SSE §110 custom_prompt (e2e)', () => {
  let app: INestApplication<App>;
  let adminToken: string;
  let prisma: PrismaService;
  let promptId: number | null;
  // Captured by the faked generateSql so the test can assert ctx.customPrompt.
  let capturedSqlCtx: { customPrompt?: string };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        selectDatasource: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { datasourceId: 1 } },
          ]),
        // generateSql captures the assembled ctx so the test can assert the
        // §110 custom_prompt body reached the LLM context.
        generateSql: (ctx: { customPrompt?: string }) => {
          capturedSqlCtx = ctx;
          return asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT 1',
                tables: [],
                chartType: 'table',
                brief: 'cp brief',
              },
            },
          ]);
        },
        generateFilter: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { success: true, sql: 'SELECT 1' } },
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
      // REAL AiQuestionService + REAL CustomPromptService — NOT overridden.
      // Downstream services are mocked so context assembly is deterministic.
      .overrideProvider(DatasourceService)
      .useValue({
        findAll: () =>
          Promise.resolve([
            { id: 1, name: 'fake-ds', description: null, type: 'mysql' },
          ]),
        findOne: () =>
          Promise.resolve({
            id: 1,
            name: 'fake-ds',
            type: 'mysql',
            tables: [
              {
                id: 1,
                tableName: 'users',
                checked: true,
                fields: [{ id: 10, fieldName: 'age' }],
              },
            ],
          }),
        getMSchema: () => Promise.resolve('MS-SCHEMA'),
        previewTable: () =>
          Promise.resolve({
            columns: ['id', 'name'],
            rows: [{ id: 1, name: 'sample' }],
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
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
    adminToken = await login(app);
    capturedSqlCtx = { customPrompt: undefined };
    promptId = null;
    // Clean slate: remove any pre-existing GENERATE_SQL custom prompts for
    // oid=1 so the "no match" scenario is deterministic (test DB is ephemeral;
    // also recovers from prior runs that crashed before afterEach cleanup).
    await prisma.customPrompt.deleteMany({
      where: { oid: 1, type: 'GENERATE_SQL' },
    });
  });

  afterEach(async () => {
    if (promptId != null) {
      await prisma.customPrompt
        .delete({ where: { id: promptId } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('seeded GENERATE_SQL custom_prompt → ctx.customPrompt reaches the generator', async () => {
    // Seed a global (specificDs=false) GENERATE_SQL custom prompt for oid=1
    // (admin). findCustomPrompts matches on (type, oid) + specificDs=false.
    const cp = await prisma.customPrompt.create({
      data: {
        type: 'GENERATE_SQL',
        oid: 1,
        name: `e2e-cp-${Date.now()}`,
        prompt: 'ALWAYS LIMIT 100',
        specificDs: false,
        datasourceIds: [],
        advancedApplication: null,
      },
    });
    promptId = cp.id;

    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, adminToken)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, adminToken)
        .send({ chat_id: chatId, question: '查询用户' });
      expect(res.status).toBe(200);
      // §110: the runtime-matched custom_prompt body was injected into the
      // system-prompt context that generateSql received.
      expect(capturedSqlCtx.customPrompt).toBe('ALWAYS LIMIT 100');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, adminToken)
        .send({ id: chatId });
    }
  });

  it('no custom_prompt seeded → ctx.customPrompt is empty', async () => {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, adminToken)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<ChatInfo>).data.id;

    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, adminToken)
        .send({ chat_id: chatId, question: '查询用户' });
      expect(res.status).toBe(200);
      // No matching custom prompt → empty string (the {custom_prompt} token
      // renders as '' per the template's missing-token contract).
      expect(capturedSqlCtx.customPrompt).toBe('');
    } finally {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, adminToken)
        .send({ id: chatId });
    }
  });
});
