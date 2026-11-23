// UserService spec — the update() workspace-reconciliation path. Focus: the
// oid reset must never strand a user on workspace 0 (oid_list: [] without a
// replacement oid previously wrote User.oid = 0 → JwtAuthGuard lockout).
import { UserService } from './user.service';
import { NotFoundException } from '@nestjs/common';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { PrismaService } from '../database/prisma.service';
import { ImportErrorFileService } from '../common/import-export/import-error-file.service';
import * as bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import type { CurrentUserInfo } from '../common/context/request-context';

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 3, oid: 1 }),
      update: jest.fn().mockResolvedValue({ id: 3, oid: 2 }),
    },
    workspace: {
      findFirst: jest.fn().mockResolvedValue({ id: 2 }),
      count: jest.fn().mockResolvedValue(1),
    },
    userWs: {
      findMany: jest.fn().mockResolvedValue([{ oid: 1 }]),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: jest.fn(),
  };
  // Interactive transactions run on the same mocked client.
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) =>
    fn(prisma),
  );
  const service = new UserService(
    prisma as unknown as PrismaService,
    { write: jest.fn() } as unknown as ImportErrorFileService,
  );
  return { service, prisma };
}

describe('UserService.update (workspace reconciliation)', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('re-points the current workspace when oid_list drops it', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockImplementation((({
      where,
    }: {
      where: { id?: number };
    }) =>
      where?.id === 3
        ? Promise.resolve({ id: 3, oid: 1 })
        : Promise.resolve({ id: 3, oid: 1 })) as never);

    await service.update(3, { oid_list: [2] });

    const reset = prisma.user.update.mock.calls.find(
      ([args]: [{ where: { id: number }; data: { oid?: number } }]) =>
        args.data?.oid !== undefined,
    );
    expect(reset?.[0].data.oid).toBe(2);
  });

  it('rejects oid_list: [] without a replacement oid instead of writing oid 0', async () => {
    const { service, prisma } = makeService();
    await expect(service.update(3, { oid_list: [] })).rejects.toThrow(
      'A user must belong to at least one workspace',
    );
    const writes = prisma.user.update.mock.calls as Array<{
      data?: { oid?: number };
    }>;
    expect(writes.some(([, w]) => w?.data?.oid === 0)).toBe(false);
  });
});

// ─── appended coverage: getInfo / pager / create / update mutations ────────
// Same makeService pattern as above, extended with the models the remaining
// methods need (systemVariable for the password-policy parameter reads) and a
// $transaction that understands BOTH forms (array for pager, interactive for
// everything else).

function makeUserService(overrides: Record<string, unknown> = {}) {
  const importError = {
    write: jest.fn().mockResolvedValue('user_1700000000_abcd_error.xlsx'),
    resolveDownload: jest.fn().mockResolvedValue('/tmp/user_1_error.xlsx'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 7, account: 'zeus', oid: 1 }),
      update: jest.fn().mockResolvedValue({ id: 3, oid: 1 }),
      delete: jest.fn().mockResolvedValue({ id: 3 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
    },
    workspace: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(1),
    },
    userWs: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    systemVariable: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
    ...overrides,
  };
  prisma.$transaction.mockImplementation((arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    return (arg as (tx: unknown) => unknown)(prisma);
  });
  const service = new UserService(
    prisma as unknown as PrismaService,
    importError as unknown as ImportErrorFileService,
  );
  return { service, prisma, importError };
}

function makeCurrentUser(
  overrides: Partial<CurrentUserInfo> = {},
): CurrentUserInfo {
  return {
    id: 5,
    account: 'ada',
    oid: 1,
    language: 'en',
    ...overrides,
  };
}

/** Build an import workbook in memory: header row + one row per entry. */
async function buildImportWorkbook(
  rows: unknown[][],
  mutate?: (ws: ExcelJS.Worksheet) => void,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('users');
  ws.addRow(['account', 'password', 'email', 'language', 'oid']);
  for (const r of rows) ws.addRow(r);
  mutate?.(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('UserService.getInfo', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('maps the auth UserInfo shape with legacy-null name and zero defaults', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      account: 'ada',
      name: null,
      oid: 2,
      language: 'zh-CN',
      origin: 0,
    });
    await expect(
      service.getInfo(makeCurrentUser({ oid: 2, language: 'zh-CN' })),
    ).resolves.toEqual({
      id: 5,
      account: 'ada',
      name: 'ada', // name column null → account fallback
      oid: 2,
      language: 'zh-CN',
      exp: 0,
      time: 0,
      weight: 0,
      origin: 0,
    });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 5 },
    });
  });

  it('passes through real name and JWT iat/exp/weight', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      account: 'ada',
      name: 'Ada Lovelace',
      oid: 1,
      language: 'en',
      origin: 1,
    });
    await expect(
      service.getInfo(makeCurrentUser({ iat: 100, exp: 200, weight: 1 })),
    ).resolves.toEqual({
      id: 5,
      account: 'ada',
      name: 'Ada Lovelace',
      oid: 1,
      language: 'en',
      exp: 200,
      time: 100,
      weight: 1,
      origin: 1,
    });
  });

  it('throws NotFound for a vanished user', async () => {
    const { service } = makeUserService();
    await expect(service.getInfo(makeCurrentUser())).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.getInfo(makeCurrentUser())).rejects.toThrow(
      'User not found',
    );
  });
});

