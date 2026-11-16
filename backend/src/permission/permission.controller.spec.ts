// PermissionController spec — locks the /ds_permission wire contract. All
// three routes are thin delegation (list bare array, save with the validated
// DTO body, delete by parsed rule-group id); expression-tree validation and
// Prisma cascades live in permission.service.spec.
import { PermissionController } from './permission.controller';
import { PermissionService } from './permission.service';

describe('PermissionController', () => {
  let permissionService: {
    list: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
  };
  let controller: PermissionController;

  beforeEach(() => {
    permissionService = {
      list: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };
    controller = new PermissionController(
      permissionService as unknown as PermissionService,
    );
  });

  it('list delegates to the service', async () => {
    const rows = [{ id: 1, name: 'gold-tier' }];
    permissionService.list.mockResolvedValue(rows);
    await expect(controller.list()).resolves.toEqual(rows);
    expect(permissionService.list).toHaveBeenCalled();
  });

  it('save forwards the dto body verbatim', async () => {
    const body = {
      name: 'gold-tier',
      datasource_id: 2,
      problem_info: [{ flag: 'and', filter: [] }],
    };
    permissionService.save.mockResolvedValue({ id: 1, name: 'gold-tier' });
    await expect(controller.save(body as never)).resolves.toEqual({
      id: 1,
      name: 'gold-tier',
    });
    expect(permissionService.save).toHaveBeenCalledWith(body);
  });

  it('remove forwards the parsed rule-group id', async () => {
    permissionService.remove.mockResolvedValue([{ id: 1 }]);
    await expect(controller.remove(1)).resolves.toEqual([{ id: 1 }]);
    expect(permissionService.remove).toHaveBeenCalledWith(1);
  });
});
