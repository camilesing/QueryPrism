// MetricService + DataStandardService unit tests (MetaDataImprove M4):
// governed-dictionary authority routing (direct edit vs proposal), the
// approval apply flow, per-kind validation, and the runtime
// matchDefinitions / namingTemplateFor resolution. Prisma is mocked; the
// actor comes from the real RequestContext ALS (semantic.service.spec
// pattern). The pure matching/rendering rules live in metric-policy.spec.
import { BadRequestException } from '@nestjs/common';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { MetricService, type MetricUpsertInfo } from './metric.service';
import { DataStandardService } from './standard.service';
import type { MetricDef } from '@prisma/client';

setI18n(createTestI18n());

function withUser(
  user: { id: number; oid: number; weight?: number; account?: string },
  fn: () => Promise<unknown>,
): Promise<unknown> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: user.account ?? 'tester',
        oid: user.oid,
        language: 'zh-CN',
        weight: user.weight ?? 0,
      },
    },
    fn,
  );
}

const MEMBER = { id: 7, oid: 1, weight: 0, account: 'member' };
const WS_ADMIN = { id: 5, oid: 1, weight: 1, account: 'wsadmin' };

/** Explicit mock shape — jest.fn's inference on the self-referencing
 *  $transaction callback degrades to any, tripping the typed-lint rules. */
interface EntityMockSet {
  create: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  findMany: jest.Mock;
}

