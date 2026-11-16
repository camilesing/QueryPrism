// DataStandardService unit tests (MetaDataImprove M4): the shared
// GovernedDictService governance flow driven through the data-standard
// dictionary — scope authority routing (direct edit vs change request), the
// single-writer review claim (approve / reject / lost race), natural-key
// P2002 retry-then-409, version history, enable/disable, admin page filters
// and the runtime naming-template block. Prisma is mocked with the dual-form
// $transaction; the actor comes from the real RequestContext ALS
// (metric.service.spec pattern). The pure matching rules live in
// metric-policy.spec.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { DataStandard } from '@prisma/client';
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  DataStandardService,
  type StandardUpsertInfo,
} from './standard.service';

setI18n(createTestI18n());

function withUser<T>(
  user: { id: number; oid: number; weight?: number; account?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: user.account ?? 'tester',
        oid: user.oid,
        // English so tr() assertions match src/i18n/en/standard.json verbatim.
        language: 'en',
        weight: user.weight ?? 0,
      },
    },
    fn,
  );
}

const MEMBER = { id: 7, oid: 1, weight: 0, account: 'member' };
const WS_ADMIN = { id: 5, oid: 1, weight: 1, account: 'wsadmin' };
const SYS_ADMIN = { id: 1, oid: 1, weight: 0, account: 'root' };
const FOREIGN_WS_ADMIN = { id: 6, oid: 2, weight: 1, account: 'foreign' };

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

interface StandardPrismaMock {
  dataStandard: EntityMockSet;
  dataStandardVersion: { create: jest.Mock; findMany: jest.Mock };
  semanticChangeRequest: {
    create: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    findMany: jest.Mock;
  };
  $transaction: jest.Mock;
}

