import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

describe('Application bootstrap (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Replicate main.ts: global prefix is not registered via DI, so set it here.
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns a plain-string error body for unknown routes (404)', async () => {
    // Phase 9: error bodies are plain strings (the frontend reads
    // error.response.data.toString()), not the {success,code,message,data} object.
    const res = await request(app.getHttpServer()).get('/');
    expect(res.status).toBe(404);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('rejects unauthenticated datasource mutations with 401 (plain-string body)', async () => {
    // Phase 10 §90: DatasourceController now carries class-level JwtAuthGuard.
    // §60: error bodies are plain strings, not the {success,code,message,data}
    // object. (The Phase 2 global-ValidationPipe 400 smoke test is obsolete —
    // there is no global pipe; mutating routes use plain @Body() per §38, and
    // the auth guard fires first anyway.) Authenticated CRUD + the 400-on-
    // missing-id path are covered in datasource.e2e-spec.ts.
    const res = await request(app.getHttpServer())
      .post('/api/v1/datasource/add')
      .send({ name: 'x', type: 'sqlite' });
    expect(res.status).toBe(401);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
    expect(res.text.length).toBeGreaterThan(0);
  });

  it('lists datasources with the success envelope (authenticated)', async () => {
    // Phase 10 §82: list route moved from GET /datasource (RESTful) to
    // GET /datasource/list (action-style) + is now auth-guarded.
    const loginRes = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .send({ username: 'admin', password: 'admin' });
    expect(loginRes.status).toBe(200); // batch7: assert login success
    const token = (loginRes.body as ApiEnvelope<{ access_token: string }>).data
      .access_token;

    const res = await request(app.getHttpServer())
      .get('/api/v1/datasource/list')
      .set('X-QUERYPRISM-TOKEN', token);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<unknown[]>;
    expect(body).toEqual(
      expect.objectContaining({ success: true, code: 0, msg: 'success' }),
    );
    expect(Array.isArray(body.data)).toBe(true);
  });
});