describe('UserService.pager', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('paginates DB-side without a keyword, defaulting invalid page/size', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.count.mockResolvedValue(7);
    prisma.user.findMany.mockResolvedValue([{ id: 1 }]);

    const out = await service.pager({ page: 0, pageSize: -5 });

    expect(out).toEqual({ total: 7, list: [{ id: 1 }] });
    expect(prisma.user.count).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      include: { userWorkspaces: { select: { oid: true } } },
      skip: 0, // page 0 → 1, pageSize -5 → 20
      take: 20,
    });
  });

  it('computes skip/take from the requested page when valid', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.count.mockResolvedValue(60);
    prisma.user.findMany.mockResolvedValue([]);
    await service.pager({ page: 2, pageSize: 5 });
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
  });

  const d = (day: number) => new Date(Date.UTC(2024, 0, day));

  function seedKeywordMatches(
    prisma: ReturnType<typeof makeUserService>['prisma'],
  ) {
    prisma.user.findMany.mockResolvedValue([
      { id: 1, account: 'dave', name: 'Alice', email: null, createdAt: d(5) }, // exact via name
      { id: 2, account: 'alice', name: 'A', email: null, createdAt: d(1) }, // exact via account
      { id: 3, account: 'alicejr', name: null, email: null, createdAt: d(2) }, // prefix
      {
        id: 4,
        account: 'bob',
        name: 'bobby alice smith',
        email: null,
        createdAt: d(3),
      }, // contains
      { id: 5, account: 'carol', name: null, email: 'x@y.z', createdAt: d(4) }, // no match
    ]);
  }

  it('keyword path ranks exact > prefix > contains, ties by createdAt desc', async () => {
    const { service, prisma } = makeUserService();
    seedKeywordMatches(prisma);

    const out = await service.pager({
      page: 1,
      pageSize: 10,
      keyword: 'Alice',
    });

    // case-insensitive SQL prefilter on account/name/email
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { account: { contains: 'Alice', mode: 'insensitive' } },
          { name: { contains: 'Alice', mode: 'insensitive' } },
          { email: { contains: 'Alice', mode: 'insensitive' } },
        ],
      },
      include: { userWorkspaces: { select: { oid: true } } },
    });
    // non-matching rows are dropped; dave beats alice only by recency
    expect(out.total).toBe(4);
    expect(out.list.map((u: { id: number }) => u.id)).toEqual([1, 2, 3, 4]);
  });

  it('keyword path slices the RANKED list (total stays pre-slice)', async () => {
    const { service, prisma } = makeUserService();
    seedKeywordMatches(prisma);
    const out = await service.pager({ page: 1, pageSize: 2, keyword: 'alice' });
    expect(out).toEqual({
      total: 4,
      list: [
        { id: 1, account: 'dave', name: 'Alice', email: null, createdAt: d(5) },
        { id: 2, account: 'alice', name: 'A', email: null, createdAt: d(1) },
      ],
    });
    expect(out.total).toBe(4); // ranked total, not the slice length
  });
});

