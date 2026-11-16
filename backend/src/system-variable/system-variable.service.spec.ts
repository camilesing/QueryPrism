// system-variable.service spec — Phase 10c cycle 2 §82/§88/§101.
//   - listAll/listPage share listFilter: no name → {} (all, system first),
//     with name → `name contains AND type != 'system'` (system vars excluded
//     from name searches).
//   - save upserts by id presence: strict int parse (non-numeric id → 400),
//     dup-name check inside ONE interactive $transaction (400 on conflict,
//     excluding self on update), create forces type='custom' + createTime/
//     createBy, update only writes name/varType/value.
//   - delete: bare ids array → deleteMany in ids; empty array is a no-op.
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../database/prisma.service';
import { SystemVariableService } from './system-variable.service';

function mockRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 5,
    name: 'region',
    varType: 'text',
    type: 'custom',
    value: ['north', 'south'],
    createTime: new Date('2026-09-01T00:00:00.000Z'),
    createBy: 1,
    ...over,
  };
}

describe('SystemVariableService', () => {
  let service: SystemVariableService;
  let prisma: {
    systemVariable: Record<string, jest.Mock>;
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      systemVariable: {
        findMany: jest.fn(),
        count: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    // Both forms: array (listPage's [count, findMany]) and interactive
    // callback (save's dup check + write — run immediately with the same
    // mock table).
    prisma.$transaction = jest.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: typeof prisma) => unknown)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
    );

    const module = await Test.createTestingModule({
      providers: [
        SystemVariableService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(SystemVariableService);
  });

  describe('listAll', () => {
    it('no name → all rows, ordered type desc + name asc, snake-mapped', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([
        mockRow({ type: 'system', name: 'currentUser' }),
        mockRow(),
      ]);
      const rows = await service.listAll();
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ type: 'desc' }, { name: 'asc' }],
      });
      expect(rows).toEqual([
        {
          id: 5,
          name: 'currentUser',
          var_type: 'text',
          value: ['north', 'south'],
          type: 'system',
        },
        {
          id: 5,
          name: 'region',
          var_type: 'text',
          value: ['north', 'south'],
          type: 'custom',
        },
      ]);
    });

    it('with name → contains filter AND system vars excluded', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await service.listAll('reg');
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: {
          name: { contains: 'reg', mode: 'insensitive' },
          type: { not: 'system' },
        },
        orderBy: [{ type: 'desc' }, { name: 'asc' }],
      });
    });

    it('empty-string name → no filter (falsy arm)', async () => {
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await service.listAll('');
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ type: 'desc' }, { name: 'asc' }],
      });
    });
  });

  describe('listPage', () => {
    it('same filter, paginated inside ONE $transaction → {items, total}', async () => {
      prisma.systemVariable.count.mockResolvedValue(7);
      prisma.systemVariable.findMany.mockResolvedValue([mockRow()]);
      const result = await service.listPage(2, 10, 'reg');
      const ops = prisma.$transaction.mock.calls[0][0] as unknown[];
      expect(ops).toHaveLength(2);
      expect(prisma.systemVariable.count).toHaveBeenCalledWith({
        where: {
          name: { contains: 'reg', mode: 'insensitive' },
          type: { not: 'system' },
        },
      });
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
        where: {
          name: { contains: 'reg', mode: 'insensitive' },
          type: { not: 'system' },
        },
        orderBy: [{ type: 'desc' }, { name: 'asc' }],
        skip: 10,
        take: 10,
      });
      expect(result.total).toBe(7);
      expect(result.items).toEqual([
        {
          id: 5,
          name: 'region',
          var_type: 'text',
          value: ['north', 'south'],
          type: 'custom',
        },
      ]);
    });

    it('no name → unfiltered page', async () => {
      prisma.systemVariable.count.mockResolvedValue(0);
      prisma.systemVariable.findMany.mockResolvedValue([]);
      await service.listPage(1, 20);
      expect(prisma.systemVariable.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {}, skip: 0, take: 20 }),
      );
    });
  });

  describe('save', () => {
    it('create branch (no id): forces type=custom + stamps createTime/createBy', async () => {
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      prisma.systemVariable.create.mockResolvedValue(mockRow());
      const result = await service.save(
        { name: 'region', var_type: 'text', value: ['north'] },
        42,
      );
      expect(result).toEqual({ success: true });
      expect(prisma.systemVariable.findFirst).toHaveBeenCalledWith({
        where: { name: 'region' },
      });
      expect(prisma.systemVariable.create).toHaveBeenCalledTimes(1);
      const call = prisma.systemVariable.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.name).toBe('region');
      expect(call.data.varType).toBe('text');
      expect(call.data.type).toBe('custom');
      expect(call.data.value).toEqual(['north']);
      expect(call.data.createBy).toBe(42);
      expect(call.data.createTime).toBeInstanceOf(Date);
      expect((call.data.createTime as Date).getTime()).toBeGreaterThanOrEqual(
        Date.now() - 5000,
      );
      // create branch — update is never touched
      expect(prisma.systemVariable.update).not.toHaveBeenCalled();
    });

    it('falsy id forms (null / empty string) take the CREATE branch', async () => {
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      await service.save(
        { id: null, name: 'a', var_type: 'text', value: [] },
        1,
      );
      await service.save({ id: '', name: 'b', var_type: 'text', value: [] }, 1);
      expect(prisma.systemVariable.create).toHaveBeenCalledTimes(2);
      // dup check without self-exclusion (no id)
      expect(prisma.systemVariable.findFirst).toHaveBeenNthCalledWith(1, {
        where: { name: 'a' },
      });
      expect(prisma.systemVariable.findFirst).toHaveBeenNthCalledWith(2, {
        where: { name: 'b' },
      });
    });

    it('update branch (numeric id, string id): dup check excludes self; only name/varType/value written', async () => {
      prisma.systemVariable.findFirst.mockResolvedValue(null);
      prisma.systemVariable.update.mockResolvedValue(mockRow());
      await service.save(
        { id: '5', name: 'renamed', var_type: 'number', value: [0, 10] },
        42,
      );
      expect(prisma.systemVariable.findFirst).toHaveBeenCalledWith({
        where: { name: 'renamed', id: { not: 5 } },
      });
      expect(prisma.systemVariable.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: {
          name: 'renamed',
          varType: 'number',
          value: [0, 10],
        },
      });
      expect(prisma.systemVariable.create).not.toHaveBeenCalled();
    });

    it('non-numeric id → 400 before any transaction work', async () => {
      await expect(
        service.save({ id: 'abc', name: 'x', var_type: 'text', value: [] }, 1),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('duplicate name → 400 and no create/update', async () => {
      prisma.systemVariable.findFirst.mockResolvedValue(mockRow());
      await expect(
        service.save({ name: 'region', var_type: 'text', value: [] }, 1),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.systemVariable.create).not.toHaveBeenCalled();
      expect(prisma.systemVariable.update).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes the given ids via deleteMany in', async () => {
      const result = await service.delete([5, 9]);
      expect(result).toEqual({ success: true });
      expect(prisma.systemVariable.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: [5, 9] } },
      });
    });

    it('empty ids array → no deleteMany call', async () => {
      const result = await service.delete([]);
      expect(result).toEqual({ success: true });
      expect(prisma.systemVariable.deleteMany).not.toHaveBeenCalled();
    });
  });
});
