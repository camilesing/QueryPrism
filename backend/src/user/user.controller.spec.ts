// UserController spec — locks the route → UserService wiring plus the
// in-controller contracts: toUserSnake mapping applied on pager/getOne/
// create/update/updateStatus returns (oid_list derived from userWorkspaces),
// Number.isFinite 4xx guards on :key ids (getOne/remove), translated 400s
// for missing id / missing upload, and the two @Res blob routes
// (exportTemplate xlsx headers + send, errorRecord res.download). Self-
// service routes are thin delegations asserted with called-with.
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateLanguageDto } from './dto/update-language.dto';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import type { LogConfig } from '../audit/log-config.interface';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const T0 = new Date('2026-02-03T04:05:06.789Z');

/** Raw service row (Prisma User + userWorkspaces include) the mapper reads. */
const userRow = {
  id: 9,
  account: 'ops@x',
  name: 'Ops',
  email: 'ops@x.io',
  oid: 1,
  status: 1,
  origin: 0,
  language: 'en',
  systemVariables: [{ variableId: 1, variableValue: 'a' }],
  createdAt: T0,
  updatedAt: T0,
  userWorkspaces: [{ oid: 1 }, { oid: 2 }],
};

const USER_SNAKE = {
  id: 9,
  account: 'ops@x',
  name: 'Ops',
  email: 'ops@x.io',
  oid: 1,
  oid_list: [1, 2],
  status: 1,
  origin: 0,
  language: 'en',
  system_variables: [{ variableId: 1, variableValue: 'a' }],
  create_time: T0.toISOString(),
  update_time: T0.toISOString(),
};

