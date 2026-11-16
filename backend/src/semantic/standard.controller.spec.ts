// StandardController spec — locks the route → service wiring for the M4
// data-standards admin surface. The controller is thin (guards + delegation);
// scope filtering and approval routing live in DataStandardService. Here we
// assert the kind/pager params pass through, the delete body is sanitized to
// integers, and the enable flag accepts both 'true' and '1' spellings.
import { StandardController } from './standard.controller';
import { DataStandardService } from './standard.service';

describe('StandardController', () => {
  let service: {
    page: jest.Mock;
    versions: jest.Mock;
    upsert: jest.Mock;
    remove: jest.Mock;
    setEnabled: jest.Mock;
  };
  let controller: StandardController;

  beforeEach(() => {
    service = {
      page: jest.fn(),
      versions: jest.fn(),
      upsert: jest.fn(),
      remove: jest.fn(),
      setEnabled: jest.fn(),
    };
    controller = new StandardController(
      service as unknown as DataStandardService,
    );
  });

  it('page forwards kind, pager and the optional filters', async () => {
    service.page.mockResolvedValue({ items: [], total: 0 });
    await controller.page('unit', 2, 10, 'GLOBAL', 'length', 'mm');
    expect(service.page).toHaveBeenCalledWith('unit', 2, 10, {
      scope: 'GLOBAL',
      category: 'length',
      keyword: 'mm',
    });
  });

  it('page works without optional query filters (undefined scope/category/keyword)', async () => {
    service.page.mockResolvedValue({ items: [], total: 0 });
    await controller.page('naming', 1, 20);
    expect(service.page).toHaveBeenCalledWith('naming', 1, 20, {
      scope: undefined,
      category: undefined,
      keyword: undefined,
    });
  });

  it('versions delegates by id', async () => {
    service.versions.mockResolvedValue([]);
    await controller.versions(7);
    expect(service.versions).toHaveBeenCalledWith(7);
  });

  it('upsert delegates the dto verbatim', async () => {
    const dto = { kind: 'unit', name: 'mm', scope: 'WORKSPACE' };
    service.upsert.mockResolvedValue(dto);
    await expect(controller.upsert(dto as never)).resolves.toEqual(dto);
    expect(service.upsert).toHaveBeenCalledWith(dto);
  });

  it('remove filters the id body to integers', async () => {
    service.remove.mockResolvedValue({ success: true });
    await controller.remove([1, 2.5, '3' as unknown as number, NaN, 4]);
    expect(service.remove).toHaveBeenCalledWith([1, 4]);
  });

  it('remove passes an empty list when the body is not an array', async () => {
    service.remove.mockResolvedValue({ success: true });
    await controller.remove(undefined as unknown as number[]);
    expect(service.remove).toHaveBeenCalledWith([]);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('setEnabled maps "%s" to %s', async (raw, expected) => {
    service.setEnabled.mockResolvedValue({ success: true });
    await controller.setEnabled(9, raw);
    expect(service.setEnabled).toHaveBeenCalledWith(9, expected);
  });
});
