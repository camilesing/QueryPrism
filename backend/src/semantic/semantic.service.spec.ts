// SemanticService unit tests (MetaDataImprove M2): scope authority routing
// (direct edit vs proposal), the approval apply flow, and the
// PERSONAL > WORKSPACE > GLOBAL effective resolution. Prisma is mocked; the
// actor comes from the real RequestContext ALS (assistant.service.spec
// pattern).
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { SemanticService, type EnumCollectSummary } from './semantic.service';
import type {
  SemanticEntitySnake,
  SemanticPage,
} from './semantic-snake-mapper';

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
const SYS_ADMIN = { id: 1, oid: 1, weight: 0, account: 'admin' };

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

interface SemanticPrismaMock {
  tableSemantic: EntityMockSet;
  fieldSemantic: EntityMockSet;
  tableSemanticVersion: { create: jest.Mock; findMany: jest.Mock };
  fieldSemanticVersion: { create: jest.Mock; findMany: jest.Mock };
  semanticChangeRequest: {
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  table: { findMany: jest.Mock };
  systemVariable: { findMany: jest.Mock };
  $transaction: jest.Mock;
}

function makePrisma(): SemanticPrismaMock {
  const entity = (): EntityMockSet => ({
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  });
  const prisma: SemanticPrismaMock = {
    tableSemantic: entity(),
    fieldSemantic: entity(),
    tableSemanticVersion: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    fieldSemanticVersion: {
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
    table: { findMany: jest.fn().mockResolvedValue([]) },
    // No saved parameter rows → resolveEmbeddingConfig uses env defaults.
    systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
    // Execute the callback with the SAME mock object as tx.
    $transaction: jest
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn(prisma),
      ),
  };
  return prisma;
}

type MockPrisma = SemanticPrismaMock;

/** DatasourceService mock for collectEnums: findOne returns the ds metadata,
 * withConnection hands the probe connector straight to the callback. */
function makeDatasourceService(sampleDistinct: jest.Mock) {
  const connector = { sampleDistinct };
  return {
    findOne: jest.fn().mockResolvedValue({
      id: 3,
      tables: [
        {
          id: 30,
          tableName: 'sales_order',
          fields: [
            { id: 300, fieldName: 'order_status' },
            { id: 301, fieldName: 'amount' },
          ],
        },
      ],
    }),
    withConnection: jest.fn(
      (_id: number, fn: (c: unknown) => Promise<unknown>) => fn(connector),
    ),
  };
}

function makeService(
  prisma: MockPrisma = makePrisma(),
  datasourceService = makeDatasourceService(jest.fn().mockResolvedValue([])),
) {
  return {
    service: new SemanticService(
      prisma as never,
      datasourceService as never,
      { onApproval: jest.fn() } as never,
    ),
    prisma,
    datasourceService,
  };
}

const TABLE_INFO = {
  entity_type: 'table' as const,
  scope: 'WORKSPACE' as const,
  datasource_id: 3,
  table_name: 'sales_order',
  meaning: '销售订单主表',
};

describe('SemanticService.upsert authority routing', () => {
  it('member → WORKSPACE becomes a pending request (no direct write)', async () => {
    const { service, prisma } = makeService();
    const result = await withUser(MEMBER, () => service.upsert(TABLE_INFO));
    expect(result).toEqual({ applied: false, request_id: expect.any(Number) });
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: 'table',
          action: 'upsert',
          targetType: 'WORKSPACE',
          proposerUid: 7,
        }),
      }),
    );
  });

  it('member → GLOBAL also becomes a request; ws admin → GLOBAL too', async () => {
    const { service, prisma } = makeService();
    await withUser(MEMBER, () =>
      service.upsert({ ...TABLE_INFO, scope: 'GLOBAL' }),
    );
    expect(
      prisma.semanticChangeRequest.create.mock.calls[0][0].data.targetType,
    ).toBe('GLOBAL');

    prisma.semanticChangeRequest.create.mockClear();
    await withUser(WS_ADMIN, () =>
      service.upsert({ ...TABLE_INFO, scope: 'GLOBAL' }),
    );
    // ws admin cannot write GLOBAL either — also a request
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalled();
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('ws admin → WORKSPACE writes directly (v1 + version history)', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 11,
        ...data,
        version: 1,
      }),
    );
    const result = await withUser(WS_ADMIN, () => service.upsert(TABLE_INFO));
    expect(result).toEqual({ applied: true, id: 11 });
    expect(prisma.tableSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        datasourceId: 3,
        tableName: 'sales_order',
      }),
    });
    expect(prisma.tableSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityId: 11, version: 1 }),
    });
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();
  });

  it('retries once when the create race loses (P2002) and then creates', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create
      .mockRejectedValueOnce(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      )
      .mockImplementationOnce(
        ({ data }: { data: Record<string, unknown> }) => ({
          id: 31,
          ...data,
          version: 1,
        }),
      );
    const result = await withUser(WS_ADMIN, () => service.upsert(TABLE_INFO));
    expect(result).toEqual({ applied: true, id: 31 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.tableSemantic.create).toHaveBeenCalledTimes(2);
  });

  it('update path increments version and snapshots the new state', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue({
      id: 12,
      version: 2,
      meaning: '旧含义',
    });
    prisma.tableSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 12,
        ...data,
        version: 3,
      }),
    );
    const result = await withUser(WS_ADMIN, () =>
      service.upsert({ ...TABLE_INFO, meaning: '新含义' }),
    );
    expect(result).toEqual({ applied: true, id: 12 });
    expect(prisma.tableSemantic.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({
        meaning: '新含义',
        version: { increment: 1 },
      }),
    });
    expect(prisma.tableSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ entityId: 12, version: 3 }),
    });
  });

  it('PERSONAL is pinned to the actor workspace + uid (any member)', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 21,
        ...data,
        version: 1,
      }),
    );
    const result = await withUser(MEMBER, () =>
      service.upsert({ ...TABLE_INFO, scope: 'PERSONAL' }),
    );
    expect(result).toEqual({ applied: true, id: 21 });
    expect(prisma.tableSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 7,
      }),
    });
  });
});