interface MetricPrismaMock {
  metricDef: EntityMockSet;
  dataStandard: EntityMockSet;
  metricDefVersion: { create: jest.Mock; findMany: jest.Mock };
  dataStandardVersion: { create: jest.Mock; findMany: jest.Mock };
  semanticChangeRequest: {
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  fieldSemantic: EntityMockSet;
  table: { findFirst: jest.Mock; findMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrisma(): MetricPrismaMock {
  const entity = (): EntityMockSet => ({
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  });
  const prisma: MetricPrismaMock = {
    metricDef: entity(),
    dataStandard: entity(),
    metricDefVersion: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    dataStandardVersion: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    semanticChangeRequest: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 999,
          ...data,
        })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    fieldSemantic: entity(),
    table: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    // Execute the callback with the SAME mock object as tx.
    $transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
  };
  return prisma;
}

function makeServices(prisma: MetricPrismaMock = makePrisma()) {
  const standard = new DataStandardService(prisma as never);
  const datasources = { findOne: jest.fn().mockResolvedValue({ id: 1 }) };
  return {
    metric: new MetricService(
      prisma as never,
      { onApproval: jest.fn() } as never,
      standard,
      datasources as never,
    ),
    standard,
    prisma,
    datasources,
  };
}

const ATOMIC_INFO: MetricUpsertInfo = {
  kind: 'atomic',
  scope: 'WORKSPACE',
  code: 'pay_amount',
  name: '支付金额',
  unit: '元',
  definition: {
    datasource_id: 3,
    table_name: 'orders',
    field_name: 'pay_amount',
    aggregation: 'SUM',
  },
};

describe('MetricService.upsert authority routing', () => {
  it('ws admin applies directly with a create + version snapshot', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 11,
        version: 1,
        ...data,
      }),
    );
    const result = await withUser(WS_ADMIN, () => metric.upsert(ATOMIC_INFO));
    expect(result).toEqual({ applied: true, id: 11 });
    expect(prisma.metricDef.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'atomic',
        code: 'pay_amount',
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        definition: ATOMIC_INFO.definition,
        createBy: 5,
      }),
    });
    expect(prisma.metricDefVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 11,
        version: 1,
        snapshot: expect.objectContaining({ source: 'create' }),
      }),
    });
  });

  it('retries once when the create race loses (P2002) and then creates', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create
      .mockRejectedValueOnce(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      )
      .mockImplementationOnce(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: 41,
          version: 1,
          ...data,
        }),
      );
    const result = await withUser(WS_ADMIN, () => metric.upsert(ATOMIC_INFO));
    expect(result).toEqual({ applied: true, id: 41 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.metricDef.create).toHaveBeenCalledTimes(2);
  });

  it('member → WORKSPACE becomes a pending request (no direct write)', async () => {
    const { metric, prisma } = makeServices();
    const result = await withUser(MEMBER, () => metric.upsert(ATOMIC_INFO));
    expect(result).toEqual({ applied: false, request_id: 999 });
    expect(prisma.metricDef.create).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'metric',
        action: 'upsert',
        targetType: 'WORKSPACE',
        proposerUid: 7,
        payload: expect.objectContaining({
          kind: 'atomic',
          code: 'pay_amount',
        }),
      }),
    });
  });

  it('rejects bad codes and malformed/composite-invalid definitions', async () => {
    const { metric } = makeServices();
    await expect(
      withUser(WS_ADMIN, () =>
        metric.upsert({ ...ATOMIC_INFO, code: 'bad-code' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withUser(WS_ADMIN, () =>
        metric.upsert({
          ...ATOMIC_INFO,
          kind: 'atomic',
          definition: { datasource_id: 3, aggregation: 'SUM' },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      withUser(WS_ADMIN, () =>
        metric.upsert({
          kind: 'composite',
          scope: 'WORKSPACE',
          code: 'atv',
          name: '客单价',
          definition: { expression: 'atv + pay_amount' },
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('MetricService governance flow', () => {
  it('remove: direct rows vanish, upper-layer rows become requests', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      {
        id: 1,
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        enabled: true,
        version: 2,
        kind: 'atomic',
        code: 'a',
        name: 'a',
        definition: {},
      },
      {
        id: 2,
        scope: 'GLOBAL',
        oid: null,
        ownerUid: null,
        enabled: true,
        version: 1,
        kind: 'period',
        code: 'last_7d',
        name: '最近7天',
        definition: {},
      },
    ]);
    const result = await withUser(WS_ADMIN, () => metric.remove([1, 2]));
    expect(result).toEqual({ removed: 1, requested: 1 });
    expect(prisma.metricDef.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 } }),
    );
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'metric',
        action: 'remove',
        targetType: 'GLOBAL',
        payload: expect.objectContaining({ kind: 'period', code: 'last_7d' }),
      }),
    });
  });

  it('review approval applies the payload at the target layer + closes', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 55,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: {
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        definition: ATOMIC_INFO.definition,
        enabled: true,
      },
    });
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 12,
        version: 1,
        ...data,
      }),
    );
    await withUser(WS_ADMIN, () => metric.review(55, true, 'ok'));
    expect(prisma.metricDef.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ code: 'pay_amount', scope: 'WORKSPACE' }),
    });
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 55, status: 'pending' },
      data: expect.objectContaining({ status: 'approved', reviewerUid: 5 }),
    });
  });

  it('does not apply a request a concurrent review already claimed', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 55,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: {
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        definition: ATOMIC_INFO.definition,
        enabled: true,
      },
    });
    // the claim matched 0 rows: the other reviewer committed first
    prisma.semanticChangeRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withUser(WS_ADMIN, () => metric.review(55, true)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.metricDef.create).not.toHaveBeenCalled();
    expect(prisma.metricDefVersion.create).not.toHaveBeenCalled();
  });

  it('pageRequests filters to the M4 entityTypes', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findMany.mockResolvedValue([]);
    // the controller's shared inbox covers BOTH dictionaries
    await withUser(WS_ADMIN, () =>
      metric.pageRequests('pending', 1, 10, ['metric', 'standard']),
    );
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: { in: ['metric', 'standard'] },
        }),
      }),
    );
  });
});

describe('MetricService.matchDefinitions', () => {
  const row = (over: Partial<MetricDef>): MetricDef => ({
    id: 1,
    kind: 'atomic',
    code: 'x',
    name: 'x',
    aliases: null,
    description: null,
    unit: null,
    definition: {},
    scope: 'WORKSPACE',
    oid: 1,
    ownerUid: null,
    enabled: true,
    version: 1,
    createBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });

  it('resolves the derived metric, its default time field and tables', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      row({
        id: 11,
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        unit: '元',
        definition: {
          datasource_id: 3,
          table_name: 'orders',
          field_name: 'pay_amount',
          aggregation: 'SUM',
        },
      }),
      row({
        id: 41,
        kind: 'derived',
        code: 'baby_pay',
        name: '母婴支付金额',
        definition: { atomic_code: 'pay_amount' },
      }),
    ]);
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        id: 71,
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        datasourceId: 3,
        tableName: 'orders',
        fieldName: 'pay_time',
        role: 'time',
        meaning: '支付时间',
        unit: null,
        enumValues: null,
        enabled: true,
        version: 1,
        createBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    // keywords for "母婴支付金额趋势" — the derived metric's own name
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, new Set(['母婴支付金额']), 5),
    );
    expect(r.matched).toBe(1);
    expect(r.atomicTableNames).toEqual(['orders']);
    expect(r.text).toContain('SUM(orders.pay_amount)');
    expect(r.text).toContain('母婴支付金额 (baby_pay)');
  });
});

