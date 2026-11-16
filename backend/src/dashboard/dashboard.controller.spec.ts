// DashboardController spec — locks the action-route wiring plus the two real
// in-controller behaviors: parseId (strict integer parse via parseStrictInt;
// junk ids get a translated 400 instead of an opaque Prisma 500) and the
// move_resource pid normalization ('root'/'0'/''/null/undefined → null,
// numeric strings/numbers parsed, junk → 400). Also locks the snake mapping
// applied to list/load/create/update returns (leaf derived from node_type,
// canvas JSON-stringified with '{}'/'[]' defaults, create_name/update_name
// only on load_resource) and the @SystemLog resources callbacks.
import { BadRequestException } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import type { LogConfig } from '../audit/log-config.interface';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const T0 = new Date('2026-05-06T07:08:09.012Z');

/** CoreDashboard-shaped row (only fields the snake mapper reads). */
const row = (over: Record<string, unknown> = {}) => ({
  id: 2,
  name: 'Sales Dashboard',
  pid: 1,
  oid: 1,
  level: 2,
  nodeType: 'leaf',
  type: 'dashboard',
  canvasStyleData: { style: 1 },
  componentData: [{ c: 1 }],
  canvasViewInfo: null,
  mobileLayout: null,
  status: 'active',
  version: 3,
  contentId: null,
  createdAt: T0,
  updatedAt: T0,
  createBy: 1,
  updateBy: 2,
  ...over,
});