describe('UserController', () => {
  let userService: Record<string, jest.Mock>;
  let controller: UserController;

  beforeEach(() => {
    setI18n(createTestI18n());
    userService = {
      getInfo: jest.fn(),
      getWorkspaceOptions: jest.fn(),
      updateOwnLanguage: jest.fn(),
      changeOwnPassword: jest.fn(),
      switchWorkspace: jest.fn(),
      getDefaultPwd: jest.fn(),
      exportTemplate: jest.fn(),
      resolveErrorRecord: jest.fn(),
      clearErrorRecord: jest.fn(),
      pager: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      importUsers: jest.fn(),
      update: jest.fn(),
      resetToDefaultPassword: jest.fn(),
      updateStatus: jest.fn(),
      remove: jest.fn(),
      removeBatch: jest.fn(),
    };
    controller = new UserController(userService as unknown as UserService);
  });

  // ─── self-service ───────────────────────────────────────────────────────

  it('info / wsOptions forward the current user', () => {
    const user = { id: 9, account: 'ops@x', oid: 1, language: 'en' };
    userService.getInfo.mockReturnValue({ account: 'ops@x' });
    expect(controller.info(user)).toEqual({ account: 'ops@x' });
    expect(userService.getInfo).toHaveBeenCalledWith(user);

    userService.getWorkspaceOptions.mockReturnValue([{ id: 1, name: 'ws' }]);
    expect(controller.wsOptions(user)).toEqual([{ id: 1, name: 'ws' }]);
    expect(userService.getWorkspaceOptions).toHaveBeenCalledWith(user);
  });

  it('updateOwnLanguage forwards user + language', async () => {
    const user = { id: 9, account: 'ops@x', oid: 1, language: 'en' };
    userService.updateOwnLanguage.mockResolvedValue({ success: true });
    const dto = { language: 'zh-CN' } as UpdateLanguageDto;
    await controller.updateOwnLanguage(user, dto);
    expect(userService.updateOwnLanguage).toHaveBeenCalledWith(user, 'zh-CN');
  });

  it('changeOwnPassword forwards both passwords', async () => {
    const user = { id: 9, account: 'ops@x', oid: 1, language: 'en' };
    userService.changeOwnPassword.mockResolvedValue({ success: true });
    await controller.changeOwnPassword(user, { pwd: 'old', new_pwd: 'new' });
    expect(userService.changeOwnPassword).toHaveBeenCalledWith(
      user,
      'old',
      'new',
    );
  });

  it('switchWorkspace coerces the oid', async () => {
    const user = { id: 9, account: 'ops@x', oid: 1, language: 'en' };
    userService.switchWorkspace.mockResolvedValue({ success: true });
    await controller.switchWorkspace(user, '2');
    expect(userService.switchWorkspace).toHaveBeenCalledWith(user, 2);
  });

  // ─── mgmt extras (@Res blob routes) ─────────────────────────────────────

  it('exportTemplate sets xlsx headers and sends the buffer', async () => {
    const buffer = Buffer.from('template-xlsx');
    userService.exportTemplate.mockResolvedValue(buffer);
    const res = { set: jest.fn(), send: jest.fn() } as unknown as Response;
    await controller.exportTemplate(res);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="user-template.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buffer);
  });

  it('errorRecord downloads the resolved path under the key name', async () => {
    userService.resolveErrorRecord.mockResolvedValue('/tmp/err/abc.xlsx');
    const res = { download: jest.fn() } as unknown as Response;
    await controller.errorRecord('abc', res);
    expect(res.download).toHaveBeenCalledWith('/tmp/err/abc.xlsx', 'abc');
  });

  it('clearErrorRecord delegates by key', async () => {
    userService.clearErrorRecord.mockResolvedValue({ success: true });
    await expect(controller.clearErrorRecord('abc')).resolves.toEqual({
      success: true,
    });
    expect(userService.clearErrorRecord).toHaveBeenCalledWith('abc');
  });

  // ─── pager + snake mapping ──────────────────────────────────────────────

  it('pager maps list rows to snake items and keeps total', async () => {
    userService.pager.mockResolvedValue({ total: 1, list: [userRow] });
    const out = await controller.pager('2', '10', 'ops');
    expect(userService.pager).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      keyword: 'ops',
    });
    expect(out).toEqual({ total: 1, items: [USER_SNAKE] });
  });

  it('pager tolerates a missing keyword', async () => {
    userService.pager.mockResolvedValue({ total: 0, list: [] });
    const out = await controller.pager('1', '20');
    expect(userService.pager).toHaveBeenCalledWith({
      page: 1,
      pageSize: 20,
      keyword: undefined,
    });
    expect(out.items).toEqual([]);
  });

  // ─── getOne / remove (Number.isFinite guards) ──────────────────────────

  it('getOne 400s (translated) on a non-numeric key', async () => {
    await expect(controller.getOne('abc')).rejects.toMatchObject({
      message: 'Invalid user id',
    });
    expect(userService.findOne).not.toHaveBeenCalled();
  });

  it('getOne 400s (translated) when no user matches the numeric key', async () => {
    userService.findOne.mockResolvedValue(null);
    await expect(controller.getOne('99')).rejects.toMatchObject({
      message: 'User #99 not found',
    });
    expect(userService.findOne).toHaveBeenCalledWith(99);
  });

  it('getOne maps the found user to snake_case', async () => {
    userService.findOne.mockResolvedValue(userRow);
    await expect(controller.getOne('9')).resolves.toEqual(USER_SNAKE);
  });

  it('remove 400s (translated) on a non-numeric key (sync throw)', () => {
    expect(() => controller.remove('abc')).toThrow(BadRequestException);
    expect(() => controller.remove('abc')).toThrow('Invalid user id');
    expect(userService.remove).not.toHaveBeenCalled();
  });

  it('remove deletes by numeric id', async () => {
    userService.remove.mockResolvedValue({ success: true });
    await expect(controller.remove('7')).resolves.toEqual({ success: true });
    expect(userService.remove).toHaveBeenCalledWith(7);
  });

  // ─── create / import / update ──────────────────────────────────────────

  it('create maps the created user to snake_case', async () => {
    const dto = {
      account: 'ops@x',
      pwd: 'pw',
      oid_list: [1, 2],
    } as CreateUserDto;
    userService.create.mockResolvedValue(userRow);
    await expect(controller.create(dto)).resolves.toEqual(USER_SNAKE);
    expect(userService.create).toHaveBeenCalledWith(dto);
  });

  it('importUsers 400s (translated) when no file was uploaded (sync throw)', () => {
    expect(() =>
      controller.importUsers(undefined as Express.Multer.File),
    ).toThrow(BadRequestException);
    expect(() =>
      controller.importUsers(undefined as Express.Multer.File),
    ).toThrow('Please upload an Excel file');
    expect(userService.importUsers).not.toHaveBeenCalled();
  });

  it('importUsers forwards the file buffer', async () => {
    userService.importUsers.mockResolvedValue({ success: true });
    const file = { buffer: Buffer.from('rows'), originalname: 'u.xlsx' };
    await expect(
      controller.importUsers(file as Express.Multer.File),
    ).resolves.toEqual({ success: true });
    expect(userService.importUsers).toHaveBeenCalledWith(file.buffer);
  });

  it('getDefaultPwd delegates', () => {
    userService.getDefaultPwd.mockReturnValue('queryprism@666');
    expect(controller.getDefaultPwd()).toBe('queryprism@666');
    expect(userService.getDefaultPwd).toHaveBeenCalled();
  });

  it('update 400s (translated) when dto.id is undefined', async () => {
    await expect(controller.update({ account: 'ops@x' })).rejects.toMatchObject(
      {
        message: 'Missing user id',
      },
    );
    expect(userService.update).not.toHaveBeenCalled();
  });

  it('update forwards id + body and maps the result', async () => {
    const dto = { id: 9, name: 'Ops2' } as UpdateUserDto;
    userService.update.mockResolvedValue({ ...userRow, name: 'Ops2' });
    const out = await controller.update(dto);
    expect(userService.update).toHaveBeenCalledWith(9, dto);
    expect(out).toEqual({ ...USER_SNAKE, name: 'Ops2' });
  });

  // ─── password / status / batch delete ──────────────────────────────────

  it('resetPassword coerces the id', async () => {
    userService.resetToDefaultPassword.mockResolvedValue({ success: true });
    await expect(controller.resetPassword('9')).resolves.toEqual({
      success: true,
    });
    expect(userService.resetToDefaultPassword).toHaveBeenCalledWith(9);
  });

  it('updateStatus forwards id + status and maps the result', async () => {
    const dto = { id: 9, status: 0 };
    userService.updateStatus.mockResolvedValue(userRow);
    await expect(controller.updateStatus(dto)).resolves.toEqual(USER_SNAKE);
    expect(userService.updateStatus).toHaveBeenCalledWith(9, 0);
  });

  it('removeBatch forwards the id array', async () => {
    userService.removeBatch.mockResolvedValue({ success: true });
    await expect(controller.removeBatch({ ids: [1, 2] })).resolves.toEqual({
      success: true,
    });
    expect(userService.removeBatch).toHaveBeenCalledWith([1, 2]);
  });

  // ─── @SystemLog audit metadata (normally invoked by the audit
  //     interceptor with the handler's return value) ──────────────────────

  it('create/updateStatus @SystemLog resources callbacks extract account+id', () => {
    const createCfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      UserController.prototype.create,
    ) as LogConfig;
    expect(createCfg.resources(USER_SNAKE)).toEqual([
      { name: 'ops@x', originId: 9 },
    ]);

    const updateCfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      UserController.prototype.update,
    ) as LogConfig;
    expect(updateCfg.resources(USER_SNAKE)).toEqual([
      { name: 'ops@x', originId: 9 },
    ]);

    const statusCfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      UserController.prototype.updateStatus,
    ) as LogConfig;
    expect(statusCfg.resources(USER_SNAKE)).toEqual([
      { name: 'ops@x', originId: 9 },
    ]);
  });
});
