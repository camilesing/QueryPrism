// Attribution-domain governance e2e — scenario tests over a realistic
// fixture (4 SQLite tables derived from the 归因域 v1 FlinkSQL DDL, see
// test/fixtures/attribution/README.md). Unlike the per-module contract specs
// (semantic/metric/custom-prompt e2e), this suite drives the four governance
// features against ONE shared datasource and asserts the runtime seams they
// feed (semantic-alias recall expansion, metric caliber matching, naming
// rules, effective annotations / M-Schema decoration, custom-prompt
// resolution).
//
// CRUD runs over real HTTP; matching logic runs via direct service calls
// wrapped in requestContextStorage ALS (no HTTP for DI-only methods).
// Expected aggregates are computed from the committed CSVs — never
// hard-coded — so regenerating the fixture cannot desync the spec.
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/database/prisma.service';
import { requestContextStorage } from './../src/common/context/request-context';
import { SemanticService } from './../src/semantic/semantic.service';
import { MetricService } from './../src/semantic/metric.service';
import { DataStandardService } from './../src/semantic/standard.service';
import { CustomPromptService } from './../src/custom-prompt/custom-prompt.service';
import { DatasourceService } from './../src/datasource/datasource.service';
import {
  ATTRIBUTION_TABLES,
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

/** DI-only service methods read the actor from the ALS (RequestContext), so
 *  direct calls must run inside a store — same trick as semantic.service.spec. */
function withUser<T>(
  user: { id: number; oid: number; account: string; weight?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: user.account,
        oid: user.oid,
        language: 'zh-CN',
        weight: user.weight ?? 0,
      },
    },
    fn,
  );
}

