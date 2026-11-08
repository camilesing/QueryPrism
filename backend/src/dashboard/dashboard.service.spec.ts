// DashboardService unit tests.
//
// Service shape:
// - list_resource: filter by oid + createBy + optional nodeType; build tree
// - load_resource: full row + create_name/update_name via User lookup;
//   403 ownership check (createBy !== current user id)
// - create_resource/create_canvas: NO backend name-uniqueness check (frontend
//   gates via check_name — the client-side check is trusted). Sets createBy = uid.
// - update_resource/update_canvas: NO uniqueness check. Sets updateBy = uid.
// - check_name (validate_name): opt-based uniqueness, returns boolean
// - delete_resource: ownership 403 + folder-not-empty guard (safety: refuse
//   to delete a non-empty folder)
// - move_resource: QueryPrism implements pid+level update for frontend parity
//
// Per plan: `tree()`/`saveCanvas(id, dto)` signatures preserved. `tree()` is a
// thin wrapper over listResource(). saveCanvas stays (version-bump path) even
// though the new controller routes through updateCanvas instead.
import { requestContextStorage } from '../common/context/request-context';
import { DashboardService } from './dashboard.service';
import type { CoreDashboard, Prisma } from '@prisma/client';
import type { User } from '@prisma/client';

function withUser<T>(oid: number, fn: () => Promise<T>, uid = 1): Promise<T> {
  return requestContextStorage.run(
    { user: { id: uid, account: 'tester', oid, language: 'zh-CN' } },
    fn,
  );
}

type MockPrisma = {
  coreDashboard: {
    create: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findFirst: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
  };
  user: {
    findUnique: jest.Mock;
  };
};

function makeService(prisma: MockPrisma) {
  return new DashboardService(
    prisma as unknown as never,
    {
      execSql: jest.fn().mockResolvedValue({ columns: [], rows: [] }),
    } as never,
  );
}

