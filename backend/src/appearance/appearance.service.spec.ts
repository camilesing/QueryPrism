// appearance.service spec — the service reads SystemVariable rows of type
// 'appearance' and maps each to the frontend's {pkey, pval} shape. Empty
// store → [] (the frontend treats [] as "use defaults", fixing the page-load
// 404). Stored Json values are coerced to string (appearance values are all
// strings: themeColor, name, '0'/'1' show flags, URLs).
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { AppearanceService } from './appearance.service';
import { AppearanceFileService } from './appearance-file.service';

describe('AppearanceService', () => {
  let service: AppearanceService;
  let prisma: { systemVariable: { findMany: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      systemVariable: { findMany: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        AppearanceService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: AppearanceFileService,
          useValue: {
            save: jest.fn(),
            exists: jest.fn(),
            pathFor: jest.fn(),
            mediaType: jest.fn(),
            delete: jest.fn(),
          },
        },
      ],
    }).compile();
    service = module.get(AppearanceService);
  });

  it('queries only appearance rows (type=appearance)', async () => {
    prisma.systemVariable.findMany.mockResolvedValue([]);
    await service.getUi();
    expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
      where: { type: 'appearance' },
    });
  });

  it('returns [] when no appearance settings are configured', async () => {
    prisma.systemVariable.findMany.mockResolvedValue([]);
    await expect(service.getUi()).resolves.toEqual([]);
  });

  it('maps each row name/value to pkey/pval', async () => {
    prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'themeColor', value: 'blue' },
      { name: 'name', value: 'QueryPrism' },
      { name: 'showDoc', value: '1' },
    ]);
    await expect(service.getUi()).resolves.toEqual([
      { pkey: 'themeColor', pval: 'blue' },
      { pkey: 'name', pval: 'QueryPrism' },
      { pkey: 'showDoc', pval: '1' },
    ]);
  });

  it('coerces non-string Json scalars to string pval', async () => {
    prisma.systemVariable.findMany.mockResolvedValue([
      { name: 'flag', value: true },
      { name: 'count', value: 3 },
    ]);
    await expect(service.getUi()).resolves.toEqual([
      { pkey: 'flag', pval: 'true' },
      { pkey: 'count', pval: '3' },
    ]);
  });
});

describe('AppearanceService.save', () => {
  const NEW_ID = `${'a'.repeat(32)}.png`;
  const OLD_ID = `${'b'.repeat(32)}.png`;

  function setup() {
    // Interactive-transaction client: every read that informs a write and
    // every write must go through `tx`, never the outer client.
    const tx = {
      systemVariable: { findMany: jest.fn(), upsert: jest.fn() },
    };
    const prisma = {
      systemVariable: { findMany: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const files = {
      save: jest.fn().mockResolvedValue(NEW_ID),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AppearanceService(prisma as never, files as never);
    return { service, prisma, tx, files };
  }

  const upload = (flag: string) =>
    ({
      originalname: `logo.png,${flag}`,
      size: 10,
      buffer: Buffer.from('x'),
    }) as never;

  it('checks name conflicts inside the same transaction as the upserts', async () => {
    const { service, prisma, tx } = setup();
    tx.systemVariable.findMany.mockResolvedValue([]);
    await service.save(JSON.stringify([{ pkey: 'name', pval: 'Prism' }]), []);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.systemVariable.findMany).not.toHaveBeenCalled();
    expect(tx.systemVariable.findMany).toHaveBeenCalledWith({
      where: { name: { in: ['name'] }, type: { not: 'appearance' } },
      select: { name: true },
    });
    expect(tx.systemVariable.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a key owned by another variable type without writing anything', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockImplementation(
      (args: { where: { type?: unknown } }) =>
        Promise.resolve(
          args.where.type === 'appearance' ? [] : [{ name: 'web' }],
        ),
    );
    await expect(service.save('[]', [upload('web')])).rejects.toThrow(
      '变量名已被其他配置占用: web',
    );
    expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('replaces an uploaded image and deletes the old file after commit', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockImplementation(
      (args: { where: { type?: unknown } }) =>
        Promise.resolve(
          args.where.type === 'appearance'
            ? [{ name: 'web', value: OLD_ID }]
            : [],
        ),
    );
    await service.save('[]', [upload('web')]);
    expect(tx.systemVariable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'web' } }),
    );
    expect(files.delete).toHaveBeenCalledWith(OLD_ID);
    expect(files.delete).not.toHaveBeenCalledWith(NEW_ID);
  });

  it('removes freshly uploaded files when the transaction fails', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockResolvedValue([]);
    tx.systemVariable.upsert.mockRejectedValue(new Error('db down'));
    await expect(service.save('[]', [upload('web')])).rejects.toThrow(
      'db down',
    );
    expect(files.delete).toHaveBeenCalledWith(NEW_ID);
  });
});