describe('SemanticService.review', () => {
  const pendingRequest = {
    id: 100,
    oid: 1,
    status: 'pending',
    action: 'upsert',
    targetType: 'WORKSPACE',
    payload: {
      datasource_id: 3,
      table_name: 'sales_order',
      meaning: '提案含义',
      enabled: true,
    },
  };

  it('member cannot review; ws admin of the same workspace can', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingRequest);
    await expect(
      withUser(MEMBER, () => service.review(100, true)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 31,
        ...data,
        version: 1,
      }),
    );
    await withUser(WS_ADMIN, () => service.review(100, true));
    expect(prisma.tableSemantic.create).toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 100, status: 'pending' },
      data: expect.objectContaining({ status: 'approved', reviewerUid: 5 }),
    });
  });

  it('does not re-apply a request claimed by a concurrent review', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingRequest);
    prisma.semanticChangeRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withUser(WS_ADMIN, () => service.review(100, true)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('a foreign workspace admin cannot review another workspace request', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingRequest);
    await expect(
      withUser({ id: 9, oid: 2, weight: 1 }, () => service.review(100, true)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('approve of a remove request deletes the target row at the layer', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pendingRequest,
      action: 'remove',
    });
    prisma.tableSemantic.findFirst.mockResolvedValue({ id: 41 });
    await withUser(WS_ADMIN, () => service.review(100, true));
    expect(prisma.tableSemantic.delete).toHaveBeenCalledWith({
      where: { id: 41 },
    });
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 100, status: 'pending' },
      data: expect.objectContaining({ status: 'approved' }),
    });
  });

  it('reject only closes the request (no entity write)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingRequest);
    await withUser(WS_ADMIN, () => service.review(100, false, '不需要'));
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 100, status: 'pending' },
      data: expect.objectContaining({
        status: 'rejected',
        reviewNote: '不需要',
      }),
    });
  });

  it('reviewing a non-pending request is rejected', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pendingRequest,
      status: 'approved',
    });
    await expect(
      withUser(WS_ADMIN, () => service.review(100, true)),
    ).rejects.toThrow();
  });
});

describe('SemanticService.effectiveAnnotations', () => {
  it('resolves PERSONAL over WORKSPACE over GLOBAL per key', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue([
      {
        tableName: 'a',
        scope: 'GLOBAL',
        meaning: '全局含义',
        updatedAt: new Date(),
      },
      {
        tableName: 'a',
        scope: 'WORKSPACE',
        oid: 1,
        meaning: '空间含义',
        updatedAt: new Date(),
      },
      {
        tableName: 'a',
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 7,
        meaning: '个人含义',
        updatedAt: new Date(),
      },
      {
        tableName: 'b',
        scope: 'GLOBAL',
        meaning: '仅全局',
        updatedAt: new Date(),
      },
    ]);
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        tableName: 'a',
        fieldName: 'status',
        scope: 'WORKSPACE',
        oid: 1,
        role: 'dimension',
        meaning: '订单状态',
        unit: null,
        enumValues: [{ value: 'paid', label: '已支付' }, { value: 'refunded' }],
      },
    ]);
    const out = await withUser(MEMBER, () =>
      service.effectiveAnnotations(3, ['a', 'b']),
    );
    expect(out.tableMeanings).toEqual({ a: '个人含义', b: '仅全局' });
    expect(out.fieldNotes['a.status']).toEqual({
      role: 'dimension',
      meaning: '订单状态',
      unit: undefined,
      enums: [{ value: 'paid', label: '已支付' }, { value: 'refunded' }],
    });
  });

  it('another user PERSONAL row is invisible (falls back to workspace)', async () => {
    const { service, prisma } = makeService();
    // The query itself must filter PERSONAL to ownerUid — assert the where.
    prisma.tableSemantic.findMany.mockResolvedValue([
      {
        tableName: 'a',
        scope: 'WORKSPACE',
        oid: 1,
        meaning: '空间含义',
        updatedAt: new Date(),
      },
    ]);
    const out = await withUser(MEMBER, () =>
      service.effectiveAnnotations(3, ['a']),
    );
    expect(out.tableMeanings).toEqual({ a: '空间含义' });
    expect(prisma.tableSemantic.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { scope: 'PERSONAL', oid: 1, ownerUid: 7 },
          ]),
        }),
      }),
    );
  });
});

