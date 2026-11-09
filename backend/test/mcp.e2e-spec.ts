// MCP e2e — exercises the full Bearer-authenticated MCP endpoint through the
// real Nest pipeline (global prefix, ValidationPipe, TransformInterceptor,
// RequestContext middleware) plus the workspace-admin integration CRUD.
//
// Flow: login as the seeded admin → create an McpIntegration → call
// initialize/tools/list/tools/call with `Authorization: Bearer <token>`.
// The LLM/datasource/safety providers are overridden (mirrors chat.e2e) so
// ask_question's runPipeline resolves deterministically without an API key or
// live LLM; G2SsrClient is overridden to avoid the canvas native build.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { DatasourceService } from './../src/datasource/datasource.service';
import { AiQuestionService } from './../src/llm/ai-question.service';
import {
  GeneratorService,
  type LlmGenEvent,
} from './../src/llm/generator.service';
import { SqlSafetyService } from './../src/chat/sql-safety.service';
import { G2SsrClient } from './../src/mcp/g2-ssr-client.service';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

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

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  data: T;
}

interface RpcEnvelope<T = unknown> {
  jsonrpc: string;
  id?: number | string | null;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface CallResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  isError?: boolean;
}

interface IntegrationSnake {
  id: number;
  name: string;
  description: string | null;
  access_key: string;
  token: string;
  status: string;
}

/** Parse an MCP response: SSE (`data:` line) or plain JSON (401 envelope). */
function parseEnvelope(text: string, contentType: string): RpcEnvelope {
  if (contentType.includes('text/event-stream')) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (!line) {
      throw new Error(`no SSE data line in response: ${text.slice(0, 200)}`);
    }
    return JSON.parse(line.slice(5).trim()) as RpcEnvelope;
  }
  return JSON.parse(text) as RpcEnvelope;
}

