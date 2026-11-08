// Appearance admin e2e — POST /system/appearance (multipart KV + images),
// public GET /system/appearance/ui, public picture streaming, and image reset.
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
  msg: string;
  data: T;
}

interface Pair {
  pkey: string;
  pval: string;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

// 1x1 transparent PNG (the file service validates extension/size only).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
  'base64',
);

describe('Appearance /system/appearance (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    token = await login(app);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.systemVariable.deleteMany({ where: { type: 'appearance' } });
    await app.close();
  });

  it('saves KV rows + an uploaded image, then serves them publicly', async () => {
    const data = [
      { pkey: 'name', pval: 'QueryPrism E2E', ptype: 'str', sort: 1 },
      { pkey: 'themeColor', pval: 'blue', ptype: 'str', sort: 1 },
    ];
    const saved = await request(app.getHttpServer())
      .post('/api/v1/system/appearance')
      .set(TOKEN_HEADER, token)
      .field('data', JSON.stringify(data))
      .attach('files', PNG, 'logo.png,web');
    expect(saved.status).toBe(200);
    // The frontend treats a falsy response as success (and refreshes).
    expect((saved.body as ApiEnvelope).data).toBeNull();

    const ui = await request(app.getHttpServer()).get(
      '/api/v1/system/appearance/ui',
    );
    expect(ui.status).toBe(200);
    const pairs = (ui.body as ApiEnvelope<Pair[]>).data;
    expect(pairs.find((p) => p.pkey === 'name')?.pval).toBe('QueryPrism E2E');
    expect(pairs.find((p) => p.pkey === 'themeColor')?.pval).toBe('blue');
    const webId = pairs.find((p) => p.pkey === 'web')?.pval ?? '';
    expect(webId).toMatch(/^[a-f0-9]{32}\.png$/);

    const picture = await request(app.getHttpServer()).get(
      `/api/v1/system/appearance/picture/${webId}`,
    );
    expect(picture.status).toBe(200);
    expect(picture.headers['content-type']).toMatch(/image\/png/);
  });

  it('resetting an image field deletes the old file', async () => {
    const ui = await request(app.getHttpServer()).get(
      '/api/v1/system/appearance/ui',
    );
    const oldWeb = (ui.body as ApiEnvelope<Pair[]>).data.find(
      (p) => p.pkey === 'web',
    )?.pval;
    expect(oldWeb).toBeTruthy();

    const reset = await request(app.getHttpServer())
      .post('/api/v1/system/appearance')
      .set(TOKEN_HEADER, token)
      .field(
        'data',
        JSON.stringify([{ pkey: 'web', pval: '', ptype: 'file', sort: 1 }]),
      );
    expect(reset.status).toBe(200);

    const picture = await request(app.getHttpServer()).get(
      `/api/v1/system/appearance/picture/${oldWeb}`,
    );
    expect(picture.status).toBe(404);
  });
});
