// RowPermissionService spec — runtime row-permission filter resolver tests
// (the getRowFilters + isNormalUser logic; the stored expressionTree string
// is parsed directly with JSON.parse). PrismaService is a
// jest.Mock; the evaluator (filter-tree.ts) is the real module (its own
// 44-test spec covers the tree→WHERE translation).
import { RowPermissionService } from './row-permission.service';
import { PrismaService } from '../database/prisma.service';
import { requestContextStorage } from '../common/context/request-context';

/** Minimal datasource shape the service consumes (a structural subset of the
 *  Prisma `Datasource & { tables: { fields }[] }` returned by findOne). */
interface TestTable {
  id: number;
  tableName: string;
  fields: { id: number; fieldName: string }[];
}
interface TestDs {
  type: string;
  tables: TestTable[];
}

function makeDs(): TestDs {
  return {
    type: 'mysql',
    tables: [
      {
        id: 1,
        tableName: 'users',
        fields: [
          { id: 100, fieldName: 'age' },
          { id: 101, fieldName: 'name' },
        ],
      },
      {
        id: 2,
        tableName: 'orders',
        fields: [{ id: 200, fieldName: 'amount' }],
      },
    ],
  };
}

/** Build a DsPermission row (the shape prisma.dsPermission.findMany returns,
 *  with `rules.userList` as a parsed JSON array). */
function permRow(
  id: number,
  tableId: number,
  expressionTree: string | null,
  userList: unknown,
): unknown {
  return {
    id,
    tableId,
    type: 'row',
    expressionTree,
    permissions: null,
    rules: { userList },
  };
}

/** Build an expressionTree JSON string for a single eq condition. */
function tree(fieldId: number, term: string, value: string): string {
  return JSON.stringify({
    logic: 'AND',
    items: [{ type: 'item', field_id: fieldId, term, value }],
  });
}

/** Rules are fetched only for the request's current workspace (oid 7).
 *  Wrap the service so each call runs inside an ALS request context. */
function withContext<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value: unknown = Reflect.get(t, prop, receiver);
      if (typeof value !== 'function') return value;
      const fn = value as (...a: unknown[]) => unknown;
      return (...args: unknown[]): unknown =>
        requestContextStorage.run(
          { user: { id: 2, account: 'tester', oid: 7, language: 'zh-CN' } },
          () => fn.apply(t, args),
        );
    },
  });
}

describe('RowPermissionService', () => {
  function makeService() {
    const prisma = {
      dsPermission: { findMany: jest.fn() },
    };
    const service = withContext(
      new RowPermissionService(prisma as unknown as PrismaService),
    );
    return { service, prisma };
  }

  describe('isNormalUser', () => {
    it('returns false for the admin (uid 1, hardcoded)', () => {
      const { service } = makeService();
      expect(service.isNormalUser({ id: 1 })).toBe(false);
    });
    it('returns true for any other user', () => {
      const { service } = makeService();
      expect(service.isNormalUser({ id: 2 })).toBe(true);
      expect(service.isNormalUser({ id: 999 })).toBe(true);
    });
  });

  describe('getRowFilters', () => {
    it('returns [] for the admin (bypasses row-permission, no prisma call)', async () => {
      const { service, prisma } = makeService();
      const out = await service.getRowFilters({ id: 1 }, makeDs(), ['users']);
      expect(out).toEqual([]);
      expect(prisma.dsPermission.findMany).not.toHaveBeenCalled();
    });

    it('returns [] when the SQL references no tables in the datasource', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), []);
      expect(out).toEqual([]);
      expect(prisma.dsPermission.findMany).not.toHaveBeenCalled();
    });

    it('returns [{table,filter}] for a non-admin with a matching rule', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(100, 'eq', '18'), [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([{ table: 'users', filter: "(`age` = '18')" }]);
      expect(prisma.dsPermission.findMany).toHaveBeenCalledWith({
        where: {
          tableId: { in: [1] },
          type: 'row',
          rules: { oid: 7 },
        },
        include: { rules: { select: { userList: true } } },
      });
    });

    it('returns [] when the rule exists but the user is not in userList', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(100, 'eq', '18'), [3, 4]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([]);
    });

    it('matches user.id whether userList stores it as number or string', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(100, 'gt', '18'), ['2']), // string form
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([{ table: 'users', filter: "(`age` > '18')" }]);
    });

    it('returns [] when the matching rule has a null expressionTree', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, null, [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([]);
    });

    it('scopes to only the tables referenced in the SQL', async () => {
      const { service, prisma } = makeService();
      // SQL references 'users' only; a rule for 'orders' (tableId=2) is fetched
      // but maps to no SQL-referenced table — actually findMany is scoped to
      // tableId IN [1] (users only), so orders rules are never fetched.
      prisma.dsPermission.findMany.mockResolvedValue([]);
      await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(prisma.dsPermission.findMany).toHaveBeenCalledWith({
        where: {
          tableId: { in: [1] },
          type: 'row',
          rules: { oid: 7 },
        },
        include: { rules: { select: { userList: true } } },
      });
    });

    it('AND-joins multiple matching rules for the same table', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(100, 'eq', '18'), [2]),
        permRow(2, 1, tree(101, 'like', 'joh'), [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([
        {
          table: 'users',
          // §116.6d: like terms now carry an explicit ESCAPE clause (mysql
          // literal form doubles the backslash).
          filter: "(`age` = '18') AND (`name` LIKE '%joh%' ESCAPE '\\\\')",
        },
      ]);
    });

    it('emits one entry per SQL-referenced table that has a matching rule', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(100, 'eq', '18'), [2]),
        permRow(2, 2, tree(200, 'gt', '5'), [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), [
        'users',
        'orders',
      ]);
      expect(out).toEqual([
        { table: 'users', filter: "(`age` = '18')" },
        { table: 'orders', filter: "(`amount` > '5')" },
      ]);
    });

    it('DENIES rules whose tree references an unknown field (§116.6b fail-closed)', async () => {
      const { service, prisma } = makeService();
      // field_id 999 not in users.fields → the leaf renders the deny
      // fragment instead of vanishing (a dropped restriction would widen
      // access to the whole table).
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, tree(999, 'eq', '18'), [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
    });

    it('DENIES rules whose stored expressionTree is corrupt JSON (§116.6b)', async () => {
      const { service, prisma } = makeService();
      prisma.dsPermission.findMany.mockResolvedValue([
        permRow(1, 1, '{"logic":"AND","items":[oops', [2]),
      ]);
      const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
      expect(out).toEqual([{ table: 'users', filter: '(1 = 0)' }]);
    });

    it('DENIES every referenced table when the request context is missing (fail closed)', async () => {
      // Called outside any ALS request context: the workspace is unknown, so
      // the rule set cannot be resolved. An empty filter list would mean "no
      // restriction" (fail OPEN); every referenced table must be denied.
      const prisma = { dsPermission: { findMany: jest.fn() } };
      const service = new RowPermissionService(
        prisma as unknown as PrismaService,
      );
      const out = await service.getRowFilters({ id: 2 }, makeDs(), [
        'users',
        'orders',
      ]);
      expect(out).toEqual([
        { table: 'users', filter: '(1 = 0)' },
        { table: 'orders', filter: '(1 = 0)' },
      ]);
      expect(prisma.dsPermission.findMany).not.toHaveBeenCalled();
    });
  });
});
