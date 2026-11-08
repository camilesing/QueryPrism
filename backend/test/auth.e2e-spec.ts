// Phase 9b (§70): auth contract aligned to the frontend.
// - POST /login/access-token: `application/x-www-form-urlencoded` body
//   {username, password} (the xpack stub's queryprismEncrypt is identity, so the
//   backend receives plaintext). Resolves to {access_token, token_type,
//   platform_info} (frontend UserStore.login reads `res.access_token`).
// - Error bodies are plain strings (§60); success envelope is {code:0,msg,data}.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

interface LoginData {
  access_token: string;
  token_type: string;
  platform_info: unknown;
}

// Phase 9b (§70): UserStore.info reads {id(→uid), account, name, oid,
// language, exp, time, weight, origin} — exp/time/weight/origin are Number()'d,
// the rest String()'d. Missing fields break the store (uid='undefined').
interface UserInfoData {
  id: number;
  account: string;
  name: string;
  oid: number;
  language: string;
  exp: number;
  time: number;
  weight: number;
  origin: number;
}

describe('Auth flow (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('logs in via POST /login/access-token (form-urlencoded) and returns access_token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .type('form')
      .send({ username: 'admin', password: 'admin' });
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<LoginData>;
    expect(body.code).toBe(0);
    expect(typeof body.data.access_token).toBe('string');
    expect(body.data.token_type).toBe('bearer');
  });

  it('rejects wrong credentials with 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .type('form')
      .send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
    // Phase 9 (§60): error bodies are plain strings.
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
  });

  it('rejects malformed login payloads (validation)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .type('form')
      .send({ username: 'admin' }); // missing password
    expect(res.status).toBe(400);
    expect(res.text.length).toBeGreaterThan(0); // batch7: was a tautological typeof check
  });

  it('logs out with a valid token (returns null so frontend falls through to #/login)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .type('form')
      .send({ username: 'admin', password: 'admin' });
    const token = (login.body as ApiEnvelope<LoginData>).data.access_token;

    const res = await request(app.getHttpServer())
      .post('/api/v1/login/logout')
      .set(TOKEN_HEADER, `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<unknown>;
    expect(body.code).toBe(0);
    expect(body.data).toBeNull();
  });

  it('returns user info with name/exp/time/weight/origin (frontend UserStore.info shape)', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/login/access-token')
      .type('form')
      .send({ username: 'admin', password: 'admin' });
    const token = (login.body as ApiEnvelope<LoginData>).data.access_token;

    const res = await request(app.getHttpServer())
      .get('/api/v1/user/info')
      .set(TOKEN_HEADER, `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as ApiEnvelope<UserInfoData>;
    expect(body.code).toBe(0);
    expect(body.data.account).toBe('admin');
    expect(body.data.name).toBe('admin'); // MVP fallback: name = account
    expect(typeof body.data.id).toBe('number');
    expect(typeof body.data.oid).toBe('number');
    expect(typeof body.data.language).toBe('string');
    expect(typeof body.data.exp).toBe('number');
    expect(typeof body.data.time).toBe('number');
    expect(typeof body.data.weight).toBe('number');
    expect(typeof body.data.origin).toBe('number');
  });
});