describe('SemanticService.remove routing', () => {
  it('sys admin removes GLOBAL directly; member creates a remove request', async () => {
    const { service, prisma } = makeService();
    const globalRow = {
      id: 51,
      scope: 'GLOBAL',
      oid: null,
      ownerUid: null,
      datasourceId: 3,
      tableName: 'sales_order',
    };
    prisma.tableSemantic.findMany.mockResolvedValue([globalRow]);

    const sysResult = await withUser(SYS_ADMIN, () =>
      service.remove('table', [51]),
    );
    expect(sysResult).toEqual({ removed: 1, requested: 0 });
    expect(prisma.tableSemantic.delete).toHaveBeenCalledWith({
      where: { id: 51 },
    });

    prisma.tableSemantic.delete.mockClear();
    const memberResult = await withUser(MEMBER, () =>
      service.remove('table', [51]),
    );
    expect(memberResult).toEqual({ removed: 0, requested: 1 });
    expect(prisma.tableSemantic.delete).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'remove',
          targetType: 'GLOBAL',
        }),
      }),
    );
  });
});

describe('SemanticService.collectEnums (MetaDataImprove M3.3)', () => {
  const dimensionRow = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 77,
    scope: 'WORKSPACE',
    oid: 1,
    ownerUid: null,
    datasourceId: 3,
    tableName: 'sales_order',
    fieldName: 'order_status',
    role: 'dimension',
    meaning: '订单状态',
    unit: null,
    enumValues: null,
    enabled: true,
    version: 4,
    ...over,
  });

  it('backfills a low-cardinality dimension with versioned enumValues', async () => {
    const sampleDistinct = jest
      .fn()
      .mockResolvedValue(['paid', null, 'refunded', 'paid']);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([dimensionRow()]);
    prisma.fieldSemantic.update.mockResolvedValue({
      ...dimensionRow(),
      version: 5,
      enumValues: [{ value: 'paid' }, { value: 'refunded' }],
    });

    const summary = (await withUser(WS_ADMIN, () =>
      service.collectEnums(3),
    )) as EnumCollectSummary;

    expect(sampleDistinct).toHaveBeenCalledWith(
      'sales_order',
      'order_status',
      10000, // semantic.enum_scan_rows default
    );
    // NULLs dropped, duplicates collapsed, sorted
    expect(prisma.fieldSemantic.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: {
        enumValues: [{ value: 'paid' }, { value: 'refunded' }],
        version: { increment: 1 },
      },
    });
    expect(prisma.fieldSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 77,
        version: 5,
        snapshot: expect.objectContaining({ source: 'enum_collect' }),
      }),
    });
    expect(summary.collected).toEqual([
      {
        id: 77,
        table_name: 'sales_order',
        field_name: 'order_status',
        values: 2,
      },
    ]);
    expect(summary.skipped).toEqual([]);
  });

  it('preserves labels of still-sampled values and drops absent ones', async () => {
    const sampleDistinct = jest.fn().mockResolvedValue(['refunded', 'paid']);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([
      dimensionRow({
        enumValues: [
          { value: 'paid', label: '已支付' },
          { value: 'void', label: '作废' },
          // malformed legacy entry — must not break the run
          'legacy-string',
        ],
      }),
    ]);
    prisma.fieldSemantic.update.mockResolvedValue(dimensionRow());

    await withUser(WS_ADMIN, () => service.collectEnums(3));

    // paid keeps its curated label; refunded is new; void was not sampled.
    expect(prisma.fieldSemantic.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: {
        enumValues: [{ value: 'paid', label: '已支付' }, { value: 'refunded' }],
        version: { increment: 1 },
      },
    });
  });

  it('skips fields above the cardinality cap and never writes them', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `v${i}`);
    const sampleDistinct = jest.fn().mockResolvedValue(many);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([dimensionRow()]);

    const summary = (await withUser(WS_ADMIN, () =>
      service.collectEnums(3),
    )) as EnumCollectSummary;

    expect(summary.collected).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].reason).toContain('50');
    expect(prisma.fieldSemantic.update).not.toHaveBeenCalled();
  });

  it('skips rows the actor cannot edit directly (upper-layer governance)', async () => {
    const sampleDistinct = jest.fn();
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    // A member cannot write GLOBAL directly → approval round, not a backfill.
    prisma.fieldSemantic.findMany.mockResolvedValue([
      dimensionRow({ id: 88, scope: 'GLOBAL', oid: null }),
    ]);

    const summary = (await withUser(MEMBER, () =>
      service.collectEnums(3),
    )) as EnumCollectSummary;

    expect(summary.collected).toEqual([]);
    expect(summary.skipped).toHaveLength(1);
    expect(sampleDistinct).not.toHaveBeenCalled();
    expect(prisma.fieldSemantic.update).not.toHaveBeenCalled();
  });

  it('skips dangling semantics (table/field no longer synced) without probing', async () => {
    const sampleDistinct = jest.fn();
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([
      dimensionRow({ id: 90, tableName: 'gone_table' }),
      dimensionRow({ id: 91, fieldName: 'gone_field' }),
    ]);

    const summary = (await withUser(WS_ADMIN, () =>
      service.collectEnums(3),
    )) as EnumCollectSummary;

    expect(summary.collected).toEqual([]);
    expect(summary.skipped).toHaveLength(2);
    expect(sampleDistinct).not.toHaveBeenCalled();
  });

  it('rate-limits an immediate rerun (semantic.enum_cooldown)', async () => {
    const sampleDistinct = jest.fn().mockResolvedValue(['a']);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([dimensionRow()]);
    prisma.fieldSemantic.update.mockResolvedValue(dimensionRow());

    await withUser(WS_ADMIN, () => service.collectEnums(3));
    await expect(
      withUser(WS_ADMIN, () => service.collectEnums(3)),
    ).rejects.toThrow();
  });
});

// ─── appended coverage: admin page, versions, setEnabled, pageRequests ────

