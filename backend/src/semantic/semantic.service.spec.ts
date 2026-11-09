// SemanticService unit tests (MetaDataImprove M2): scope authority routing
// (direct edit vs proposal), the approval apply flow, and the
// PERSONAL > WORKSPACE > GLOBAL effective resolution. Prisma is mocked; the
// actor comes from the real RequestContext ALS (assistant.service.spec
// pattern).
import { ForbiddenException } from '@nestjs/common';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { SemanticService } from './semantic.service';

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
  tableSemanticVersion: { create: jest.Mock };
  fieldSemanticVersion: { create: jest.Mock };
  semanticChangeRequest: {
    create: jest.Mock;
    update: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  table: { findMany: jest.Mock };
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
    tableSemanticVersion: { create: jest.fn() },
    fieldSemanticVersion: { create: jest.fn() },
    semanticChangeRequest: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
          id: 999,
          ...data,
        })),
      update: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
    table: { findMany: jest.fn().mockResolvedValue([]) },
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

function makeService(prisma: MockPrisma = makePrisma()) {
  return { service: new SemanticService(prisma as never), prisma };
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
    expect(prisma.semanticChangeRequest.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: expect.objectContaining({ status: 'approved', reviewerUid: 5 }),
    });
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
    expect(prisma.semanticChangeRequest.update).toHaveBeenCalledWith({
      where: { id: 100 },
      data: expect.objectContaining({ status: 'approved' }),
    });
  });

  it('reject only closes the request (no entity write)', async () => {
    const { service, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingRequest);
    await withUser(WS_ADMIN, () => service.review(100, false, '不需要'));
    expect(prisma.tableSemantic.create).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.update).toHaveBeenCalledWith({
      where: { id: 100 },
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
        enumValues: [{ value: 'paid' }, { value: 'refunded' }],
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
      enums: ['paid', 'refunded'],
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
