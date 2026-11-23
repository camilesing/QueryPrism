// Attribution-domain chat e2e — the full NL2SQL pipeline over the realistic
// fixture (test/fixtures/attribution) with ONLY the LLM faked. Every other
// collaborator is REAL: AiQuestionService (data-training / custom-prompt
// recall), DatasourceService (M-Schema + SQLite execSql),
// MetricService / DataStandardService / SemanticService matching. The fake
// GeneratorService.generateSql captures the assembled AiModelQuestion and
// returns a canned SQL, so each test asserts BOTH the prompt injection of all
// four governance features AND the SQL execution against the live SQLite file
// (expected values recomputed from the CSVs — never hard-coded).
//
// clarify.enabled is switched off via a SystemVariable parameter row for this
// suite: table recall always returns [] in the test env (no embedding
// provider), so the pipeline wants to stuff all 4 checked tables and
// clarify.table_threshold (default 3) would pause every question. The
// parameter system exists exactly for this; the row is swept in cleanup.
// (chat-clarify.e2e-spec.ts covers the pause itself.)
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { GeneratorService } from './../src/llm/generator.service';
import type { LlmGenEvent } from './../src/llm/generator.service';
import {
  buildAttributionDb,
  createAttributionDatasource,
  readAttributionCsv,
  removeAttributionDatasource,
  type AttributionDatasource,
} from './helpers/attribution-fixture';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface CapturedContext {
  question: string;
  schema: string;
  customPrompt?: string;
  metrics?: string;
  namingRules?: string;
}

const CANNED_SQL =
  "SELECT utm_source, SUM(total_amount_first) AS first_gmv FROM sl_dm_store_referrer_utm_rt WHERE is_first = 'yes' GROUP BY utm_source ORDER BY first_gmv DESC";

function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: () =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false, value: items[i++] }),
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

/** First `id` frame of the SSE stream → the new ChatRecord id. */
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
      // non-JSON frame — skip
    }
  }
  throw new Error('recordId not found in SSE stream');
}

/** Expected first-touch GMV per utm_source, recomputed from the fixture CSV. */
function expectedFirstTouchGmv(): Map<string, number> {
  const dm = readAttributionCsv('sl_dm_store_referrer_utm_rt');
  const out = new Map<string, number>();
  for (const r of dm.rows) {
    if (r.is_first !== 'yes') continue;
    out.set(
      r.utm_source,
      (out.get(r.utm_source) ?? 0) + Number(r.total_amount_first),
    );
  }
  return out;
}

