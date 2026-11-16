// MetricController spec — locks the route → service wiring for the M4
// metric-system admin surface (metric + standard share the approval inbox).
// In-controller logic worth pinning: the datasource_id query param is
// coerced to a positive finite number or dropped; the approval box maps
// 'mine' vs pending AND the shared-inbox entityType filter
// ['metric','standard'] rides along; the delete body is sanitized to
// integers (empty list when not an array); the enable flag accepts both
// 'true' and '1'; uploadExcel (OPTIONAL file) throws a plain BadRequest
// when the file or its buffer is missing/empty; export reads the six-sheet
// xlsx blob from the import service via @Res().
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { MetricController } from './metric.controller';
import { MetricService } from './metric.service';
import { MetricImportService } from './metric-import.service';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mkRes() {
  return {
    set: jest.fn(),
    send: jest.fn(),
  } as unknown as Response & { set: jest.Mock; send: jest.Mock };
}

describe('MetricController', () => {
  let service: {
    page: jest.Mock;
    versions: jest.Mock;
    pageRequests: jest.Mock;
    upsert: jest.Mock;
    reviewShared: jest.Mock;
    remove: jest.Mock;
    setEnabled: jest.Mock;
  };
  let importService: { exportAll: jest.Mock; importExcel: jest.Mock };
  let controller: MetricController;

  beforeEach(() => {
    service = {
      page: jest.fn(),
      versions: jest.fn(),
      pageRequests: jest.fn(),
      upsert: jest.fn(),
      reviewShared: jest.fn(),
      remove: jest.fn(),
      setEnabled: jest.fn(),
    };
    importService = {
      exportAll: jest.fn(),
      importExcel: jest.fn(),
    };
    controller = new MetricController(
      service as unknown as MetricService,
      importService as unknown as MetricImportService,
    );
  });

  it('page forwards kind, pager and coerced datasource_id', async () => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page('atomic', 2, 10, 'WORKSPACE', '5', 'kw');
    expect(service.page).toHaveBeenCalledWith('atomic', 2, 10, {
      scope: 'WORKSPACE',
      datasourceId: 5,
      keyword: 'kw',
    });
  });

  it.each([
    ['abc'], // NaN → dropped
    ['0'], // not > 0 → dropped
    ['-3'], // negative → dropped
    [undefined], // absent → dropped
  ])('page drops an unusable datasource_id (%s)', async (raw) => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page('atomic', 1, 20, undefined, raw);
    expect(service.page).toHaveBeenCalledWith('atomic', 1, 20, {
      scope: undefined,
      datasourceId: undefined,
      keyword: undefined,
    });
  });

  it('versions delegates by id', async () => {
    service.versions.mockResolvedValue([]);
    await controller.versions(7);
    expect(service.versions).toHaveBeenCalledWith(7);
  });

  it('requests maps the box and pins the shared metric+standard inbox', async () => {
    service.pageRequests.mockResolvedValue({ data: [] });
    await controller.requests('mine', 1, 20);
    expect(service.pageRequests).toHaveBeenCalledWith('mine', 1, 20, [
      'metric',
      'standard',
    ]);
  });

  it('requests treats a non-mine box as pending', async () => {
    service.pageRequests.mockResolvedValue({ data: [] });
    await controller.requests('pending', 1, 20);
    expect(service.pageRequests).toHaveBeenCalledWith('pending', 1, 20, [
      'metric',
      'standard',
    ]);
  });

  it('upsert delegates the dto verbatim', async () => {
    const dto = { kind: 'atomic', name: 'revenue', scope: 'WORKSPACE' };
    service.upsert.mockResolvedValue({ applied: true, id: 1 });
    await expect(controller.upsert(dto as never)).resolves.toEqual({
      applied: true,
      id: 1,
    });
    expect(service.upsert).toHaveBeenCalledWith(dto);
  });

  it('review forwards id/approve/review_note to the shared review', async () => {
    service.reviewShared.mockResolvedValue({ success: true });
    await controller.review({
      id: 9,
      approve: true,
      review_note: 'ok',
    });
    expect(service.reviewShared).toHaveBeenCalledWith(9, true, 'ok');
  });

  it('remove sanitizes the id body to integers', async () => {
    service.remove.mockResolvedValue({ success: true });
    await controller.remove([1, 2.5, '3' as number, NaN, 4]);
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

  it('export sends the xlsx blob with attachment headers', async () => {
    const buf = Buffer.from('metrics-xlsx');
    importService.exportAll.mockResolvedValue(buf);
    const res = mkRes();

    await controller.export(res);

    expect(importService.exportAll).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith({
      // read from the REAL MetricImportService.XLSX_TYPE static
      'Content-Type': MetricImportService.XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="metrics.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
    expect(XLSX_TYPE).toBe(MetricImportService.XLSX_TYPE); // sanity: mime
  });

  it('uploadExcel throws a plain BadRequest when the file is missing', () => {
    expect(() => controller.uploadExcel(undefined)).toThrow(
      new BadRequestException('file is required'),
    );
    expect(importService.importExcel).not.toHaveBeenCalled();
  });

  it('uploadExcel throws a plain BadRequest when the buffer is empty', () => {
    expect(() => controller.uploadExcel({ buffer: Buffer.alloc(0) })).toThrow(
      new BadRequestException('file is required'),
    );
    expect(importService.importExcel).not.toHaveBeenCalled();
  });

  it('uploadExcel forwards the buffer to the import service', async () => {
    const summary = { applied: 5, failed: 0 };
    importService.importExcel.mockResolvedValue(summary);
    const file = { buffer: Buffer.from('xlsx-bytes') };
    await expect(controller.uploadExcel(file)).resolves.toBe(summary);
    expect(importService.importExcel).toHaveBeenCalledWith(file.buffer);
  });
});
