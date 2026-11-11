// Regression suite e2e (MetaDataImprove M6) — the full loop:
//   1. manual run captures the baseline (DB-side COUNT/SUM via real execSql)
//   2. a member proposes + admin approves a semantic change → the approval
//      hook schedules a debounced run (real RegressionTriggerService)
//   3. the LLM fake now emits a WIDER SQL (WHERE dropped) → the case is
//      flagged with sum_inflated (the caliber-widening accident M6 hunts)
//   4. promote adopts the new aggregates → the same SQL passes
// The LLM/datasource-safety layers are faked (chat-semantic.e2e-spec
// pattern); DatasourceService.execSql is REAL so the verify aggregates hit
// the real temp SQLite datasource.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { encryptFrontendConfig } from './../src/datasource/frontend-config-crypto';
import { AiQuestionService } from './../src/llm/ai-question.service';
import { GeneratorService } from './../src/llm/generator.service';
import type { LlmGenEvent } from './../src/llm/generator.service';
import { SqlSafetyService } from './../src/chat/sql-safety.service';
import { waitFor } from './helpers/wait-for';

jest.setTimeout(180_000);

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
  username: string,
  password: string,
): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username, password });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

const stamp = Date.now();
const tempDbPath = `/tmp/test-regression-e2e-${stamp}.db`;
const memberAccount = `reg_member_${stamp}`;
const semanticTable = `reg_orders_${stamp}`;

// Phase 1: the correct caliber (category = 'A' → 1 group, SUM 100).
// Phase 2: the "semantic change" regression — the WHERE vanished (2 groups,
// SUM 150 = 60+40+50): row count +100%, sum +50% — invisible in code review,
// obvious when you run the numbers.
const SQL_NARROW = `SELECT category, SUM(amount) AS total FROM orders WHERE category = 'A' GROUP BY category`;
const SQL_WIDE = `SELECT category, SUM(amount) AS total FROM orders GROUP BY category`;
let fakeSql = SQL_NARROW;

interface RunCaseRow {
  status: string;
  rowCount: number | null;
  sums: { total?: number } | null;
  delta: { reasons?: string[]; rowCountPct?: number } | null;
  message: string | null;
}

