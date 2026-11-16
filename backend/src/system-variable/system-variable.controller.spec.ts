// SystemVariableController spec — locks the action-style /sys_variable wire
// contract. The controller is thin: optional `{name?}` filter bodies (default
// `{}`), pager params, save delegating with the acting admin's uid, and the
// bare-array delete body. Prisma logic lives in the service.
import { SystemVariableController } from './system-variable.controller';
import { SystemVariableService } from './system-variable.service';

describe('SystemVariableController', () => {
  let svc: {
    listAll: jest.Mock;
    listPage: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
  };
  let controller: SystemVariableController;

  beforeEach(() => {
    svc = {
      listAll: jest.fn(),
      listPage: jest.fn(),
      save: jest.fn(),
      delete: jest.fn(),
    };
    controller = new SystemVariableController(
      svc as unknown as SystemVariableService,
    );
  });

  it('listAll defaults to no name filter when the body is omitted', async () => {
    svc.listAll.mockResolvedValue([]);
    await controller.listAll();
    expect(svc.listAll).toHaveBeenCalledWith(undefined);
  });

  it('listAll forwards the name keyword', async () => {
    svc.listAll.mockResolvedValue([]);
    await controller.listAll({ name: 'quota' });
    expect(svc.listAll).toHaveBeenCalledWith('quota');
  });

  it('listPage forwards pager and optional name filter', async () => {
    svc.listPage.mockResolvedValue({ items: [], total: 0 });
    await controller.listPage(1, 20, { name: 'cache' });
    expect(svc.listPage).toHaveBeenCalledWith(1, 20, 'cache');
  });

  it('listPage works with an omitted body', async () => {
    svc.listPage.mockResolvedValue({ items: [], total: 0 });
    await controller.listPage(2, 5);
    expect(svc.listPage).toHaveBeenCalledWith(2, 5, undefined);
  });

  it('save delegates the dto with the acting user id', async () => {
    const dto = { name: 'top_n', var_type: 'number', value: '5' };
    svc.save.mockResolvedValue({ success: true });
    const user = { id: 1, account: 'admin', oid: 1 };
    await expect(controller.save(dto as never, user as never)).resolves.toEqual(
      {
        success: true,
      },
    );
    expect(svc.save).toHaveBeenCalledWith(dto, 1);
  });

  it('delete forwards the bare id array', async () => {
    svc.delete.mockResolvedValue({ success: true });
    await expect(controller.delete([1, 2])).resolves.toEqual({ success: true });
    expect(svc.delete).toHaveBeenCalledWith([1, 2]);
  });
});