describe('DataStandardService', () => {
  it('routes upsert by authority and renders naming rules at runtime', async () => {
    const { standard, prisma } = makeServices();
    // member proposes a naming entry
    const result = await withUser(MEMBER, () =>
      standard.upsert({
        kind: 'naming',
        scope: 'WORKSPACE',
        code: 'annual_revenue',
        term: '年营收',
        name: '年度总营业额',
        category: 'business_noun',
      }),
    );
    expect(result).toEqual({ applied: false, request_id: 999 });
    // runtime: the naming dictionary matches the question
    prisma.dataStandard.findMany.mockResolvedValue([
      {
        id: 21,
        kind: 'naming',
        code: 'annual_revenue',
        term: '年营收',
        name: '年度总营业额',
        aliases: null,
        category: 'business_noun',
        description: null,
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        enabled: true,
        version: 1,
        createBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    // runtime: the naming dictionary matches the extracted keyword
    const text = await withUser(MEMBER, () =>
      standard.namingTemplateFor(new Set(['年营收']), 5),
    );
    expect(text).toContain('term="年营收"');
    expect(text).toContain('standard="年度总营业额"');
    // units never render into the prompt block
    const none = await withUser(MEMBER, () =>
      standard.namingTemplateFor(new Set(['件']), 5),
    );
    expect(none).toBe('');
  });

  it('rejects a category foreign to the kind', async () => {
    const { standard } = makeServices();
    await expect(
      withUser(WS_ADMIN, () =>
        standard.upsert({
          kind: 'unit',
          scope: 'WORKSPACE',
          code: 'jian',
          term: '件',
          name: '件',
          category: 'business_noun',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---- appended: reviewShared inbox dispatch, page/versions reads, the
// ---- update/remove/toggle write arms and payload mapping ----

/** Full MetricDef-shaped row for the read/apply paths. */
const defRow = (
  over: Partial<MetricDef> & Record<string, unknown>,
): MetricDef => ({
  id: 1,
  kind: 'atomic',
  code: 'x',
  name: 'x',
  aliases: null,
  description: null,
  unit: null,
  definition: {},
  scope: 'WORKSPACE',
  oid: 1,
  ownerUid: null,
  enabled: true,
  version: 1,
  createBy: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  ...over,
});

const ATOMIC_DEF = {
  datasource_id: 3,
  table_name: 'orders',
  field_name: 'pay_amount',
  aggregation: 'SUM',
};

describe('MetricService.reviewShared', () => {
  it('rejects unknown or non-pending requests', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(null);
    await expect(
      withUser(WS_ADMIN, () => metric.reviewShared(55, true)),
    ).rejects.toThrow('该变更提案不在待审批状态');
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      entityType: 'metric',
      status: 'approved',
    });
    await expect(
      withUser(WS_ADMIN, () => metric.reviewShared(55, true)),
    ).rejects.toThrow('该变更提案不在待审批状态');
  });

  it('dispatches a standard request to the standard dictionary', async () => {
    const { metric, standard, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      entityType: 'standard',
      status: 'pending',
    });
    const review = jest.spyOn(standard, 'review').mockResolvedValue();
    await withUser(WS_ADMIN, () => metric.reviewShared(57, true, 'go'));
    expect(review).toHaveBeenCalledWith(57, true, 'go');
  });

  it('handles a metric request itself', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      entityType: 'metric',
      status: 'pending',
    });
    const review = jest.spyOn(metric, 'review').mockResolvedValue();
    await withUser(WS_ADMIN, () => metric.reviewShared(58, false, 'no'));
    expect(review).toHaveBeenCalledWith(58, false, 'no');
  });
});

describe('MetricService.page', () => {
  it('flags dangling ds bindings and keeps reference-free kinds at true', async () => {
    const { metric, prisma } = makeServices();
    // the prisma mock ignores `where`, so the fixture carries only atomic rows
    prisma.metricDef.findMany.mockResolvedValue([
      defRow({ id: 1, code: 'pay_amount', definition: ATOMIC_DEF }),
      defRow({ id: 3, code: 'corrupt', definition: 'hand-corrupted' }),
      defRow({
        id: 5,
        code: 'other_ds',
        definition: { ...ATOMIC_DEF, datasource_id: 9 },
      }),
    ]);
    prisma.table.findFirst.mockResolvedValue(null); // the binding dangles
    const page = await withUser(WS_ADMIN, () =>
      metric.page('atomic', 1, 10, { datasourceId: 3 }),
    );
    // the datasource filter drops the ds9 row, keeps the unparseable one
    expect(page.total_count).toBe(2);
    expect((page.data as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'pay_amount',
      'corrupt',
    ]);
    expect(page.data[0].table_exists).toBe(false);
    expect(page.data[1].table_exists).toBe(true); // unparseable def → no binding → true
    expect(prisma.table.findFirst).toHaveBeenCalledWith({
      where: {
        datasourceId: 3,
        tableName: 'orders',
        datasource: { oid: 1 },
      },
      select: { id: true },
    });
  });

  it('marks table_exists true when the synced Table row still exists', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      defRow({ id: 1, code: 'pay_amount', definition: ATOMIC_DEF }),
    ]);
    prisma.table.findFirst.mockResolvedValue({ id: 99 });
    const page = await withUser(WS_ADMIN, () => metric.page('atomic', 1, 10));
    expect(page.data[0].table_exists).toBe(true);
  });

  it('the datasourceId filter keeps other kinds and same-ds rows only', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      defRow({
        id: 1,
        kind: 'modifier',
        code: 'mod_ds3',
        definition: {
          datasource_id: 3,
          table_name: 't',
          field_name: 'f',
          operator: '=',
          values: ['v'],
        },
      }),
      defRow({
        id: 2,
        kind: 'modifier',
        code: 'mod_ds9',
        definition: {
          datasource_id: 9,
          table_name: 't',
          field_name: 'f',
          operator: '=',
          values: ['v'],
        },
      }),
      defRow({
        id: 3,
        kind: 'period',
        code: 'free_p',
        definition: { mode: 'anchor', anchor: 'ytd' },
      }),
      defRow({
        id: 4,
        kind: 'modifier',
        code: 'corrupt_mod',
        definition: 'oops',
      }),
    ]);
    const page = await withUser(WS_ADMIN, () =>
      metric.page('modifier', 1, 10, { datasourceId: 3 }),
    );
    expect((page.data as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'mod_ds3',
      'free_p',
      'corrupt_mod',
    ]);
  });

  it('narrows by keyword + scope inside the visible layers and clamps paging', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) =>
        defRow({
          id: i + 1,
          kind: 'period',
          code: `p${String(i + 1).padStart(2, '0')}`,
          definition: { mode: 'anchor', anchor: 'ytd' },
        }),
      ),
    );
    const page = await withUser(WS_ADMIN, () =>
      metric.page('period', 2, 5, { keyword: '  p1  ', scope: 'PERSONAL' }),
    );
    expect(prisma.metricDef.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind: 'period',
          scope: 'PERSONAL',
          AND: [
            {
              OR: [
                { scope: 'GLOBAL' },
                { scope: 'WORKSPACE', oid: 1 },
                { scope: 'PERSONAL', oid: 1, ownerUid: 5 },
              ],
            },
            {
              OR: [
                { code: { contains: 'p1', mode: 'insensitive' } },
                { name: { contains: 'p1', mode: 'insensitive' } },
              ],
            },
          ],
        },
        orderBy: [{ code: 'asc' }],
      }),
    );
    // pageSize floors at 10 → 12 rows = 2 pages; page 2 holds the last 2
    expect(page.page_size).toBe(10);
    expect(page.total_pages).toBe(2);
    expect(page.current_page).toBe(2);
    expect((page.data as Array<{ code: string }>).map((r) => r.code)).toEqual([
      'p11',
      'p12',
    ]);
    // a non-positive page clamps to 1
    const first = await withUser(WS_ADMIN, () => metric.page('period', 0, 10));
    expect(first.current_page).toBe(1);
  });
});

