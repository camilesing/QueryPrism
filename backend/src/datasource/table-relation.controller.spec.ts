// TableRelationController spec — locks the route → DatasourceService wiring
// for the X6 relation-graph surface: bare-array body passthrough (save),
// `?? []` fallback for a missing body, query-param coercion for the versions
// pager (Number(x) || default so junk strings fall back, not NaN), and the
// ParseIntPipe-guarded restore/compare delegations. The controller holds no
// other logic — relation normalization lives in m-schema.builder.ts.
import { TableRelationController } from './table-relation.controller';
import { DatasourceService } from './datasource.service';
import { TableRelationCompareDto } from '../common/dtos';

describe('TableRelationController', () => {
  let ds: {
    getTableRelation: jest.Mock;
    saveTableRelation: jest.Mock;
    getTableRelationVersions: jest.Mock;
    restoreTableRelation: jest.Mock;
    compareTableRelation: jest.Mock;
  };
  let controller: TableRelationController;

  beforeEach(() => {
    ds = {
      getTableRelation: jest.fn(),
      saveTableRelation: jest.fn(),
      getTableRelationVersions: jest.fn(),
      restoreTableRelation: jest.fn(),
      compareTableRelation: jest.fn(),
    };
    controller = new TableRelationController(
      ds as unknown as DatasourceService,
    );
  });

  it('get coerces the id and delegates', async () => {
    const cells = [{ shape: 'edge' }];
    ds.getTableRelation.mockResolvedValue(cells);
    await expect(controller.get('3')).resolves.toBe(cells);
    expect(ds.getTableRelation).toHaveBeenCalledWith(3);
  });

  it('save stores the bare cells array verbatim', async () => {
    const cells = [
      { shape: 'edge', source: { cell: 't1', port: 'f1' } },
      { shape: 'node' },
    ];
    ds.saveTableRelation.mockResolvedValue({ success: true });
    await expect(controller.save('3', cells)).resolves.toEqual({
      success: true,
    });
    expect(ds.saveTableRelation).toHaveBeenCalledWith(3, cells);
  });

  it('save normalizes a missing body to an empty cells array', async () => {
    ds.saveTableRelation.mockResolvedValue({ success: true });
    await expect(
      controller.save('3', undefined as unknown as unknown[]),
    ).resolves.toEqual({ success: true });
    expect(ds.saveTableRelation).toHaveBeenCalledWith(3, []);
  });

  it('versions forwards parsed pagination', async () => {
    const page = { items: [], total: 0 };
    ds.getTableRelationVersions.mockResolvedValue(page);
    await expect(controller.versions('3', '2', '50')).resolves.toBe(page);
    expect(ds.getTableRelationVersions).toHaveBeenCalledWith(3, 2, 50);
  });

  it('versions falls back to 1/20 when the query strings are junk', async () => {
    ds.getTableRelationVersions.mockResolvedValue({ items: [], total: 0 });
    await controller.versions('3', 'abc', '0');
    expect(ds.getTableRelationVersions).toHaveBeenCalledWith(3, 1, 20);
  });

  it('versions defaults when no query params are supplied', async () => {
    ds.getTableRelationVersions.mockResolvedValue({ items: [], total: 0 });
    await controller.versions('3');
    expect(ds.getTableRelationVersions).toHaveBeenCalledWith(3, 1, 20);
  });

  it('restore delegates with already-piped numbers', async () => {
    ds.restoreTableRelation.mockResolvedValue({ success: true });
    await expect(controller.restore(3, 5)).resolves.toEqual({ success: true });
    expect(ds.restoreTableRelation).toHaveBeenCalledWith(3, 5);
  });

  it('compare forwards from/to versions', async () => {
    const diff = { added: [], removed: [] };
    ds.compareTableRelation.mockResolvedValue(diff);
    const dto: TableRelationCompareDto = { from_version: 2, to_version: 5 };
    await expect(controller.compare(3, dto)).resolves.toBe(diff);
    expect(ds.compareTableRelation).toHaveBeenCalledWith(3, 2, 5);
  });

  it('compare forwards an undefined to_version (newest saved)', async () => {
    ds.compareTableRelation.mockResolvedValue({ added: [], removed: [] });
    await controller.compare(3, { from_version: 1 });
    expect(ds.compareTableRelation).toHaveBeenCalledWith(3, 1, undefined);
  });
});