function makePrisma(): StandardPrismaMock {
  const entity = (): EntityMockSet => ({
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn().mockResolvedValue([]),
  });
  const prisma: StandardPrismaMock = {
    dataStandard: entity(),
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
    // Dual form: interactive callbacks get the SAME mock object as tx; the
    // array form (audit page) resolves in parallel.
    $transaction: jest
      .fn()
      .mockImplementation(
        async (
          arg: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>,
        ) => (typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
      ),
  };
  return prisma;
}

function makeService(prisma: StandardPrismaMock = makePrisma()) {
  const regressionTrigger = { onApproval: jest.fn() };
  const standard = new DataStandardService(
    prisma as never,
    regressionTrigger as never,
  );
  return { standard, prisma, regressionTrigger };
}

const NAMING_INFO: StandardUpsertInfo = {
  kind: 'naming',
  scope: 'WORKSPACE',
  code: 'annual_revenue',
  term: '年营收',
  name: '年度总营业额',
  category: 'business_noun',
};

function stdRow(over: Partial<DataStandard> = {}): DataStandard {
  return {
    id: 21,
    scope: 'WORKSPACE',
    oid: 1,
    ownerUid: null,
    kind: 'naming',
    code: 'annual_revenue',
    term: '年营收',
    name: '年度总营业额',
    aliases: null,
    category: 'business_noun',
    description: null,
    enabled: true,
    version: 1,
    createBy: 5,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...over,
  };
}

const VISIBLE_FILTER = {
  OR: [
    { scope: 'GLOBAL' },
    { scope: 'WORKSPACE', oid: 1 },
    { scope: 'PERSONAL', oid: 1, ownerUid: 5 },
  ],
};

describe('DataStandardService.upsert authority routing', () => {
  it('ws admin applies directly: create + version snapshot in one tx', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 21,
        version: 1,
        ...data,
      }),
    );
    const result = (await withUser(WS_ADMIN, () =>
      standard.upsert(NAMING_INFO),
    )) as { applied: boolean; id: number };
    expect(result).toEqual({ applied: true, id: 21 });
    expect(prisma.dataStandard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'WORKSPACE',
        oid: 1,
        ownerUid: null,
        kind: 'naming',
        code: 'annual_revenue',
        enabled: true, // default when neither info nor an existing row set it
        createBy: 5,
      }),
    });
    expect(prisma.dataStandardVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 21,
        version: 1,
        snapshot: expect.objectContaining({ source: 'create' }),
        changedBy: 5,
      }),
    });
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();
  });

  it('edits an existing row, preserving its disabled flag when `enabled` is omitted', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findFirst.mockResolvedValue(
      stdRow({ id: 3, enabled: false, version: 1 }),
    );
    prisma.dataStandard.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        ...stdRow({ id: 3, enabled: false }),
        ...data,
        version: 2,
      }),
    );
    const result = (await withUser(WS_ADMIN, () =>
      standard.upsert({ ...NAMING_INFO, note: 'reworded' }),
    )) as { applied: boolean; id: number };
    expect(result).toEqual({ applied: true, id: 3 });
    expect(prisma.dataStandard.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: expect.objectContaining({
        enabled: false, // NOT re-enabled by an edit that omits the flag
        version: { increment: 1 },
      }),
    });
    expect(prisma.dataStandardVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 3,
        version: 2,
        snapshot: expect.objectContaining({ source: 'edit' }),
        note: 'reworded',
      }),
    });
  });

  it('retries the whole transaction once when the create race loses (P2002)', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create
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
    const result = (await withUser(WS_ADMIN, () =>
      standard.upsert(NAMING_INFO),
    )) as { applied: boolean; id: number };
    expect(result).toEqual({ applied: true, id: 41 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.dataStandard.create).toHaveBeenCalledTimes(2);
  });

  it('gives up with 409 write_conflict when the retry loses too', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.upsert(NAMING_INFO)),
    ).rejects.toThrow(ConflictException);
    await expect(
      withUser(WS_ADMIN, () => standard.upsert(NAMING_INFO)),
    ).rejects.toThrow('This entry was changed concurrently — please retry');
    expect(prisma.dataStandard.create).toHaveBeenCalledTimes(4); // 2 runs × 2 attempts
  });

  it('member → WORKSPACE becomes a pending request (no direct write)', async () => {
    const { standard, prisma } = makeService();
    const result = (await withUser(MEMBER, () =>
      standard.upsert({
        ...NAMING_INFO,
        aliases: [' 营收 ', '', '营业收入'], // carried on the proposal payload
        description: ' 年度总营业额（含税） ',
      }),
    )) as { applied: boolean; request_id: number };
    expect(result).toEqual({ applied: false, request_id: 999 });
    expect(prisma.dataStandard.create).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        oid: 1,
        entityType: 'standard',
        action: 'upsert',
        targetType: 'WORKSPACE',
        proposerUid: 7,
        proposer: 'member',
        payload: expect.objectContaining({
          kind: 'naming',
          code: 'annual_revenue',
          term: '年营收',
          category: 'business_noun',
          aliases: ['营收', '营业收入'],
          description: '年度总营业额（含税）',
        }),
      }),
    });
  });

  it('member → own PERSONAL layer writes directly (ownerUid forced)', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 31,
        version: 1,
        ...data,
      }),
    );
    const result = (await withUser(MEMBER, () =>
      standard.upsert({
        ...NAMING_INFO,
        scope: 'PERSONAL',
        enabled: true,
        aliases: [' 营收 ', '', '营业收入'], // trimmed + empties dropped
      }),
    )) as { applied: boolean; id: number };
    expect(result).toEqual({ applied: true, id: 31 });
    expect(prisma.dataStandard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'PERSONAL',
        oid: 1,
        ownerUid: 7, // personal rows are always the actor's own
        createBy: 7,
        enabled: true,
        aliases: ['营收', '营业收入'],
      }),
    });
  });

  it('rejects a duplicate pending proposal on the same natural key only', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findFirst.mockResolvedValue({
      payload: { kind: 'naming', code: 'annual_revenue' },
    });
    await expect(
      withUser(MEMBER, () => standard.upsert(NAMING_INFO)),
    ).rejects.toThrow('A pending change request already exists for this entry');
    // A different natural key under the same actor is a fresh proposal.
    const result = (await withUser(MEMBER, () =>
      standard.upsert({ ...NAMING_INFO, code: 'refund_rate' }),
    )) as { applied: boolean; request_id: number };
    expect(result).toEqual({ applied: false, request_id: 999 });
  });

  it('rejects unknown scopes and malformed entries before any write', async () => {
    const { standard, prisma } = makeService();
    await expect(
      withUser(WS_ADMIN, () =>
        standard.upsert({ ...NAMING_INFO, scope: 'FOO' as never }),
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      withUser(WS_ADMIN, () =>
        standard.upsert({ ...NAMING_INFO, kind: 'bogus' as never }),
      ),
    ).rejects.toThrow('Unknown data-standard kind');
    await expect(
      withUser(WS_ADMIN, () => standard.upsert({ ...NAMING_INFO, code: ' ' })),
    ).rejects.toThrow('Code, term and standard name are required');
    await expect(
      withUser(WS_ADMIN, () => standard.upsert({ ...NAMING_INFO, term: '' })),
    ).rejects.toThrow('Code, term and standard name are required');
    await expect(
      withUser(WS_ADMIN, () => standard.upsert({ ...NAMING_INFO, name: '' })),
    ).rejects.toThrow('Code, term and standard name are required');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a category foreign to the kind (unit vs naming)', async () => {
    const { standard } = makeService();
    await expect(
      withUser(WS_ADMIN, () =>
        standard.upsert({
          kind: 'unit',
          scope: 'WORKSPACE',
          code: 'jian',
          term: '件',
          name: '件',
          category: 'business_noun', // a naming-only category
        }),
      ),
    ).rejects.toThrow('Unknown standard category');
    await expect(
      withUser(WS_ADMIN, () =>
        standard.upsert({
          kind: 'naming',
          scope: 'WORKSPACE',
          code: 'jine',
          term: '金额',
          name: '金额',
          category: 'currency', // a unit-only category
        }),
      ),
    ).rejects.toThrow('Unknown standard category');
  });
});