describe('MetricService.versions', () => {
  it('maps version history to the snake wire shape after the visibility check', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findUnique.mockResolvedValue(
      defRow({ id: 9, scope: 'WORKSPACE', oid: 1, ownerUid: null }),
    );
    const when = new Date('2026-02-03T04:05:06.000Z');
    prisma.metricDefVersion.findMany.mockResolvedValue([
      {
        id: 31,
        version: 3,
        snapshot: { code: 'x', source: 'edit' },
        changedBy: 5,
        note: 'ok',
        createdAt: when,
      },
      {
        id: 30,
        version: 2,
        snapshot: { code: 'x', source: 'create' },
        changedBy: null,
        note: null,
        createdAt: when,
      },
    ]);
    const out = await withUser(WS_ADMIN, () => metric.versions(9));
    expect(out).toEqual([
      {
        id: 31,
        version: 3,
        snapshot: { code: 'x', source: 'edit' },
        changed_by: 5,
        note: 'ok',
        create_time: when.toISOString(),
      },
      {
        id: 30,
        version: 2,
        snapshot: { code: 'x', source: 'create' },
        changed_by: null,
        note: null,
        create_time: when.toISOString(),
      },
    ]);
    expect(prisma.metricDefVersion.findMany).toHaveBeenCalledWith({
      where: { entityId: 9 },
      orderBy: { version: 'desc' },
    });
  });

  it('hides version history of a foreign workspace row', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findUnique.mockResolvedValue(
      defRow({ id: 9, scope: 'WORKSPACE', oid: 2, ownerUid: null }),
    );
    await expect(withUser(WS_ADMIN, () => metric.versions(9))).rejects.toThrow(
      '指标条目不存在',
    );
  });
});