describe('Attribution governance (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  let memberToken: string;
  let prisma: PrismaService;
  let semantic: SemanticService;
  let metric: MetricService;
  let standard: DataStandardService;
  let customPrompt: CustomPromptService;
  let datasource: DatasourceService;
  let ds: AttributionDatasource;
  const stamp = Date.now();
  const dsName = `attribution-gov-${stamp}`;
  const memberAccount = `e2e-attr-${stamp}`;
  let memberUid = 0;

  // id trackers so afterAll sweeps ONLY this suite's rows.
  const metricIds: number[] = [];
  const standardIds: number[] = [];
  const customPromptIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    await app.init();
    prisma = app.get(PrismaService);
    semantic = app.get(SemanticService);
    metric = app.get(MetricService);
    standard = app.get(DataStandardService);
    customPrompt = app.get(CustomPromptService);
    datasource = app.get(DatasourceService);
    token = await login(app);

    // A plain member of workspace 1 (weight 0) for the proposal/layer tests.
    await request(app.getHttpServer())
      .post('/api/v1/user')
      .set(TOKEN_HEADER, token)
      .send({
        account: memberAccount,
        password: 'Init1234!',
        email: `${memberAccount}@e2e.test`,
        name: 'Attribution Member',
        oid: 1,
        oid_list: [1],
        status: 1,
      });
    memberToken = await login(app, memberAccount, 'Init1234!');
    memberUid = (
      await prisma.user.findUniqueOrThrow({
        where: { account: memberAccount },
        select: { id: true },
      })
    ).id;

    const dbPath = `/tmp/attr-gov-e2e-${stamp}.db`;
    buildAttributionDb(dbPath);
    ds = await createAttributionDatasource(app, token, dbPath, dsName);
  });

  afterAll(async () => {
    // Governance rows by tracker; semantics by datasource natural key.
    await prisma.tableSemantic
      .deleteMany({ where: { datasourceId: ds?.dsId ?? -1 } })
      .catch(() => undefined);
    await prisma.fieldSemantic
      .deleteMany({ where: { datasourceId: ds?.dsId ?? -1 } })
      .catch(() => undefined);
    await prisma.semanticChangeRequest
      .deleteMany({ where: { proposerUid: memberUid || -1 } })
      .catch(() => undefined);
    for (const [path, ids] of [
      ['/api/v1/system/metric', metricIds],
      ['/api/v1/system/standard', standardIds],
      ['/api/v1/system/custom_prompt', customPromptIds],
    ] as const) {
      if (ids.length > 0) {
        await request(app.getHttpServer())
          .delete(path)
          .set(TOKEN_HEADER, token)
          .send(ids)
          .catch(() => undefined);
      }
    }
    if (memberAccount) {
      await prisma.user
        .deleteMany({ where: { account: memberAccount } })
        .catch(() => undefined);
    }
    if (ds) await removeAttributionDatasource(app, token, ds, dsName);
    await app.close();
  });

  const admin = <T>(fn: () => Promise<T>) =>
    withUser({ id: 1, oid: 1, account: 'admin', weight: 1 }, fn);
  const member = <T>(fn: () => Promise<T>) =>
    withUser({ id: memberUid, oid: 1, account: memberAccount, weight: 0 }, fn);

  // ─── datasource baseline ────────────────────────────────────────────────

  it('synced the four attribution tables with their CSV row counts', async () => {
    const tables = await request(app.getHttpServer())
      .post(`/api/v1/datasource/tableList/${ds.dsId}`)
      .set(TOKEN_HEADER, token);
    expect(tables.status).toBe(200);
    const list = (
      tables.body as ApiEnvelope<
        { table_name: string; table_comment: string | null; checked: boolean }[]
      >
    ).data;
    expect(list.map((t) => t.table_name).sort()).toEqual(
      ATTRIBUTION_TABLES.map((t) => t.name).sort(),
    );
    const dm = list.find(
      (t) => t.table_name === 'sl_dm_store_referrer_utm_rt',
    )!;
    expect(dm.table_comment).toBe('店铺来源UTM实时汇总表');
    expect(dm.checked).toBe(true);

    for (const { name } of ATTRIBUTION_TABLES) {
      const expected = readAttributionCsv(name).rows.length;
      const res = await request(app.getHttpServer())
        .post(`/api/v1/datasource/execSql/${ds.dsId}`)
        .set(TOKEN_HEADER, token)
        .send({ sql: `SELECT COUNT(*) AS c FROM ${name}` });
      expect(res.status).toBe(200);
      expect((res.body.data as { rows: unknown[][] }).rows[0][0]).toBe(
        expected,
      );
    }
  });

  // ─── 数据字典 (semantic dictionary) ─────────────────────────────────────

  it('fieldList exposes the renamed columns (visitor_uuid / interact_days / dim_key)', async () => {
    // fieldList/:id takes a TABLE id (not the datasource id).
    const tables = await request(app.getHttpServer())
      .post(`/api/v1/datasource/tableList/${ds.dsId}`)
      .set(TOKEN_HEADER, token);
    const rows = tables.body.data as { id: number; table_name: string }[];
    const dmId = rows.find(
      (t) => t.table_name === 'sl_dm_store_referrer_utm_rt',
    )!.id;
    const convId = rows.find(
      (t) => t.table_name === 'dwv_order_conversion_attribution',
    )!.id;

    const dm = await request(app.getHttpServer())
      .post(`/api/v1/datasource/fieldList/${dmId}`)
      .set(TOKEN_HEADER, token);
    expect(dm.status).toBe(200);
    const dmFields = (dm.body.data as { field_name: string }[]).map(
      (f) => f.field_name,
    );
    expect(dmFields).toContain('dim_key');
    expect(dmFields).toContain('stat_date');
    expect(dmFields).not.toContain('row_key');

    const conv = await request(app.getHttpServer())
      .post(`/api/v1/datasource/fieldList/${convId}`)
      .set(TOKEN_HEADER, token);
    expect(conv.status).toBe(200);
    const convFields = (conv.body.data as { field_name: string }[]).map(
      (f) => f.field_name,
    );
    expect(convFields).toContain('visitor_uuid');
    expect(convFields).toContain('interact_days');
    expect(convFields).not.toContain('interact_day');
  });

  it('workspace semantics decorate the M-Schema (meaning/unit/enum labels)', async () => {
    const upsert = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .put('/api/v1/system/semantic')
        .set(TOKEN_HEADER, token)
        .send(body);

    const table = await upsert({
      entity_type: 'table',
      scope: 'WORKSPACE',
      datasource_id: ds.dsId,
      table_name: 'sl_dm_store_referrer_utm_rt',
      meaning: '店铺维度流量来源UTM日汇总(首触/末触两行一组)',
    });
    expect(table.status).toBe(200);
    expect((table.body.data as { applied: boolean }).applied).toBe(true);

    for (const body of [
      {
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'utm_source',
        role: 'dimension',
        meaning: 'UTM流量来源(渠道标识)',
      },
      {
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'total_amount_first',
        role: 'metric',
        meaning: '首触归因销售额',
        unit: '分',
      },
      {
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'sales_channel',
        role: 'dimension',
        meaning: '销售渠道',
        enum_values: [
          { value: 'web', label: 'Web商店' },
          { value: 'live', label: '直播' },
        ],
      },
    ]) {
      const res = await upsert(body);
      expect(res.status).toBe(200);
    }

    const annotations = await admin(() =>
      semantic.effectiveAnnotations(ds.dsId, ['sl_dm_store_referrer_utm_rt']),
    );
    const schema = await admin(() =>
      datasource.getMSchema(ds.dsId, undefined, annotations),
    );
    expect(schema).toContain('店铺维度流量来源UTM日汇总');
    expect(schema).toContain('UTM流量来源(渠道标识)');
    expect(schema).toContain('首触归因销售额');
    expect(schema).toContain('单位: 分');
    expect(schema).toContain('web(Web商店)');
  });

  it('PERSONAL overrides WORKSPACE only for its owner', async () => {
    // Member owns a PERSONAL note for the same field.
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'field',
        scope: 'PERSONAL',
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'utm_source',
        role: 'dimension',
        meaning: '个人口径-渠道',
      });
    expect(res.status).toBe(200);
    expect((res.body.data as { applied: boolean }).applied).toBe(true);

    const names = ['sl_dm_store_referrer_utm_rt'];
    const adminNotes = await admin(() =>
      semantic.effectiveAnnotations(ds.dsId, names),
    );
    expect(
      adminNotes.fieldNotes['sl_dm_store_referrer_utm_rt.utm_source'].meaning,
    ).toBe('UTM流量来源(渠道标识)');
    const memberNotes = await member(() =>
      semantic.effectiveAnnotations(ds.dsId, names),
    );
    expect(
      memberNotes.fieldNotes['sl_dm_store_referrer_utm_rt.utm_source'].meaning,
    ).toBe('个人口径-渠道');
  });

  it('collect_enum backfills distinct members from the live SQLite file', async () => {
    const res = await request(app.getHttpServer())
      .post(`/api/v1/system/semantic/collect_enum/${ds.dsId}`)
      .set(TOKEN_HEADER, token);
    expect(res.status).toBe(200);
    const summary = (
      res.body as ApiEnvelope<{
        collected: {
          table_name: string;
          field_name: string;
          values?: number;
        }[];
        skipped: { table_name: string; field_name: string }[];
      }>
    ).data;

    const dm = readAttributionCsv('sl_dm_store_referrer_utm_rt');
    const expectDistinct = (col: string) =>
      new Set(dm.rows.map((r) => r[col])).size;

    const utm = summary.collected.find((c) => c.field_name === 'utm_source');
    expect(utm).toBeDefined();
    expect(utm!.values).toBe(expectDistinct('utm_source'));

    const channel = summary.collected.find(
      (c) => c.field_name === 'sales_channel',
    );
    expect(channel).toBeDefined();
    expect(channel!.values).toBe(expectDistinct('sales_channel'));

    // Curated labels survive; collected members are sorted with the rest.
    const row = await prisma.fieldSemantic.findFirstOrThrow({
      where: {
        datasourceId: ds.dsId,
        tableName: 'sl_dm_store_referrer_utm_rt',
        fieldName: 'sales_channel',
      },
    });
    const values =
      (row.enumValues as Array<{ value: string; label?: string }> | null) ?? [];
    expect(values.find((v) => v.value === 'web')?.label).toBe('Web商店');
    expect(values.map((v) => v.value)).toEqual(
      [...new Set(dm.rows.map((r) => r.sales_channel))].sort(),
    );
  });

  it('member WORKSPACE proposal → admin approval applies + versions', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/semantic')
      .set(TOKEN_HEADER, memberToken)
      .send({
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: ds.dsId,
        table_name: 'dwv_order_conversion_attribution',
        field_name: 'interact_days',
        role: 'metric',
        meaning: '首触到成单的转化周期(天)',
        unit: '天',
      });
    expect(propose.status).toBe(200);
    const out = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data;
    expect(out.applied).toBe(false);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/semantic/request/review')
      .set(TOKEN_HEADER, token)
      .send({ id: out.request_id, approve: true });
    expect(review.status).toBe(200);

    const applied = await prisma.fieldSemantic.findFirstOrThrow({
      where: {
        datasourceId: ds.dsId,
        tableName: 'dwv_order_conversion_attribution',
        fieldName: 'interact_days',
        scope: 'WORKSPACE',
      },
    });
    expect(applied.meaning).toBe('首触到成单的转化周期(天)');
    const versions = await request(app.getHttpServer())
      .get(`/api/v1/system/semantic/versions/field/${applied.id}`)
      .set(TOKEN_HEADER, token);
    expect(versions.status).toBe(200);
    expect((versions.body.data as unknown[]).length).toBe(1);
  });

  // ─── 指标 (metrics) ─────────────────────────────────────────────────────

  it('metric definitions match attribution questions and force-stuff the atomic table', async () => {
    const put = async (body: Record<string, unknown>) => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/system/metric')
        .set(TOKEN_HEADER, token)
        .send(body);
      expect(res.status).toBe(200);
      const out = res.body.data as { applied: boolean; id: number };
      expect(out.applied).toBe(true);
      metricIds.push(out.id);
      return out;
    };

    await put({
      kind: 'atomic',
      scope: 'WORKSPACE',
      code: 'first_touch_gmv',
      name: '首触归因GMV',
      aliases: ['首触GMV'],
      unit: '分',
      definition: {
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'total_amount_first',
        aggregation: 'SUM',
      },
    });
    await put({
      kind: 'atomic',
      scope: 'WORKSPACE',
      code: 'first_touch_order_cnt',
      name: '首触归因订单量',
      definition: {
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'order_cnt_first',
        aggregation: 'SUM',
      },
    });
    const modifier = await put({
      kind: 'modifier',
      scope: 'WORKSPACE',
      code: 'first_touch_only',
      name: '仅首触行',
      definition: {
        datasource_id: ds.dsId,
        table_name: 'sl_dm_store_referrer_utm_rt',
        field_name: 'is_first',
        operator: '=',
        values: ['yes'],
      },
    });
    const period = await put({
      kind: 'period',
      scope: 'WORKSPACE',
      code: 'recent_7d',
      name: '近7天',
      definition: { mode: 'recent', time_unit: 'day', count: 7 },
    });
    await put({
      kind: 'derived',
      scope: 'WORKSPACE',
      code: 'first_touch_gmv_7d',
      name: '近7天首触GMV',
      definition: {
        atomic_code: 'first_touch_gmv',
        modifier_codes: ['first_touch_only'],
        period_code: 'recent_7d',
        time_field: 'stat_date',
      },
    });
    const atv = await put({
      kind: 'composite',
      scope: 'WORKSPACE',
      code: 'first_touch_atv',
      name: '首触客单价',
      definition: { expression: 'first_touch_gmv / first_touch_order_cnt' },
    });
    // referenced rows must outlive the composite for the delete sweep
    expect(modifier.id).toBeTruthy();
    expect(period.id).toBeTruthy();
    expect(atv.id).toBeTruthy();

    // Literal name match by the QUESTION naming the metric.
    const m1 = await admin(() =>
      metric.matchDefinitions(ds.dsId, '统计各流量来源的首触归因GMV', 5),
    );
    expect(m1.text).toContain('<metric_definitions>');
    expect(m1.text).toContain(
      'SUM(sl_dm_store_referrer_utm_rt.total_amount_first)',
    );
    expect(m1.atomicTableNames).toContain('sl_dm_store_referrer_utm_rt');

    // Alias match works too.
    const m2 = await admin(() =>
      metric.matchDefinitions(ds.dsId, '首触GMV按渠道拆分', 5),
    );
    expect(m2.text).toContain('first_touch_gmv');

    // Disabled metrics drop out of matching.
    await request(app.getHttpServer())
      .get(`/api/v1/system/metric/${metricIds[0]}/enable/false`)
      .set(TOKEN_HEADER, token);
    const m3 = await admin(() =>
      metric.matchDefinitions(ds.dsId, '统计各流量来源的首触归因GMV', 5),
    );
    expect(m3.text).not.toContain('first_touch_gmv');
    await request(app.getHttpServer())
      .get(`/api/v1/system/metric/${metricIds[0]}/enable/true`)
      .set(TOKEN_HEADER, token);
  });

  it('stores a dangling-reference composite but skips it at match time', async () => {
    // The documented contract (AGENTS/metric-policy): dangling refs in a
    // composite expression skip THE METRIC at render time, never the request
    // — the referenced code may be defined later.
    const res = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, token)
      .send({
        kind: 'composite',
        scope: 'WORKSPACE',
        code: 'broken_atv',
        name: '悬空客单价',
        definition: { expression: 'first_touch_gmv / not_defined_code' },
      });
    expect(res.status).toBe(200);
    metricIds.push((res.body.data as { id: number }).id);

    const m = await admin(() =>
      metric.matchDefinitions(ds.dsId, '统计悬空客单价', 5),
    );
    expect(m.text).not.toContain('broken_atv');
    expect(m.text).not.toContain('悬空客单价');
    expect(m.text).not.toContain('not_defined_code');
  });

  it('member metric proposal → admin approval', async () => {
    const propose = await request(app.getHttpServer())
      .put('/api/v1/system/metric')
      .set(TOKEN_HEADER, memberToken)
      .send({
        kind: 'atomic',
        scope: 'WORKSPACE',
        code: 'avg_interact_days',
        name: '平均转化周期',
        unit: '天',
        definition: {
          datasource_id: ds.dsId,
          table_name: 'dwv_order_conversion_attribution',
          field_name: 'interact_days',
          aggregation: 'AVG',
        },
      });
    expect(propose.status).toBe(200);
    const out = (
      propose.body as ApiEnvelope<{ applied: boolean; request_id: number }>
    ).data;
    expect(out.applied).toBe(false);

    const review = await request(app.getHttpServer())
      .put('/api/v1/system/metric/request/review')
      .set(TOKEN_HEADER, token)
      .send({ id: out.request_id, approve: true });
    expect(review.status).toBe(200);
    const applied = await prisma.metricDef.findFirstOrThrow({
      where: { scope: 'WORKSPACE', code: 'avg_interact_days' },
    });
    metricIds.push(applied.id);
    expect(applied.enabled).toBe(true);
  });

  // ─── 数据标准 (data standards) ──────────────────────────────────────────

  it('naming standards render <naming_rules> and respect enablement', async () => {
    const put = async (body: Record<string, unknown>) => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/system/standard')
        .set(TOKEN_HEADER, token)
        .send(body);
      expect(res.status).toBe(200);
      standardIds.push(res.body.data.id as number);
      return res.body.data as { id: number };
    };

    const unit = await put({
      kind: 'unit',
      scope: 'WORKSPACE',
      code: 'amount_cent',
      term: '金额',
      name: '人民币分',
      category: 'currency',
    });
    const gmv = await put({
      kind: 'naming',
      scope: 'WORKSPACE',
      code: 'gmv',
      term: 'GMV',
      name: '商品交易总额',
      aliases: ['交易额'],
      category: 'business_noun',
    });

    const versions = await request(app.getHttpServer())
      .get(`/api/v1/system/standard/versions/${unit.id}`)
      .set(TOKEN_HEADER, token);
    expect(versions.status).toBe(200);
    expect((versions.body.data as unknown[]).length).toBe(1);

    const rendered = await admin(() =>
      standard.namingTemplateFor('按流量来源统计GMV和交易额', 5),
    );
    expect(rendered).toContain('<naming_rules>');
    expect(rendered).toContain('term="GMV"');
    expect(rendered).toContain('standard="商品交易总额"');

    // Disabled naming rows are excluded from the template.
    await request(app.getHttpServer())
      .get(`/api/v1/system/standard/${gmv.id}/enable/false`)
      .set(TOKEN_HEADER, token);
    const after = await admin(() =>
      standard.namingTemplateFor('按流量来源统计GMV', 5),
    );
    expect(after).not.toContain('term="GMV"');
  });

  // ─── 提示词 (custom prompts) ────────────────────────────────────────────

  it('custom prompts resolve global + datasource-bound, isolated by type', async () => {
    const put = async (body: Record<string, unknown>) => {
      const res = await request(app.getHttpServer())
        .put('/api/v1/system/custom_prompt')
        .set(TOKEN_HEADER, token)
        .send(body);
      expect(res.status).toBe(200);
      const out = res.body.data as { id: number };
      customPromptIds.push(out.id);
      return out;
    };

    await put({
      type: 'GENERATE_SQL',
      name: `归因口径-${stamp}`,
      prompt: '归因域查询一律使用首触/末触成对口径,金额单位为分。',
      specific_ds: false,
      datasource_ids: [],
    });
    await put({
      type: 'GENERATE_SQL',
      name: `归因表前缀-${stamp}`,
      prompt: 'dwv_/sl_dm_ 前缀表为归因域数仓分层表。',
      specific_ds: true,
      datasource_ids: [ds.dsId],
    });
    await put({
      type: 'ANALYSIS',
      name: `归因分析-${stamp}`,
      prompt: '分析时区分首触与末触的贡献差异。',
      specific_ds: false,
      datasource_ids: [],
    });

    // Both GENERATE_SQL prompts apply on the attribution DS (id order = creation).
    const onDs = await admin(() =>
      customPrompt.findCustomPrompts('GENERATE_SQL', 1, ds.dsId),
    );
    expect(onDs.promptList).toHaveLength(2);
    expect(onDs.customPromptText).toContain('首触/末触成对口径');
    expect(onDs.customPromptText).toContain('归因域数仓分层表');

    // On another datasource only the global prompt applies.
    const otherDs = await admin(() =>
      customPrompt.findCustomPrompts('GENERATE_SQL', 1, 1),
    );
    expect(otherDs.promptList).toHaveLength(1);
    expect(otherDs.customPromptText).toContain('首触/末触成对口径');
    expect(otherDs.customPromptText).not.toContain('归因域数仓分层表');

    // ANALYSIS never sees GENERATE_SQL rows.
    const analysis = await admin(() =>
      customPrompt.findCustomPrompts('ANALYSIS', 1, ds.dsId),
    );
    expect(analysis.promptList).toHaveLength(1);
    expect(analysis.customPromptText).toContain('首触与末触的贡献差异');

    // Page route filters by type.
    const page = await request(app.getHttpServer())
      .post('/api/v1/system/custom_prompt/GENERATE_SQL/page/1/50')
      .set(TOKEN_HEADER, token)
      .send({});
    expect(page.status).toBe(200);
    const names = (page.body.data as { data: { name: string }[] }).data.map(
      (r) => r.name,
    );
    expect(names).toContain(`归因口径-${stamp}`);
    expect(names).not.toContain(`归因分析-${stamp}`);
  });
});
