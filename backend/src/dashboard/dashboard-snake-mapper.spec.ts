// dashboard-snake-mapper spec — verifies the snake_case wire shapes the
// frontend reads (api/dashboard.ts + canvasUtils.ts + ResourceTree.vue +
// treeNode.ts). e2e green ≠ contract correct; the mapper must emit the
// exact field names the frontend reads.
//
// Three response shapes:
// 1. list_resource → tree of DashboardBaseResponse {id, name, pid, node_type,
//    leaf, type, create_time, update_time, children}
// 2. load_resource → full row dict + create_name/update_name + canvas fields
//    as JSON STRINGS (frontend does JSON.parse on canvas_*)
// 3. create_resource/create_canvas/update_resource/update_canvas → BaseDashboard
//    subset {id, name, pid, workspace_id, org_id, type, node_type, level,
//    create_by} — frontend only reads res.id, so full ResourceSnake is safe.
//
// Design notes:
// - id is a NUMBER (autoincrement integer; no UUID/snowflake ids)
// - pid is number|null — the frontend accepts string|number
// - leaf = (node_type === 'leaf') is computed (no DB column) so
//   treeDraggableChart.ts:83 works
// - status runtime-coerced 'active'→1 / else→0 (QueryPrism keeps String
//   @default("active") — no migration, coerce on read)
// - canvas fields emitted as JSON strings with safe defaults ('[]'/'{}' when
//   null) so frontend JSON.parse never throws
// - org_id always null (QueryPrism has no orgId column; the frontend
//   doesn't read it)
import {
  toDashboardNodeSnake,
  toDashboardResourceSnake,
} from './dashboard-snake-mapper';
import type { CoreDashboard } from '@prisma/client';
import type { DashboardNode } from './dashboard.service';

function row(
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
    version: 3,
    contentId: null,
    createBy: 1,
    updateBy: null,
    createdAt: new Date('2026-07-26T10:00:00.000Z'),
    updatedAt: new Date('2026-07-26T11:00:00.000Z'),
    ...partial,
  };
}

describe('dashboard-snake-mapper', () => {
  describe('toDashboardNodeSnake (list_resource tree)', () => {
    it('maps a leaf root node with all 8 fields + children', () => {
      const leaf: DashboardNode = {
        ...row({ id: 10, name: '销售看板', nodeType: 'leaf' }),
        children: [],
      };
      const snake = toDashboardNodeSnake(leaf);
      expect(snake).toEqual({
        id: 10,
        name: '销售看板',
        pid: null,
        node_type: 'leaf',
        leaf: true,
        type: 'dashboard',
        create_time: leaf.createdAt.getTime(),
        update_time: leaf.updatedAt.getTime(),
        children: [],
      });
    });

    it('maps a folder node (leaf=false) and recurses into children', () => {
      const child: DashboardNode = {
        ...row({ id: 2, name: 'c', nodeType: 'leaf', pid: 1 }),
        children: [],
      };
      const folder: DashboardNode = {
        ...row({ id: 1, name: '目录', nodeType: 'folder', type: null }),
        children: [child],
      };
      const snake = toDashboardNodeSnake(folder);
      expect(snake.leaf).toBe(false);
      expect(snake.node_type).toBe('folder');
      expect(snake.type).toBeNull();
      expect(snake.children).toHaveLength(1);
      expect(snake.children[0]).toMatchObject({
        id: 2,
        node_type: 'leaf',
        leaf: true,
        pid: 1,
      });
    });

    it('emits pid as number for nested children (not string "root")', () => {
      const node: DashboardNode = {
        ...row({ id: 5, name: 'n', pid: 3 }),
        children: [],
      };
      expect(toDashboardNodeSnake(node).pid).toBe(3);
    });
  });

  describe('toDashboardResourceSnake (load_resource / create / update)', () => {
    it('emits full row with canvas fields as JSON strings + create_name/update_name', () => {
      const r = row({
        id: 10,
        name: '销售看板',
        pid: null,
        oid: 7,
        level: 0,
        nodeType: 'leaf',
        type: 'dashboard',
        canvasStyleData: { background: '#fff' },
        componentData: [{ id: 'c1', type: 'sq-text' }],
        canvasViewInfo: { c1: { x: 10, y: 10 } },
        mobileLayout: null,
        status: 'active',
        version: 5,
        contentId: 42,
        createBy: 1,
        updateBy: 2,
      });
      const snake = toDashboardResourceSnake(r, {
        createName: 'admin',
        updateName: 'editor',
      });
      // scalar fields
      expect(snake.id).toBe(10);
      expect(snake.name).toBe('销售看板');
      expect(snake.pid).toBeNull();
      expect(snake.workspace_id).toBe(7);
      expect(snake.org_id).toBeNull();
      expect(snake.level).toBe(0);
      expect(snake.node_type).toBe('leaf');
      expect(snake.type).toBe('dashboard');
      expect(snake.mobile_layout).toBeNull();
      expect(snake.status).toBe(1); // 'active' → 1
      expect(snake.version).toBe(5);
      expect(snake.content_id).toBe(42);
      expect(snake.create_time).toBe(r.createdAt.getTime());
      expect(snake.update_time).toBe(r.updatedAt.getTime());
      expect(snake.create_by).toBe(1);
      expect(snake.update_by).toBe(2);
      expect(snake.create_name).toBe('admin');
      expect(snake.update_name).toBe('editor');
      // canvas fields are JSON strings
      expect(typeof snake.canvas_style_data).toBe('string');
      expect(JSON.parse(snake.canvas_style_data)).toEqual({
        background: '#fff',
      });
      expect(typeof snake.component_data).toBe('string');
      expect(JSON.parse(snake.component_data)).toEqual([
        { id: 'c1', type: 'sq-text' },
      ]);
      expect(typeof snake.canvas_view_info).toBe('string');
      expect(JSON.parse(snake.canvas_view_info)).toEqual({
        c1: { x: 10, y: 10 },
      });
    });

    it('coerces status "disabled" → 0', () => {
      const r = row({ id: 1, name: 'n', status: 'disabled' });
      expect(toDashboardResourceSnake(r).status).toBe(0);
    });

    it('emits safe JSON defaults when canvas fields are null (frontend JSON.parse never throws)', () => {
      const r = row({
        id: 1,
        name: 'folder',
        nodeType: 'folder',
        canvasStyleData: null,
        componentData: null,
        canvasViewInfo: null,
      });
      const snake = toDashboardResourceSnake(r);
      expect(JSON.parse(snake.canvas_style_data)).toEqual({});
      expect(JSON.parse(snake.component_data)).toEqual([]);
      expect(JSON.parse(snake.canvas_view_info)).toEqual({});
    });

    it('omits create_name/update_name when opts not provided (create/update response)', () => {
      const r = row({ id: 1, name: 'n' });
      const snake = toDashboardResourceSnake(r);
      expect(snake.create_name).toBeNull();
      expect(snake.update_name).toBeNull();
    });

    it('emits create_by/update_by as number|null (not stringified)', () => {
      const r = row({ id: 1, name: 'n', createBy: 5, updateBy: null });
      const snake = toDashboardResourceSnake(r);
      expect(snake.create_by).toBe(5);
      expect(snake.update_by).toBeNull();
    });
  });
});