describe('UserService.create', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('creates the user + deduped UserWs rows and returns the detailed row', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.count.mockResolvedValue(2); // oid_list [2,3] both active
    const detailed = { id: 7, account: 'zeus', userWorkspaces: [{ oid: 1 }] };
    prisma.user.findUnique.mockResolvedValue(detailed); // findDetailed re-fetch

    const out = await service.create({
      account: 'zeus',
      password: 'Sup3r$ecret',
      oid: 1,
      oid_list: [2, 3],
    });

    expect(out).toBe(detailed);
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: 1, archivedAt: null },
    });
    expect(prisma.workspace.count).toHaveBeenCalledWith({
      where: { id: { in: [2, 3] }, archivedAt: null },
    });
    const createArgs = prisma.user.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data).toMatchObject({
      account: 'zeus',
      email: null, // dto.email undefined → null
      name: 'zeus', // dto.name undefined → account
      oid: 1,
      status: 1, // dto.status undefined → active
      origin: 0,
      language: 'en', // dto.language undefined → en
    });
    expect('systemVariables' in (createArgs.data as object)).toBe(false); // undefined → key omitted
    expect(
      await bcrypt.compare('Sup3r$ecret', createArgs.data.password as string),
    ).toBe(true);
    // primary oid 1 + oid_list {2,3} = exactly three memberships
    const wsRows = prisma.userWs.createMany.mock.calls[0][0].data as Array<{
      uid: number;
      oid: number;
    }>;
    expect(wsRows).toHaveLength(3);
    expect(wsRows).toEqual(
      expect.arrayContaining([
        { uid: 7, oid: 1 },
        { uid: 7, oid: 2 },
        { uid: 7, oid: 3 },
      ]),
    );
  });

  it('passes through every optional column when provided', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.create.mockResolvedValue({ id: 8, account: 'hera' });
    prisma.user.findUnique.mockResolvedValue({ id: 8, userWorkspaces: [] });
    await service.create({
      account: 'hera',
      password: 'Sup3r$ecret',
      email: 'h@olympus.gr',
      name: 'Hera',
      oid: 3,
      status: 0,
      language: 'zh-CN',
      system_variables: { theme: 'dark' },
    });
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      email: 'h@olympus.gr',
      name: 'Hera',
      oid: 3,
      status: 0,
      language: 'zh-CN',
      systemVariables: { theme: 'dark' },
    });
    // no oid_list → no active-workspace count check
    expect(prisma.workspace.count).not.toHaveBeenCalled();
    expect(prisma.userWs.createMany).toHaveBeenCalledWith({
      data: [{ uid: 8, oid: 3 }],
    });
  });

  it('rejects an unknown/archived primary workspace', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findFirst.mockResolvedValue(null);
    await expect(
      service.create({
        account: 'x',
        password: 'pw',
        oid: 9,
      }),
    ).rejects.toThrow('Workspace #9 does not exist or has been archived');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('rejects an oid_list entry that is not an active workspace', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.count.mockResolvedValue(1); // 2 requested, 1 found
    await expect(
      service.create({
        account: 'x',
        password: 'pw',
        oid: 1,
        oid_list: [2, 4],
      }),
    ).rejects.toThrow('Some workspaces do not exist or have been archived');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('UserService.update (field passthrough + guards)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  function dispatchFindUnique(
    prisma: ReturnType<typeof makeUserService>['prisma'],
    basic: unknown,
    selectOid: unknown,
    detailed: unknown,
  ) {
    prisma.user.findUnique.mockImplementation(((args: {
      include?: unknown;
      select?: unknown;
    }) => {
      if (args?.include) return Promise.resolve(detailed);
      if (args?.select) return Promise.resolve(selectOid);
      return Promise.resolve(basic);
    }) as never);
  }

  it('passes scalar columns straight to user.update (no oid logic)', async () => {
    const { service, prisma } = makeUserService();
    const detailed = { id: 3, account: 'newacct', userWorkspaces: [] };
    dispatchFindUnique(prisma, { id: 3, oid: 1 }, null, detailed);

    const out = await service.update(3, {
      account: 'newacct',
      email: 'n@x.com',
      name: 'New',
      language: 'zh-CN',
      status: 0,
      system_variables: { a: 1 },
    });

    expect(out).toBe(detailed);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 3 },
      data: {
        account: 'newacct',
        email: 'n@x.com',
        name: 'New',
        language: 'zh-CN',
        status: 0,
        systemVariables: { a: 1 },
      },
    });
    // no oid / oid_list → no membership reconciliation at all
    expect(prisma.userWs.upsert).not.toHaveBeenCalled();
    expect(prisma.userWs.findMany).not.toHaveBeenCalled();
  });

  it('rejects a primary oid that is not an active workspace', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(prisma, { id: 3, oid: 1 }, null, null);
    prisma.workspace.findFirst.mockResolvedValue(null);
    await expect(service.update(3, { oid: 2 })).rejects.toThrow(
      'Workspace #2 does not exist or has been archived',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('upserts the primary workspace membership when oid changes', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(prisma, { id: 3, oid: 1 }, null, {
      id: 3,
      userWorkspaces: [],
    });
    await service.update(3, { oid: 2 });
    expect(prisma.workspace.findFirst).toHaveBeenCalledWith({
      where: { id: 2, archivedAt: null },
      select: { id: true },
    });
    expect(prisma.userWs.upsert).toHaveBeenCalledWith({
      where: { uid_oid: { uid: 3, oid: 2 } },
      create: { uid: 3, oid: 2 },
      update: {},
    });
  });

  it('rejects an oid_list entry that is not an active workspace', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(prisma, { id: 3, oid: 1 }, null, null);
    prisma.workspace.count.mockResolvedValue(0);
    await expect(service.update(3, { oid_list: [2] })).rejects.toThrow(
      'Some workspaces do not exist or have been archived',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('keeps the current oid when oid_list still contains it (no re-point)', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(
      prisma,
      { id: 3, oid: 1 },
      { oid: 1 },
      { id: 3, userWorkspaces: [] },
    );
    prisma.userWs.findMany.mockResolvedValue([{ oid: 1 }]);

    await service.update(3, { oid_list: [1] });

    // exactly ONE update — the row update itself, never an oid re-point
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update.mock.calls[0][0].data).toEqual({});
    // memberships already match the target → no add/remove
    expect(prisma.userWs.deleteMany).not.toHaveBeenCalled();
    expect(prisma.userWs.createMany).not.toHaveBeenCalled();
  });

  it('skips the re-point when the in-tx current-oid read returns null', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(prisma, { id: 3, oid: 1 }, null, {
      id: 3,
      userWorkspaces: [],
    });
    prisma.userWs.findMany.mockResolvedValue([{ oid: 1 }]);

    await service.update(3, { oid_list: [2] });

    // reconcile ran (remove 1, add 2) …
    expect(prisma.userWs.deleteMany).toHaveBeenCalledWith({
      where: { uid: 3, oid: { in: [1] } },
    });
    expect(prisma.userWs.createMany).toHaveBeenCalledWith({
      data: [{ uid: 3, oid: 2 }],
    });
    // … but no second user.update re-point (current was null)
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it('re-points to dto.oid (not target[0]) when both oid and oid_list drop the current', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(
      prisma,
      { id: 3, oid: 3 },
      { oid: 3 },
      { id: 3, userWorkspaces: [] },
    );
    prisma.userWs.findMany.mockResolvedValue([{ oid: 3 }]);

    await service.update(3, { oid: 2, oid_list: [2] });

    // The main row update carries data.oid = dto.oid, AND the post-reconcile
    // re-point also lands on dto.oid (never 0, never target[0]-vs-dto.oid drift).
    const oidWrites = (
      prisma.user.update.mock.calls as Array<[{ data: { oid?: number } }]>
    )
      .map(([c]) => c.data)
      .filter((data) => data.oid !== undefined);
    expect(oidWrites).toEqual([{ oid: 2 }, { oid: 2 }]);
  });

  it('throws NotFound when the user does not exist', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.update(9, { name: 'X' })).rejects.toThrow(
      'User #9 not found',
    );
  });

  it('throws NotFound when the detailed re-fetch after update misses', async () => {
    const { service, prisma } = makeUserService();
    dispatchFindUnique(prisma, { id: 9, oid: 1 }, null, null);
    await expect(service.update(9, { name: 'X' })).rejects.toThrow(
      'User #9 not found',
    );
    expect(prisma.user.update).toHaveBeenCalledTimes(1); // row update DID run
  });
});

