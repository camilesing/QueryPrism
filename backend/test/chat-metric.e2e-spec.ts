// Chat metric e2e — MetaDataImprove M4: a question whose extracted keyword IS
// a metric name injects its caliber into the generate_sql prompt block and
// force-stuffs the atomic table into the schema; naming-dictionary entries
// inject the standard translations when a keyword or a piece of the stuffed
// schema's metadata equals the term; metric.enabled=false disables the
// injection. Matching is EXACT keyword equality — the raw question is never
// substring-matched. The LLM/datasource/safety providers are faked
// (SSE-block pattern from chat-semantic.e2e-spec); MetricService /
// DataStandardService are REAL (real Prisma rows seeded per case) so matching
// + resolution run for true.
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
];

describe('Chat metric definitions + naming rules (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let capturedTableIds: number[] | undefined;
  let capturedMetrics: string | undefined;
  let capturedNamingRules: string | undefined;
  /** What the faked keyword extraction returns for a turn ('EMPTY' = none). */
  let extractedKeywords: string;

  beforeEach(async () => {
    capturedTableIds = undefined;
    capturedMetrics = undefined;
    capturedNamingRules = undefined;
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
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT 1',
                tables: [],
                chartType: 'table',
                brief: 'metric e2e',
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
        // without this the real extractKeywords step throws before calling the
        // faked generator and silently degrades to "no keywords"
        buildForKeywords: () => ({}),
        buildSqlContext: (ctx: {
          tableIds?: number[];
          metrics?: string;
          namingRules?: string;
        }) => {
          capturedTableIds = ctx.tableIds;
          capturedMetrics = ctx.metrics;
          capturedNamingRules = ctx.namingRules;
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
          // 2 candidates WITHOUT sales_order — the metric match must be what
          // force-stuffs table 1 back into the schema.
          Promise.resolve(FAKE_TABLES.slice(1, 3)),
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
    await prisma.metricDef.deleteMany({});
    await prisma.dataStandard.deleteMany({});
    await prisma.systemVariable.deleteMany({
      where: {
        type: 'parameter',
        name: {
          in: ['metric.enabled', 'metric.max_definitions', 'naming.enabled'],
        },
      },
    });
  });

  afterEach(async () => {
    await prisma.metricDef.deleteMany({}).catch(() => undefined);
    await prisma.dataStandard.deleteMany({}).catch(() => undefined);
    await prisma.systemVariable
      .deleteMany({
        where: {
          type: 'parameter',
          name: {
            in: ['metric.enabled', 'metric.max_definitions', 'naming.enabled'],
          },
        },
      })
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

  async function ask(chatId: number, question: string) {
    return request(app.getHttpServer())
      .post('/api/v1/chat/question')
      .set(TOKEN_HEADER, token)
      .send({ chat_id: chatId, question });
  }

  async function cleanupChat(chatId: number): Promise<void> {
    await request(app.getHttpServer())
      .delete(`/api/v1/chat/${chatId}`)
      .set(TOKEN_HEADER, token)
      .send({ id: chatId });
  }

  it('a derived metric named by a keyword injects its caliber and force-stuffs its table', async () => {
    await prisma.metricDef.create({
      data: {
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        unit: '元',
        scope: 'WORKSPACE',
        oid: 1,
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      },
    });
    await prisma.metricDef.create({
      data: {
        kind: 'derived',
        code: 'pay_7d',
        name: '近7天支付金额',
        scope: 'WORKSPACE',
        oid: 1,
        definition: { atomic_code: 'pay_amount' },
      },
    });
    // the extractor produced the derived metric's OWN name
    extractedKeywords = '近7天支付金额';
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '统计近7天支付金额');
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      // Recall returned [2, 3]; the matched metric's atomic table (1) was
      // force-appended by the M4 step.
      expect(capturedTableIds).toEqual([2, 3, 1]);
      // The caliber block rides along on the SQL context.
      expect(capturedMetrics).toContain('<metric_definitions>');
      expect(capturedMetrics).toContain('SUM(sales_order.amount)');
      expect(capturedMetrics).toContain('近7天支付金额 (pay_7d)');
    } finally {
      await cleanupChat(chatId);
    }
  });

  it('a metric name that is only PART of a keyword is not matched (no substring)', async () => {
    await prisma.metricDef.create({
      data: {
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        scope: 'WORKSPACE',
        oid: 1,
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      },
    });
    // the question contains 支付金额 verbatim, but the extracted keyword is
    // the longer phrase — exact equality fails
    extractedKeywords = '支付金额趋势';
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '统计支付金额');
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedMetrics).toBe('');
      expect(capturedTableIds).toEqual([2, 3]);
    } finally {
      await cleanupChat(chatId);
    }
  });

  it('naming entries inject on an exact keyword OR on stuffed schema metadata', async () => {
    await prisma.dataStandard.create({
      data: {
        kind: 'naming',
        code: 'annual_revenue',
        term: '年营收',
        name: '年度总营业额',
        category: 'business_noun',
        scope: 'WORKSPACE',
        oid: 1,
      },
    });
    // no keyword names this entry — the COMMENT of a stuffed table does
    // (recall returns crm_customer whose comment is 客户信息)
    await prisma.dataStandard.create({
      data: {
        kind: 'naming',
        code: 'customer_master',
        term: '客户信息',
        name: '客户主数据',
        category: 'business_noun',
        scope: 'WORKSPACE',
        oid: 1,
      },
    });
    extractedKeywords = '年营收';
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '今年的年营收是多少');
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedNamingRules).toContain('<naming_rules>');
      // keyword hit
      expect(capturedNamingRules).toContain('term="年营收"');
      expect(capturedNamingRules).toContain('standard="年度总营业额"');
      // schema-metadata hit (table comment of a stuffed table)
      expect(capturedNamingRules).toContain('term="客户信息"');
      expect(capturedNamingRules).toContain('standard="客户主数据"');
      // No metric matched → the metric block stays empty.
      expect(capturedMetrics).toBe('');
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
    await prisma.metricDef.create({
      data: {
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        scope: 'WORKSPACE',
        oid: 1,
        definition: {
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
      },
    });
    const chatId = await startChat();
    try {
      const res = await ask(chatId, '统计支付金额');
      expect(res.status).toBe(200);
      expect(res.text).toContain('"type":"sql"');
      expect(capturedMetrics).toBe('');
      // No force-stuff either — table 1 stays out of the recall set.
      expect(capturedTableIds).toEqual([2, 3]);
    } finally {
      await cleanupChat(chatId);
    }
  });
});
