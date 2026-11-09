// Metric + data-standard ingestion e2e — MetaDataImprove M4 channels: the
// ApiKeyGuard-authenticated POST /meta/metric/import and /meta/standard/import
// (JSON batches) and the admin Excel export/import round-trip over the six
// sheets. Real services + real Prisma (semantic-meta.e2e-spec pattern).
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';

const TOKEN_HEADER = 'X-QUERYPRISM-TOKEN';

interface ApiEnvelope<T = unknown> {
  success: boolean;
  code: number;
  msg: string;
  data: T;
}

async function login(app: INestApplication<App>): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/login/access-token')
    .send({ username: 'admin', password: 'admin' });
  expect(res.status).toBe(200);
  return (res.body as ApiEnvelope<{ access_token: string }>).data.access_token;
}

describe('Metric + standard ingestion (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let prisma: PrismaService;
  let apiKeyId: number | null = null;
  let accessKey = '';
  let secret = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    token = await login(app);
    await prisma.metricDef.deleteMany({});
    await prisma.dataStandard.deleteMany({});

    // Provision one API key for the admin (uid 1) — created + revealed via
    // the existing apikey admin surface.
    const created = await request(app.getHttpServer())
      .post('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(created.status).toBe(200);
    apiKeyId = (created.body as ApiEnvelope<{ id: number }>).data.id;
    const list = await request(app.getHttpServer())
      .get('/api/v1/system/apikey')
      .set(TOKEN_HEADER, token);
    const keyRow = (
      list.body as ApiEnvelope<Array<{ id: number; access_key: string }>>
    ).data.find((k) => k.id === apiKeyId);
    accessKey = keyRow!.access_key;
    const revealed = await request(app.getHttpServer())
      .get(`/api/v1/system/apikey/${apiKeyId}/secret`)
      .set(TOKEN_HEADER, token);
    secret = (revealed.body as ApiEnvelope<{ secret_key: string }>).data
      .secret_key;
  });

  afterAll(async () => {
    await prisma.metricDef.deleteMany({}).catch(() => undefined);
    await prisma.dataStandard.deleteMany({}).catch(() => undefined);
    if (apiKeyId != null) {
      await prisma.apiKey
        .delete({ where: { id: apiKeyId } })
        .catch(() => undefined);
    }
    await app.close();
  });

  it('rejects the meta imports without API key headers (401)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/metric/import')
      .send([{ kind: 'period', code: 'x', name: 'x' }]);
    expect(res.status).toBe(401);
    const res2 = await request(app.getHttpServer())
      .post('/api/v1/meta/standard/import')
      .send([{ kind: 'unit', code: 'x', term: 'x', name: 'x' }]);
    expect(res2.status).toBe(401);
  });

  it('imports metric + standard JSON batches at WORKSPACE via API key auth', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/meta/metric/import')
      .set('X-QUERYPRISM-APIKEY', accessKey)
      .set('X-QUERYPRISM-APISECRET', secret)
      .send([
        {
          kind: 'atomic',
          code: 'api_pay_amount',
          name: '支付金额',
          unit: '元',
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
          aggregation: 'SUM',
        },
        // A bad row is reported, not fatal (missing aggregation).
        {
          kind: 'atomic',
          code: 'api_broken',
          name: '坏行',
          datasource_id: 1,
          table_name: 'sales_order',
          field_name: 'amount',
        },
      ]);
    expect(res.status).toBe(200);
    const out = (
      res.body as ApiEnvelope<{ applied: number; failed: unknown[] }>
    ).data;
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(1);

    const row = await prisma.metricDef.findFirst({
      where: { scope: 'WORKSPACE', kind: 'atomic', code: 'api_pay_amount' },
    });
    expect(row?.name).toBe('支付金额');

    const std = await request(app.getHttpServer())
      .post('/api/v1/meta/standard/import')
      .set('X-QUERYPRISM-APIKEY', accessKey)
      .set('X-QUERYPRISM-APISECRET', secret)
      .send([
        {
          kind: 'naming',
          code: 'api_gmv',
          term: 'GMV',
          name: '商品交易总额',
          category: 'business_noun',
        },
      ]);
    expect(std.status).toBe(200);
    expect((std.body as ApiEnvelope<{ applied: number }>).data.applied).toBe(1);
    const stdRow = await prisma.dataStandard.findFirst({
      where: { scope: 'WORKSPACE', code: 'api_gmv' },
    });
    expect(stdRow?.name).toBe('商品交易总额');
  });

  it('Excel export → import round-trips rows across sheets', async () => {
    const exported = await request(app.getHttpServer())
      .get('/api/v1/system/metric/export')
      .set(TOKEN_HEADER, token)
      .responseType('blob');
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('spreadsheetml');

    // Build a tiny import workbook (one metric sheet + the standards sheet).
    const wb = new ExcelJS.Workbook();
    const period = wb.addWorksheet('time_periods');
    period.addRow([
      'code',
      'name',
      'aliases',
      'mode',
      'time_unit',
      'count',
      'anchor',
      'description',
      'enabled',
    ]);
    period.addRow([
      'excel_7d',
      '近7天',
      '最近一周',
      'recent',
      'day',
      7,
      '',
      '',
      'true',
    ]);
    const units = wb.addWorksheet('data_standards');
    units.addRow([
      'kind',
      'code',
      'term',
      'name',
      'aliases',
      'category',
      'description',
      'enabled',
    ]);
    units.addRow(['unit', 'excel_jian', '件', '件', '', 'count', '', 'true']);
    const buf = await wb.xlsx.writeBuffer();

    const uploaded = await request(app.getHttpServer())
      .post('/api/v1/system/metric/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach('file', Buffer.from(buf), 'metrics.xlsx');
    expect(uploaded.status).toBe(200);
    const out = (uploaded.body as ApiEnvelope<{ applied: number }>).data;
    expect(out.applied).toBeGreaterThanOrEqual(2);

    const periodRow = await prisma.metricDef.findFirst({
      where: { scope: 'WORKSPACE', kind: 'period', code: 'excel_7d' },
    });
    expect(periodRow?.name).toBe('近7天');
    const unitRow = await prisma.dataStandard.findFirst({
      where: { scope: 'WORKSPACE', code: 'excel_jian' },
    });
    expect(unitRow?.term).toBe('件');

    // The exported workbook itself re-imports cleanly (round-trip shape).
    const reupload = await request(app.getHttpServer())
      .post('/api/v1/system/metric/uploadExcel')
      .set(TOKEN_HEADER, token)
      .attach(
        'file',
        Buffer.from(exported.body as ArrayBuffer),
        'metrics-roundtrip.xlsx',
      );
    expect(reupload.status).toBe(200);
  });
});