describe('UserService.remove / removeBatch / updateStatus', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('remove deletes an existing user', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({ id: 4 });
    await expect(service.remove(4)).resolves.toEqual({ success: true });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 4 } });
  });

  it('remove throws NotFound for a missing user', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.remove(4)).rejects.toThrow('User #4 not found');
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('removeBatch rejects an empty ids array', async () => {
    const { service, prisma } = makeUserService();
    await expect(service.removeBatch([])).rejects.toThrow(
      'ids must not be empty',
    );
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it('removeBatch rejects a non-array body', async () => {
    const { service } = makeUserService();
    await expect(service.removeBatch(undefined as never)).rejects.toThrow(
      'ids must not be empty',
    );
  });

  it('removeBatch deletes by id list (missing ids simply match 0 rows)', async () => {
    const { service, prisma } = makeUserService();
    await expect(service.removeBatch([2, 3, 4])).resolves.toEqual({
      success: true,
    });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [2, 3, 4] } },
    });
  });

  describe('system admin (uid 1) protection', () => {
    it('remove(1) is refused and deletes nothing', async () => {
      const { service, prisma } = makeUserService();
      await expect(service.remove(1)).rejects.toMatchObject({ status: 400 });
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('removeBatch is refused as soon as uid 1 is among the ids', async () => {
      const { service, prisma } = makeUserService();
      await expect(service.removeBatch([2, 1])).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.user.deleteMany).not.toHaveBeenCalled();
    });

    it('updateStatus cannot disable uid 1 (enabling stays allowed)', async () => {
      const { service, prisma } = makeUserService();
      const detailed = { id: 1, status: 1, userWorkspaces: [{ oid: 1 }] };
      prisma.user.findUnique
        .mockResolvedValueOnce({ id: 1, status: 1 }) // findOneOrFail
        .mockResolvedValueOnce(detailed); // findDetailed
      await expect(service.updateStatus(1, 0)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
      // re-enabling an already enabled admin is a no-op, not a lockout
      await expect(service.updateStatus(1, 1)).resolves.toBe(detailed);
    });

    it('update cannot disable uid 1 through the status field', async () => {
      const { service, prisma } = makeUserService();
      prisma.user.findUnique.mockResolvedValue({ id: 1, status: 1 });
      await expect(service.update(1, { status: 0 })).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('resetToDefaultPassword(1) is refused: the default password is public', async () => {
      const { service, prisma } = makeUserService();
      prisma.user.findUnique.mockResolvedValue({ id: 1, status: 1 });
      await expect(service.resetToDefaultPassword(1)).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  it('updateStatus writes the Int status and returns the detailed row', async () => {
    const { service, prisma } = makeUserService();
    const detailed = { id: 9, status: 0, userWorkspaces: [{ oid: 1 }] };
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 9, status: 1 }) // findOneOrFail
      .mockResolvedValueOnce(detailed); // findDetailed
    const out = await service.updateStatus(9, 0);
    expect(out).toBe(detailed);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { status: 0 },
    });
  });

  it('updateStatus throws NotFound for a missing user', async () => {
    const { service } = makeUserService();
    await expect(service.updateStatus(9, 1)).rejects.toThrow(
      'User #9 not found',
    );
  });
});

describe('UserService password flows', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('resetToDefaultPassword hashes DEFAULT_PWD into the row', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique
      .mockResolvedValueOnce({ id: 9 }) // findOneOrFail
      .mockResolvedValueOnce({ id: 9 }); // not used, defensive
    await expect(service.resetToDefaultPassword(9)).resolves.toEqual({
      success: true,
    });
    const data = prisma.user.update.mock.calls[0][0].data as {
      password: string;
    };
    expect(await bcrypt.compare('123456', data.password)).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { password: data.password },
    });
  });

  it('resetToDefaultPassword throws NotFound for a missing user', async () => {
    const { service } = makeUserService();
    await expect(service.resetToDefaultPassword(9)).rejects.toThrow(
      'User #9 not found',
    );
  });

  it('getDefaultPwd returns the constant when the parameter row is absent', async () => {
    const { service } = makeUserService();
    await expect(service.getDefaultPwd()).resolves.toBe('123456');
  });

  it('getDefaultPwd hides the password when login.initial_pwd_hidden=true', async () => {
    const { service, prisma } = makeUserService();
    prisma.systemVariable.findFirst.mockResolvedValue({ value: true });
    await expect(service.getDefaultPwd()).resolves.toBe('');
  });

  it('getDefaultPwd trims/case-folds the stored value', async () => {
    const { service, prisma } = makeUserService();
    prisma.systemVariable.findFirst.mockResolvedValue({ value: ' TRUE ' });
    await expect(service.getDefaultPwd()).resolves.toBe('');
  });

  it('getDefaultPwd stays visible for false/object values', async () => {
    const { service, prisma } = makeUserService();
    prisma.systemVariable.findFirst.mockResolvedValueOnce({ value: 'false' });
    await expect(service.getDefaultPwd()).resolves.toBe('123456');
    prisma.systemVariable.findFirst.mockResolvedValueOnce({ value: { a: 1 } });
    await expect(service.getDefaultPwd()).resolves.toBe('123456');
  });
});