async function callMcp(
  app: INestApplication<App>,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
  mcpToken?: string,
): Promise<{
  status: number;
  contentType: string;
  envelope: RpcEnvelope;
  text: string;
}> {
  let req = request(app.getHttpServer())
    .post('/api/v1/mcp')
    .set('Accept', 'application/json, text/event-stream');
  if (mcpToken) {
    req = req.set('Authorization', `Bearer ${mcpToken}`);
  }
  const res = await req.send({ jsonrpc: '2.0', id, method, params });
  const contentType = res.headers['content-type'] ?? '';
  const text = res.text ?? JSON.stringify(res.body);
  return {
    status: res.status,
    contentType,
    envelope: parseEnvelope(text, contentType),
    text,
  };
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

async function createIntegration(
  app: INestApplication<App>,
  jwt: string,
  name: string,
): Promise<IntegrationSnake> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/system/mcp-integration')
    .set(TOKEN_HEADER, jwt)
    .send({ name, description: 'e2e' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<IntegrationSnake>).data;
}

async function sweepIntegrations(
  app: INestApplication<App>,
  jwt: string,
): Promise<void> {
  const res = await request(app.getHttpServer())
    .get('/api/v1/system/mcp-integration')
    .set(TOKEN_HEADER, jwt);
  const items = (res.body as ApiEnvelope<IntegrationSnake[]>).data ?? [];
  for (const item of items) {
    await request(app.getHttpServer())
      .delete(`/api/v1/system/mcp-integration/${item.id}`)
      .set(TOKEN_HEADER, jwt);
  }
}

describe('MCP /api/v1/mcp (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: string;
  let integration: IntegrationSnake;

  beforeAll(async () => {
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
                sql: 'SELECT x, y FROM t',
                tables: ['t'],
                chartType: 'bar',
                brief: 'e2e brief',
              },
            },
          ]),
        generateChart: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: { chartType: 'bar', config: { xField: 'x', yField: 'y' } },
            },
          ]),
        generateAnalysis: () =>
          asyncFrom<LlmGenEvent>([{ type: 'result', data: { analysis: 'a' } }]),
        generatePredict: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { predict: 'p', predictData: [] } },
          ]),
        generateGuessQuestion: () =>
          asyncFrom<LlmGenEvent>([{ type: 'result', data: { questions: [] } }]),
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'SQLite' }),
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
        execSql: () =>
          Promise.resolve({ columns: ['x', 'y'], rows: [['a', 1]] }),
        recallTables: () => Promise.resolve([]),
        tableList: () =>
          Promise.resolve([
            {
              id: 1,
              tableName: 't',
              tableComment: 'demo table',
              checked: true,
            },
          ]),
        fieldList: () =>
          Promise.resolve([
            {
              fieldName: 'x',
              fieldType: 'text',
              fieldComment: null,
              isPrimaryKey: false,
              checked: true,
            },
          ]),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({ validate: () => ({ ok: true, tables: [] }) })
      .overrideProvider(G2SsrClient)
      .useValue({ render: jest.fn().mockResolvedValue({ image: 'b64img' }) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    jwt = await login(app);
    await sweepIntegrations(app, jwt);
    integration = await createIntegration(app, jwt, 'e2e-agent');
  });

  afterAll(async () => {
    await sweepIntegrations(app, jwt);
    await app.close();
  });

  it('rejects a request without a Bearer token (401)', async () => {
    const res = await callMcp(app, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1.0' },
    });
    expect(res.status).toBe(401);
    expect(res.envelope.error?.code).toBe(-32001);
  });

  it('rejects an invalid Bearer token (401)', async () => {
    const res = await callMcp(
      app,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0' },
      },
      2,
      'qp_does_not_exist.bad',
    );
    expect(res.status).toBe(401);
    expect(res.envelope.error?.code).toBe(-32001);
  });

  it('creates an integration with a qp_ token and masks it in the list', async () => {
    expect(integration.token).toMatch(/^qp_[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(integration.access_key).toBe(integration.token.split('.')[0]);
    expect(integration.status).toBe('active');

    const list = await request(app.getHttpServer())
      .get('/api/v1/system/mcp-integration')
      .set(TOKEN_HEADER, jwt);
    expect(list.status).toBe(200);
    const items = (list.body as ApiEnvelope<IntegrationSnake[]>).data;
    const found = items.find((item) => item.id === integration.id);
    expect(found).toBeDefined();
    expect(found?.token).toBe(''); // masked
  });

  it('responds to initialize with server capabilities (SSE)', async () => {
    const res = await callMcp(
      app,
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e', version: '1.0' },
      },
      3,
      integration.token,
    );
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/event-stream');
    const result = res.envelope.result as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools?: { listChanged?: boolean } };
    };
    expect(result.serverInfo.name).toBe('queryprism');
    expect(result.capabilities.tools?.listChanged).toBe(true);
  });

  it('lists the six integration tools', async () => {
    const res = await callMcp(app, 'tools/list', {}, 4, integration.token);
    expect(res.status).toBe(200);
    const result = res.envelope.result as { tools: { name: string }[] };
    expect(result.tools.map((t) => t.name).sort()).toEqual(
      [
        'list_datasources',
        'list_tables',
        'describe_table',
        'list_models',
        'start_chat',
        'ask_question',
      ].sort(),
    );
  });

  it('list_datasources returns the seeded workspace datasource without configuration', async () => {
    const res = await callMcp(
      app,
      'tools/call',
      { name: 'list_datasources', arguments: {} },
      5,
      integration.token,
    );
    expect(res.status).toBe(200);
    const result = res.envelope.result as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text ?? '') as {
      datasources: {
        id: number;
        name: string;
        type: string;
        table_count: number;
        configuration?: unknown;
      }[];
    };
    const seeded = parsed.datasources.find((ds) => ds.id === 1);
    expect(seeded).toBeDefined();
    expect(seeded?.name).toBe('默认数据源');
    expect(seeded?.configuration).toBeUndefined();
  });

  it('list_tables and describe_table return workspace metadata', async () => {
    const tablesRes = await callMcp(
      app,
      'tools/call',
      { name: 'list_tables', arguments: { datasource_id: 1 } },
      6,
      integration.token,
    );
    const tablesResult = tablesRes.envelope.result as CallResult;
    expect(tablesResult.isError).toBeFalsy();
    expect(JSON.parse(tablesResult.content[0].text ?? '')).toEqual({
      datasource_id: 1,
      tables: [
        { id: 1, table_name: 't', table_comment: 'demo table', checked: true },
      ],
    });

    const describeRes = await callMcp(
      app,
      'tools/call',
      {
        name: 'describe_table',
        arguments: { datasource_id: 1, table_name: 'T' },
      },
      7,
      integration.token,
    );
    const describeResult = describeRes.envelope.result as CallResult;
    expect(describeResult.isError).toBeFalsy();
    const described = JSON.parse(describeResult.content[0].text ?? '') as {
      table: { table_name: string };
      fields: { field_name: string }[];
    };
    expect(described.table.table_name).toBe('t');
    expect(described.fields).toEqual([
      {
        field_name: 'x',
        field_type: 'text',
        field_comment: null,
        is_primary_key: false,
        checked: true,
      },
    ]);
  });

  it('start_chat creates an MCP-origin chat', async () => {
    const res = await callMcp(
      app,
      'tools/call',
      { name: 'start_chat', arguments: { datasource_id: 1, title: 'e2e' } },
      8,
      integration.token,
    );
    expect(res.status).toBe(200);
    const result = res.envelope.result as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text ?? '') as {
      chat_id: number;
    };
    expect(parsed.chat_id).toBeGreaterThan(0);
  });

  it('ask_question assembles the pipeline result + an image block', async () => {
    const res = await callMcp(
      app,
      'tools/call',
      {
        name: 'ask_question',
        arguments: {
          question: '画个图',
          datasource_id: 1,
          return_img: true,
        },
      },
      9,
      integration.token,
    );
    expect(res.status).toBe(200);
    const result = res.envelope.result as CallResult;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text ?? '') as {
      record_id: number;
      sql: string;
      brief: string;
      chart_type: string;
      chart_config: Record<string, unknown>;
    };
    expect(parsed.sql).toBe('SELECT x, y FROM t');
    expect(parsed.brief).toBe('e2e brief');
    expect(parsed.chart_type).toBe('bar');
    // The SSE chart frame / persisted record now carries the chart
    // object (type + axis) the Vue frontend renders directly.
    expect(parsed.chart_config).toEqual({
      type: 'bar',
      title: '',
      axis: {
        x: { name: 'x', value: 'x' },
        y: [{ name: 'y', value: 'y' }],
      },
    });
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'b64img',
      mimeType: 'image/png',
    });
  });

  it('disabling the integration revokes its token immediately', async () => {
    const update = await request(app.getHttpServer())
      .put('/api/v1/system/mcp-integration')
      .set(TOKEN_HEADER, jwt)
      .send({ id: integration.id, status: 'disabled' });
    expect(update.status).toBe(200);

    const res = await callMcp(app, 'tools/list', {}, 10, integration.token);
    expect(res.status).toBe(401);

    // Re-enable for the rotation test.
    await request(app.getHttpServer())
      .put('/api/v1/system/mcp-integration')
      .set(TOKEN_HEADER, jwt)
      .send({ id: integration.id, status: 'active' });
  });

  it('rotating the token invalidates the old token', async () => {
    const rotate = await request(app.getHttpServer())
      .patch(`/api/v1/system/mcp-integration/secret/${integration.id}`)
      .set(TOKEN_HEADER, jwt);
    expect(rotate.status).toBe(200);
    const rotated = (rotate.body as ApiEnvelope<{ token: string }>).data.token;
    expect(rotated).toMatch(/^qp_[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(rotated).not.toBe(integration.token);

    const oldRes = await callMcp(app, 'tools/list', {}, 11, integration.token);
    expect(oldRes.status).toBe(401);

    const newRes = await callMcp(app, 'tools/list', {}, 12, rotated);
    expect(newRes.status).toBe(200);
  });

  it('deleting the integration revokes its token', async () => {
    const rotated = await request(app.getHttpServer())
      .get(`/api/v1/system/mcp-integration/${integration.id}/secret`)
      .set(TOKEN_HEADER, jwt);
    expect(rotated.status).toBe(200);
    const token = (rotated.body as ApiEnvelope<{ token: string }>).data.token;

    const del = await request(app.getHttpServer())
      .delete(`/api/v1/system/mcp-integration/${integration.id}`)
      .set(TOKEN_HEADER, jwt);
    expect(del.status).toBe(200);

    const res = await callMcp(app, 'tools/list', {}, 13, token);
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// MetaDataImprove M1 — ask_question two-phase clarify: an ambiguous question
// over >= threshold candidate tables returns needs_clarification; the caller
// re-calls with clarify_record_id + picks to resume the SAME record.
// ---------------------------------------------------------------------------
describe('MCP ask_question clarify (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: string;
  let integration: IntegrationSnake;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
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
                brief: 'clarify brief',
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
          asyncFrom<LlmGenEvent>([{ type: 'result', data: { analysis: 'a' } }]),
        generatePredict: () =>
          asyncFrom<LlmGenEvent>([
            { type: 'result', data: { predict: 'p', predictData: [] } },
          ]),
        generateGuessQuestion: () =>
          asyncFrom<LlmGenEvent>([{ type: 'result', data: { questions: [] } }]),
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'SQLite' }),
        buildSqlContext: () => ({ engine: 'SQLite' }),
        buildForResult: () => ({ engine: 'SQLite' }),
      })
      .overrideProvider(DatasourceService)
      .useValue({
        findAll: () =>
          Promise.resolve([
            { id: 1, name: 'fake-ds', description: null, type: 'sqlite' },
          ]),
        // 4 checked tables, none named by the ambiguous question.
        findOne: () =>
          Promise.resolve({
            id: 1,
            name: 'fake-ds',
            type: 'sqlite',
            tables: [
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
            ],
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
        recallTables: () => Promise.resolve([]),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({
        validate: () => ({ ok: true, tables: [] }),
        extractTableNames: () => [],
      })
      .overrideProvider(G2SsrClient)
      .useValue({ render: jest.fn().mockResolvedValue({ image: 'b64img' }) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    jwt = await login(app);
    await sweepIntegrations(app, jwt);
    integration = await createIntegration(app, jwt, 'e2e-clarify-agent');
  });

  afterAll(async () => {
    await sweepIntegrations(app, jwt);
    await app.close();
  });

  it('returns needs_clarification, then resumes the record with picked tables', async () => {
    // Phase 1: ambiguous question → structured clarify result, no SQL.
    const first = await callMcp(
      app,
      'tools/call',
      {
        name: 'ask_question',
        arguments: { question: '统计一下整体情况', datasource_id: 1 },
      },
      1,
      integration.token,
    );
    expect(first.status).toBe(200);
    const firstResult = first.envelope.result as CallResult;
    expect(firstResult.isError).toBeFalsy();
    const asked = JSON.parse(firstResult.content[0].text ?? '') as {
      needs_clarification: boolean;
      record_id: number;
      question: string;
      candidates: Array<{ table_id: number; table_name: string }>;
      max_select: number;
    };
    expect(asked.needs_clarification).toBe(true);
    expect(asked.candidates).toHaveLength(4);
    expect(asked.max_select).toBe(3);

    // Phase 2: answer with two table picks → the same record produces SQL.
    const picks = asked.candidates.slice(0, 2).map((c) => c.table_id);
    const second = await callMcp(
      app,
      'tools/call',
      {
        name: 'ask_question',
        arguments: {
          clarify_record_id: asked.record_id,
          clarify_table_ids: picks,
        },
      },
      2,
      integration.token,
    );
    expect(second.status).toBe(200);
    const secondResult = second.envelope.result as CallResult;
    expect(secondResult.isError).toBeFalsy();
    const answered = JSON.parse(secondResult.content[0].text ?? '') as {
      record_id: number;
      sql: string;
      brief: string;
      needs_clarification?: boolean;
    };
    expect(answered.record_id).toBe(asked.record_id);
    expect(answered.sql).toBe('SELECT 1');
    expect(answered.needs_clarification).toBeUndefined();
  });

  it('rejects a clarify answer for a record that never paused (error result)', async () => {
    // Ask with an explicit table mention → no clarify pause → the record
    // finishes; resuming it must fail as a tool error, not a crash.
    const direct = await callMcp(
      app,
      'tools/call',
      {
        name: 'ask_question',
        arguments: { question: '查一下sales_order的金额', datasource_id: 1 },
      },
      3,
      integration.token,
    );
    const directResult = direct.envelope.result as CallResult;
    const parsed = JSON.parse(directResult.content[0].text ?? '') as {
      record_id: number;
    };
    expect(parsed.record_id).toBeGreaterThan(0);

    const resume = await callMcp(
      app,
      'tools/call',
      {
        name: 'ask_question',
        arguments: {
          clarify_record_id: parsed.record_id,
          clarify_skip: true,
        },
      },
      4,
      integration.token,
    );
    expect(resume.status).toBe(200);
    const resumeResult = resume.envelope.result as CallResult;
    expect(resumeResult.isError).toBe(true);
  });
});