describe('Regression suite (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let adminToken: string;
  let memberToken: string;
  let dsId: number;
  let caseId: number;

  beforeAll(async () => {
    const db = new Database(tempDbPath);
    db.exec(
      'CREATE TABLE orders (id INTEGER PRIMARY KEY, category TEXT, amount REAL)',
    );
    db.exec(
      "INSERT INTO orders (id, category, amount) VALUES (1, 'A', 60), (2, 'A', 40), (3, 'B', 50)",
    );
    db.close();

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
                sql: fakeSql,
                tables: [],
                chartType: 'table',
                brief: 'regression e2e',
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
        generateGuessQuestion: () =>
          asyncFrom<LlmGenEvent>([{ type: 'result', data: { questions: [] } }]),
      })
      .overrideProvider(AiQuestionService)
      .useValue({
        buildForSelectDatasource: () => ({ engine: 'SQLite' }),
        buildSqlContext: () => ({ engine: 'SQLite' }),
        buildForResult: () => ({ engine: 'SQLite' }),
      })
      .overrideProvider(SqlSafetyService)
      .useValue({ validate: () => ({ ok: true, tables: [] }) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    adminToken = await login(app, 'admin', 'admin');

    // Member (normal user of workspace 1) for the proposal flow.
    const created = await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, adminToken)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Regression Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    expect(created.status).toBe(200);
    memberToken = await login(app, memberAccount, 'Init1234!');

    const add = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .set(TOKEN_HEADER, adminToken)
      .send({
        name: `regression-e2e-${stamp}`,
        type: 'sqlite',
        configuration: encryptFrontendConfig({ db: tempDbPath }),
      });
    expect(add.status).toBe(200);
    dsId = (add.body as ApiEnvelope<{ id: number }>).data.id;
  });

  afterAll(async () => {
    // Clean by suite timestamp: regression rows, the approved semantic, the
    // request, the member, the datasource. Regression chats are deleted by
    // the runner itself; sweep any stragglers (origin=2).
    await prisma.regressionRunCase.deleteMany({}).catch(() => undefined);
    await prisma.regressionRun.deleteMany({}).catch(() => undefined);
    await prisma.regressionCase.deleteMany({}).catch(() => undefined);
    await prisma.tableSemantic
      .deleteMany({ where: { tableName: semanticTable } })
      .catch(() => undefined);
    await prisma.semanticChangeRequest
      .deleteMany({ where: { createdAt: { gte: new Date(stamp - 1000) } } })
      .catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { account: memberAccount } })
      .catch(() => undefined);
    if (dsId) {
      await prisma.datasource
        .deleteMany({ where: { id: dsId } })
        .catch(() => undefined);
    }
    await app.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  function createCase() {
    return request(app.getHttpServer())
      .put('/api/v1/system/regression')
      .set(TOKEN_HEADER, adminToken)
      .send({
        datasource_id: dsId,
        name: 'A类订单金额',
        question: '统计A类订单的总金额',
        tolerance_pct: 10,
      });
  }

  async function startManualRun(): Promise<number> {
    const res = await request(app.getHttpServer())
      .post('/api/v1/system/regression/run')
      .set(TOKEN_HEADER, adminToken);
    expect(res.status).toBe(200);
    return (res.body as ApiEnvelope<number>).data;
  }

  async function waitRunDone(runId: number) {
    return waitFor(
      async () =>
        prisma.regressionRun.findUniqueOrThrow({ where: { id: runId } }),
      (run) => run.status === 'done',
      { attempts: 100, delayMs: 200 },
    );
  }

  async function runCasesOf(runId: number): Promise<RunCaseRow[]> {
    return prisma.regressionRunCase.findMany({
      where: { runId },
      orderBy: { caseId: 'asc' },
    }) as unknown as Promise<RunCaseRow[]>;
  }

  it('creates the case and captures the baseline on the first manual run', async () => {
    const res = await createCase();
    expect(res.status).toBe(200);
    caseId = (res.body as ApiEnvelope<{ id: number }>).data.id;

    const runId = await startManualRun();
    await waitRunDone(runId);

    const cases = await runCasesOf(runId);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('baseline_captured');
    // DB-side aggregates: 1 group ('A'), SUM(amount)=100 — NOT the capped
    // sample rows.
    expect(cases[0].rowCount).toBe(1);
    expect(cases[0].sums?.total).toBe(100);

    const row = await prisma.regressionCase.findUniqueOrThrow({
      where: { id: caseId },
    });
    expect((row.baseline as { rowCount: number }).rowCount).toBe(1);
  });

  it('an approved semantic change auto-triggers a run that FLAGS the widened caliber', async () => {
    // The "accident": after the semantic change the LLM drops the WHERE.
    fakeSql = SQL_WIDE;

    // Member proposes a WORKSPACE table semantic; nothing runs yet.
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'table',
        scope: 'WORKSPACE',
        datasource_id: dsId,
        table_name: semanticTable,
        meaning: '回归测试语义变更',
        note: '成员提案',
      });
    expect(propose.status).toBe(200);
    const requestId = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id?: number }>
    ).data.request_id;
    expect(requestId).toBeDefined();

    const beforeRuns = await prisma.regressionRun.count();

    const approve = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, adminToken)
      .send({ id: requestId, approve: true });
    expect(approve.status).toBe(200);

    // The approval hook debounces ~30s, then the run executes (LLM fake +
    // verify aggregates). Poll until an approval-triggered run is done.
    const run = await waitFor(
      async () =>
        prisma.regressionRun.findFirst({
          where: { trigger: 'approval', status: 'done' },
          orderBy: { id: 'desc' },
        }),
      (r) => r !== null,
      { attempts: 90, delayMs: 1000 },
    );
    expect(run!.id).toBeGreaterThan(beforeRuns);

    const cases = await runCasesOf(run!.id);
    expect(cases).toHaveLength(1);
    expect(cases[0].status).toBe('flagged');
    expect(cases[0].rowCount).toBe(2); // A + B groups (fan-out)
    expect(cases[0].sums?.total).toBe(150); // 60+40+50 — the widened caliber
    expect(cases[0].delta?.reasons).toContain('sum_inflated:total');
    expect(cases[0].delta?.reasons).toContain('row_count_inflated');
    expect(cases[0].delta?.rowCountPct).toBe(100);
  });

  it('promote adopts the new aggregates; the same SQL then passes', async () => {
    const runs = await prisma.regressionRun.findMany({
      where: { trigger: 'approval', status: 'done' },
      orderBy: { id: 'desc' },
      take: 1,
    });

    const promote = await request(app.getHttpServer())
      .post(`/api/v1/system/regression/run/${runs[0].id}/promote`)
      .set(TOKEN_HEADER, adminToken);
    expect(promote.status).toBe(200);

    const row = await prisma.regressionCase.findUniqueOrThrow({
      where: { id: caseId },
    });
    expect((row.baseline as { sums: { total: number } }).sums.total).toBe(150);

    const runId = await startManualRun();
    await waitRunDone(runId);
    const cases = await runCasesOf(runId);
    expect(cases[0].status).toBe('passed');
    expect(cases[0].delta?.reasons).toEqual([]);
  });

  it('cleans up its transient regression chats (origin=2)', async () => {
    // The runner deletes each case's chat in finally — none survive.
    const leftovers = await prisma.chat.count({ where: { origin: 2 } });
    expect(leftovers).toBe(0);
  });
});
