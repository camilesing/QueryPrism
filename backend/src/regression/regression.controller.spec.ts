// RegressionController spec — locks the route → service wiring for the M6
// regression-suite admin surface. The in-controller logic worth pinning:
// query-param coercion (`current_page`/`page_size` strings are clamped to
// page ≥ 1 and size 1..100, with NaN/0 falling back to the defaults via
// `||`), the datasource_id filter ternary, and the upsert DTO's snake→camel
// remap (datasource_id→datasourceId, metric_code→metricCode,
// tolerance_pct→tolerancePct) before the service sees it. The enable route
// maps the 'true'/'false' path string; run forwards `{actor_uid}`.
import { RegressionController } from './regression.controller';
import { RegressionService } from './regression.service';

describe('RegressionController', () => {
  let service: {
    pageCases: jest.Mock;
    upsertCase: jest.Mock;
    removeCase: jest.Mock;
    setCaseEnabled: jest.Mock;
    startRun: jest.Mock;
    listRuns: jest.Mock;
    runDetail: jest.Mock;
    promote: jest.Mock;
  };
  let controller: RegressionController;

  beforeEach(() => {
    service = {
      pageCases: jest.fn(),
      upsertCase: jest.fn(),
      removeCase: jest.fn(),
      setCaseEnabled: jest.fn(),
      startRun: jest.fn(),
      listRuns: jest.fn(),
      runDetail: jest.fn(),
      promote: jest.fn(),
    };
    controller = new RegressionController(
      service as unknown as RegressionService,
    );
  });

  it('listCases forwards oid + datasource filter + clamped pager', async () => {
    service.pageCases.mockResolvedValue({ data: [] });
    await controller.listCases(3, '5', '2', '50');
    expect(service.pageCases).toHaveBeenCalledWith(3, 5, 2, 50);
  });

  it('listCases defaults when called with oid only', async () => {
    service.pageCases.mockResolvedValue({ data: [] });
    await controller.listCases(3);
    expect(service.pageCases).toHaveBeenCalledWith(3, undefined, 1, 20);
  });

  it('listCases clamps bad pages and oversized sizes', async () => {
    service.pageCases.mockResolvedValue({ data: [] });
    // NaN page → 1; NaN size → default 20; '0' size is falsy → default 20
    await controller.listCases(3, '5', 'abc', 'abc');
    expect(service.pageCases).toHaveBeenCalledWith(3, 5, 1, 20);
    await controller.listCases(3, undefined, '0', '0');
    expect(service.pageCases).toHaveBeenCalledWith(3, undefined, 1, 20);
    // size 500 → capped at 100
    await controller.listCases(3, '1', '3', '500');
    expect(service.pageCases).toHaveBeenCalledWith(3, 1, 3, 100);
  });

  it('upsert remaps the snake DTO keys to the camel service payload', async () => {
    const dto = {
      id: 7,
      datasource_id: 2,
      name: 'daily revenue',
      question: 'revenue yesterday?',
      metric_code: 'revenue',
      tolerance_pct: 5,
      enabled: true,
    };
    service.upsertCase.mockResolvedValue(dto);
    await controller.upsert(3, 9, dto);
    expect(service.upsertCase).toHaveBeenCalledWith(3, 9, {
      id: 7,
      datasourceId: 2,
      name: 'daily revenue',
      question: 'revenue yesterday?',
      metricCode: 'revenue',
      tolerancePct: 5,
      enabled: true,
    });
  });

  it('upsert tolerates optional keys being absent', async () => {
    const dto = { datasource_id: 2, name: 'n', question: 'q' };
    service.upsertCase.mockResolvedValue(dto);
    await controller.upsert(3, 9, dto);
    expect(service.upsertCase).toHaveBeenCalledWith(3, 9, {
      id: undefined,
      datasourceId: 2,
      name: 'n',
      question: 'q',
      metricCode: undefined,
      tolerancePct: undefined,
      enabled: undefined,
    });
  });

  it('remove forwards oid + numeric id', async () => {
    service.removeCase.mockResolvedValue({ success: true });
    await controller.remove(3, 12);
    expect(service.removeCase).toHaveBeenCalledWith(3, 12);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('setEnabled maps the path-param "%s" to %s', async (raw, expected) => {
    service.setCaseEnabled.mockResolvedValue({ success: true });
    await controller.setEnabled(3, 12, raw);
    expect(service.setCaseEnabled).toHaveBeenCalledWith(3, 12, expected);
  });

  it('run starts a manual run attributed to the actor uid', async () => {
    service.startRun.mockResolvedValue({ id: 99 });
    await controller.run(3, 9);
    expect(service.startRun).toHaveBeenCalledWith(3, 'manual', {
      actor_uid: 9,
    });
  });

  it('listRuns clamps the same pager as listCases', async () => {
    service.listRuns.mockResolvedValue({ data: [] });
    await controller.listRuns(3);
    expect(service.listRuns).toHaveBeenCalledWith(3, 1, 20);
    await controller.listRuns(3, '0', '500');
    expect(service.listRuns).toHaveBeenCalledWith(3, 1, 100);
    // falsy/NaN page_size falls back to the default 20
    await controller.listRuns(3, '2', 'abc');
    expect(service.listRuns).toHaveBeenCalledWith(3, 2, 20);
    await controller.listRuns(3, '2', '0');
    expect(service.listRuns).toHaveBeenCalledWith(3, 2, 20);
  });

  it('runDetail forwards oid + run id', async () => {
    service.runDetail.mockResolvedValue({ cases: [] });
    await controller.runDetail(3, 99);
    expect(service.runDetail).toHaveBeenCalledWith(3, 99);
  });

  it('promote forwards oid + run id', async () => {
    service.promote.mockResolvedValue({ promoted: 2 });
    await controller.promote(3, 99);
    expect(service.promote).toHaveBeenCalledWith(3, 99);
  });
});
