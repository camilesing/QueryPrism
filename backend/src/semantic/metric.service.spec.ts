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
import type { EmbeddingConfig } from '../common/config/embedding-config';

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

/** Embedding / vector stubs. `available: false` is the default so every
 *  pre-vector test keeps exercising the literal-only path (the vector stage
 *  only runs when a task snapshot is passed AND both are available). */
function makeServices(prisma: MetricPrismaMock = makePrisma()) {
  const standard = new DataStandardService(prisma as never);
  const embedding = {
    available: false,
    embed: jest.fn(),
    embedBatch: jest.fn(),
  };
  const vector = {
    available: false,
    upsert: jest.fn(),
    search: jest.fn(),
  };
  return {
    metric: new MetricService(
      prisma as never,
      { onApproval: jest.fn() } as never,
      standard,
      embedding as never,
      vector as never,
    ),
    standard,
    prisma,
    embedding,
    vector,
  };
}

/** Full strategy snapshot — the vector stage requires one explicitly. */
const CONFIG: EmbeddingConfig = {
  enabled: true,
  terminologySimilarity: 0.4,
  terminologyTopCount: 5,
  dataTrainingSimilarity: 0.4,
  dataTrainingTopCount: 5,
  tableEnabled: true,
  tableCount: 10,
  tableAlpha: 0.4,
  keywordEnabled: true,
  datasourceCount: 10,
  clarifyEnabled: true,
  clarifyTableThreshold: 3,
  clarifyMaxSelect: 3,
  clarifyMaxRounds: 1,
  semanticEnabled: true,
  semanticMaxTables: 1,
  semanticEnumMaxValues: 50,
  semanticEnumScanRows: 10000,
  semanticEnumCooldown: 60,
  metricEnabled: true,
  metricMaxDefinitions: 5,
  metricSimilarityThreshold: 0.55,
  namingEnabled: true,
};

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
    embedding: null,
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
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '母婴支付金额趋势', 5),
    );
    expect(r.matched).toBe(1);
    expect(r.atomicTableNames).toEqual(['orders']);
    expect(r.text).toContain('SUM(orders.pay_amount)');
    expect(r.text).toContain('母婴支付金额 (baby_pay)');
  });

  const atomic = (over: Partial<MetricDef>): MetricDef => ({
    id: 1,
    kind: 'atomic',
    code: 'x',
    name: 'x',
    aliases: null,
    embedding: null,
    description: null,
    unit: null,
    definition: {
      datasource_id: 3,
      table_name: 'orders',
      field_name: 'pay_amount',
      aggregation: 'SUM',
    },
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

  const stubVectorHit = (
    services: ReturnType<typeof makeServices>,
    id: number,
    distance: number,
  ) => {
    services.embedding.available = true;
    services.embedding.embed.mockResolvedValue([0.1, 0.2]);
    services.vector.available = true;
    services.vector.search.mockResolvedValue([{ id, distance }]);
  };

  it('vector hits fill the remaining slots after the literal matches', async () => {
    const services = makeServices();
    const { metric, prisma } = services;
    prisma.metricDef.findMany
      .mockResolvedValueOnce([
        atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
        atomic({ id: 12, code: 'refund_amount', name: '退款金额' }),
      ])
      .mockResolvedValueOnce([
        { id: 12, kind: 'atomic', code: 'refund_amount' },
      ]);
    stubVectorHit(services, 12, 0.2); // similarity 0.8
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额趋势', 5, CONFIG),
    );
    expect(r.matched).toBe(2);
    expect(r.text).toContain('支付金额 (pay_amount)');
    expect(r.text).toContain('退款金额 (refund_amount)');
    expect(r.degradeReason).toBeUndefined();
  });

  it('drops vector hits at or below metric.similarity_threshold', async () => {
    const services = makeServices();
    const { metric, prisma } = services;
    prisma.metricDef.findMany
      .mockResolvedValueOnce([
        atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
        atomic({ id: 12, code: 'refund_amount', name: '退款金额' }),
      ])
      .mockResolvedValueOnce([
        { id: 12, kind: 'atomic', code: 'refund_amount' },
      ]);
    stubVectorHit(services, 12, 0.45); // similarity 0.55 == threshold
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额趋势', 5, CONFIG),
    );
    expect(r.matched).toBe(1);
    expect(r.text).not.toContain('refund_amount');
  });

  it('never lets a vector hit evict a literal match (cap saturation)', async () => {
    const services = makeServices();
    const { metric, prisma } = services;
    prisma.metricDef.findMany
      .mockResolvedValueOnce([
        atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
        atomic({ id: 12, code: 'refund_amount', name: '退款金额' }),
      ])
      .mockResolvedValueOnce([
        { id: 12, kind: 'atomic', code: 'refund_amount' },
      ]);
    stubVectorHit(services, 12, 0.1); // similarity 0.9, most similar
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额', 1, CONFIG),
    );
    expect(r.matched).toBe(1);
    expect(r.text).toContain('支付金额 (pay_amount)');
    expect(r.text).not.toContain('refund_amount');
  });

  it('degrades to literal when embedding is unavailable, without throwing', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
    ]);
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额趋势', 5, CONFIG),
    );
    expect(r.matched).toBe(1);
    expect(r.degradeReason).toBe('no_embedding');
  });

  it('degrades to literal when the provider call fails', async () => {
    const services = makeServices();
    const { metric, prisma } = services;
    prisma.metricDef.findMany.mockResolvedValue([
      atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
    ]);
    services.embedding.available = true;
    services.embedding.embed.mockRejectedValue(new Error('provider down'));
    services.vector.available = true;
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额趋势', 5, CONFIG),
    );
    expect(r.matched).toBe(1);
    expect(r.degradeReason).toBe('error');
  });

  it('stays literal when no strategy snapshot is supplied', async () => {
    const { metric, prisma } = makeServices();
    prisma.metricDef.findMany.mockResolvedValue([
      atomic({ id: 11, code: 'pay_amount', name: '支付金额' }),
    ]);
    const r = await withUser(MEMBER, () =>
      metric.matchDefinitions(3, '支付金额趋势', 5),
    );
    expect(r.degradeReason).toBe('no_config');
  });
});

