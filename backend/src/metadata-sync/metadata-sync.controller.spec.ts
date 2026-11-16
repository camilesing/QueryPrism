// MetadataSyncController spec — locks the M5 workspace-admin surface for
// external metadata sync sources. The controller is pure delegation (guards +
// param coercion); fetch/validation/run history live in the service specs.
// Here we assert CRUD calls pass the parsed dto/id, and the manual trigger
// forwards the caller's oid so the runner can reject foreign-tenant sources.
import { MetadataSyncController } from './metadata-sync.controller';
import { MetadataSyncService } from './metadata-sync.service';
import { MetadataSyncRunnerService } from './metadata-sync-runner.service';

describe('MetadataSyncController', () => {
  let sync: {
    list: jest.Mock;
    listRuns: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };
  let runner: { run: jest.Mock };
  let controller: MetadataSyncController;

  beforeEach(() => {
    sync = {
      list: jest.fn(),
      listRuns: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
    };
    runner = { run: jest.fn() };
    controller = new MetadataSyncController(
      sync as unknown as MetadataSyncService,
      runner as unknown as MetadataSyncRunnerService,
    );
  });

  it('list delegates to sync.list', async () => {
    sync.list.mockResolvedValue([]);
    await expect(controller.list()).resolves.toEqual([]);
    expect(sync.list).toHaveBeenCalled();
  });

  it('runs forwards source id and pager', async () => {
    sync.listRuns.mockResolvedValue({ items: [], total: 0 });
    await controller.runs(4, 2, 10);
    expect(sync.listRuns).toHaveBeenCalledWith(4, 2, 10);
  });

  it('create delegates the upsert dto', async () => {
    const dto = { name: 'wiki', kind: 'HTTP_API', target: 'semantic' };
    sync.create.mockResolvedValue({ id: 4, name: 'wiki' });
    await expect(controller.create(dto as never)).resolves.toEqual({
      id: 4,
      name: 'wiki',
    });
    expect(sync.create).toHaveBeenCalledWith(dto);
  });

  it('update delegates the upsert dto', async () => {
    const dto = { id: 4, name: 'wiki2' };
    sync.update.mockResolvedValue({ id: 4, name: 'wiki2' });
    await expect(controller.update(dto as never)).resolves.toEqual({
      id: 4,
      name: 'wiki2',
    });
    expect(sync.update).toHaveBeenCalledWith(dto);
  });

  it('remove forwards the parsed id', async () => {
    sync.remove.mockResolvedValue({ success: true });
    await controller.remove(4);
    expect(sync.remove).toHaveBeenCalledWith(4);
  });

  it('run forwards id, manual trigger and the caller oid', async () => {
    const runRow = { id: 9, status: 'success' };
    runner.run.mockResolvedValue(runRow);
    await expect(controller.run(4, 7)).resolves.toEqual(runRow);
    expect(runner.run).toHaveBeenCalledWith(4, 'manual', 7);
  });
});