describe('DataStandardService.remove', () => {
  it('direct rows vanish, upper-layer rows become remove requests', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([
      stdRow({ id: 1, scope: 'WORKSPACE', oid: 1 }),
      stdRow({ id: 2, scope: 'GLOBAL', oid: null }),
    ]);
    const result = await withUser<{ removed: number; requested: number }>(
      WS_ADMIN,
      () => standard.remove([1, 2]),
    );
    expect(result).toEqual({ removed: 1, requested: 1 });
    expect(prisma.dataStandard.delete).toHaveBeenCalledWith({
      where: { id: 1 },
    });
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: 'standard',
        action: 'remove',
        targetType: 'GLOBAL',
        proposerUid: 5,
        payload: expect.objectContaining({
          kind: 'naming',
          code: 'annual_revenue',
        }),
      }),
    });
  });

  it('a member removes their own PERSONAL row directly', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([
      stdRow({ id: 9, scope: 'PERSONAL', oid: 1, ownerUid: 7 }),
    ]);
    const result = await withUser<{ removed: number; requested: number }>(
      MEMBER,
      () => standard.remove([9]),
    );
    expect(result).toEqual({ removed: 1, requested: 0 });
    expect(prisma.dataStandard.delete).toHaveBeenCalledWith({
      where: { id: 9 },
    });
  });

  it('a member removing a visible WORKSPACE row proposes instead', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([stdRow({ id: 4 })]);
    const result = await withUser<{ removed: number; requested: number }>(
      MEMBER,
      () => standard.remove([4]),
    );
    expect(result).toEqual({ removed: 0, requested: 1 });
    expect(prisma.dataStandard.delete).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'remove',
        targetType: 'WORKSPACE',
        proposerUid: 7,
      }),
    });
  });

  it('rejects the whole batch when any id is invisible (tenant probing)', async () => {
    const { standard, prisma } = makeService();
    // two ids requested, only the actor-visible one returned
    prisma.dataStandard.findMany.mockResolvedValue([
      stdRow({ id: 1, scope: 'WORKSPACE', oid: 1 }),
    ]);
    await expect(
      withUser(FOREIGN_WS_ADMIN, () => standard.remove([1, 2])),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.dataStandard.delete).not.toHaveBeenCalled();
    expect(prisma.semanticChangeRequest.create).not.toHaveBeenCalled();
  });

  it('rejects empty or non-integer id lists before any read', async () => {
    const { standard, prisma } = makeService();
    await expect(withUser(WS_ADMIN, () => standard.remove([]))).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      withUser(WS_ADMIN, () => standard.remove([1.5, Number.NaN])),
    ).rejects.toThrow('Data-standard entry not found');
    expect(prisma.dataStandard.findMany).not.toHaveBeenCalled();
  });

  it('dedupes repeated ids (one row, one write)', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([stdRow({ id: 1 })]);
    const result = await withUser<{ removed: number; requested: number }>(
      WS_ADMIN,
      () => standard.remove([1, 1]),
    );
    expect(result).toEqual({ removed: 1, requested: 0 });
    expect(prisma.dataStandard.delete).toHaveBeenCalledTimes(1);
  });
});