describe('SemanticService.page (admin entity list)', () => {
  const tableRow = (over: Record<string, unknown> = {}) => ({
    id: 1,
    scope: 'WORKSPACE',
    oid: 1,
    ownerUid: null,
    datasourceId: 3,
    tableName: 'sales_order',
    meaning: '销售订单',
    enabled: true,
    version: 2,
    createBy: 5,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  });

  it('requires a logged-in user (no request context → 403)', async () => {
    const { service } = makeService();
    await expect(service.page('table', 1, 10)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('lists visible layers and flags dangling semantics (table_exists)', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue([
      tableRow(),
      tableRow({ id: 2, scope: 'PERSONAL', ownerUid: 7, tableName: 'gone' }),
      tableRow({ id: 3, scope: 'GLOBAL', oid: null, tableName: 'global_t' }),
    ]);
    prisma.table.findMany.mockResolvedValue([
      { tableName: 'sales_order' },
      { tableName: 'global_t' },
    ]);

    const out = (await withUser(MEMBER, () =>
      service.page('table', 1, 10),
    )) as SemanticPage<SemanticEntitySnake>;
    expect(out.total_count).toBe(3);
    expect(out.total_pages).toBe(1);
    // The existence probe is scoped to the actor's workspace.
    expect(prisma.table.findMany).toHaveBeenCalledWith({
      where: { datasourceId: 3, datasource: { oid: 1 } },
      select: { tableName: true },
    });
    const byName = (name: string) =>
      out.data.find((r) => r.table_name === name);
    expect(byName('sales_order')?.table_exists).toBe(true);
    expect(byName('gone')?.table_exists).toBe(false);
    expect(byName('gone')?.scope).toBe('PERSONAL');
    expect(byName('sales_order')).toMatchObject({
      scope: 'WORKSPACE',
      owner_uid: null,
      meaning: '销售订单',
      create_time: '2026-01-01T00:00:00.000Z',
    });
  });

  it('applies keyword/scope/datasource filters as separate AND clauses', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue([]);
    await withUser(MEMBER, () =>
      service.page('table', 1, 10, {
        keyword: '订单',
        scope: 'PERSONAL',
        datasourceId: 3,
      }),
    );
    const where = prisma.tableSemantic.findMany.mock.calls[0][0]
      .where as Record<string, unknown>;
    expect(where.scope).toBe('PERSONAL');
    expect(where.datasourceId).toBe(3);
    // visibility OR stays a separate AND clause next to the keyword OR
    expect(where.AND).toHaveLength(2);
    expect((where.AND as { OR: unknown[] }[])[1].OR).toEqual([
      { tableName: { contains: '订单', mode: 'insensitive' } },
      { meaning: { contains: '订单', mode: 'insensitive' } },
    ]);

    // unknown scope values and blank keywords narrow nothing
    prisma.tableSemantic.findMany.mockClear();
    await withUser(MEMBER, () =>
      service.page('table', 1, 10, { keyword: '   ', scope: 'TEAM' }),
    );
    const where2 = prisma.tableSemantic.findMany.mock.calls[0][0]
      .where as Record<string, unknown>;
    expect(where2.scope).toBeUndefined();
    expect(where2.datasourceId).toBeUndefined();
    expect(where2.AND).toHaveLength(1);
  });

  it('clamps the page into range and floors pageSize at 10', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => tableRow({ id: i + 1 })),
    );
    const out = await withUser(MEMBER, () => service.page('table', 99, 5));
    expect(out).toMatchObject({
      current_page: 3,
      page_size: 10,
      total_count: 25,
      total_pages: 3,
    });
    expect(out.data).toHaveLength(5);

    const emptyService = makeService();
    emptyService.prisma.tableSemantic.findMany.mockResolvedValue([]);
    const empty = await withUser(MEMBER, () =>
      emptyService.service.page('table', 4, 10),
    );
    expect(empty).toMatchObject({
      current_page: 1,
      total_count: 0,
      total_pages: 0,
      data: [],
    });
  });

  it('serves the field entity list through the field mapper', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        id: 9,
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        datasourceId: 3,
        tableName: 'sales_order',
        fieldName: 'order_status',
        role: 'dimension',
        meaning: '订单状态',
        unit: null,
        enumValues: [{ value: 'paid', label: '已支付' }],
        enabled: true,
        version: 1,
        createBy: 5,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    prisma.table.findMany.mockResolvedValue([{ tableName: 'sales_order' }]);

    const out = await withUser(WS_ADMIN, () => service.page('field', 1, 10));
    expect(prisma.fieldSemantic.findMany).toHaveBeenCalled();
    expect(prisma.tableSemantic.findMany).not.toHaveBeenCalled();
    expect(out.data[0]).toMatchObject({
      field_name: 'order_status',
      role: 'dimension',
      enum_values: [{ value: 'paid', label: '已支付' }],
      table_exists: true,
    });
  });
});