describe('MetricService search-index refresh', () => {
  it('embeds + indexes the row after a committed direct upsert', async () => {
    const { metric, prisma, embedding, vector } = makeServices();
    embedding.available = true;
    embedding.embedBatch.mockResolvedValue([[0.3, 0.4]]);
    vector.available = true;
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 11,
        version: 1,
        ...data,
      }),
    );
    prisma.metricDef.findMany.mockResolvedValue([
      { id: 11, name: '支付金额', aliases: null, description: null },
    ]);
    await withUser(WS_ADMIN, () => metric.upsert(ATOMIC_INFO));
    await new Promise((resolve) => setImmediate(resolve));
    expect(embedding.embedBatch).toHaveBeenCalledWith(['支付金额']);
    expect(prisma.metricDef.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { embedding: [0.3, 0.4] },
    });
    expect(vector.upsert).toHaveBeenCalledWith(
      'metric_def',
      11,
      [0.3, 0.4],
      expect.anything(),
    );
  });

  it('does nothing when embedding is unavailable (rows stay NULL for backfill)', async () => {
    const { metric, prisma, embedding, vector } = makeServices();
    embedding.available = false;
    prisma.metricDef.findFirst.mockResolvedValue(null);
    prisma.metricDef.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 11,
        version: 1,
        ...data,
      }),
    );
    await withUser(WS_ADMIN, () => metric.upsert(ATOMIC_INFO));
    await new Promise((resolve) => setImmediate(resolve));
    expect(embedding.embedBatch).not.toHaveBeenCalled();
    expect(vector.upsert).not.toHaveBeenCalled();
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
    const text = await withUser(MEMBER, () =>
      standard.namingTemplateFor('今年年营收多少', 5),
    );
    expect(text).toContain('term="年营收"');
    expect(text).toContain('standard="年度总营业额"');
    // units never render into the prompt block
    const none = await withUser(MEMBER, () =>
      standard.namingTemplateFor('按件', 5),
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