describe('DashboardController', () => {
  let service: Record<string, jest.Mock>;
  let controller: DashboardController;

  beforeEach(() => {
    setI18n(createTestI18n());
    service = {
      listResource: jest.fn(),
      loadResource: jest.fn(),
      createResource: jest.fn(),
      createCanvas: jest.fn(),
      updateResource: jest.fn(),
      updateCanvas: jest.fn(),
      validateName: jest.fn(),
      remove: jest.fn(),
      moveResource: jest.fn(),
    };
    controller = new DashboardController(
      service as unknown as DashboardService,
    );
  });

  // ─── list / load ────────────────────────────────────────────────────────

  it('listResource forwards node_type and maps the tree recursively', async () => {
    const child = row({
      id: 2,
      name: 'Sales Dashboard',
      nodeType: 'leaf',
      children: [],
    });
    const tree = [
      row({
        id: 1,
        name: 'Reports',
        nodeType: 'folder',
        type: null,
        children: [child],
      }),
    ];
    service.listResource.mockResolvedValue(tree);
    const out = await controller.listResource({ node_type: 'leaf' });
    expect(service.listResource).toHaveBeenCalledWith('leaf');
    expect(out).toEqual([
      {
        id: 1,
        name: 'Reports',
        pid: 1,
        node_type: 'folder',
        leaf: false,
        type: null,
        create_time: T0.getTime(),
        update_time: T0.getTime(),
        children: [
          {
            id: 2,
            name: 'Sales Dashboard',
            pid: 1,
            node_type: 'leaf',
            leaf: true,
            type: 'dashboard',
            create_time: T0.getTime(),
            update_time: T0.getTime(),
            children: [],
          },
        ],
      },
    ]);
  });

  it('listResource forwards an absent node_type as undefined', async () => {
    service.listResource.mockResolvedValue([]);
    await expect(controller.listResource({})).resolves.toEqual([]);
    expect(service.listResource).toHaveBeenCalledWith(undefined);
  });

  it('loadResource parses the id, stringifies canvas JSON and surfaces user names', async () => {
    service.loadResource.mockResolvedValue(
      row({ createName: 'Alice', updateName: 'Bob' }),
    );
    const out = await controller.loadResource({ id: '2' });
    expect(service.loadResource).toHaveBeenCalledWith(2);
    expect(out).toEqual({
      id: 2,
      name: 'Sales Dashboard',
      pid: 1,
      workspace_id: 1,
      org_id: null,
      level: 2,
      node_type: 'leaf',
      type: 'dashboard',
      canvas_style_data: '{"style":1}',
      component_data: '[{"c":1}]',
      canvas_view_info: '{}',
      mobile_layout: null,
      status: 1,
      version: 3,
      content_id: null,
      create_time: T0.getTime(),
      update_time: T0.getTime(),
      create_by: 1,
      update_by: 2,
      create_name: 'Alice',
      update_name: 'Bob',
    });
  });

  it('loadResource 400s (translated) on a non-integer id', async () => {
    await expect(controller.loadResource({ id: '2.5' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.loadResource({ id: '2.5' })).rejects.toThrow(
      'id must be an integer',
    );
    expect(service.loadResource).not.toHaveBeenCalled();
  });

  // ─── create / update ───────────────────────────────────────────────────

  it('createResource maps the folder row (no opts → create_name/update_name null)', async () => {
    service.createResource.mockResolvedValue(
      row({ id: 5, nodeType: 'folder', status: 'disabled' }),
    );
    const body = { name: 'Reports', node_type: 'folder' };
    const out = await controller.createResource(body);
    expect(service.createResource).toHaveBeenCalledWith(body);
    expect(out).toMatchObject({
      id: 5,
      node_type: 'folder',
      status: 0,
      create_name: null,
      update_name: null,
    });
  });

  it('createCanvas delegates and maps the leaf row', async () => {
    service.createCanvas.mockResolvedValue(row({ id: 6 }));
    const body = { name: 'New canvas', pid: 1 };
    const out = await controller.createCanvas(body);
    expect(service.createCanvas).toHaveBeenCalledWith(body);
    expect(out).toMatchObject({ id: 6, node_type: 'leaf' });
  });

  it('updateResource parses the body id before delegating', async () => {
    service.updateResource.mockResolvedValue(row({ id: 2, name: 'v2' }));
    const body = { id: '2', name: 'v2' };
    const out = await controller.updateResource(body);
    expect(service.updateResource).toHaveBeenCalledWith(2, body);
    expect(out).toMatchObject({ id: 2, name: 'v2' });
  });

  it('updateResource 400s on a non-integer id', async () => {
    await expect(
      controller.updateResource({ id: 'abc', name: 'x' }),
    ).rejects.toThrow('id must be an integer');
    expect(service.updateResource).not.toHaveBeenCalled();
  });

  it('updateCanvas accepts a numeric id and forwards the body', async () => {
    service.updateCanvas.mockResolvedValue(row({ id: 2, name: 'v3' }));
    const body = { id: 2, name: 'v3', component_data: '[]' };
    const out = await controller.updateCanvas(body);
    expect(service.updateCanvas).toHaveBeenCalledWith(2, body);
    expect(out).toMatchObject({ id: 2, name: 'v3' });
  });

  it('updateCanvas 400s on a junk id', async () => {
    await expect(
      controller.updateCanvas({ id: '1e3', name: 'x' }),
    ).rejects.toThrow('id must be an integer');
    expect(service.updateCanvas).not.toHaveBeenCalled();
  });

  // ─── check_name ────────────────────────────────────────────────────────

  it('checkName returns the raw availability boolean', async () => {
    service.validateName.mockResolvedValue(true);
    const body = { name: 'Reports', opt: 'create', pid: null };
    await expect(controller.checkName(body)).resolves.toBe(true);
    expect(service.validateName).toHaveBeenCalledWith(body);

    service.validateName.mockResolvedValue(false);
    await expect(
      controller.checkName({ name: 'Reports', opt: 'update', id: '2' }),
    ).resolves.toBe(false);
  });

  // ─── delete / move ─────────────────────────────────────────────────────

  it('deleteResource parses the route id and delegates', async () => {
    service.remove.mockResolvedValue({ success: true });
    await expect(controller.deleteResource('7', 'Reports')).resolves.toEqual({
      success: true,
    });
    expect(service.remove).toHaveBeenCalledWith(7);
  });

  it('deleteResource 400s on a junk id', async () => {
    await expect(controller.deleteResource('#7', 'Reports')).rejects.toThrow(
      'id must be an integer',
    );
    expect(service.remove).not.toHaveBeenCalled();
  });

  describe('moveResource pid normalization', () => {
    it.each([
      ['root', null],
      ['0', null],
      ['', null],
      [null, null],
      [undefined, null],
      ['9', 9],
      [12, 12],
    ])('pid %p → %p', async (pid, expected) => {
      service.moveResource.mockResolvedValue({ success: true });
      await expect(controller.moveResource('5', { pid })).resolves.toEqual({
        success: true,
      });
      expect(service.moveResource).toHaveBeenCalledWith(5, expected);
    });

    it('400s (translated) on a junk pid', async () => {
      await expect(
        controller.moveResource('5', { pid: 'folder-9' }),
      ).rejects.toThrow('id must be an integer');
      expect(service.moveResource).not.toHaveBeenCalled();
    });

    it('400s on a junk route id', async () => {
      await expect(controller.moveResource('x', { pid: '9' })).rejects.toThrow(
        'id must be an integer',
      );
      expect(service.moveResource).not.toHaveBeenCalled();
    });
  });

  // ─── @SystemLog audit metadata (normally invoked by the audit
  //     interceptor with the handler's return value) ──────────────────────

  it('create/update @SystemLog resources callbacks extract name+id', () => {
    for (const method of [
      'createResource',
      'createCanvas',
      'updateResource',
      'updateCanvas',
    ]) {
      const cfg = Reflect.getMetadata(
        SYSTEMLOG_KEY,
        DashboardController.prototype[method as keyof DashboardController],
      ) as LogConfig;
      expect(cfg.resources({ id: 2, name: 'Sales Dashboard' })).toEqual([
        { name: 'Sales Dashboard', originId: 2 },
      ]);
    }
  });
});