describe('MetricService.validateInfo / payload mapping', () => {
  it('rejects unknown kinds and missing names', async () => {
    const { metric } = makeServices();
    await expect(
      withUser(WS_ADMIN, () =>
        metric.upsert({
          ...ATOMIC_INFO,
          kind: 'bogus' as never,
        }),
      ),
    ).rejects.toThrow('未知的指标类型');
    await expect(
      withUser(WS_ADMIN, () => metric.upsert({ ...ATOMIC_INFO, name: '   ' })),
    ).rejects.toThrow('指标编码与名称为必填');
  });

  it('carries trimmed aliases/description/unit and the enabled flag into proposals', async () => {
    const { metric, prisma } = makeServices();
    await withUser(MEMBER, () =>
      metric.upsert({
        ...ATOMIC_INFO,
        aliases: [' 支付 ', '', '付款 '],
        description: ' 描述 ',
        unit: ' 元 ',
        enabled: false,
      }),
    );
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          kind: 'atomic',
          code: 'pay_amount',
          aliases: ['支付', '付款'],
          description: '描述',
          unit: '元',
          enabled: false,
        }),
      }),
    });
  });

  it('blocks a duplicate pending proposal on the same natural key, passes different keys', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findFirst.mockResolvedValue({
      id: 900,
      payload: { kind: 'atomic', code: 'pay_amount' },
    });
    await expect(
      withUser(MEMBER, () => metric.upsert(ATOMIC_INFO)),
    ).rejects.toThrow('该条目已存在待审批的变更提案');
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();

    prisma.semanticChangeRequest.findFirst.mockResolvedValue({
      id: 901,
      payload: { kind: 'atomic', code: 'another' },
    });
    const ok = await withUser(MEMBER, () =>
      metric.upsert({ ...ATOMIC_INFO, code: 'pay_amount' }),
    );
    expect(ok).toEqual({ applied: false, request_id: 999 });
  });

  it('rejects malformed change-request payloads on approval', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 55,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: null,
    });
    await expect(
      withUser(WS_ADMIN, () => metric.review(55, true)),
    ).rejects.toThrow('变更提案的载荷格式非法');
    expect(prisma.metricDef.create).not.toHaveBeenCalled();

    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 55,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: { kind: 'bogus', code: 'x', name: 'x' },
    });
    await expect(
      withUser(WS_ADMIN, () => metric.review(55, true)),
    ).rejects.toThrow('变更提案的载荷格式非法');
    expect(prisma.metricDef.create).not.toHaveBeenCalled();
  });

  it('approves a period payload with default enabled and filters non-string aliases', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 55,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: {
        kind: 'period',
        code: 'last_30d',
        name: '最近30天',
        aliases: ['近一月', 5, null],
        definition: { mode: 'recent', time_unit: 'day', count: 30 },
      },
    });
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 61,
        version: 1,
        ...data,
      }),
    );
    await withUser(WS_ADMIN, () => metric.review(55, true));
    expect(prisma.metricDef.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'period',
        code: 'last_30d',
        aliases: ['近一月'],
        definition: { mode: 'recent', time_unit: 'day', count: 30 },
        enabled: true, // payload carried no boolean → default
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
      }),
    });
  });
});