describe('SemanticService.versions (append-only history)', () => {
  it('returns newest-first table history mapped to snake wire', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findUnique.mockResolvedValue({
      id: 12,
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
    });
    prisma.tableSemanticVersion.findMany.mockResolvedValue([
      {
        id: 71,
        version: 2,
        snapshot: { meaning: 'v2' },
        changedBy: 5,
        note: 'x',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
      {
        id: 70,
        version: 1,
        snapshot: { meaning: 'v1' },
        changedBy: 5,
        note: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const out = await withUser(WS_ADMIN, () => service.versions('table', 12));
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 71,
      version: 2,
      changed_by: 5,
      note: 'x',
      create_time: '2026-02-01T00:00:00.000Z',
    });
  });

  it('reads field-semantic history (own PERSONAL row is visible)', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findUnique.mockResolvedValue({
      id: 13,
      scope: 'PERSONAL',
      oid: 1,
      ownerUid: 7,
    });
    prisma.fieldSemanticVersion.findMany.mockResolvedValue([
      {
        id: 80,
        version: 1,
        snapshot: {},
        changedBy: 7,
        note: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const out = await withUser(MEMBER, () => service.versions('field', 13));
    expect(out[0]).toMatchObject({ id: 80, version: 1, changed_by: 7 });
  });

  it("404s a missing entity and another workspace's row (no enumeration)", async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findUnique.mockResolvedValue(null);
    await expect(
      withUser(WS_ADMIN, () => service.versions('table', 404)),
    ).rejects.toBeInstanceOf(NotFoundException);

    prisma.tableSemantic.findUnique.mockResolvedValue({
      id: 14,
      scope: 'WORKSPACE',
      oid: 2,
      ownerUid: null,
    });
    await expect(
      withUser(WS_ADMIN, () => service.versions('table', 14)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tableSemanticVersion.findMany).not.toHaveBeenCalled();
  });
});

describe('SemanticService.setEnabled', () => {
  it('toggles a table semantic and writes a toggle version snapshot', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findUnique.mockResolvedValue({
      id: 12,
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      version: 3,
      meaning: '含义',
    });
    prisma.tableSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 12,
        ...data,
        version: 4,
      }),
    );
    await withUser(WS_ADMIN, () => service.setEnabled('table', 12, false));
    expect(prisma.tableSemantic.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { enabled: false, version: { increment: 1 } },
    });
    expect(prisma.tableSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 12,
        // writeVersion re-reads the row — snapshot carries ITS version
        version: 3,
        snapshot: expect.objectContaining({
          meaning: '含义',
          enabled: false,
          source: 'toggle',
        }),
      }),
    });
  });

  it('toggles a field semantic (field snapshot carries role/unit)', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findUnique.mockResolvedValue({
      id: 13,
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
      version: 2,
      role: 'dimension',
      meaning: '状态',
      unit: null,
    });
    prisma.fieldSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 13,
        ...data,
        version: 3,
      }),
    );
    await withUser(WS_ADMIN, () => service.setEnabled('field', 13, true));
    expect(prisma.fieldSemantic.update).toHaveBeenCalledWith({
      where: { id: 13 },
      data: { enabled: true, version: { increment: 1 } },
    });
    expect(prisma.fieldSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 13,
        // snapshot version comes from the findUnique re-read (row.version)
        version: 2,
        snapshot: expect.objectContaining({
          role: 'dimension',
          enabled: true,
          source: 'toggle',
        }),
      }),
    });
  });

  it('forbids a member from toggling a workspace row', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findUnique.mockResolvedValue({
      id: 12,
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
    });
    await expect(
      withUser(MEMBER, () => service.setEnabled('table', 12, true)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tableSemantic.update).not.toHaveBeenCalled();
  });

  it('sys admin toggles a GLOBAL row; a vanished row skips the snapshot', async () => {
    const { service, prisma } = makeService();
    // first read = loadEntity, second read = writeVersion's re-read (row gone)
    prisma.tableSemantic.findUnique
      .mockResolvedValueOnce({
        id: 20,
        scope: 'GLOBAL',
        oid: null,
        ownerUid: null,
      })
      .mockResolvedValueOnce(null);
    prisma.tableSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 20,
        ...data,
        version: 2,
      }),
    );
    await withUser(SYS_ADMIN, () => service.setEnabled('table', 20, true));
    expect(prisma.tableSemantic.update).toHaveBeenCalled();
    expect(prisma.tableSemanticVersion.create).not.toHaveBeenCalled();
  });
});

describe('SemanticService.pageRequests (approval inbox)', () => {
  const reqRow = (over: Record<string, unknown> = {}) => ({
    id: 100,
    oid: 1,
    entityType: 'table',
    action: 'upsert',
    targetType: 'WORKSPACE',
    payload: {},
    status: 'pending',
    proposerUid: 7,
    proposer: 'member',
    reviewerUid: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date('2026-03-01T00:00:00Z'),
    ...over,
  });

  it('"mine" lists only the actor own proposals (snake wire)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findMany.mockResolvedValue([reqRow()]);
    const out = await withUser(MEMBER, () =>
      service.pageRequests('mine', 1, 10),
    );
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ proposerUid: 7 }),
      }),
    );
    expect(out.data[0]).toMatchObject({
      id: 100,
      entity_type: 'table',
      target_type: 'WORKSPACE',
      proposer_uid: 7,
      reviewed_at: null,
      create_time: '2026-03-01T00:00:00.000Z',
    });
  });

  it('"pending" for a ws admin narrows to their workspace WORKSPACE queue', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findMany.mockResolvedValue([]);
    await withUser(WS_ADMIN, () => service.pageRequests('pending', 1, 10));
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'pending',
          targetType: 'WORKSPACE',
          oid: 1,
        }),
      }),
    );
  });

  it('"pending" for the system admin sees every pending request', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findMany.mockResolvedValue([]);
    await withUser(SYS_ADMIN, () => service.pageRequests('pending', 1, 10));
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: { in: ['table', 'field'] },
          status: 'pending',
        },
      }),
    );
  });

  it('paginates: clamps page into range, page size floor 10', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => reqRow({ id: i + 1 })),
    );
    const out = await withUser(MEMBER, () =>
      service.pageRequests('mine', 99, 5),
    );
    expect(out).toMatchObject({
      current_page: 2,
      page_size: 10,
      total_count: 12,
      total_pages: 2,
    });
    expect(out.data).toHaveLength(2);
  });
});

