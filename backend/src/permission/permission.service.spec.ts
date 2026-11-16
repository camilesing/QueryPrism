// permission.service spec — Phase 10d cycle 5. Verifies the 3-route
// contract (list/save/delete) reverse-engineered from the frontend. Mocks
// PrismaService; the controller layer applies the snake-mapper (§88), so
// the service works with prisma rows.
// RequestContext.getUser() reads the AsyncLocalStorage store; the `withUser`
// helper establishes it for a test without spinning up the Nest middleware.
import { requestContextStorage } from '../common/context/request-context';
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { PermissionService } from './permission.service';

function withUser<T>(oid: number, fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: { id: 1, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  $transaction: jest.Mock;
  dsRules: {
    findMany: jest.Mock;
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  dsPermission: {
    create: jest.Mock;
    createMany: jest.Mock;
    deleteMany: jest.Mock;
  };
  // Workspace-reference validation reads datasource/table ownership.
  datasource: { count: jest.Mock };
  table: { count: jest.Mock };
};

function makePrisma(): MockPrisma {
  const prisma = {
    dsRules: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    dsPermission: {
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    datasource: {
      // Every referenced id resolves in the workspace by default.
      count: jest
        .fn()
        .mockImplementation((args: { where: { id: { in: number[] } } }) =>
          Promise.resolve(args.where.id.in.length),
        ),
    },
    table: {
      count: jest
        .fn()
        .mockImplementation((args: { where: { id: { in: number[] } } }) =>
          Promise.resolve(args.where.id.in.length),
        ),
    },
  } as unknown as MockPrisma;
  // Review P1-1: the service routes multi-step writes through $transaction.
  // Emulate BOTH forms: interactive (the callback receives this same mock
  // client — no real rollback, but call-order/usage assertions work) and
  // array form (sequential Promise.all).
  prisma.dsPermission.createMany.mockResolvedValue({ count: 0 });
  prisma.$transaction = jest.fn((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (client: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  return prisma;
}

describe('PermissionService', () => {
  let prisma: MockPrisma;
  let service: PermissionService;

  beforeEach(async () => {
    prisma = makePrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PermissionService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(PermissionService);
  });

  // ─────────────────────────── list ───────────────────────────

  describe('list', () => {
    it('returns bare array of snake-mapped groups (oid-scoped, includes permissions relation)', async () => {
      prisma.dsRules.findMany.mockResolvedValue([
        {
          id: 100,
          oid: 7,
          name: 'admins',
          userList: [1, 2],
          permissions: [
            {
              id: 1,
              rulesId: 100,
              name: 'row-rule',
              type: 'row',
              dsId: 10,
              dsName: 'orders_ds',
              tableId: 20,
              tableName: 'orders',
              expressionTree: '{"logic":"and","items":[]}',
              permissions: '[]',
              createTime: new Date('2026-07-26T00:00:00Z'),
            },
          ],
          createTime: new Date('2026-07-26T00:00:00Z'),
        },
      ]);
      const out = await withUser(7, () => service.list());
      expect(prisma.dsRules.findMany).toHaveBeenCalledWith({
        where: { oid: 7 },
        include: { permissions: true },
        orderBy: { createTime: 'desc' },
      });
      expect(out).toEqual([
        {
          id: 100,
          name: 'admins',
          permissions: [
            {
              id: 1,
              name: 'row-rule',
              type: 'row',
              ds_id: 10,
              ds_name: 'orders_ds',
              table_id: 20,
              table_name: 'orders',
              tree: { logic: 'and', items: [] },
              permission_list: [],
            },
          ],
          users: [1, 2],
        },
      ]);
      expect(Array.isArray(out)).toBe(true); // bare array, NOT {items,total}
    });

    it('returns [] when no rule groups (empty workspace)', async () => {
      prisma.dsRules.findMany.mockResolvedValue([]);
      const out = await withUser(1, () => service.list());
      expect(out).toEqual([]);
    });
  });

  // ─────────────────────────── save ───────────────────────────

  describe('save (create)', () => {
    it('creates DsRules + DsPermission items from body; derives userList from body.users', async () => {
      prisma.dsRules.create.mockImplementation(
        (args: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: 500,
            oid: 3,
            name: args.data.name,
            userList: args.data.userList,
            permissions: [],
            createTime: new Date('2026-07-26T00:00:00Z'),
          }),
      );
      prisma.dsPermission.createMany.mockResolvedValue({ count: 1 });

      const out = await withUser(3, () =>
        service.save({
          name: 'new group',
          permissions: [
            {
              name: 'r1',
              type: 'row',
              ds_id: 10,
              ds_name: 'orders',
              table_id: 20,
              table_name: 'orders_tbl',
              expression_tree: '{"logic":"and","items":[]}',
              permissions: '[]',
              permission_list: [],
            },
          ],
          users: [1, 2],
        }),
      );

      // DsRules created with oid + name + userList (from body.users)
      expect(prisma.dsRules.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            oid: 3,
            name: 'new group',
            userList: [1, 2],
          }),
        }),
      );
      // DsPermission items created via ONE createMany (P3-2) with body fields
      expect(prisma.dsPermission.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            rulesId: 500,
            name: 'r1',
            type: 'row',
            dsId: 10,
            dsName: 'orders',
            tableId: 20,
            tableName: 'orders_tbl',
            expressionTree: '{"logic":"and","items":[]}',
            permissions: '[]',
          }),
        ],
      });
      // return shape for @SystemLog resources callback
      expect(out).toEqual({ id: 500, name: 'new group' });
    });

    it('persists expression_tree + permissions as JSON strings (no parsing on save)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 1, oid: 1, name: 'g' });
      const captured: Record<string, unknown>[] = [];
      prisma.dsPermission.createMany.mockImplementation(
        (args: { data: Record<string, unknown>[] }) => {
          captured.push(...args.data);
          return Promise.resolve({ count: args.data.length });
        },
      );
      await withUser(1, () =>
        service.save({
          name: 'g',
          permissions: [
            {
              name: 'col-rule',
              type: 'column',
              ds_id: 1,
              ds_name: 'ds',
              table_id: 2,
              table_name: 'tbl',
              expression_tree: '{}',
              permissions: '[{"field_id":1,"enable":true}]',
              permission_list: [],
            },
          ],
          users: [],
        }),
      );
      expect(captured[0].expressionTree).toBe('{}'); // stored as raw string
      expect(captured[0].permissions).toBe('[{"field_id":1,"enable":true}]'); // stored as raw string
    });
  });

  describe('save (update)', () => {
    it('finds ownership, deletes old items, updates rules, creates new items (delete-all-recreate)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue({
        id: 200,
        oid: 5,
        name: 'old name',
      });
      prisma.dsRules.update.mockResolvedValue({
        id: 200,
        oid: 5,
        name: 'new name',
      });

      const out = await withUser(5, () =>
        service.save({
          id: 200,
          name: 'new name',
          permissions: [
            {
              name: 'r2',
              type: 'row',
              ds_id: 30,
              ds_name: 'ds2',
              table_id: 40,
              table_name: 'tbl2',
              expression_tree: '{"logic":"or","items":[]}',
              permissions: '[]',
              permission_list: [],
            },
          ],
          users: [3, 4],
        }),
      );

      // ownership check (oid-scoped findFirst)
      expect(prisma.dsRules.findFirst).toHaveBeenCalledWith({
        where: { id: 200, oid: 5 },
      });
      // old items deleted (delete-all before recreate)
      expect(prisma.dsPermission.deleteMany).toHaveBeenCalledWith({
        where: { rulesId: 200 },
      });
      // rules updated (name + userList)
      expect(prisma.dsRules.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 200 },
          data: expect.objectContaining({
            name: 'new name',
            userList: [3, 4],
          }),
        }),
      );
      // new item created with rulesId=200 via createMany (P3-2)
      expect(prisma.dsPermission.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            rulesId: 200,
            name: 'r2',
            type: 'row',
          }),
        ],
      });
      expect(out).toEqual({ id: 200, name: 'new name' });
    });

    it('throws 404 when id not found (ownership)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () =>
          service.save({ id: 999, name: 'x', permissions: [], users: [] }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('routes the delete-all-recreate update through ONE $transaction (P1-1)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue({ id: 200, oid: 5 });
      prisma.dsRules.update.mockResolvedValue({ id: 200 });
      await withUser(5, () =>
        service.save({
          id: 200,
          name: 'n',
          permissions: [
            { type: 'row', expression_tree: '{"logic":"AND","items":[]}' },
          ],
          users: [],
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // All three writes happened INSIDE the transaction callback (the mock
      // runs it synchronously before save resolves) — order: delete → update → create.
      expect(prisma.dsPermission.deleteMany).toHaveBeenCalledWith({
        where: { rulesId: 200 },
      });
      expect(prisma.dsRules.update).toHaveBeenCalled();
      expect(prisma.dsPermission.createMany).toHaveBeenCalled();
    });

    it('a mid-sequence create failure rejects the whole save (P1-1)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue({ id: 200, oid: 5 });
      prisma.dsPermission.createMany.mockRejectedValueOnce(
        new Error('db write failed'),
      );
      await expect(
        withUser(5, () =>
          service.save({
            id: 200,
            name: 'n',
            permissions: [
              { type: 'row', expression_tree: '{"logic":"AND","items":[]}' },
            ],
            users: [],
          }),
        ),
      ).rejects.toThrow('db write failed');
    });
  });

  describe('save (validation)', () => {
    it('throws 400 when name is empty', async () => {
      await expect(
        withUser(1, () =>
          service.save({ name: '', permissions: [], users: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withUser(1, () =>
          service.save({ name: '   ', permissions: [], users: [] }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no longer crashes on a missing users field (null-guard, 2026-09 review)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 1, oid: 1, name: 'g' });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [],
          }),
        ),
      ).resolves.toEqual({ id: 1, name: 'g' });
    });

    it('rejects a row item whose expression_tree is not JSON (400, no write)', async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: '{"logic":"AND","items":[oops',
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.dsRules.create).not.toHaveBeenCalled();
    });

    it("accepts value_type==='variable' items with a valid variable_id", async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 1, oid: 1, name: 'g' });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [
                    {
                      type: 'item',
                      field_id: 1,
                      term: 'eq',
                      value_type: 'variable',
                      variable_id: 3,
                    },
                  ],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 1, name: 'g' });
    });

    it("rejects value_type==='variable' items without a variable_id", async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [
                    {
                      type: 'item',
                      field_id: 1,
                      term: 'eq',
                      value_type: 'variable',
                    },
                  ],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a between term without exactly two operands', async () => {
      for (const value of ['18', '1,2,3', '1,']) {
        await expect(
          withUser(1, () =>
            service.save({
              name: 'g',
              permissions: [
                {
                  type: 'row',
                  expression_tree: JSON.stringify({
                    logic: 'AND',
                    items: [
                      { type: 'item', field_id: 1, term: 'between', value },
                    ],
                  }),
                },
              ],
              users: [],
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('rejects an unknown term and an empty enum, recursing into sub_tree', async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [{ type: 'item', field_id: 1, term: 'DROP TABLE' }],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [
                    {
                      type: 'tree',
                      sub_tree: {
                        logic: 'OR',
                        items: [
                          {
                            type: 'item',
                            field_id: 1,
                            term: 'eq',
                            filter_type: 'enum',
                            enum_value: [],
                          },
                        ],
                      },
                    },
                  ],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a valid two-operand between (save proceeds)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 9, oid: 1, name: 'g' });
      prisma.dsPermission.create.mockResolvedValue({ id: 1 });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [
                    {
                      type: 'item',
                      field_id: 1,
                      term: 'between',
                      value: '18,30',
                    },
                  ],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 9, name: 'g' });
    });

    it('accepts a valid nested sub_tree and continues to sibling items', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 9, oid: 1, name: 'g' });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [
                    {
                      type: 'tree',
                      sub_tree: {
                        logic: 'OR',
                        items: [
                          { type: 'item', term: 'eq', value: 'x' },
                          {
                            type: 'item',
                            term: 'eq',
                            value_type: 'variable',
                            variable_id: 2,
                          },
                        ],
                      },
                    },
                    { type: 'item', term: 'gt', value: '5' },
                  ],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 9, name: 'g' });
    });
  });

  // ─────────────────────────── remove ───────────────────────────

  describe('remove', () => {
    it('finds ownership, deletes items + rules, returns [{id}] for @SystemLog callback', async () => {
      prisma.dsRules.findFirst.mockResolvedValue({ id: 300, oid: 8 });
      const out = await withUser(8, () => service.remove(300));
      expect(prisma.dsRules.findFirst).toHaveBeenCalledWith({
        where: { id: 300, oid: 8 },
      });
      expect(prisma.dsPermission.deleteMany).toHaveBeenCalledWith({
        where: { rulesId: 300 },
      });
      expect(prisma.dsRules.delete).toHaveBeenCalledWith({
        where: { id: 300 },
      });
      expect(out).toEqual([{ id: 300 }]);
    });

    it('throws 404 when id not found (ownership)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue(null);
      await expect(
        withUser(1, () => service.remove(999)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─────────────── tail-sweep: residual save/validation arms ───────────────

  describe('save (optional-field defaults)', () => {
    it('missing name defaults to empty → 400 (name ?? arm)', async () => {
      await expect(
        withUser(1, () => service.save({} as never)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.dsRules.create).not.toHaveBeenCalled();
    });

    it('missing permissions array defaults to [] on create (no createMany)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 77, oid: 1, name: 'g' });
      const out = await withUser(1, () => service.save({ name: 'g' }));
      expect(out).toEqual({ id: 77, name: 'g' });
      expect(prisma.dsPermission.createMany).not.toHaveBeenCalled();
    });

    it('missing permissions array defaults to [] on update (delete still runs)', async () => {
      prisma.dsRules.findFirst.mockResolvedValue({ id: 200, oid: 5 });
      prisma.dsRules.update.mockResolvedValue({ id: 200 });
      const out = await withUser(5, () => service.save({ id: 200, name: 'n' }));
      expect(out).toEqual({ id: 200, name: 'n' });
      expect(prisma.dsPermission.deleteMany).toHaveBeenCalledWith({
        where: { rulesId: 200 },
      });
      expect(prisma.dsPermission.createMany).not.toHaveBeenCalled();
    });

    it('a row item with null / empty expression_tree is allowed (no tree to validate)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 8, oid: 1, name: 'g' });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              { type: 'row' }, // expression_tree absent (null arm)
              { type: 'row', expression_tree: '' }, // empty-string arm
            ],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 8, name: 'g' });
    });

    it('items without optional fields persist as nulls (?? null arms)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 8, oid: 1, name: 'g' });
      await withUser(1, () =>
        service.save({
          name: 'g',
          permissions: [{ type: 'column' }],
          users: [],
        }),
      );
      const data = prisma.dsPermission.createMany.mock.calls[0][0] as {
        data: Record<string, unknown>[];
      };
      expect(data.data[0]).toEqual({
        rulesId: 8,
        name: null,
        type: 'column',
        dsId: null,
        dsName: null,
        tableId: null,
        tableName: null,
        expressionTree: null,
        permissions: null,
      });
    });
  });

  describe('save (expression-tree shape arms)', () => {
    it('JSON that parses to a non-object (string/number/array) → 400', async () => {
      for (const tree of ['"str"', '42', '[]']) {
        await expect(
          withUser(1, () =>
            service.save({
              name: 'g',
              permissions: [{ type: 'row', expression_tree: tree }],
              users: [],
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('missing / non-string / invalid logic → 400 (AND and OR are accepted)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 1, oid: 1, name: 'g' });
      // top-level OR accepted
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              { type: 'row', expression_tree: '{"logic":"or","items":[]}' },
            ],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 1, name: 'g' });
      // logic absent → '' → rejected
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [{ type: 'row', expression_tree: '{"items":[]}' }],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // logic non-string → '' → rejected
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              { type: 'row', expression_tree: '{"logic":5,"items":[]}' },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      // unknown operator word → rejected
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              { type: 'row', expression_tree: '{"logic":"XOR","items":[]}' },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('items not an array → 400', async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              { type: 'row', expression_tree: '{"logic":"AND","items":{}}' },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('between with a non-string value is rejected (value fallback to empty)', async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [{ type: 'item', term: 'between', value: 18 }],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a null child entry inside items → 400 (unknown term, c?. guards)', async () => {
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [
              {
                type: 'row',
                expression_tree: JSON.stringify({
                  logic: 'AND',
                  items: [null],
                }),
              },
            ],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('save (workspace-reference validation arms)', () => {
    it('rejects when a referenced datasource is missing / outside the workspace', async () => {
      prisma.datasource.count.mockResolvedValueOnce(0); // found !== dsIds.length
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [{ type: 'column', ds_id: 99 }],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.dsRules.create).not.toHaveBeenCalled();
    });

    it('rejects when a referenced table is missing / outside the workspace', async () => {
      prisma.table.count.mockResolvedValueOnce(0);
      prisma.dsRules.findFirst.mockResolvedValue({ id: 200, oid: 1 });
      await expect(
        withUser(1, () =>
          service.save({
            id: 200,
            name: 'g',
            permissions: [{ type: 'column', table_id: 99 }],
            users: [],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.dsRules.update).not.toHaveBeenCalled();
    });

    it('non-number ds_id / table_id entries are skipped (filter typeof arm)', async () => {
      prisma.dsRules.create.mockResolvedValue({ id: 3, oid: 1, name: 'g' });
      await expect(
        withUser(1, () =>
          service.save({
            name: 'g',
            permissions: [{ type: 'column', ds_id: null, table_id: undefined }],
            users: [],
          }),
        ),
      ).resolves.toEqual({ id: 3, name: 'g' });
      expect(prisma.datasource.count).not.toHaveBeenCalled();
      expect(prisma.table.count).not.toHaveBeenCalled();
    });
  });

  describe('createItems default client', () => {
    it('falls back to the plain PrismaService when no transactional client is passed', async () => {
      // Both save() call sites pass an explicit tx; the default parameter is
      // exercised directly (private helper via cast) to pin the fallback.
      prisma.dsPermission.createMany.mockResolvedValue({ count: 1 });
      const createItems = (
        service as unknown as {
          createItems: (
            rulesId: number,
            items: { type: string }[],
            client?: unknown,
          ) => Promise<void>;
        }
      ).createItems.bind(service);
      await createItems(12, [{ type: 'column' }], undefined);
      expect(prisma.dsPermission.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ rulesId: 12, type: 'column' })],
      });
    });
  });

  describe('workspace context', () => {
    it('list without a resolved workspace (no user in ALS) → 404 ws_unresolved', async () => {
      await expect(
        requestContextStorage.run({}, () => service.list()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