describe('MetricService direct-write arms', () => {
  it('updates an existing row in place and snapshots the edit (enabled preserved)', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findFirst.mockResolvedValue({
      id: 44,
      enabled: false,
      version: 2,
    });
    prisma.metricDef.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        ...data,
        id: 44,
        version: 3,
      }),
    );
    const result = await withUser(WS_ADMIN, () =>
      metric.upsert({ ...ATOMIC_INFO, aliases: ['x'] }),
    );
    expect(result).toEqual({ applied: true, id: 44 });
    expect(prisma.metricDef.update).toHaveBeenCalledWith({
      where: { id: 44 },
      data: expect.objectContaining({
        name: '支付金额',
        aliases: ['x'],
        enabled: false, // edit omitted the flag → stored value kept
        version: { increment: 1 },
      }),
    });
    expect(prisma.metricDefVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 44,
        version: 3,
        snapshot: expect.objectContaining({ source: 'edit' }),
        changedBy: 5,
      }),
    });

    // an explicit enabled overrides the stored flag
    await withUser(WS_ADMIN, () =>
      metric.upsert({ ...ATOMIC_INFO, enabled: true }),
    );
    expect(prisma.metricDef.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: true }),
      }),
    );
  });

  it('applies an approved remove request and stays idempotent when the row is gone', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 56,
      status: 'pending',
      action: 'remove',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: {
        kind: 'atomic',
        code: 'pay_amount',
        name: 'x',
        definition: ATOMIC_DEF,
      },
    });
    prisma.metricDef.findFirst.mockResolvedValueOnce({ id: 77 });
    await withUser(WS_ADMIN, () => metric.review(56, true));
    expect(prisma.metricDef.delete).toHaveBeenCalledWith({
      where: { id: 77 },
    });

    // approving the same removal again: the row is already gone → no write
    prisma.metricDef.findFirst.mockResolvedValueOnce(null);
    await withUser(WS_ADMIN, () => metric.review(56, true));
    expect(prisma.metricDef.delete).toHaveBeenCalledTimes(1);
  });

  it('rejecting a request claims it and applies nothing', async () => {
    const { metric, prisma } = makeServices();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      id: 57,
      status: 'pending',
      action: 'upsert',
      targetType: 'WORKSPACE',
      oid: 1,
      payload: {
        kind: 'period',
        code: 'p',
        name: 'p',
        definition: { mode: 'anchor', anchor: 'ytd' },
      },
    });
    await withUser(WS_ADMIN, () => metric.review(57, false, 'nope'));
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 57, status: 'pending' },
      data: expect.objectContaining({ status: 'rejected', reviewerUid: 5 }),
    });
    expect(prisma.metricDef.create).not.toHaveBeenCalled();
    expect(prisma.metricDef.update).not.toHaveBeenCalled();
  });

  it('setEnabled bumps the version and snapshots a toggle', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findUnique.mockResolvedValue(
      defRow({ id: 9, scope: 'WORKSPACE', oid: 1, ownerUid: null }),
    );
    prisma.metricDef.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 9,
        kind: 'atomic',
        code: 'pay_amount',
        name: '支付金额',
        aliases: null,
        description: null,
        unit: null,
        definition: ATOMIC_DEF,
        ...data,
        version: 4,
      }),
    );
    await withUser(WS_ADMIN, () => metric.setEnabled(9, false));
    expect(prisma.metricDef.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { enabled: false, version: { increment: 1 } },
    });
    expect(prisma.metricDefVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 9,
        version: 4,
        snapshot: expect.objectContaining({ source: 'toggle', enabled: false }),
        changedBy: 5,
      }),
    });
  });
});

describe('MetricService.matchDefinitions — exact keyword matching', () => {
  const exactAtomic = (over: Partial<MetricDef>): MetricDef =>
    defRow({
      code: 'pay_amount',
      name: '支付金额',
      definition: ATOMIC_DEF,
      ...over,
    });

  it('matches an exact keyword, never a substring of one', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([exactAtomic({ id: 11 })]);
    const hit = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, new Set(['支付金额']), 5),
    );
    expect(hit).toEqual(
      expect.objectContaining({ matched: 1, atomicTableNames: ['orders'] }),
    );
    // the raw question "支付金额趋势" is NOT a keyword → nothing renders
    const miss = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, new Set(['支付金额趋势']), 5),
    );
    expect(miss).toEqual({ text: '', atomicTableNames: [], matched: 0 });
  });

  it('reads the dictionary and the time fields only — no vector stage', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([exactAtomic({ id: 11 })]);
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, new Set(['支付金额']), 5),
    );
    expect(r).not.toHaveProperty('degradeReason');
    expect(prisma.metricDef.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fieldSemantic.findMany).toHaveBeenCalledTimes(1);
  });
});