// ─── appended coverage: validation, field entities, request payloads ──────

describe('SemanticService.upsert validation + field entities', () => {
  it('rejects invalid scope / blank meaning / missing field_name / bad role', async () => {
    const { service, prisma } = makeService();
    await expect(
      withUser(WS_ADMIN, () =>
        service.upsert({ ...TABLE_INFO, scope: 'TEAM' as never }),
      ),
    ).rejects.toThrow('未知的语义层级');
    await expect(
      withUser(WS_ADMIN, () =>
        service.upsert({ ...TABLE_INFO, meaning: '   ' }),
      ),
    ).rejects.toThrow('必填');
    await expect(
      withUser(WS_ADMIN, () =>
        service.upsert({
          ...TABLE_INFO,
          entity_type: 'field',
          meaning: 'x',
        }),
      ),
    ).rejects.toThrow('必填');
    await expect(
      withUser(WS_ADMIN, () =>
        service.upsert({
          ...TABLE_INFO,
          entity_type: 'field',
          field_name: 'status',
          role: 'bogus' as never,
          meaning: 'x',
        }),
      ),
    ).rejects.toThrow('未知的字段角色');
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('404s when the datasource is not reachable from the actor workspace', async () => {
    const ds = makeDatasourceService(jest.fn());
    ds.findOne.mockRejectedValueOnce(
      new NotFoundException('数据源 #404 不存在'),
    );
    const { service, prisma } = makeService(makePrisma(), ds);
    await expect(
      withUser(WS_ADMIN, () => service.upsert(TABLE_INFO)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('writes a field semantic directly with defaults + enum passthrough', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findFirst.mockResolvedValue(null);
    prisma.fieldSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 61,
        ...data,
        version: 1,
      }),
    );
    const result = await withUser(WS_ADMIN, () =>
      service.upsert({
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: 3,
        table_name: 'sales_order',
        field_name: 'order_status',
        meaning: '订单状态',
        enum_values: [{ value: 'paid', label: '已支付' }],
      }),
    );
    expect(result).toEqual({ applied: true, id: 61 });
    expect(prisma.fieldSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        fieldName: 'order_status',
        role: 'other',
        unit: null,
        // {value,label} entries pass through verbatim
        enumValues: [{ value: 'paid', label: '已支付' }],
        enabled: true,
      }),
    });
    expect(prisma.fieldSemanticVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 61,
        version: 1,
        snapshot: expect.objectContaining({ source: 'create' }),
      }),
    });
  });

  it('field update increments the version and preserves a stored disabled flag', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findFirst.mockResolvedValue({
      id: 62,
      version: 4,
      enabled: false,
    });
    prisma.fieldSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 62,
        ...data,
        version: 5,
      }),
    );
    const result = await withUser(WS_ADMIN, () =>
      service.upsert({
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: 3,
        table_name: 'sales_order',
        field_name: 'order_status',
        meaning: '新含义',
        unit: '元',
      }),
    );
    expect(result).toEqual({ applied: true, id: 62 });
    expect(prisma.fieldSemantic.update).toHaveBeenCalledWith({
      where: { id: 62 },
      data: expect.objectContaining({
        meaning: '新含义',
        unit: '元',
        enabled: false,
        version: { increment: 1 },
      }),
    });
  });

  it('table update preserves the stored enabled flag when the edit omits it', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue({
      id: 12,
      version: 2,
      enabled: false,
    });
    prisma.tableSemantic.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 12,
        ...data,
        version: 3,
      }),
    );
    await withUser(WS_ADMIN, () =>
      service.upsert({ ...TABLE_INFO, meaning: '新含义' }),
    );
    expect(prisma.tableSemantic.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({ enabled: false }),
    });
  });

  it('table create honors an explicit enabled:false', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 15,
        ...data,
        version: 1,
      }),
    );
    await withUser(WS_ADMIN, () =>
      service.upsert({ ...TABLE_INFO, enabled: false }),
    );
    expect(prisma.tableSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ enabled: false }),
    });
  });

  it('conflict surfaces as 409 when the create race loses twice', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      withUser(WS_ADMIN, () => service.upsert(TABLE_INFO)),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('blocks a member proposal while an identical request is pending', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findFirst.mockResolvedValue({
      payload: { datasource_id: 3, table_name: 'sales_order' },
    });
    await expect(
      withUser(MEMBER, () => service.upsert(TABLE_INFO)),
    ).rejects.toThrow('已存在待审批');
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();

    // a pending request for ANOTHER natural key does not block
    prisma.semanticChangeRequest.findFirst.mockResolvedValue({
      payload: { datasource_id: 3, table_name: 'other_table' },
    });
    const result = await withUser(MEMBER, () => service.upsert(TABLE_INFO));
    expect(result).toEqual({ applied: false, request_id: expect.any(Number) });
  });

  it('member field proposal carries the full field payload', async () => {
    const { service, prisma } = makeService();
    const result = await withUser(MEMBER, () =>
      service.upsert({
        entity_type: 'field',
        scope: 'WORKSPACE',
        datasource_id: 3,
        table_name: 'sales_order',
        field_name: 'order_status',
        role: 'dimension',
        meaning: '订单状态',
        unit: '元',
        enum_values: [{ value: 'paid', label: '已支付' }],
        enabled: false,
      }),
    );
    expect(result.applied).toBe(false);
    const data = prisma.semanticChangeRequest.create.mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(data.entityType).toBe('field');
    expect(data.payload).toEqual({
      datasource_id: 3,
      table_name: 'sales_order',
      meaning: '订单状态',
      enabled: false,
      field_name: 'order_status',
      role: 'dimension',
      unit: '元',
      enum_values: [{ value: 'paid', label: '已支付' }],
    });
  });
});

