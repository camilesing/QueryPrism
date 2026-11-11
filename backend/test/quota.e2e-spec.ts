// Quota e2e (MetaDataImprove M7) — daily query budgets enforced at the chat
// pipeline entry. Runs the full SSE pipeline with deterministic LLM/datasource
// fakes (same pattern as chat.e2e-spec) but the REAL QuotaService + Prisma:
// a workspace-default budget of 1 lets the first question through and fails
// the second with the quota error frame, without touching the LLM fake's SQL
// path (the record is created, then failed).
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
            : Promise.resolve({ done: false, value: items[i++] }),
      };
    },
  };
}

async function login(
  app: INestApplication<App>,
  username = 'admin',
  password = 'admin',
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username, password });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Query quota (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let token: string;
  let quotaUid = 0;
  let quotaToken = '';
  const chatIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(GeneratorService)
      .useValue({
        generateSql: () =>
          asyncFrom<LlmGenEvent>([
            {
              type: 'result',
              data: {
                success: true,
                sql: 'SELECT 1',
                tables: [],
                chartType: 'table',
                brief: 'quota e2e',
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
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'SQLite' }),
        buildSqlContext: () => ({ engine: 'SQLite' }),
        buildForResult: () => ({ engine: 'SQLite' }),
      })
      .overrideProvider(DatasourceService)
      .useValue({
        findAll: () => Promise.resolve([]),
        findOne: () =>
          Promise.resolve({
            id: 1,
            name: 'fake-ds',
            type: 'sqlite',
            tables: [],
          }),
        execSql: () => Promise.resolve({ columns: ['id'], rows: [[1]] }),
        recallTables: () => Promise.resolve([]),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({
        validate: () => ({ ok: true, tables: [] }),
        // The quota user is a normal user → the row-permission path calls
        // extractTableNames; return no tables so getRowFilters yields [].
        extractTableNames: () => [],
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);

    // Dedicated low-budget user — NOT a workspace-default row: a default row
    // for oid 1 would poison every later suite that asks questions as admin,
    // and jest's suite order is not guaranteed.
    const account = `quota_user_${Date.now()}`;
    const created = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account,
        password: 'Init1234!',
        email: `${account}@e2e.test`,
        name: 'Quota User',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    expect(created.status).toBe(200);
    quotaUid = (await prisma.user.findUniqueOrThrow({ where: { account } })).id;
    quotaToken = await login(app, account, 'Init1234!');
    await prisma.queryBudget.upsert({
      where: {
        oid_subjectType_subjectId: {
          oid: 1,
          subjectType: 'user',
          subjectId: quotaUid,
        },
      },
      create: {
        oid: 1,
        subjectType: 'user',
        subjectId: quotaUid,
        dailyLimit: 1,
      },
      update: { dailyLimit: 1 },
    });
  });

  afterAll(async () => {
    await prisma.queryBudget
      .deleteMany({
        where: { oid: 1, subjectType: 'user', subjectId: quotaUid },
      })
      .catch(() => undefined);
    await prisma.queryUsageDaily
      .deleteMany({ where: { oid: 1, subjectId: quotaUid } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: quotaUid } })
      .catch(() => undefined);
    for (const id of chatIds) {
      await prisma.chat.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await app.close();
  });

  async function askQuestion(): Promise<string> {
    const start = await request(app.getHttpServer())
      .post('/api/v1/chat/start')
      .set(TOKEN_HEADER, quotaToken)
      .send({ datasource: 1 });
    const chatId = (start.body as ApiEnvelope<{ id: number }>).data.id;
    chatIds.push(chatId);
    const res = await request(app.getHttpServer())
      .post('/api/v1/chat/question')
      .set(TOKEN_HEADER, quotaToken)
      .send({ chat_id: chatId, question: '查询用户数' });
    return res.text;
  }

  it('first query passes, second exhausts the budget and fails the record', async () => {
    const first = await askQuestion();
    expect(first).toContain('"type":"sql"');
    expect(first).not.toContain('"type":"error"');

    const second = await askQuestion();
    expect(second).toContain('"type":"id"'); // record still created
    expect(second).toContain('"type":"error"');
    expect(second).toContain('预算');
    // The failed record never reached the (fake) LLM.
    expect(second).not.toContain('"type":"sql"');
  });

  it('GET /system/quota reports the budget rows and today usage', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/system/quota')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const rows = (
      res.body as ApiEnvelope<
        Array<{
          subject_type: string;
          subject_id: number | null;
          daily_limit: number;
          used_today: number | null;
        }>
      >
    ).data;
    const own = rows.find(
      (r) => r.subject_type === 'user' && r.subject_id === quotaUid,
    );
    expect(own?.daily_limit).toBe(1);
    // Rejected attempts don't consume budget — only the accepted first query.
    expect(own?.used_today).toBe(1);
    // A default row created and removed within this test cannot leak to
    // other suites (serial worker): create → visible → delete.
    await request(app.getHttpServer())
      .put('/api/v1/system/quota')
      .set(TOKEN_HEADER, token)
      .send({ subject_type: 'default', daily_limit: 50 });
    const withDefaultRes = await request(app.getHttpServer())
      .get('/api/v1/system/quota')
      .set(TOKEN_HEADER, token);
    const withDefault = (
      withDefaultRes.body as ApiEnvelope<Array<{ subject_type: string }>>
    ).data;
    expect(withDefault.some((r) => r.subject_type === 'default')).toBe(true);
    const defRow = await prisma.queryBudget.findFirst({
      where: { oid: 1, subjectType: 'default' },
    });
    if (defRow) {
      await prisma.queryBudget.delete({ where: { id: defRow.id } });
    }
  });

  it('PUT /system/quota validates subject shape', async () => {
    const bad = await request(app.getHttpServer())
      .put('/api/v1/system/quota')
      .set(TOKEN_HEADER, token)
      .send({ subject_type: 'user', daily_limit: 5 }); // missing subject_id
    expect(bad.status).toBe(400);

    const ok = await request(app.getHttpServer())
      .put('/api/v1/system/quota')
      .set(TOKEN_HEADER, token)
      .send({ subject_type: 'user', subject_id: quotaUid, daily_limit: 99 });
    expect(ok.status).toBe(200);
    // Restore the enforcement limit for... nothing further asks here; still
    // tidy the row back so afterAll state matches expectations.
    await prisma.queryBudget.update({
      where: {
        oid_subjectType_subjectId: {
          oid: 1,
          subjectType: 'user',
          subjectId: quotaUid,
        },
      },
      data: { dailyLimit: 1 },
    });
  });
});
