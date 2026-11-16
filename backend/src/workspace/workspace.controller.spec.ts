// WorkspaceController spec — locks the /system/workspace wiring plus the
// controller-owned contracts: the uws pager/option/lookup snake mappings
// (name falls back to account), oid query coercion (undefined stays
// undefined, string becomes number), the uwsOption empty-keyword early
// `return null` (missing AND blank keyword), create/update forwarding with
// description spread conditionally and Number(id) coercion, the 400 on a
// falsy update id (frontend sends `id: ''` on create-style bodies), and the
// admin archive/restore/permanent delegations.
import { BadRequestException } from '@nestjs/common';
import { WorkspaceController } from './workspace.controller';
import { WorkspaceService } from './workspace.service';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import type { LogConfig } from '../audit/log-config.interface';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const T0 = new Date('2026-04-05T06:07:08.901Z');

const user = { id: 1, account: 'admin', oid: 1, language: 'en' };

describe('WorkspaceController', () => {
  let service: Record<string, jest.Mock>;
  let controller: WorkspaceController;

  beforeEach(() => {
    setI18n(createTestI18n());
    service = {
      uwsPager: jest.fn(),
      uwsOptionPager: jest.fn(),
      uwsOption: jest.fn(),
      uwsCreate: jest.fn(),
      uwsUpdate: jest.fn(),
      uwsDelete: jest.fn(),
      findArchived: jest.fn(),
      restore: jest.fn(),
      permanentRemove: jest.fn(),
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      archive: jest.fn(),
    };
    controller = new WorkspaceController(
      service as unknown as WorkspaceService,
    );
  });

  // ─── uws pager / option (member management) ────────────────────────────

  it('uwsPager coerces the oid query and maps items via toUwsItemSnake', async () => {
    // name null → falls back to account; email undefined → null
    service.uwsPager.mockResolvedValue({
      items: [
        {
          id: 9,
          name: null,
          account: 'ops@x',
          status: 1,
          weight: 2,
          createdAt: T0,
        },
      ],
      total: 1,
    });
    const out = await controller.uwsPager(1, 20, user, '2', 'ops');
    expect(service.uwsPager).toHaveBeenCalledWith(1, 20, user, 2, 'ops');
    expect(out).toEqual({
      total: 1,
      items: [
        {
          id: 9,
          name: 'ops@x',
          account: 'ops@x',
          status: 1,
          email: null,
          weight: 2,
          create_time: T0.toISOString(),
        },
      ],
    });
  });

  it('uwsPager keeps oid undefined when the query param is absent', async () => {
    service.uwsPager.mockResolvedValue({ items: [], total: 0 });
    await controller.uwsPager(1, 20, user, undefined, undefined);
    expect(service.uwsPager).toHaveBeenCalledWith(
      1,
      20,
      user,
      undefined,
      undefined,
    );
  });

  it('uwsOptionPager maps unbound users via toUserSnake', async () => {
    service.uwsOptionPager.mockResolvedValue({
      items: [
        { id: 11, account: 'new@x', name: null, status: 1, createdAt: T0 },
      ],
      total: 1,
    });
    const out = await controller.uwsOptionPager(1, 20, user, 2, 'new');
    expect(service.uwsOptionPager).toHaveBeenCalledWith(1, 20, user, 2, 'new');
    expect(out).toEqual({
      total: 1,
      items: [
        {
          id: 11,
          name: 'new@x',
          account: 'new@x',
          status: 1,
          email: null,
          create_time: T0.toISOString(),
        },
      ],
    });
  });

  it('uwsOption returns null early for a missing keyword (no service call)', async () => {
    await expect(controller.uwsOption(undefined)).resolves.toBeNull();
    expect(service.uwsOption).not.toHaveBeenCalled();
  });

  it('uwsOption returns null early for a blank keyword (no service call)', async () => {
    await expect(controller.uwsOption('')).resolves.toBeNull();
    expect(service.uwsOption).not.toHaveBeenCalled();
  });

  it('uwsOption maps the found user via toUserSnake', async () => {
    service.uwsOption.mockResolvedValue({
      id: 11,
      account: 'new@x',
      name: 'New',
      status: 1,
      createdAt: T0,
    });
    const out = await controller.uwsOption('new');
    expect(service.uwsOption).toHaveBeenCalledWith('new');
    expect(out).toEqual({
      id: 11,
      name: 'New',
      account: 'new@x',
      status: 1,
      email: null,
      create_time: T0.toISOString(),
    });
  });

  it('uwsOption returns null when no user matches', async () => {
    service.uwsOption.mockResolvedValue(null);
    await expect(controller.uwsOption('ghost')).resolves.toBeNull();
  });

  it('uwsCreate / uwsUpdate / uwsDelete forward dto + user', async () => {
    service.uwsCreate.mockResolvedValue({ success: true });
    const dto = { uid_list: [9], oid: 2, weight: 2 };
    await expect(controller.uwsCreate(user, dto)).resolves.toEqual({
      success: true,
    });
    expect(service.uwsCreate).toHaveBeenCalledWith(dto, user);

    service.uwsUpdate.mockResolvedValue({ success: true });
    const upd = { uid: 9, oid: 2, weight: 0 };
    await expect(controller.uwsUpdate(upd)).resolves.toEqual({
      success: true,
    });
    expect(service.uwsUpdate).toHaveBeenCalledWith(upd);

    service.uwsDelete.mockResolvedValue({ success: true });
    const del = { uid_list: [9], oid: 2 };
    await expect(controller.uwsDelete(user, del)).resolves.toEqual({
      success: true,
    });
    expect(service.uwsDelete).toHaveBeenCalledWith(del, user);
  });

  // ─── archive / restore / permanent (admin) ─────────────────────────────

  it('findArchived maps rows including the archived_at timestamp', async () => {
    service.findArchived.mockResolvedValue([
      {
        id: 2,
        name: 'old',
        description: null,
        archivedAt: T0,
        createdAt: T0,
      },
    ]);
    const out = await controller.findArchived();
    expect(out).toEqual([
      {
        id: 2,
        name: 'old',
        description: null,
        create_time: T0.toISOString(),
        archived_at: T0.toISOString(),
      },
    ]);
  });

  it('restore / permanentRemove / archive delegate by id', async () => {
    service.restore.mockResolvedValue({ success: true });
    await expect(controller.restore(2)).resolves.toEqual({ success: true });
    expect(service.restore).toHaveBeenCalledWith(2);

    service.permanentRemove.mockResolvedValue({ success: true });
    await expect(controller.permanentRemove(2)).resolves.toEqual({
      success: true,
    });
    expect(service.permanentRemove).toHaveBeenCalledWith(2);

    service.archive.mockResolvedValue({ success: true });
    await expect(controller.archive(2)).resolves.toEqual({ success: true });
    expect(service.archive).toHaveBeenCalledWith(2);
  });

  // ─── workspace CRUD ────────────────────────────────────────────────────

  it('findAll maps rows, surfacing member_count when _count exists', async () => {
    service.findAll.mockResolvedValue([
      {
        id: 1,
        name: 'ws',
        description: 'd',
        createdAt: T0,
        _count: { users: 5 },
      },
    ]);
    const out = await controller.findAll();
    expect(out).toEqual([
      {
        id: 1,
        name: 'ws',
        description: 'd',
        create_time: T0.toISOString(),
        archived_at: null,
        member_count: 5,
      },
    ]);
  });

  it('findOne maps a single row', async () => {
    service.findOne.mockResolvedValue({
      id: 1,
      name: 'ws',
      description: null,
      createdAt: T0,
    });
    const out = await controller.findOne(1);
    expect(service.findOne).toHaveBeenCalledWith(1);
    // no _count on the row → member_count key omitted entirely
    expect(out).toEqual({
      id: 1,
      name: 'ws',
      description: null,
      create_time: T0.toISOString(),
      archived_at: null,
    });
  });

  it('create forwards name + description when present', async () => {
    service.create.mockResolvedValue({
      id: 3,
      name: 'new-ws',
      description: 'd',
      createdAt: T0,
    });
    const out = await controller.create({ name: 'new-ws', description: 'd' });
    expect(service.create).toHaveBeenCalledWith({
      name: 'new-ws',
      description: 'd',
    });
    expect(out).toMatchObject({ id: 3, name: 'new-ws' });
  });

  it('create omits the description key entirely when absent', async () => {
    service.create.mockResolvedValue({
      id: 3,
      name: 'new-ws',
      description: null,
      createdAt: T0,
    });
    await controller.create({ name: 'new-ws' });
    expect(service.create).toHaveBeenCalledWith({ name: 'new-ws' });
  });

  it('update 400s on a falsy id (frontend sends id: "" on create bodies)', async () => {
    await expect(controller.update({ name: 'x', id: '' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.update({ name: 'x', id: '' })).rejects.toThrow(
      'id is required',
    );
    expect(service.update).not.toHaveBeenCalled();
  });

  it('update coerces a string id to number and maps the row', async () => {
    service.update.mockResolvedValue({
      id: 3,
      name: 'renamed',
      description: 'd',
      createdAt: T0,
    });
    const out = await controller.update({ id: '3', name: 'renamed' });
    expect(service.update).toHaveBeenCalledWith({
      id: 3,
      name: 'renamed',
    });
    expect(out).toMatchObject({ id: 3, name: 'renamed' });
  });

  it('update forwards the description when provided', async () => {
    service.update.mockResolvedValue({
      id: 3,
      name: 'ws',
      description: 'd2',
      createdAt: T0,
    });
    await controller.update({ id: 3, name: 'ws', description: 'd2' });
    expect(service.update).toHaveBeenCalledWith({
      id: 3,
      name: 'ws',
      description: 'd2',
    });
  });

  // ─── @SystemLog audit metadata (normally invoked by the audit
  //     interceptor with the handler's return value) ──────────────────────

  it('create @SystemLog resources callback extracts name+id', () => {
    const cfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      WorkspaceController.prototype.create,
    ) as LogConfig;
    expect(cfg.resources({ name: 'ws', id: 3 })).toEqual([
      { name: 'ws', originId: 3 },
    ]);
  });
});