describe('UserService self-service (language/password)', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('updateOwnLanguage writes the language column', async () => {
    const { service, prisma } = makeUserService();
    await expect(
      service.updateOwnLanguage(makeCurrentUser({ id: 6 }), 'zh-CN'),
    ).resolves.toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 6 },
      data: { language: 'zh-CN' },
    });
  });

  it('changeOwnPassword throws NotFound when the user vanished', async () => {
    const { service } = makeUserService();
    await expect(
      service.changeOwnPassword(makeCurrentUser(), 'a', 'NewPassw0rd!'),
    ).rejects.toThrow('User not found');
  });

  it('changeOwnPassword rejects a wrong original password', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      password: await bcrypt.hash('OldPassw0rd!', 10),
    });
    await expect(
      service.changeOwnPassword(makeCurrentUser(), 'wrong', 'NewPassw0rd!'),
    ).rejects.toThrow('Original password is incorrect');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changeOwnPassword enforces PWD_REGEX server-side', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      password: await bcrypt.hash('OldPassw0rd!', 10),
    });
    await expect(
      service.changeOwnPassword(makeCurrentUser(), 'OldPassw0rd!', 'weak'),
    ).rejects.toThrow('密码格式错误');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('changeOwnPassword succeeds when the initial-pwd policy is ON but the new pwd differs', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      password: await bcrypt.hash('OldPassw0rd!', 10),
    });
    prisma.systemVariable.findFirst.mockResolvedValue({ value: 'true' }); // initial_pwd_disabled
    await expect(
      service.changeOwnPassword(
        makeCurrentUser(),
        'OldPassw0rd!',
        'NewPassw0rd!',
      ),
    ).resolves.toEqual({ success: true });
    const data = prisma.user.update.mock.calls[0][0].data as {
      password: string;
    };
    expect(await bcrypt.compare('NewPassw0rd!', data.password)).toBe(true);
  });

  it('changeOwnPassword hashes and stores a valid new password', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({
      id: 5,
      password: await bcrypt.hash('OldPassw0rd!', 10),
    });
    await expect(
      service.changeOwnPassword(
        makeCurrentUser(),
        'OldPassw0rd!',
        'NewPassw0rd!',
      ),
    ).resolves.toEqual({ success: true });
    const call = prisma.user.update.mock.calls[0][0] as {
      where: { id: number };
      data: { password: string };
    };
    expect(call.where).toEqual({ id: 5 });
    expect(await bcrypt.compare('NewPassw0rd!', call.data.password)).toBe(true);
  });
});