describe('DataStandardService.setEnabled', () => {
  it('toggles a workspace row with a toggle version snapshot', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(stdRow({ id: 21 }));
    prisma.dataStandard.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        ...stdRow({ id: 21 }),
        ...data,
        version: 2,
      }),
    );
    await withUser(WS_ADMIN, () => standard.setEnabled(21, false));
    expect(prisma.dataStandard.update).toHaveBeenCalledWith({
      where: { id: 21 },
      data: { enabled: false, version: { increment: 1 } },
    });
    expect(prisma.dataStandardVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 21,
        version: 2,
        snapshot: expect.objectContaining({ source: 'toggle', enabled: false }),
        changedBy: 5,
      }),
    });
  });

  it('forbids a member from toggling a workspace row', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(stdRow({ id: 21 }));
    await expect(
      withUser(MEMBER, () => standard.setEnabled(21, true)),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.dataStandard.update).not.toHaveBeenCalled();
  });

  it('forbids touching another user’s PERSONAL row', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(
      stdRow({ id: 22, scope: 'PERSONAL', oid: 1, ownerUid: 99 }),
    );
    await expect(
      withUser(MEMBER, () => standard.setEnabled(22, true)),
    ).rejects.toThrow('You may not edit this scope layer directly');
    expect(prisma.dataStandard.update).not.toHaveBeenCalled();
  });

  it('toggles the actor’s own PERSONAL row', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(
      stdRow({ id: 23, scope: 'PERSONAL', oid: 1, ownerUid: 7 }),
    );
    prisma.dataStandard.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        ...stdRow({ id: 23, scope: 'PERSONAL', oid: 1, ownerUid: 7 }),
        ...data,
        version: 2,
      }),
    );
    await withUser(MEMBER, () => standard.setEnabled(23, true));
    expect(prisma.dataStandard.update).toHaveBeenCalledWith({
      where: { id: 23 },
      data: { enabled: true, version: { increment: 1 } },
    });
  });

  it('404s an unknown id', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(null);
    await expect(
      withUser(WS_ADMIN, () => standard.setEnabled(404, true)),
    ).rejects.toThrow('Data-standard entry not found');
    expect(prisma.dataStandard.update).not.toHaveBeenCalled();
  });
});

describe('DataStandardService.page', () => {
  it('lists one kind within the actor-visible layers, code-ordered', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([]);
    const result = (await withUser(WS_ADMIN, () =>
      standard.page('unit', 1, 10),
    )) as { current_page: number; total_pages: number; data: unknown[] };
    expect(result).toMatchObject({ current_page: 1, total_pages: 0, data: [] });
    expect(prisma.dataStandard.findMany).toHaveBeenCalledWith({
      where: { kind: 'unit', AND: [VISIBLE_FILTER] },
      orderBy: [{ code: 'asc' }],
    });
  });

  it('narrows by keyword (within visible layers) + scope/category filters', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([]);
    await withUser(WS_ADMIN, () =>
      standard.page('naming', 1, 10, {
        keyword: '  年营收  ',
        scope: 'WORKSPACE',
        category: 'business_noun',
      }),
    );
    expect(prisma.dataStandard.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'naming',
        scope: 'WORKSPACE',
        category: 'business_noun',
        AND: [
          VISIBLE_FILTER,
          {
            OR: [
              { code: { contains: '年营收', mode: 'insensitive' } },
              { term: { contains: '年营收', mode: 'insensitive' } },
              { name: { contains: '年营收', mode: 'insensitive' } },
            ],
          },
        ],
      },
      orderBy: [{ code: 'asc' }],
    });
  });

  it('paginates server-side: min page size 10, clamped current page', async () => {
    const { standard, prisma } = makeService();
    const rows = Array.from({ length: 25 }, (_, i) =>
      stdRow({ id: i + 1, code: `c${String(i).padStart(2, '0')}` }),
    );
    prisma.dataStandard.findMany.mockResolvedValue(rows);
    const result = (await withUser(WS_ADMIN, () =>
      standard.page('naming', 2, 5),
    )) as {
      current_page: number;
      page_size: number;
      total_count: number;
      total_pages: number;
      data: Array<{ id: number; term: string; create_time: string }>;
    };
    expect(result).toMatchObject({
      current_page: 2,
      page_size: 10, // clamped up from 5
      total_count: 25,
      total_pages: 3,
    });
    expect(result.data).toHaveLength(10);
    expect(result.data[0].id).toBe(11);
    expect(result.data[0].term).toBe('年营收');
    expect(result.data[0].create_time).toBe('2026-01-01T00:00:00.000Z');
    // page 99 clamps to the last page
    const last = (await withUser(WS_ADMIN, () =>
      standard.page('naming', 99, 10),
    )) as { current_page: number; data: unknown[] };
    expect(last.current_page).toBe(3);
    expect(last.data).toHaveLength(5);
  });
});

