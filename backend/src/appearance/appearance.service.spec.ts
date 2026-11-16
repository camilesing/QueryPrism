// appearance.service spec — the service reads SystemVariable rows of type
// 'appearance' and maps each to the frontend's {pkey, pval} shape. Empty
// store → [] (the frontend treats [] as "use defaults", fixing the page-load
// 404). Stored Json values are coerced to string (appearance values are all
// strings: themeColor, name, '0'/'1' show flags, URLs).
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { AppearanceService } from './appearance.service';
import { AppearanceFileService } from './appearance-file.service';

describe('AppearanceService file delegation', () => {
  it('delegates exists/pathFor/mediaType to the file service', async () => {
    const files = {
      save: jest.fn(),
      exists: jest.fn().mockResolvedValue(true),
      pathFor: jest.fn().mockReturnValue('/tmp/a.png'),
      mediaType: jest.fn().mockReturnValue('image/png'),
      delete: jest.fn(),
    };
    const service = new AppearanceService({} as never, files as never);
    await expect(service.exists('id.png')).resolves.toBe(true);
    expect(service.pathFor('id.png')).toBe('/tmp/a.png');
    expect(service.mediaType('id.png')).toBe('image/png');
  });
});

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

  it('treats undefined files as no uploads', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockResolvedValue([]);
    await service.save(
      JSON.stringify([{ pkey: 'name', pval: 'Prism' }]),
      undefined,
    );
    expect(files.save).not.toHaveBeenCalled();
    expect(tx.systemVariable.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an upload whose flag is not an appearance file key', async () => {
    const { service, tx, files } = setup();
    await expect(service.save('[]', [upload('bogus')])).rejects.toThrow(
      '无法识别的外观图片字段: logo.png',
    );
    expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
    expect(files.save).not.toHaveBeenCalled();
  });

  it('falls back to originalname when the upload flag has no file name part', async () => {
    const { service, files } = setup();
    const noName = {
      originalname: ',bogus',
      size: 1,
      buffer: Buffer.from('x'),
    };
    await expect(service.save('[]', [noName as never])).rejects.toThrow(
      '无法识别的外观图片字段: ,bogus',
    );
    expect(files.save).not.toHaveBeenCalled();
  });

  it('deletes the previous image when an entry explicitly resets the field', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockImplementation(
      (args: { where: { type?: unknown } }) =>
        Promise.resolve(
          args.where.type === 'appearance'
            ? [{ name: 'web', value: OLD_ID }]
            : [],
        ),
    );
    await service.save(JSON.stringify([{ pkey: 'web', pval: '' }]), []);
    expect(files.delete).toHaveBeenCalledWith(OLD_ID);
    // A reset upserts the empty value back into the variable row.
    expect(tx.systemVariable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: 'web' },
        update: expect.objectContaining({ value: '' }),
      }),
    );
  });

  it('reset with no previous value deletes nothing', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockResolvedValue([]);
    await service.save(JSON.stringify([{ pkey: 'web', pval: '' }]), []);
    expect(files.delete).not.toHaveBeenCalled();
  });

  it('reset of a non-file previous value deletes nothing', async () => {
    const { service, tx, files } = setup();
    tx.systemVariable.findMany.mockImplementation(
      (args: { where: { type?: unknown } }) =>
        Promise.resolve(
          args.where.type === 'appearance'
            ? [{ name: 'web', value: 'blue' }]
            : [],
        ),
    );
    await service.save(JSON.stringify([{ pkey: 'web', pval: '' }]), []);
    expect(files.delete).not.toHaveBeenCalled();
  });
});

describe('AppearanceService.save data parsing', () => {
  function setup() {
    const tx = { systemVariable: { findMany: jest.fn(), upsert: jest.fn() } };
    const prisma = {
      systemVariable: { findMany: jest.fn(), upsert: jest.fn() },
      $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
    };
    const files = { save: jest.fn(), delete: jest.fn() };
    const service = new AppearanceService(prisma as never, files as never);
    tx.systemVariable.findMany.mockResolvedValue([]);
    return { service, tx, files };
  }

  it('treats undefined data as an empty entry list', async () => {
    const { service, tx } = setup();
    await service.save(undefined, []);
    expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
  });

  it('rejects data that is not valid JSON', async () => {
    const { service, tx } = setup();
    await expect(service.save('{bad json', [])).rejects.toThrow(
      'common.invalid_json_string',
    );
    expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
  });

  it('rejects data that parses to a non-array', async () => {
    const { service, tx } = setup();
    await expect(service.save('{"pkey":"a"}', [])).rejects.toThrow(
      'appearance.data_must_be_array',
    );
    expect(tx.systemVariable.upsert).not.toHaveBeenCalled();
  });

  it('skips null / non-object / empty-key items and upserts the rest', async () => {
    const { service, tx } = setup();
    await service.save(
      JSON.stringify([
        null,
        42,
        'plain',
        { pkey: '', pval: 'dropped' },
        { pkey: 7, pval: 'dropped' },
        { pkey: 'name', pval: 'Prism' },
      ]),
      [],
    );
    expect(tx.systemVariable.upsert).toHaveBeenCalledTimes(1);
    expect(tx.systemVariable.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'name' } }),
    );
  });

  it('stringifies pval of every JSON scalar/object kind', async () => {
    const { service, tx } = setup();
    await service.save(
      JSON.stringify([
        { pkey: 'absent' },
        { pkey: 'nul', pval: null },
        { pkey: 'num', pval: 3 },
        { pkey: 'bool', pval: false },
        { pkey: 'obj', pval: { a: 1 } },
      ]),
      [],
    );
    const values = Object.fromEntries(
      (
        tx.systemVariable.upsert.mock.calls as unknown as Array<
          [{ create: { name: string; value: string } }]
        >
      ).map((call) => [call[0].create.name, call[0].create.value]),
    );
    expect(values).toEqual({
      absent: '',
      nul: '',
      num: '3',
      bool: 'false',
      obj: '{"a":1}',
    });
  });

  it('keeps provided ptype/sort metadata on accepted entries', async () => {
    const { service, tx } = setup();
    await service.save(
      JSON.stringify([
        { pkey: 'themeColor', pval: 'blue', ptype: 'str', sort: 5 },
      ]),
      [],
    );
    expect(tx.systemVariable.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects an upload whose originalname has no flag separator', async () => {
    const { service, files } = setup();
    const plain = {
      originalname: 'logo.png',
      size: 1,
      buffer: Buffer.from('x'),
    };
    await expect(service.save('[]', [plain as never])).rejects.toThrow(
      '无法识别的外观图片字段: logo.png',
    );
    expect(files.save).not.toHaveBeenCalled();
  });
});