describe('UserService workspace options + switch', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('system admin sees every workspace, archived ones flagged', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findMany.mockResolvedValue([
      { id: 1, name: 'default', archivedAt: null },
      { id: 2, name: 'old', archivedAt: new Date('2024-02-01T00:00:00Z') },
    ]);
    await expect(
      service.getWorkspaceOptions(makeCurrentUser({ id: 1 })),
    ).resolves.toEqual([
      { id: 1, name: 'default', archived: false },
      { id: 2, name: 'old', archived: true },
    ]);
    expect(prisma.workspace.findMany).toHaveBeenCalledWith({
      orderBy: { id: 'asc' },
      select: { id: true, name: true, archivedAt: true },
    });
  });

  it('members see only their active memberships', async () => {
    const { service, prisma } = makeUserService();
    prisma.userWs.findMany.mockResolvedValue([
      { oid: 3, workspace: { name: 'Sales' } },
      { oid: 4, workspace: { name: 'Ops' } },
    ]);
    await expect(
      service.getWorkspaceOptions(makeCurrentUser({ id: 5 })),
    ).resolves.toEqual([
      { id: 3, name: 'Sales' },
      { id: 4, name: 'Ops' },
    ]);
    expect(prisma.userWs.findMany).toHaveBeenCalledWith({
      where: { uid: 5, workspace: { archivedAt: null } },
      include: { workspace: { select: { name: true } } },
      orderBy: { oid: 'asc' },
    });
  });

  it('switchWorkspace throws NotFound for an unknown workspace', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findUnique.mockResolvedValue(null);
    await expect(service.switchWorkspace(makeCurrentUser(), 5)).rejects.toThrow(
      'Workspace #5 not found',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('switchWorkspace forbids a member from an archived workspace', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 5,
      archivedAt: new Date(),
    });
    await expect(
      service.switchWorkspace(makeCurrentUser({ id: 5 }), 5),
    ).rejects.toThrow('Workspace has been archived');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('switchWorkspace throws NotFound without a membership', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 5,
      archivedAt: null,
    });
    prisma.userWs.findUnique.mockResolvedValue(null);
    await expect(service.switchWorkspace(makeCurrentUser(), 5)).rejects.toThrow(
      'Not a member of workspace #5',
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('switchWorkspace moves a member with a membership', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 5,
      archivedAt: null,
    });
    prisma.userWs.findUnique.mockResolvedValue({ uid: 5, oid: 5 });
    await expect(
      service.switchWorkspace(makeCurrentUser(), 5),
    ).resolves.toEqual({ success: true });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { oid: 5 },
    });
  });

  it('switchWorkspace lets the system admin into an archived workspace', async () => {
    const { service, prisma } = makeUserService();
    prisma.workspace.findUnique.mockResolvedValue({
      id: 5,
      archivedAt: new Date(),
    });
    await expect(
      service.switchWorkspace(makeCurrentUser({ id: 1 }), 5),
    ).resolves.toEqual({ success: true });
    expect(prisma.userWs.findUnique).not.toHaveBeenCalled(); // no membership check
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { oid: 5 },
    });
  });
});