describe('DataStandardService.versions', () => {
  it('returns the history of a visible row, newest first', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(stdRow({ id: 21 }));
    prisma.dataStandardVersion.findMany.mockResolvedValue([
      {
        id: 2,
        version: 2,
        snapshot: { source: 'edit' },
        changedBy: 5,
        note: 'ok',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
      {
        id: 1,
        version: 1,
        snapshot: { source: 'create' },
        changedBy: 7,
        note: null,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const rows = (await withUser(MEMBER, () => standard.versions(21))) as Array<
      Record<string, unknown>
    >;
    expect(prisma.dataStandardVersion.findMany).toHaveBeenCalledWith({
      where: { entityId: 21 },
      orderBy: { version: 'desc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      version: 2,
      changed_by: 5,
      note: 'ok',
      create_time: '2026-02-01T00:00:00.000Z',
    });
  });

  it('404s a foreign workspace row (ids are global — no leak)', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findUnique.mockResolvedValue(
      stdRow({ id: 22, scope: 'WORKSPACE', oid: 99 }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.versions(22)),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.dataStandardVersion.findMany).not.toHaveBeenCalled();
  });
});

describe('DataStandardService.pageRequests (shared inbox)', () => {
  const requestRow = (over: Record<string, unknown> = {}) => ({
    id: 55,
    entityType: 'standard',
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

  it("'mine' lists the actor's own proposals", async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findMany.mockResolvedValue([requestRow()]);
    // page 0 normalizes to 1
    const zero = (await withUser(MEMBER, () =>
      standard.pageRequests('mine', 0, 10),
    )) as { current_page: number };
    expect(zero.current_page).toBe(1);
    const result = (await withUser(MEMBER, () =>
      standard.pageRequests('mine', 1, 10),
    )) as { data: Array<Record<string, unknown>> };
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: { in: ['standard'] },
          proposerUid: 7,
        }),
      }),
    );
    expect(result.data[0]).toMatchObject({
      entity_type: 'standard',
      proposer_uid: 7,
      target_type: 'WORKSPACE',
    });
  });

  it("'pending' for a ws admin is scoped to their workspace's WORKSPACE targets", async () => {
    const { standard, prisma } = makeService();
    await withUser(WS_ADMIN, () => standard.pageRequests('pending', 1, 10));
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

  it("'pending' for the system admin sees everything pending", async () => {
    const { standard, prisma } = makeService();
    await withUser(SYS_ADMIN, () => standard.pageRequests('pending', 1, 10));
    const where = prisma.semanticChangeRequest.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('pending');
    expect(where).not.toHaveProperty('targetType');
    expect(where).not.toHaveProperty('oid');
  });

  it('accepts a shared entityTypes filter and clamps paging', async () => {
    const { standard, prisma } = makeService();
    const rows = Array.from({ length: 12 }, (_, i) =>
      requestRow({ id: i + 1 }),
    );
    prisma.semanticChangeRequest.findMany.mockResolvedValue(rows);
    const result = (await withUser(WS_ADMIN, () =>
      standard.pageRequests('pending', 99, 10, ['metric', 'standard']),
    )) as { current_page: number; data: unknown[] };
    expect(prisma.semanticChangeRequest.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: { in: ['metric', 'standard'] },
        }),
      }),
    );
    expect(result.current_page).toBe(2); // 12 rows / 10 per page
    expect(result.data).toHaveLength(2);
  });
});

