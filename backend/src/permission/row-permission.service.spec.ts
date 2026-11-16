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

// ─────────────────────────────────────────────────────────────────────────
// Extended coverage (appended): variable resolution (system + custom), the
// numberBound range guards, collectVariableIds sub-tree walking, the
// userList non-array/empty guards, and the parseTree shape guards. All go
// through the public getRowFilters — the real filter-tree evaluator renders
// the fragments, so each expected string is the actual WHERE text.
// ─────────────────────────────────────────────────────────────────────────

/** A DsPermission row with a nullable tableId (orphan-guard coverage). */
function perm(
  id: number,
  tableId: number | null,
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

/** expressionTree JSON for one variable-backed leaf condition. */
function varTree(fieldId: number, term: string, variableId: number): string {
  return JSON.stringify({
    logic: 'AND',
    items: [
      {
        type: 'item',
        field_id: fieldId,
        term,
        value_type: 'variable',
        variable_id: variableId,
        value: '',
      },
    ],
  });
}

describe('RowPermissionService — variable resolution (extended)', () => {
  function makeVarService() {
    const prisma = {
      dsPermission: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findUnique: jest.fn().mockResolvedValue(null) },
      systemVariable: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = withContext(
      new RowPermissionService(prisma as unknown as PrismaService),
    );
    return { service, prisma };
  }

  /** dbUser row shape returned by prisma.user.findUnique. */
  function dbUser(partial: Partial<Record<string, unknown>> = {}) {
    return {
      name: 'Alice',
      account: 'alice',
      email: 'alice@t.co',
      systemVariables: [],
      ...partial,
    };
  }

  it('resolves a SYSTEM name variable and renders it as the literal', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['name'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` = 'Alice')" }]);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 2 },
      select: { name: true, account: true, email: true, systemVariables: true },
    });
    expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
      where: { id: { in: [10] } },
    });
  });

  it('system name variable falls back to the account when name is null', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ name: null, account: 'fallback' }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['name'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` = 'fallback')" }]);
  });

  it('system account and email variables resolve to their fields', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
      perm(2, 2, varTree(200, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['Account'] }, // case-insensitive key
      { id: 11, type: 'system', varType: 'text', value: ['email'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: "(`age` = 'alice')" },
      { table: 'orders', filter: "(`amount` = 'alice@t.co')" },
    ]);
  });

  it('DENIES an unknown system-variable key (nothing but name/account/email)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['phone'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  it('DENIES a system variable whose resolved value is null or blank', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]), // email null
      perm(2, 2, varTree(200, 'eq', 11), [2]), // name '  ' → blank
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ name: '  ', email: null }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['email'] },
      { id: 11, type: 'system', varType: 'text', value: ['name'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '((1 = 0))' },
      { table: 'orders', filter: '((1 = 0))' },
    ]);
  });

  it('DENIES when the system variable allows a non-string (or nothing) as its key', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
      perm(2, 2, varTree(200, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: [42] }, // non-string first allowed
      { id: 11, type: 'system', varType: 'text', value: [] }, // empty allowed
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '((1 = 0))' },
      { table: 'orders', filter: '((1 = 0))' },
    ]);
  });

  it('DENIES every variable item when the user row no longer exists', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: ['name'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  it('DENIES a variable id the resolver has no row for (map.get → null)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 99), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([]); // id 99 not found
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  // --- custom (user-bound) variables -----------------------------------

  it('renders a custom variable override list as an IN (...) when term=in', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'in', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [{ variableId: 11, variableValues: ['a', 'b'] }],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` IN ('a','b'))" }]);
  });

  it('accepts the legacy single-value override form (variableValue)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ systemVariables: [{ variableId: 11, variableValue: 'x' }] }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` = 'x')" }]);
  });

  it('skips non-object override entries while matching variableId', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [
          null,
          'junk',
          42,
          { variableId: 11, variableValues: ['ok'] },
        ],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` = 'ok')" }]);
  });

  it('DENIES a custom variable with no override for the user (or non-array overrides)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
      perm(2, 2, varTree(200, 'eq', 12), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ systemVariables: 'not-an-array' }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
      { id: 12, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '((1 = 0))' },
      { table: 'orders', filter: '((1 = 0))' },
    ]);
  });

  it('DENIES a custom variable whose override values are all blank', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [{ variableId: 11, variableValues: ['', '  '] }],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  it("text variables keep only values inside the variable's allowed set", async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]), // values partially outside
      perm(2, 2, varTree(200, 'eq', 12), [2]), // values all outside
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [
          { variableId: 11, variableValues: ['b', 'zzz'] },
          { variableId: 12, variableValues: ['zzz'] },
        ],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'text', value: ['a', 'b'] },
      { id: 12, type: 'custom', varType: 'text', value: ['a', 'b'] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: "(`age` = 'b')" },
      { table: 'orders', filter: '((1 = 0))' }, // everything filtered out → null
    ]);
  });

  it('number variables enforce the [min,max] allowed range', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]), // inside
      perm(2, 2, varTree(200, 'eq', 12), [2]), // below min
      perm(3, 1, varTree(101, 'eq', 13), [2]), // above max — reuses users.name
    ]);
    // table 1 gets two trees (AND-joined), table 2 one tree.
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [
          { variableId: 11, variableValues: ['50'] },
          { variableId: 12, variableValues: ['-1'] },
          { variableId: 13, variableValues: ['200'] },
        ],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'number', value: [0, 100] },
      { id: 12, type: 'custom', varType: 'number', value: [0, 100] },
      { id: 13, type: 'custom', varType: 'number', value: [0, 100] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    // users: tree 11 inside range → '50'; tree 13 above max → DENY leaf,
    // AND-joined on the same table. orders: tree 12 below min → DENY.
    expect(out).toEqual([
      { table: 'users', filter: "(`age` = '50') AND ((1 = 0))" },
      { table: 'orders', filter: '((1 = 0))' },
    ]);
  });

  it('string numeric bounds parse; garbage bounds are treated as unset', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]), // min '20' (string) → 10 < 20 DENY
      perm(2, 2, varTree(200, 'eq', 12), [2]), // min 'abc', max {} → unset → pass
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [
          { variableId: 11, variableValues: ['10'] },
          { variableId: 12, variableValues: ['9999'] },
        ],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'number', value: ['20'] },
      { id: 12, type: 'custom', varType: 'number', value: ['abc', {}] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '((1 = 0))' },
      { table: 'orders', filter: "(`amount` = '9999')" },
    ]);
  });

  it('non-finite numeric bounds are ignored; an unparseable value skips the range check', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]), // min Infinity → unset; value unparseable
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [{ variableId: 11, variableValues: ['oops'] }],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'number', value: [Infinity, 100] },
    ]);
    // 'oops' is not a finite number → numberBound(values[0]) is null → the
    // range check is skipped entirely and the raw value renders.
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: "(`age` = 'oops')" }]);
  });

  it('datetime variables bound via Date.parse', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]), // inside the window
      perm(2, 2, varTree(200, 'eq', 12), [2]), // before the window
      perm(3, 1, varTree(101, 'eq', 13), [2]), // max 'not-a-date' → unset → pass
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [
          { variableId: 11, variableValues: ['2026-06-01'] },
          { variableId: 12, variableValues: ['2025-06-01'] },
          { variableId: 13, variableValues: ['2030-01-01'] },
        ],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      {
        id: 11,
        type: 'custom',
        varType: 'datetime',
        value: ['2026-01-01', '2026-12-31'],
      },
      {
        id: 12,
        type: 'custom',
        varType: 'datetime',
        value: ['2026-01-01', '2026-12-31'],
      },
      {
        id: 13,
        type: 'custom',
        varType: 'datetime',
        value: ['2026-01-01', 'not-a-date'],
      },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      {
        table: 'users',
        filter: "(`age` = '2026-06-01') AND (`name` = '2030-01-01')",
      },
      { table: 'orders', filter: '((1 = 0))' },
    ]);
  });

  it('an empty-string datetime min bound is unset; the max bound still applies', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({
        systemVariables: [{ variableId: 11, variableValues: ['2030-01-01'] }],
      }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      {
        id: 11,
        type: 'custom',
        varType: 'datetime',
        value: ['', '2026-12-31'],
      },
    ]);
    // min '' → unset → only the max bound remains; 2030 > 2026-12-31 → DENY
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  // --- tree shape guards ------------------------------------------------

  it('collects variable ids nested inside sub_trees', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(
        1,
        1,
        JSON.stringify({
          logic: 'AND',
          items: [
            {
              type: 'tree',
              sub_tree: {
                logic: 'OR',
                items: [
                  {
                    type: 'item',
                    field_id: 100,
                    term: 'eq',
                    value_type: 'variable',
                    variable_id: 11,
                    value: '',
                  },
                ],
              },
            },
          ],
        }),
        [2],
      ),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ systemVariables: [{ variableId: 11, variableValues: ['v'] }] }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    // the resolver WAS built for the nested id (11), and the sub-tree renders
    expect(prisma.systemVariable.findMany).toHaveBeenCalledWith({
      where: { id: { in: [11] } },
    });
    expect(out).toEqual([{ table: 'users', filter: "((`age` = 'v'))" }]);
  });

  it('a tree with an empty items list renders null → no filter emitted', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, '{"logic":"AND","items":[]}', [2]),
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([]);
    // no variable ids to collect → no resolver fetch
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('a tree child of type=tree without sub_tree is ignored', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, '{"logic":"AND","items":[{"type":"tree"}]}', [2]),
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([]); // no renderable child → fragment null → dropped
  });

  it('trees whose parsed JSON is a non-object are corrupt → DENY (§116.6b)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, '123', [2]), // JSON number
      perm(2, 2, 'null', [2]), // JSON null
      perm(3, 1, '"str"', [2]), // JSON string
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '(1 = 0)' },
      { table: 'orders', filter: '(1 = 0)' },
    ]);
  });

  it('trees missing logic or items keys are corrupt → DENY (§116.6b)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, '{"logic":"AND"}', [2]), // no items
      perm(2, 2, '{"items":[]}', [2]), // no logic
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    expect(out).toEqual([
      { table: 'users', filter: '(1 = 0)' },
      { table: 'orders', filter: '(1 = 0)' },
    ]);
  });

  // --- userList + tableId guards ----------------------------------------

  it('skips rules whose userList is null, empty, or not an array', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, tree(100, 'eq', '18'), null),
      perm(2, 1, tree(100, 'eq', '18'), []),
      perm(3, 1, tree(100, 'eq', '18'), '2'), // a bare string, not an array
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([]);
  });

  it('skips orphan permission rows whose tableId is null', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, null, tree(100, 'eq', '18'), [2]),
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([]);
  });

  it('omits referenced tables that ended up with no matching rules', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, tree(100, 'eq', '18'), [2]),
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), [
      'users',
      'orders',
    ]);
    // orders was referenced but has no matching rule → no entry at all
    expect(out).toEqual([{ table: 'users', filter: "(`age` = '18')" }]);
  });

  it('returns [] when tableNames reference nothing in the datasource', async () => {
    const { service, prisma } = makeVarService();
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['ghosts']);
    expect(out).toEqual([]);
    expect(prisma.dsPermission.findMany).not.toHaveBeenCalled();
  });

  it('a tree whose items value is null walks as empty (no throw, no filter)', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, '{"logic":"AND","items":null}', [2]),
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([]);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('a system variable with a non-array allowed value resolves nothing → DENY', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 10), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(dbUser());
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 10, type: 'system', varType: 'text', value: 'name' }, // not an array
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });

  it('a custom override carrying neither variableValues nor variableValue → DENY', async () => {
    const { service, prisma } = makeVarService();
    prisma.dsPermission.findMany.mockResolvedValue([
      perm(1, 1, varTree(100, 'eq', 11), [2]),
    ]);
    prisma.user.findUnique.mockResolvedValue(
      dbUser({ systemVariables: [{ variableId: 11 }] }),
    );
    prisma.systemVariable.findMany.mockResolvedValue([
      { id: 11, type: 'custom', varType: 'kv', value: [] },
    ]);
    const out = await service.getRowFilters({ id: 2 }, makeDs(), ['users']);
    expect(out).toEqual([{ table: 'users', filter: '((1 = 0))' }]);
  });
});