describe('SemanticService.remove edge routing', () => {
  it('404s when no visible row matches (missing/foreign/non-integer/empty ids)', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue([]);
    await expect(
      withUser(WS_ADMIN, () => service.remove('table', [5])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withUser(WS_ADMIN, () => service.remove('table', [1.5])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      withUser(WS_ADMIN, () => service.remove('table', [])),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();
  });

  it('deletes a field semantic directly for the workspace admin', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        id: 71,
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        datasourceId: 3,
        tableName: 'sales_order',
        fieldName: 'order_status',
      },
    ]);
    const out = await withUser(WS_ADMIN, () => service.remove('field', [71]));
    expect(out).toEqual({ removed: 1, requested: 0 });
    expect(prisma.fieldSemantic.delete).toHaveBeenCalledWith({
      where: { id: 71 },
    });
  });

  it('member: own PERSONAL row deleted, another user PERSONAL row → request', async () => {
    const { service, prisma } = makeService();
    prisma.tableSemantic.findMany.mockResolvedValue([
      {
        id: 60,
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 7,
        datasourceId: 3,
        tableName: 'mine',
      },
      {
        id: 61,
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 9,
        datasourceId: 3,
        tableName: 'theirs',
      },
    ]);
    const out = await withUser(MEMBER, () => service.remove('table', [60, 61]));
    expect(out).toEqual({ removed: 1, requested: 1 });
    expect(prisma.tableSemantic.delete).toHaveBeenCalledWith({
      where: { id: 60 },
    });
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'remove',
          targetType: 'PERSONAL',
          proposerUid: 7,
        }),
      }),
    );
  });
});

describe('SemanticService.review — semantic-specific branches', () => {
  const pending = {
    id: 100,
    oid: 1,
    status: 'pending',
    action: 'upsert',
    targetType: 'WORKSPACE',
    payload: {
      datasource_id: 3,
      table_name: 'sales_order',
      meaning: '提案含义',
      enabled: true,
    },
  };

  it('rejects a malformed PERSONAL-target request (never coerced)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      targetType: 'PERSONAL',
    });
    await expect(
      withUser(SYS_ADMIN, () => service.review(100, true)),
    ).rejects.toThrow('未知的语义层级');
    expect(prisma.semanticChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('409s when the approval apply keeps hitting the natural-key race', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      targetType: 'GLOBAL',
    });
    prisma.tableSemantic.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      withUser(SYS_ADMIN, () => service.review(100, true)),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('approves a GLOBAL-target proposal as the system admin (oid null)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      targetType: 'GLOBAL',
      oid: null,
    });
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    prisma.tableSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 51,
        ...data,
        version: 1,
      }),
    );
    await withUser(SYS_ADMIN, () => service.review(100, true));
    expect(prisma.tableSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'GLOBAL',
        oid: null,
        ownerUid: null,
        datasourceId: 3,
        tableName: 'sales_order',
      }),
    });
  });

  it('a ws admin cannot review a GLOBAL-target request', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      targetType: 'GLOBAL',
    });
    await expect(
      withUser(WS_ADMIN, () => service.review(100, true)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload without applying anything', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      payload: null,
    });
    await expect(
      withUser(WS_ADMIN, () => service.review(100, true)),
    ).rejects.toThrow('载荷格式非法');
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
  });

  it('approves a FIELD remove request (deletes at the target layer)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      action: 'remove',
      payload: {
        datasource_id: 3,
        table_name: 'sales_order',
        field_name: 'order_status',
        meaning: '',
      },
    });
    prisma.fieldSemantic.findFirst.mockResolvedValue({ id: 72 });
    await withUser(WS_ADMIN, () => service.review(100, true));
    expect(prisma.fieldSemantic.delete).toHaveBeenCalledWith({
      where: { id: 72 },
    });
  });

  it('approve of a remove with no matching row still closes approved', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      action: 'remove',
    });
    prisma.tableSemantic.findFirst.mockResolvedValue(null);
    await withUser(WS_ADMIN, () => service.review(100, true));
    expect(prisma.tableSemantic.delete).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'approved' }),
      }),
    );
  });

  it('approves a field upsert payload (role/unit/enums re-hydrated)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue({
      ...pending,
      payload: {
        datasource_id: 3,
        table_name: 'sales_order',
        field_name: 'order_status',
        role: 'dimension',
        meaning: '订单状态',
        unit: '元',
        enum_values: [{ value: 'paid', label: '已支付' }],
        enabled: true,
      },
    });
    prisma.fieldSemantic.findFirst.mockResolvedValue(null);
    prisma.fieldSemantic.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 73,
        ...data,
        version: 1,
      }),
    );
    await withUser(WS_ADMIN, () => service.review(100, true));
    expect(prisma.fieldSemantic.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fieldName: 'order_status',
        role: 'dimension',
        unit: '元',
        enumValues: [{ value: 'paid', label: '已支付' }],
        enabled: true,
      }),
    });
  });
});