describe('DataStandardService.review', () => {
  const pendingUpsert = (over: Record<string, unknown> = {}) => ({
    id: 55,
    status: 'pending',
    action: 'upsert',
    targetType: 'WORKSPACE',
    oid: 1,
    payload: {
      kind: 'naming',
      code: 'annual_revenue',
      term: '年营收',
      name: '年度总营业额',
      aliases: ['营收'],
      enabled: true,
    },
    ...over,
  });

  it('approves: claims, applies at the target layer, fires the regression trigger', async () => {
    const { standard, prisma, regressionTrigger } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingUpsert());
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 21,
        version: 1,
        ...data,
      }),
    );
    await withUser(WS_ADMIN, () => standard.review(55, true, 'ok'));
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 55, status: 'pending' },
      data: expect.objectContaining({
        status: 'approved',
        reviewerUid: 5,
        reviewNote: 'ok',
        reviewedAt: expect.any(Date),
      }),
    });
    expect(prisma.dataStandard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'WORKSPACE',
        oid: 1, // the proposer's workspace, not the reviewer's
        ownerUid: null,
        kind: 'naming',
        code: 'annual_revenue',
        aliases: ['营收'], // survives the payload round-trip
        createBy: 5,
        enabled: true,
      }),
    });
    expect(prisma.dataStandardVersion.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: 21,
        version: 1,
        note: 'ok', // the review note rides along as the version note
      }),
    });
    expect(regressionTrigger.onApproval).toHaveBeenCalledWith(1, 'standard', {
      request_id: 55,
      action: 'upsert',
    });
  });

  it('rejects: claims as rejected, applies nothing, no regression trigger', async () => {
    const { standard, prisma, regressionTrigger } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingUpsert());
    await withUser(WS_ADMIN, () => standard.review(55, false, 'no'));
    expect(prisma.semanticChangeRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 55, status: 'pending' },
      data: expect.objectContaining({ status: 'rejected', reviewNote: 'no' }),
    });
    expect(prisma.dataStandard.create).not.toHaveBeenCalled();
    expect(prisma.dataStandard.update).not.toHaveBeenCalled();
    expect(regressionTrigger.onApproval).not.toHaveBeenCalled();
  });

  it('a concurrent review that already claimed applies nothing (400, no writes)', async () => {
    const { standard, prisma, regressionTrigger } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingUpsert());
    prisma.semanticChangeRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow('The change request is not pending review');
    expect(prisma.dataStandard.create).not.toHaveBeenCalled();
    expect(prisma.dataStandardVersion.create).not.toHaveBeenCalled();
    expect(regressionTrigger.onApproval).not.toHaveBeenCalled();
  });

  it('rejects an unknown or non-pending request before claiming', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(null);
    await expect(
      withUser(WS_ADMIN, () => standard.review(404, true)),
    ).rejects.toThrow('The change request is not pending review');
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ status: 'approved' }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.semanticChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a malformed PERSONAL target instead of coercing it', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ targetType: 'PERSONAL' }),
    );
    await expect(
      withUser(SYS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow('Unknown data-standard scope layer');
    expect(prisma.semanticChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('review authority: member, foreign ws admin and non-system GLOBAL reviewer are forbidden', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingUpsert());
    await expect(
      withUser(MEMBER, () => standard.review(55, true)),
    ).rejects.toThrow('You may not review changes to this scope layer');
    // ws admin of ANOTHER workspace cannot review oid-1 requests
    await expect(
      withUser(FOREIGN_WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow(ForbiddenException);
    // GLOBAL target is system-admin only
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ targetType: 'GLOBAL', oid: null }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.semanticChangeRequest.updateMany).not.toHaveBeenCalled();
  });

  it('system admin approves a GLOBAL request with no oid, trigger falls back to the actor', async () => {
    const { standard, prisma, regressionTrigger } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ targetType: 'GLOBAL', oid: null }),
    );
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 61,
        version: 1,
        ...data,
      }),
    );
    await withUser(SYS_ADMIN, () => standard.review(55, true));
    expect(prisma.dataStandard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        scope: 'GLOBAL',
        oid: null,
        ownerUid: null,
      }),
    });
    expect(regressionTrigger.onApproval).toHaveBeenCalledWith(1, 'standard', {
      request_id: 55,
      action: 'upsert',
    });
  });

  it('approving a remove request deletes at the target layer (idempotent)', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({
        action: 'remove',
        targetType: 'GLOBAL',
        payload: {
          kind: 'naming',
          code: 'annual_revenue',
          term: '年营收',
          name: '年度总营业额',
        },
      }),
    );
    prisma.dataStandard.findFirst.mockResolvedValue(stdRow({ id: 9 }));
    await withUser(SYS_ADMIN, () => standard.review(55, true));
    expect(prisma.dataStandard.delete).toHaveBeenCalledWith({
      where: { id: 9 },
    });
    // re-approving the same key after the row is gone deletes nothing
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({
        id: 56,
        action: 'remove',
        targetType: 'GLOBAL',
        payload: { kind: 'naming', code: 'gone', term: 't', name: 'n' },
      }),
    );
    await withUser(SYS_ADMIN, () => standard.review(56, true));
    expect(prisma.dataStandard.delete).toHaveBeenCalledTimes(1);
  });

  it('parses a junk-typed payload defensively (non-strings → defaults)', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({
        payload: {
          kind: 'unit',
          code: 'jian2',
          term: 42, // non-string → ''
          name: false, // non-string → ''
          aliases: 'nope', // not an array → dropped
          category: 7, // non-string → undefined
          description: 9, // non-string → undefined
          enabled: 'yes', // non-boolean → undefined
        },
      }),
    );
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 71,
        version: 1,
        ...data,
      }),
    );
    await withUser(WS_ADMIN, () => standard.review(55, true));
    expect(prisma.dataStandard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'unit',
        code: 'jian2',
        term: '',
        name: '',
        enabled: true, // payload had no usable flag → stored default
      }),
    });
  });

  it('a malformed stored payload rolls back the claim with a 400', async () => {
    const { standard, prisma, regressionTrigger } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ payload: { kind: 'bogus', code: 'x' } }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow('The change request payload is malformed');
    // a null payload is equally malformed
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(
      pendingUpsert({ payload: null }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow('The change request payload is malformed');
    expect(prisma.dataStandard.create).not.toHaveBeenCalled();
    expect(regressionTrigger.onApproval).not.toHaveBeenCalled();
  });

  it('maps a persistent natural-key conflict during approval to 409', async () => {
    const { standard, prisma } = makeService();
    prisma.semanticChangeRequest.findUnique.mockResolvedValue(pendingUpsert());
    prisma.dataStandard.findFirst.mockResolvedValue(null);
    prisma.dataStandard.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      withUser(WS_ADMIN, () => standard.review(55, true)),
    ).rejects.toThrow(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2); // retried once
  });
});

