// UserService spec — the update() workspace-reconciliation path. Focus: the
// oid reset must never strand a user on workspace 0 (oid_list: [] without a
// replacement oid previously wrote User.oid = 0 → JwtAuthGuard lockout).
import { UserService } from './user.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { PrismaService } from '../database/prisma.service';
import { ImportErrorFileService } from '../common/import-export/import-error-file.service';

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