describe('SemanticService.effectiveAnnotations — degradation + enum caps', () => {
  it('returns empty annotations for a blank table list', async () => {
    const { service, prisma } = makeService();
    const out = await withUser(MEMBER, () =>
      service.effectiveAnnotations(3, ['', '   ']),
    );
    expect(out).toEqual({ tableMeanings: {}, fieldNotes: {} });
    expect(prisma.tableSemantic.findMany).not.toHaveBeenCalled();
  });

  it('caps cached enums at 20 entries and omits the block when empty', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        tableName: 'a',
        fieldName: 'many',
        scope: 'WORKSPACE',
        oid: 1,
        role: 'dimension',
        meaning: '多值',
        unit: null,
        enumValues: Array.from({ length: 25 }, (_, i) => ({
          value: `v${i}`,
        })),
      },
      {
        tableName: 'a',
        fieldName: 'none',
        scope: 'WORKSPACE',
        oid: 1,
        role: 'dimension',
        meaning: '无枚举',
        unit: null,
        enumValues: null,
      },
    ]);
    const out = await withUser(MEMBER, () =>
      service.effectiveAnnotations(3, ['a']),
    );
    expect(out.fieldNotes['a.many'].enums).toHaveLength(20);
    expect(out.fieldNotes['a.many'].enums?.[0]).toEqual({ value: 'v0' });
    expect(out.fieldNotes['a.none'].enums).toBeUndefined();
    expect(out.fieldNotes['a.none'].meaning).toBe('无枚举');
  });

  it('keeps a unit string on the field note', async () => {
    const { service, prisma } = makeService();
    prisma.fieldSemantic.findMany.mockResolvedValue([
      {
        tableName: 'a',
        fieldName: 'amount',
        scope: 'WORKSPACE',
        oid: 1,
        role: 'metric',
        meaning: '金额',
        unit: '元',
        enumValues: null,
      },
    ]);
    const out = await withUser(MEMBER, () =>
      service.effectiveAnnotations(3, ['a']),
    );
    expect(out.fieldNotes['a.amount']).toMatchObject({
      role: 'metric',
      unit: '元',
    });
  });
});

describe('SemanticService.collectEnums — concurrency + degraded probes', () => {
  const dimRow = (over: Partial<Record<string, unknown>> = {}) => ({
    id: 77,
    scope: 'WORKSPACE',
    oid: 1,
    ownerUid: null,
    datasourceId: 3,
    tableName: 'sales_order',
    fieldName: 'order_status',
    role: 'dimension',
    meaning: '订单状态',
    unit: null,
    enumValues: null,
    enabled: true,
    version: 4,
    ...over,
  });

  it('collapses a concurrent second run (busy guard)', async () => {
    let release!: (rows: unknown[]) => void;
    const gate = new Promise<unknown[]>((r) => {
      release = r;
    });
    const sampleDistinct = jest.fn().mockReturnValue(gate);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([dimRow()]);
    prisma.fieldSemantic.update.mockResolvedValue(dimRow());

    const first = withUser(WS_ADMIN, () => service.collectEnums(3));
    // let the first run reach the in-flight probe
    await new Promise((r) => setImmediate(r));
    expect(sampleDistinct).toHaveBeenCalled();
    await expect(
      withUser(WS_ADMIN, () => service.collectEnums(3)),
    ).rejects.toBeInstanceOf(BadRequestException);
    release(['paid']);
    const summary = (await first) as EnumCollectSummary;
    expect(summary.collected).toHaveLength(1);
  });

  it('skips a field whose probe fails (reason carried, batch continues)', async () => {
    const sampleDistinct = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(['paid']);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([
      dimRow({ id: 81 }),
      dimRow({ id: 82 }),
    ]);
    prisma.fieldSemantic.update.mockResolvedValue(dimRow());

    const summary = (await withUser(WS_ADMIN, () =>
      service.collectEnums(3),
    )) as EnumCollectSummary;
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]).toMatchObject({ id: 81 });
    expect(summary.skipped[0].reason).toContain('boom');
    expect(summary.collected).toEqual([
      expect.objectContaining({ id: 82, values: 1 }),
    ]);
  });

  it('stringifies numeric/boolean/bigint/Date samples; drops objects/blank text', async () => {
    const sampleDistinct = jest
      .fn()
      .mockResolvedValue([
        1,
        true,
        10n,
        new Date(Date.UTC(2024, 0, 2, 3, 4, 5)),
        { x: 1 },
        ['arr'],
        '',
        '   ',
        null,
        undefined,
        'b',
      ]);
    const { service, prisma } = makeService(
      makePrisma(),
      makeDatasourceService(sampleDistinct),
    );
    prisma.fieldSemantic.findMany.mockResolvedValue([dimRow()]);
    prisma.fieldSemantic.update.mockResolvedValue(dimRow());

    await withUser(WS_ADMIN, () => service.collectEnums(3));

    expect(prisma.fieldSemantic.update).toHaveBeenCalledWith({
      where: { id: 77 },
      data: {
        enumValues: [
          { value: '1' },
          { value: '10' },
          { value: '2024-01-02T03:04:05.000Z' },
          { value: 'b' },
          { value: 'true' },
        ],
        version: { increment: 1 },
      },
    });
  });
});