describe('DataStandardService.namingTemplateFor', () => {
  it('returns immediately for a blank question (no prisma read)', async () => {
    const { standard, prisma } = makeService();
    await expect(
      withUser(MEMBER, () => standard.namingTemplateFor('   ', 5)),
    ).resolves.toBe('');
    expect(prisma.dataStandard.findMany).not.toHaveBeenCalled();
  });

  it('renders matched naming rules and stays empty on no match / units', async () => {
    const { standard, prisma } = makeService();
    prisma.dataStandard.findMany.mockResolvedValue([
      stdRow({ kind: 'naming', code: 'annual_revenue', enabled: true }),
      stdRow({ id: 30, kind: 'unit', code: 'jian', term: '件', name: '件' }),
    ]);
    const text = await withUser<string>(MEMBER, () =>
      standard.namingTemplateFor('今年年营收多少', 5),
    );
    expect(text).toContain('<naming_rules>');
    expect(text).toContain('term="年营收"');
    expect(text).toContain('standard="年度总营业额"');
    expect(prisma.dataStandard.findMany).toHaveBeenCalledWith({
      where: {
        kind: 'naming',
        enabled: true,
        // member-visible layers: GLOBAL + own workspace + own personal
        OR: [
          { scope: 'GLOBAL' },
          { scope: 'WORKSPACE', oid: 1 },
          { scope: 'PERSONAL', oid: 1, ownerUid: 7 },
        ],
      },
    });
    // units never render; an unrelated question renders nothing
    expect(
      await withUser(MEMBER, () => standard.namingTemplateFor('按件', 5)),
    ).toBe('');
  });
});

describe('DataStandardService actor', () => {
  it('refuses to run without a request-context user', async () => {
    const { standard } = makeService();
    await expect(standard.page('unit', 1, 10)).rejects.toThrow(
      'No signed-in user in the request context',
    );
  });
});
