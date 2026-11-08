// RecommendedProblem (recommended_problem) e2e — verifies the
// datasource recommended-problem surface (Phase 10d cycle 6) end-to-end
// against the real AppModule + real Prisma. Routes mount under
// /recommended_problem (snake_case wire).
//
// This suite verifies the contract:
//   - GET  /recommended_problem/get_datasource_recommended/:dsId
//        → bare array of {id, datasource_id, question}
//   - GET  /recommended_problem/get_datasource_recommended_base/:dsId
//        → bare object {datasource_id, recommended_config, questions}
//   - POST /recommended_problem/save_recommended_problem
//        (body; replace-all; frontend ignores return)
//
// beforeAll creates a test Datasource row (the _base + save routes touch the
// Datasource table); afterAll deletes it (cascade removes its DsRecommendedProblem
// rows via the FK onDelete:Cascade). No sweep of other suites' datasources —
// only this suite's own test row is created/deleted (no overlap concern; the
// chat pipeline reads DsRecommendedProblem via Prisma, not HTTP).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T;
}

interface RecommendedProblemSnake {
  id: number;
  datasource_id: number;
  question: string;
}

interface RecommendedProblemBase {
  datasource_id: number;
  recommended_config: number;
  questions: string | null;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200); // batch7: assert login success
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('RecommendedProblem (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let dsId: number;
  const dsName = `e2e-rec-prob-${Date.now()}`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    token = await login(app);
    // Create a test datasource for the _base + save routes (which touch
    // Datasource.recommendedConfig). Minimal required fields: name + type.
    const ds = await prisma.datasource.create({
      data: { name: dsName, type: 'sqlite' },
    });
    dsId = ds.id;
  });

  afterAll(async () => {
    // Delete the test datasource — FK onDelete:Cascade removes its
    // DsRecommendedProblem rows.
    if (dsId != null) {
      await prisma.datasource.delete({ where: { id: dsId } }).catch(() => {});
    }
    await app.close();
  });

  it('requires a token for admin routes (401 without)', async () => {
    const res = await request(app.getHttpServer()).get(
      `/api/v1/recommended_problem/get_datasource_recommended/${dsId}`,
    );
    expect(res.status).toBe(401);
  });

  it('manages the lifecycle (getBase initial→save config 2→getBase+list→save config 1 empty→getBase+list)', async () => {
    // getBase initial — datasource just created, recommendedConfig null → 0
    const base0 = await request(app.getHttpServer())
      .get(
        `/api/v1/recommended_problem/get_datasource_recommended_base/${dsId}`,
      )
      .set(TOKEN_HEADER, token);
    expect(base0.status).toBe(200);
    expect((base0.body as ApiEnvelope<RecommendedProblemBase>).data).toEqual({
      datasource_id: dsId,
      recommended_config: 0,
      questions: null,
    });

    // list initial — no rows
    const list0 = await request(app.getHttpServer())
      .get(`/api/v1/recommended_problem/get_datasource_recommended/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(list0.status).toBe(200);
    expect((list0.body as ApiEnvelope<RecommendedProblemSnake[]>).data).toEqual(
      [],
    );

    // save config 2 + 3 problems (replace-all) → 200 (§91 @HttpCode)
    const saved = await request(app.getHttpServer())
      .post('/api/v1/recommended_problem/save_recommended_problem')
      .set(TOKEN_HEADER, token)
      .send({
        recommended_config: 2,
        datasource_id: dsId,
        problemInfo: [
          { question: 'What is the revenue?' },
          { question: 'Show sales by region' },
          { question: 'Top 10 customers' },
        ],
      });
    expect(saved.status).toBe(200);
    expect(
      (
        saved.body as ApiEnvelope<{
          datasource_id: number;
          recommended_config: number;
          count: number;
        }>
      ).data,
    ).toEqual({ datasource_id: dsId, recommended_config: 2, count: 3 });

    // getBase → config 2 + questions JSON-stringified
    const base2 = await request(app.getHttpServer())
      .get(
        `/api/v1/recommended_problem/get_datasource_recommended_base/${dsId}`,
      )
      .set(TOKEN_HEADER, token);
    const base2Data = (base2.body as ApiEnvelope<RecommendedProblemBase>).data;
    expect(base2Data.datasource_id).toBe(dsId);
    expect(base2Data.recommended_config).toBe(2);
    expect(base2Data.questions).toBe(
      JSON.stringify([
        'What is the revenue?',
        'Show sales by region',
        'Top 10 customers',
      ]),
    );

    // list → 3 rows, snake shape (id/datasource_id/question)
    const list2 = await request(app.getHttpServer())
      .get(`/api/v1/recommended_problem/get_datasource_recommended/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect(list2.status).toBe(200);
    const rows = (list2.body as ApiEnvelope<RecommendedProblemSnake[]>).data;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: rows[0].id,
      datasource_id: dsId,
      question: 'What is the revenue?',
    });
    expect(rows.map((r) => r.question)).toEqual([
      'What is the revenue?',
      'Show sales by region',
      'Top 10 customers',
    ]);

    // save config 1 + empty problems (replace-all — deletes the 3 rows)
    const saved2 = await request(app.getHttpServer())
      .post('/api/v1/recommended_problem/save_recommended_problem')
      .set(TOKEN_HEADER, token)
      .send({
        recommended_config: 1,
        datasource_id: dsId,
        problemInfo: [],
      });
    expect(saved2.status).toBe(200);
    expect((saved2.body as ApiEnvelope<{ count: number }>).data.count).toBe(0);

    // getBase → config 1 + questions null (AI auto — no questions fetched)
    const base1 = await request(app.getHttpServer())
      .get(
        `/api/v1/recommended_problem/get_datasource_recommended_base/${dsId}`,
      )
      .set(TOKEN_HEADER, token);
    expect((base1.body as ApiEnvelope<RecommendedProblemBase>).data).toEqual({
      datasource_id: dsId,
      recommended_config: 1,
      questions: null,
    });

    // list → 0 rows (all deleted)
    const list1 = await request(app.getHttpServer())
      .get(`/api/v1/recommended_problem/get_datasource_recommended/${dsId}`)
      .set(TOKEN_HEADER, token);
    expect((list1.body as ApiEnvelope<RecommendedProblemSnake[]>).data).toEqual(
      [],
    );
  });

  it('getBase on a non-existent datasource returns {dsId, 0, null}', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/recommended_problem/get_datasource_recommended_base/999999')
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    expect((res.body as ApiEnvelope<RecommendedProblemBase>).data).toEqual({
      datasource_id: 999999,
      recommended_config: 0,
      questions: null,
    });
  });
});