function dash(
  partial: Partial<CoreDashboard> & { id: number; name: string },
): CoreDashboard {
  return {
    pid: null,
    oid: 1,
    level: 0,
    nodeType: 'leaf',
    type: 'dashboard',
    canvasStyleData: null,
    componentData: null,
    canvasViewInfo: null,
    mobileLayout: null,
    status: 'active',
    version: 1,
    contentId: null,
    createBy: 1,
    updateBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function user(partial: Partial<User> & { id: number }): User {
  return {
    account: 'admin',
    password: 'hash',
    oid: 1,
    status: 1,
    origin: 0,
    name: 'Admin',
    email: null,
    language: 'zh-CN',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  };
}

function makePrisma(): MockPrisma {
  return {
    coreDashboard: {
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
  };
}

describe('DashboardService', () => {
  let prisma: MockPrisma;

  beforeEach(() => {
    prisma = makePrisma();
  });

  describe('listResource / tree', () => {
    it('filters by oid + createBy and nests by pid (roots first); admin also sees legacy NULL-createBy rows (P1-3)', async () => {
      const root1 = dash({ id: 1, name: 'r1', pid: null, nodeType: 'folder' });
      const root2 = dash({ id: 2, name: 'r2', pid: null });
      const child1 = dash({ id: 3, name: 'c1', pid: 1 });
      const grandchild = dash({ id: 4, name: 'g1', pid: 3 });
      prisma.coreDashboard.findMany.mockResolvedValue([
        root1,
        root2,
        child1,
        grandchild,
      ]);
      const svc = makeService(prisma);
      const tree = await withUser(1, () => svc.listResource());
      // uid 1 → owned rows OR legacy NULL-createBy rows (P1-3).
      expect(prisma.coreDashboard.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          OR: [{ createBy: 1 }, { createBy: null }],
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(tree.map((n) => n.id)).toEqual([1, 2]);
      expect(tree[0].children.map((n) => n.id)).toEqual([3]);
      expect(tree[0].children[0].children.map((n) => n.id)).toEqual([4]);
    });

    it('non-admin users do NOT see legacy NULL-createBy rows', async () => {
      prisma.coreDashboard.findMany.mockResolvedValue([]);
      const svc = makeService(prisma);
      await withUser(1, () => svc.listResource(), 2);
      expect(prisma.coreDashboard.findMany).toHaveBeenCalledWith({
        where: { oid: 1, createBy: 2 },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('filters by node_type when provided (folder-only for parent select)', async () => {
      prisma.coreDashboard.findMany.mockResolvedValue([
        dash({ id: 1, name: 'f', nodeType: 'folder' }),
      ]);
      const svc = makeService(prisma);
      await withUser(1, () => svc.listResource('folder'));
      expect(prisma.coreDashboard.findMany).toHaveBeenCalledWith({
        where: {
          oid: 1,
          OR: [{ createBy: 1 }, { createBy: null }],
          nodeType: 'folder',
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('tree() is a thin wrapper over listResource() (signature preserved)', async () => {
      prisma.coreDashboard.findMany.mockResolvedValue([
        dash({ id: 1, name: 'r', pid: null }),
      ]);
      const svc = makeService(prisma);
      const tree = await withUser(1, () => svc.tree());
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe(1);
    });
  });

  describe('loadResource', () => {
    it('returns row + create_name/update_name via User lookup', async () => {
      const r = dash({
        id: 10,
        name: '销售看板',
        createBy: 1,
        updateBy: 2,
      });
      prisma.coreDashboard.findFirst.mockResolvedValue(r);
      prisma.user.findUnique
        .mockResolvedValueOnce(user({ id: 1, name: 'admin' }))
        .mockResolvedValueOnce(user({ id: 2, name: 'editor' }));
      const svc = makeService(prisma);
      const row = await withUser(1, () => svc.loadResource(10));
      expect(row.id).toBe(10);
      expect(row.createName).toBe('admin');
      expect(row.updateName).toBe('editor');
    });

    it('throws 404 when not found', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.loadResource(99)),
      ).rejects.toMatchObject({
        status: 404,
      });
    });

    it('throws 403 when createBy !== current user id (ownership)', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 10, name: 'n', createBy: 999 }), // owned by another user
      );
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.loadResource(10)),
      ).rejects.toMatchObject({
        status: 403,
      });
      // User lookup must not happen when ownership fails
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('falls back create_name to account when User.name is null (§85 fallback)', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 1, name: 'n', createBy: 1, updateBy: null }),
      );
      prisma.user.findUnique.mockResolvedValueOnce(
        user({ id: 1, name: null, account: 'alice' }),
      );
      const svc = makeService(prisma);
      const row = await withUser(1, () => svc.loadResource(1));
      expect(row.createName).toBe('alice'); // name null → account fallback
      expect(row.updateName).toBeNull(); // updateBy null → null
    });
  });

  describe('createResource (folder, no canvas)', () => {
    it('normalizes pid "root" → null, sets createBy, derives level 0 for root', async () => {
      prisma.coreDashboard.create.mockResolvedValue(
        dash({ id: 10, name: '目录', nodeType: 'folder' }),
      );
      const svc = makeService(prisma);
      const row = await withUser(1, () =>
        svc.createResource({
          name: '目录',
          pid: 'root',
          node_type: 'folder',
          type: 'dashboard',
          level: 0,
        }),
      );
      expect(row.id).toBe(10);
      expect(prisma.coreDashboard.create).toHaveBeenCalledWith({
        data: {
          oid: 1,
          name: '目录',
          pid: null,
          nodeType: 'folder',
          type: 'dashboard',
          level: 0,
          createBy: 1,
        },
      });
    });

    it('derives level from parent folder when pid is a number', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 5, name: '父', level: 2, nodeType: 'folder' }),
      );
      prisma.coreDashboard.create.mockResolvedValue(
        dash({ id: 11, name: '子', pid: 5, level: 3 }),
      );
      const svc = makeService(prisma);
      const row = await withUser(1, () =>
        svc.createResource({ name: '子', pid: 5, node_type: 'leaf' }),
      );
      expect(row.level).toBe(3);
      expect(prisma.coreDashboard.create).toHaveBeenCalledWith({
        data: {
          oid: 1,
          name: '子',
          pid: 5,
          nodeType: 'leaf',
          type: null,
          level: 3,
          createBy: 1,
        },
      });
    });
  });

  describe('createCanvas (leaf with canvas)', () => {
    it('JSON.parses canvas strings + sets createBy', async () => {
      prisma.coreDashboard.create.mockResolvedValue(
        dash({ id: 12, name: '看板', nodeType: 'leaf' }),
      );
      const svc = makeService(prisma);
      await withUser(1, () =>
        svc.createCanvas({
          name: '看板',
          pid: 'root',
          node_type: 'leaf',
          type: 'dashboard',
          level: 1,
          component_data: JSON.stringify([{ id: 'c1', type: 'sq-text' }]),
          canvas_style_data: JSON.stringify({ background: '#fff' }),
          canvas_view_info: JSON.stringify({ c1: { x: 10 } }),
        }),
      );
      const calls = prisma.coreDashboard.create.mock.calls as Array<
        Array<{ data: Prisma.CoreDashboardCreateInput }>
      >;
      expect(calls[0][0].data).toMatchObject({
        oid: 1,
        name: '看板',
        pid: null,
        nodeType: 'leaf',
        createBy: 1,
      });
      // Canvas fields parsed from JSON strings to objects (Prisma.Json)
      expect(calls[0][0].data.componentData).toEqual([
        { id: 'c1', type: 'sq-text' },
      ]);
      expect(calls[0][0].data.canvasStyleData).toEqual({ background: '#fff' });
      expect(calls[0][0].data.canvasViewInfo).toEqual({ c1: { x: 10 } });
    });

    it('handles missing canvas fields gracefully (undefined → Prisma default null)', async () => {
      prisma.coreDashboard.create.mockResolvedValue(
        dash({ id: 13, name: 'n' }),
      );
      const svc = makeService(prisma);
      await withUser(1, () =>
        svc.createCanvas({ name: 'n', node_type: 'leaf' }),
      );
      const calls = prisma.coreDashboard.create.mock.calls as Array<
        Array<{ data: Record<string, unknown> }>
      >;
      // No canvas keys in data when dto fields absent
      expect(calls[0][0].data).not.toHaveProperty('componentData');
      expect(calls[0][0].data).not.toHaveProperty('canvasStyleData');
    });
  });

  describe('updateResource (rename only)', () => {
    it('updates name + updateBy, no uniqueness check (trusts frontend)', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 7, name: '旧名', createBy: 1 }),
      );
      prisma.coreDashboard.update.mockResolvedValue(
        dash({ id: 7, name: '新名' }),
      );
      const svc = makeService(prisma);
      const row = await withUser(1, () =>
        svc.updateResource(7, { name: '新名' }),
      );
      expect(row.name).toBe('新名');
      expect(prisma.coreDashboard.count).not.toHaveBeenCalled();
      expect(prisma.coreDashboard.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { name: '新名', updateBy: 1 },
      });
    });

    it('throws 404 when not found', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(null);
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.updateResource(99, { name: 'x' })),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('updateCanvas (name + canvas, no version bump)', () => {
    it('updates name + canvas fields + updateBy, no version bump', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 8, name: 'old', createBy: 1, version: 3 }),
      );
      prisma.coreDashboard.update.mockResolvedValue(
        dash({ id: 8, name: 'new', version: 3 }), // version unchanged
      );
      const svc = makeService(prisma);
      const row = await withUser(1, () =>
        svc.updateCanvas(8, {
          name: 'new',
          component_data: JSON.stringify([{ id: 'c1' }]),
          canvas_style_data: JSON.stringify({ bg: '#fff' }),
          canvas_view_info: JSON.stringify({ c1: { x: 1 } }),
        }),
      );
      expect(row.name).toBe('new');
      expect(row.version).toBe(3); // NOT bumped
      expect(prisma.coreDashboard.update).toHaveBeenCalledWith({
        where: { id: 8 },
        data: {
          name: 'new',
          updateBy: 1,
          componentData: [{ id: 'c1' }],
          canvasStyleData: { bg: '#fff' },
          canvasViewInfo: { c1: { x: 1 } },
        },
      });
    });
  });

  describe('validateName (check_name route)', () => {
    it('newLeaf: returns true when no collision (oid + createBy + name)', async () => {
      prisma.coreDashboard.count.mockResolvedValue(0);
      const svc = makeService(prisma);
      const ok = await withUser(1, () =>
        svc.validateName({ name: 'free', opt: 'newLeaf' }),
      );
      expect(ok).toBe(true);
      expect(prisma.coreDashboard.count).toHaveBeenCalledWith({
        where: { oid: 1, createBy: 1, name: 'free' },
      });
    });

    it('newFolder: returns false on collision', async () => {
      prisma.coreDashboard.count.mockResolvedValue(1);
      const svc = makeService(prisma);
      const ok = await withUser(1, () =>
        svc.validateName({ name: 'dup', opt: 'newFolder' }),
      );
      expect(ok).toBe(false);
    });

    it('rename: excludes self id from collision check', async () => {
      prisma.coreDashboard.count.mockResolvedValue(0);
      const svc = makeService(prisma);
      const ok = await withUser(1, () =>
        svc.validateName({ name: 'mine', opt: 'rename', id: 7 }),
      );
      expect(ok).toBe(true);
      expect(prisma.coreDashboard.count).toHaveBeenCalledWith({
        where: { oid: 1, createBy: 1, name: 'mine', id: { not: 7 } },
      });
    });

    it('rename: throws 400 when id missing', async () => {
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.validateName({ name: 'x', opt: 'rename' })),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('throws 400 on invalid opt', async () => {
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.validateName({ name: 'x', opt: 'bogus' })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  describe('remove (delete_resource)', () => {
    it('refuses non-empty folder (400) — QueryPrism safety deviation §107', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 3, name: '目录', nodeType: 'folder', createBy: 1 }),
      );
      prisma.coreDashboard.count.mockResolvedValue(1); // has children
      const svc = makeService(prisma);
      await expect(withUser(1, () => svc.remove(3))).rejects.toMatchObject({
        status: 400,
      });
      expect(prisma.coreDashboard.delete).not.toHaveBeenCalled();
    });

    it('deletes empty panel owned by current user', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 4, name: '看板', nodeType: 'leaf', createBy: 1 }),
      );
      prisma.coreDashboard.count.mockResolvedValue(0);
      prisma.coreDashboard.delete.mockResolvedValue(dash({ id: 4 }));
      const svc = makeService(prisma);
      const res = await withUser(1, () => svc.remove(4));
      expect(res).toEqual({ success: true });
      expect(prisma.coreDashboard.delete).toHaveBeenCalledWith({
        where: { id: 4 },
      });
    });

    it('throws 403 when not owned by current user', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 5, name: 'n', createBy: 999 }),
      );
      const svc = makeService(prisma);
      await expect(withUser(1, () => svc.remove(5))).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe('moveResource (move_resource)', () => {
    it('updates pid + level + updateBy (move to root when pid=null)', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 5, name: 'n', pid: 3, createBy: 1, level: 2 }),
      );
      prisma.coreDashboard.update.mockResolvedValue(
        dash({ id: 5, name: 'n', pid: null, level: 0 }),
      );
      const svc = makeService(prisma);
      const res = await withUser(1, () => svc.moveResource(5, null));
      expect(res).toEqual({ success: true });
      expect(prisma.coreDashboard.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { pid: null, level: 0, updateBy: 1 },
      });
    });

    it('derives level from new parent when pid is a number', async () => {
      prisma.coreDashboard.findFirst
        .mockResolvedValueOnce(dash({ id: 5, name: 'n', createBy: 1 })) // existing
        .mockResolvedValueOnce(
          dash({ id: 7, name: 'newparent', level: 1, nodeType: 'folder' }),
        ); // parent
      prisma.coreDashboard.update.mockResolvedValue(
        dash({ id: 5, pid: 7, level: 2 }),
      );
      const svc = makeService(prisma);
      await withUser(1, () => svc.moveResource(5, 7));
      expect(prisma.coreDashboard.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { pid: 7, level: 2, updateBy: 1 },
      });
    });

    it('throws 403 when not owned', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 5, name: 'n', createBy: 999 }),
      );
      const svc = makeService(prisma);
      await expect(
        withUser(1, () => svc.moveResource(5, null)),
      ).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  describe('saveCanvas (signature preserved per plan; version-bump path)', () => {
    it('writes 4 canvas fields + bumps version', async () => {
      prisma.coreDashboard.findFirst.mockResolvedValue(
        dash({ id: 8, name: 'k', version: 1 }),
      );
      prisma.coreDashboard.update.mockResolvedValue(
        dash({ id: 8, name: 'k', version: 2 }),
      );
      const svc = makeService(prisma);
      const components = [{ type: 'sq-text', props: { text: 'hi' } }];
      const view = [{ x: 10, y: 10, w: 200, h: 100 }];
      const row = await withUser(1, () =>
        svc.saveCanvas(8, {
          componentData: components,
          canvasViewInfo: view,
          canvasStyleData: { background: '#fff' },
        }),
      );
      expect(row.version).toBe(2);
      expect(prisma.coreDashboard.update).toHaveBeenCalledWith({
        where: { id: 8 },
        data: {
          canvasStyleData: { background: '#fff' },
          componentData: components,
          canvasViewInfo: view,
          mobileLayout: undefined,
          version: { increment: 1 },
        },
      });
    });
  });
});