describe('UserService.importUsers', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('imports a valid row end-to-end (numeric oid cell, defaulted language)', async () => {
    const { service, prisma, importError } = makeUserService();
    prisma.user.create.mockResolvedValue({ id: 7, account: 'zeus' });
    const file = await buildImportWorkbook([
      ['zeus', 'Sup3r$ecret', 'z@x.com', '', 2],
    ]);

    await expect(service.importUsers(file)).resolves.toEqual({
      successCount: 1,
      errorCount: 0,
      dataKey: null,
    });

    // dup check by account
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { account: 'zeus' },
    });
    const createArgs = prisma.user.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(createArgs.data).toEqual({
      account: 'zeus',
      password: createArgs.data.password,
      email: 'z@x.com',
      name: 'zeus',
      oid: 2,
      status: 1,
      origin: 0,
      language: 'en', // blank cell → default
    });
    expect(
      await bcrypt.compare('Sup3r$ecret', createArgs.data.password as string),
    ).toBe(true);
    expect(prisma.userWs.create).toHaveBeenCalledWith({
      data: { uid: 7, oid: 2 },
    });
    expect(importError.write).not.toHaveBeenCalled(); // no failures → no file
  });

  it('defaults the oid to 1 when the cell is blank and nulls a blank email', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.create.mockResolvedValue({ id: 8, account: 'ira' });
    const file = await buildImportWorkbook([['ira', 'Sup3r$ecret']]); // email/language/oid blank
    await service.importUsers(file);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      email: null,
      oid: 1,
      language: 'en',
    });
    expect(prisma.userWs.create).toHaveBeenCalledWith({
      data: { uid: 8, oid: 1 },
    });
  });

  it('collects per-row validation failures with masked passwords', async () => {
    const { service, importError } = makeUserService();
    const file = await buildImportWorkbook([
      [], // fully-empty row → skipped, not an error
      ['bob', '', '', '', ''], // password empty
      ['', 'pw', '', '', ''], // account empty
      ['carol', 'pw', 'bad-email', '', ''], // email format
      ['dave', 'pw', '', '', 'abc'], // NaN oid
      ['erin', 'pw', '', '', '0'], // non-positive oid
    ]);

    const out = await service.importUsers(file);

    expect(out).toEqual({
      successCount: 0,
      errorCount: 5,
      dataKey: 'user_1700000000_abcd_error.xlsx',
    });
    expect(importError.write).toHaveBeenCalledWith({
      prefix: 'user',
      headers: ['account', 'password', 'email', 'language', 'oid'],
      rows: [
        ['bob', '', '', 'en', ''], // blank password NOT masked as ***
        ['', '***', '', 'en', ''],
        ['carol', '***', 'bad-email', 'en', ''],
        ['dave', '***', '', 'en', 'abc'],
        ['erin', '***', '', 'en', '0'],
      ],
      messages: [
        '密码不能为空',
        '账号不能为空',
        '邮箱格式不正确',
        '工作空间 id 无效: abc',
        '工作空间 id 无效: 0',
      ],
    });
  });

  it('fails a duplicate account without touching the create path', async () => {
    const { service, prisma, importError } = makeUserService();
    prisma.user.findUnique.mockResolvedValue({ id: 1, account: 'zeus' }); // exists
    const file = await buildImportWorkbook([['zeus', 'pw', '', '', '']]);
    const out = await service.importUsers(file);
    expect(out).toEqual({
      successCount: 0,
      errorCount: 1,
      dataKey: 'user_1700000000_abcd_error.xlsx',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
    const writeArgs = importError.write.mock.calls[0][0] as {
      rows: unknown[][];
      messages: string[];
    };
    expect(writeArgs.messages).toEqual(['账号已存在']);
    // uploaded plaintext never lands in the downloadable file
    expect(writeArgs.rows).toEqual([['zeus', '***', '', 'en', '']]);
  });

  it('captures thrown create errors per row (Error and non-Error)', async () => {
    const { service, prisma, importError } = makeUserService();
    prisma.user.create
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce('nope');
    const file = await buildImportWorkbook([
      ['u1', 'Sup3r$ecret', '', '', ''],
      ['u2', 'Sup3r$ecret', '', '', ''],
    ]);
    const out = await service.importUsers(file);
    expect(out).toEqual({
      successCount: 0,
      errorCount: 2,
      dataKey: 'user_1700000000_abcd_error.xlsx',
    });
    expect(prisma.user.create).toHaveBeenCalledTimes(2);
    const writeArgs = importError.write.mock.calls[0][0] as {
      messages: string[];
    };
    expect(writeArgs.messages).toEqual(['boom', 'nope']); // String(e) fallback
  });

  it('coerces rich-text, hyperlink, boolean and numeric cells', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.create.mockResolvedValue({ id: 9, account: 'richacct' });
    const file = await buildImportWorkbook(
      [['plain', 'pw', '', '', 1]],
      (ws) => {
        ws.getRow(2).getCell(1).value = {
          richText: [{ text: 'rich' }, { text: 'acct' }],
        };
        ws.getRow(2).getCell(3).value = {
          text: 'linked@example.com',
          hyperlink: 'http://example.com',
        };
        ws.getRow(2).getCell(4).value = true;
        ws.getRow(2).getCell(5).value = 3;
      },
    );
    const out = await service.importUsers(file);
    expect(out.successCount).toBe(1);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      account: 'richacct', // richText joined
      email: 'linked@example.com', // hyperlink .text
      language: 'true', // boolean → String(true)
      oid: 3, // numeric cell → Number('3')
    });
  });

  it('coerces date cells (toISOString) and formula results', async () => {
    const { service, prisma } = makeUserService();
    prisma.user.create.mockResolvedValue({ id: 10, account: 'dateacct' });
    const file = await buildImportWorkbook(
      [['dateacct', 'pw', '', '', '']],
      (ws) => {
        const langCell = ws.getRow(2).getCell(4);
        langCell.value = new Date(Date.UTC(2024, 0, 15));
        langCell.numFmt = 'yyyy-mm-dd'; // required for the date to round-trip
        ws.getRow(2).getCell(5).value = { formula: 'A2', result: 42 };
      },
    );
    await service.importUsers(file);
    expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
      language: '2024-01-15T00:00:00.000Z', // Date → toISOString
      oid: 42, // {formula, result} → result
    });
  });

  it('rejects a workbook with no worksheet', async () => {
    const { service } = makeUserService();
    const wb = new ExcelJS.Workbook(); // zero worksheets survives the round trip
    const file = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(service.importUsers(file)).rejects.toThrow(
      'No worksheet found in the Excel file',
    );
  });

  it('propagates the parser error for a corrupt buffer', async () => {
    const { service } = makeUserService();
    await expect(service.importUsers(Buffer.from('not a zip'))).rejects.toThrow(
      /central directory/i,
    );
  });
});