describe('Attribution chat pipeline (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let ds: AttributionDatasource;
  let captured: CapturedContext | undefined;
  const stamp = Date.now();
  const dsName = `attribution-chat-${stamp}`;

  const PARAMETER_ROWS = [
    'clarify.enabled',
    'metric.enabled',
    'naming.enabled',
    'metric.max_definitions',
  ];

  // ONE overridden app for the whole suite: the afterAll sweep needs a live
  // PrismaService, so the app must not be closed between tests (chat-metric
  // rebuilds per test and therefore cleans up inside afterEach instead).
  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      // ONLY the LLM is faked — the fake generateSql hands back the canned
      // SQL after capturing the fully assembled context.
      .overrideProvider(GeneratorService)
      .useValue({
        extractKeywords: () =>
          asyncFrom<LlmGenEvent>([{ type: 'content', delta: 'EMPTY' }]),
        generateSql: (ctx: CapturedContext) => {
          captured = ctx;
          return asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: CANNED_SQL,
                tables: ['sl_dm_store_referrer_utm_rt'],
                chartType: 'table',
                brief: '首触GMV按流量来源',
              },
            },
          ]);
        },
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
            { type: 'result', data: { questions: ['推荐1'] } },
          ]),
      })
      .compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);

    const dbPath = `/tmp/attr-chat-e2e-${stamp}.db`;
    buildAttributionDb(dbPath);
    ds = await createAttributionDatasource(app, token, dbPath, dsName);
  });

  afterAll(async () => {
    if (!app) return;
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: ds?.dsId ?? -1 } })
      .catch(() => undefined);
    await prisma.fieldSemantic
      .deleteMany({ where: { datasourceId: ds?.dsId ?? -1 } })
      .catch(() => undefined);
    await prisma.metricDef
      .deleteMany({ where: { code: 'first_touch_gmv' } })
      .catch(() => undefined);
    await prisma.dataStandard
      .deleteMany({ where: { code: 'gmv' } })
      .catch(() => undefined);
    await prisma.customPrompt
      .deleteMany({ where: { oid: 1, name: { startsWith: 'attr-chat-' } } })
      .catch(() => undefined);
    await prisma.systemVariable
      .deleteMany({
        where: { type: 'parameter', name: { in: PARAMETER_ROWS } },
      })
      .catch(() => undefined);
    if (ds) await removeAttributionDatasource(app, token, ds, dsName);
    await app.close();
  });

  beforeEach(async () => {
    captured = undefined;

    // Deterministic switches: recall-off → clarify gate must not pause; other
    // feature switches reset to their enabled defaults per test.
    await prisma.systemVariable.deleteMany({
      where: { type: 'parameter', name: { in: PARAMETER_ROWS } },
    });
    await prisma.systemVariable.create({
      data: {
        type: 'parameter',
        varType: 'str',
        name: 'clarify.enabled',
        value: 'false',
      },
    });

    // The four governance features, seeded for the attribution datasource.
    await prisma.tableSemantic.deleteMany({ where: { datasourceId: ds.dsId } });
    await prisma.fieldSemantic.deleteMany({ where: { datasourceId: ds.dsId } });
    await prisma.tableSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: ds.dsId,
        tableName: 'sl_dm_store_referrer_utm_rt',
        meaning: '店铺维度流量来源UTM日汇总(首触/末触两行一组)',
        enabled: true,
      },
    });
    await prisma.fieldSemantic.create({
      data: {
        scope: 'WORKSPACE',
        oid: 1,
        datasourceId: ds.dsId,
        tableName: 'sl_dm_store_referrer_utm_rt',
        fieldName: 'utm_source',
        role: 'dimension',
        meaning: 'UTM流量来源(渠道标识)',
        enabled: true,
      },
    });
    await prisma.metricDef.deleteMany({
      where: { code: 'first_touch_gmv' },
    });
    await prisma.metricDef.create({
      data: {
        kind: 'atomic',
        code: 'first_touch_gmv',
        name: '首触归因GMV',
        unit: '分',
        scope: 'WORKSPACE',
        oid: 1,
        enabled: true,
        definition: {
          datasource_id: ds.dsId,
          table_name: 'sl_dm_store_referrer_utm_rt',
          field_name: 'total_amount_first',
          aggregation: 'SUM',
        },
      },
    });
    await prisma.dataStandard.deleteMany({ where: { code: 'gmv' } });
    await prisma.dataStandard.create({
      data: {
        kind: 'naming',
        code: 'gmv',
        term: 'GMV',
        name: '商品交易总额',
        category: 'business_noun',
        scope: 'WORKSPACE',
        oid: 1,
        enabled: true,
      },
    });
    await prisma.customPrompt.deleteMany({
      where: { oid: 1, name: { startsWith: 'attr-chat-' } },
    });
    await prisma.customPrompt.create({
      data: {
        oid: 1,
        type: 'GENERATE_SQL',
        name: 'attr-chat-global',
        prompt: '归因域查询金额单位一律为分。',
        specificDs: false,
        datasourceIds: [],
      },
    });
    await prisma.customPrompt.create({
      data: {
        oid: 1,
        type: 'GENERATE_SQL',
        name: 'attr-chat-bound',
        prompt: 'sl_dm_ 前缀表为归因域汇总层。',
        specificDs: true,
        datasourceIds: [ds.dsId],
      },
    });
  });

  afterEach(async () => {
    await prisma.systemVariable
      .deleteMany({
        where: { type: 'parameter', name: { in: PARAMETER_ROWS } },
      })
      .catch(() => undefined);
  });

  async function ask(
    question: string,
  ): Promise<{ chatId: number; rid: number; text: string }> {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, token)
      .send({ datasource: ds.dsId });
    expect(start.status).toBe(200);
    const chatId = (start.body as ApiEnvelope<{ id: number }>).data.id;
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/chat/question')
        .set(TOKEN_HEADER, token)
        .send({ chat_id: chatId, question });
      return { chatId, rid: recordIdFromSse(res.text), text: res.text };
    } catch (e) {
      await request(app.getHttpServer())
        .delete(`/api/v1/chat/${chatId}`)
        .set(TOKEN_HEADER, token)
        .send({ id: chatId })
        .catch(() => undefined);
      throw e;
    }
  }

  async function cleanupChat(chatId: number): Promise<void> {
    await request(app.getHttpServer())
      .delete(`/api/v1/chat/${chatId}`)
      .set(TOKEN_HEADER, token)
      .send({ id: chatId })
      .catch(() => undefined);
  }

  it('injects all four governance features and executes the SQL on SQLite', async () => {
    const { chatId, rid, text } = await ask('首触归因GMV');
    try {
      expect(text).toContain('"type":"sql"');
      expect(text).toContain('execute-success');

      // 数据字典 — table + field meanings decorate the stuffed M-Schema.
      expect(captured).toBeDefined();
      expect(captured!.schema).toContain('店铺维度流量来源UTM日汇总');
      expect(captured!.schema).toContain('UTM流量来源(渠道标识)');

      // 指标 — caliber block + the SUM expression of the matched atomic.
      expect(captured!.metrics).toContain('<metric_definitions>');
      expect(captured!.metrics).toContain(
        'SUM(sl_dm_store_referrer_utm_rt.total_amount_first)',
      );

      // 数据标准 — naming translation.
      expect(captured!.namingRules).toContain('term="GMV"');
      expect(captured!.namingRules).toContain('standard="商品交易总额"');

      // 提示词 — global + datasource-bound rows are concatenated.
      expect(captured!.customPrompt).toContain('金额单位一律为分');
      expect(captured!.customPrompt).toContain('归因域汇总层');

      // SQL 真执行 — record data matches the CSV-derived aggregation.
      const data = await request(app.getHttpServer())
        .get(`/api/v1/chat/record/${rid}/data`)
        .set(TOKEN_HEADER, token);
      expect(data.status).toBe(200);
      const shape = (
        data.body as ApiEnvelope<{
          fields: string[];
          data: Record<string, unknown>[];
        }>
      ).data;
      expect(shape.fields).toEqual(['utm_source', 'first_gmv']);
      const expected = [...expectedFirstTouchGmv().entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([utm_source, first_gmv]) => ({ utm_source, first_gmv }));
      expect(shape.data).toEqual(expected);
    } finally {
      await cleanupChat(chatId);
    }
  });

  it('metric.enabled=false keeps the pipeline running without injection', async () => {
    await prisma.systemVariable.create({
      data: {
        type: 'parameter',
        varType: 'str',
        name: 'metric.enabled',
        value: 'false',
      },
    });
    const { chatId, text } = await ask('首触归因GMV');
    try {
      expect(text).toContain('"type":"sql"');
      expect(text).toContain('execute-success');
      expect(captured!.metrics).toBe('');
      // The other injections are unaffected.
      expect(captured!.schema).toContain('店铺维度流量来源UTM日汇总');
      expect(captured!.customPrompt).toContain('金额单位一律为分');
    } finally {
      await cleanupChat(chatId);
    }
  });

  it('removing the datasource-bound prompt leaves only the global one', async () => {
    await prisma.customPrompt.deleteMany({
      where: { oid: 1, name: 'attr-chat-bound' },
    });
    const { chatId } = await ask('首触归因GMV');
    try {
      expect(captured!.customPrompt).toContain('金额单位一律为分');
      expect(captured!.customPrompt).not.toContain('归因域汇总层');
    } finally {
      await cleanupChat(chatId);
    }
  });
});