describe('UserService error records + template', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('resolveErrorRecord rejects keys not produced by the user import', async () => {
    const { service, importError } = makeUserService();
    await expect(
      service.resolveErrorRecord('terminology_1_error.xlsx'),
    ).rejects.toThrow('No error record');
    expect(importError.resolveDownload).not.toHaveBeenCalled();
  });

  it('resolveErrorRecord delegates user_-prefixed keys', async () => {
    const { service, importError } = makeUserService();
    await expect(service.resolveErrorRecord('user_1_error.xlsx')).resolves.toBe(
      '/tmp/user_1_error.xlsx',
    );
    expect(importError.resolveDownload).toHaveBeenCalledWith(
      'user_1_error.xlsx',
    );
  });

  it('clearErrorRecord deletes user_-prefixed keys', async () => {
    const { service, importError } = makeUserService();
    await expect(
      service.clearErrorRecord('user_1_error.xlsx'),
    ).resolves.toEqual({
      success: true,
    });
    expect(importError.delete).toHaveBeenCalledWith('user_1_error.xlsx');
  });

  it('clearErrorRecord ignores other keys (idempotent no-op)', async () => {
    const { service, importError } = makeUserService();
    await expect(service.clearErrorRecord('other.xlsx')).resolves.toEqual({
      success: true,
    });
    expect(importError.delete).not.toHaveBeenCalled();
  });

  it('exportTemplate writes a readable users template', async () => {
    const { service } = makeUserService();
    const buf = await service.exportTemplate();
    expect(Buffer.isBuffer(buf)).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buf as unknown as Parameters<ExcelJS.Workbook['xlsx']['load']>[0],
    );
    expect(wb.worksheets[0].name).toBe('users');
    const header = wb.worksheets[0].getRow(1).values as unknown[];
    expect(header.slice(1)).toEqual([
      'account',
      'password',
      'email',
      'language',
      'oid',
    ]);
    const demo = wb.worksheets[0].getRow(2).values as unknown[];
    expect(demo.slice(1)).toEqual([
      'demo',
      '123456',
      'demo@example.com',
      'en',
      1,
    ]);
  });
});

describe('UserService.findOne', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('returns the row with userWorkspaces (controller 404s on null)', async () => {
    const { service, prisma } = makeUserService();
    const detailed = { id: 3, account: 'ada', userWorkspaces: [{ oid: 1 }] };
    prisma.user.findUnique.mockResolvedValue(detailed);
    await expect(service.findOne(3)).resolves.toBe(detailed);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 3 },
      include: { userWorkspaces: { select: { oid: true } } },
    });
  });

  it('passes a null miss through untouched', async () => {
    const { service } = makeUserService();
    await expect(service.findOne(404)).resolves.toBeNull();
  });
});
