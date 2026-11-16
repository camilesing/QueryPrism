// SemanticController spec — locks the route → service wiring for the M2
// effective-semantics admin surface. In-controller logic worth pinning: the
// entity_type path segment normalizes to 'table' | 'field' (anything but
// 'field' → 'table'); the datasource_id query param is coerced to a positive
// finite number or dropped; the delete body is sanitized to integers (empty
// list when not an array); the enable flag accepts both 'true' and '1';
// uploadExcel (OPTIONAL file) throws a plain BadRequest when the file or its
// buffer is missing/empty; export reads the xlsx blob from the import
// service via @Res(). The approval inbox box param maps 'mine' vs pending.
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { SemanticController } from './semantic.controller';
import { SemanticService } from './semantic.service';
import { SemanticImportService } from './semantic-import.service';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mkRes() {
  return {
    set: jest.fn(),
    send: jest.fn(),
  } as unknown as Response & { set: jest.Mock; send: jest.Mock };
}

describe('SemanticController', () => {
  let service: {
    page: jest.Mock;
    pageRequests: jest.Mock;
    versions: jest.Mock;
    upsert: jest.Mock;
    review: jest.Mock;
    remove: jest.Mock;
    setEnabled: jest.Mock;
    collectEnums: jest.Mock;
  };
  let importService: { exportAll: jest.Mock; importExcel: jest.Mock };
  let controller: SemanticController;

  beforeEach(() => {
    service = {
      page: jest.fn(),
      pageRequests: jest.fn(),
      versions: jest.fn(),
      upsert: jest.fn(),
      review: jest.fn(),
      remove: jest.fn(),
      setEnabled: jest.fn(),
      collectEnums: jest.fn(),
    };
    importService = {
      exportAll: jest.fn(),
      importExcel: jest.fn(),
    };
    controller = new SemanticController(
      service as unknown as SemanticService,
      importService as unknown as SemanticImportService,
    );
  });

  it('page forwards entity_type, pager and coerced datasource_id', async () => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page('field', 2, 10, 'GLOBAL', '5', 'kw');
    expect(service.page).toHaveBeenCalledWith('field', 2, 10, {
      scope: 'GLOBAL',
      datasourceId: 5,
      keyword: 'kw',
    });
  });

  it('page normalizes a non-field entity_type to table', async () => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page('table', 1, 20);
    expect(service.page).toHaveBeenCalledWith('table', 1, 20, {
      scope: undefined,
      datasourceId: undefined,
      keyword: undefined,
    });
  });

  it.each([
    ['abc'], // NaN → dropped
    ['0'], // not > 0 → dropped
    ['-3'], // negative → dropped
    [undefined], // absent → dropped
  ])('page drops an unusable datasource_id (%s)', async (raw) => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page('table', 1, 20, undefined, raw);
    expect(service.page).toHaveBeenCalledWith('table', 1, 20, {
      scope: undefined,
      datasourceId: undefined,
      keyword: undefined,
    });
  });

  it.each([
    ['mine', 'mine'],
    ['pending', 'pending'],
    ['other', 'pending'],
  ])('requests maps box=%p to %p', async (raw, expected) => {
    service.pageRequests.mockResolvedValue({ data: [] });
    await controller.requests(raw, 1, 20);
    expect(service.pageRequests).toHaveBeenCalledWith(expected, 1, 20);
  });

  it.each([
    ['field', 'field'],
    ['table', 'table'],
    ['junk', 'table'],
  ])('versions normalizes entity_type %p to %p', async (raw, expected) => {
    service.versions.mockResolvedValue([]);
    await controller.versions(raw as 'table' | 'field', 7);
    expect(service.versions).toHaveBeenCalledWith(expected, 7);
  });

  it('upsert delegates the dto verbatim', async () => {
    const dto = { entityType: 'table', tableName: 't1', meaning: 'm' };
    service.upsert.mockResolvedValue({ applied: true, id: 1 });
    await expect(controller.upsert(dto as never)).resolves.toEqual({
      applied: true,
      id: 1,
    });
    expect(service.upsert).toHaveBeenCalledWith(dto);
  });

  it('review forwards id/approve/review_note', async () => {
    service.review.mockResolvedValue({ success: true });
    await controller.review({
      id: 9,
      approve: false,
      review_note: 'rework',
    });
    expect(service.review).toHaveBeenCalledWith(9, false, 'rework');
  });

  it('remove sanitizes the id body to integers', async () => {
    service.remove.mockResolvedValue({ success: true });
    await controller.remove('table', [1, 2.5, '3' as number, NaN, 4]);
    expect(service.remove).toHaveBeenCalledWith('table', [1, 4]);
  });

  it('remove passes an empty list for a field delete with a non-array body', async () => {
    service.remove.mockResolvedValue({ success: true });
    await controller.remove('field', undefined as unknown as number[]);
    expect(service.remove).toHaveBeenCalledWith('field', []);
  });

  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ])('setEnabled maps entity+flag %p to %s', async (raw, expected) => {
    service.setEnabled.mockResolvedValue({ success: true });
    await controller.setEnabled('field', 9, raw);
    expect(service.setEnabled).toHaveBeenCalledWith('field', 9, expected);
  });

  it('setEnabled normalizes a non-field entity_type to table', async () => {
    service.setEnabled.mockResolvedValue({ success: true });
    await controller.setEnabled('table', 9, '1');
    expect(service.setEnabled).toHaveBeenCalledWith('table', 9, true);
  });

  it('export sends the xlsx blob with attachment headers', async () => {
    const buf = Buffer.from('semantics-xlsx');
    importService.exportAll.mockResolvedValue(buf);
    const res = mkRes();

    await controller.export(res);

    expect(importService.exportAll).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith({
      // read from the REAL SemanticImportService.XLSX_TYPE static
      'Content-Type': SemanticImportService.XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="semantics.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
    expect(XLSX_TYPE).toBe(SemanticImportService.XLSX_TYPE); // sanity: mime
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
    const summary = { applied: 2, failed: 0 };
    importService.importExcel.mockResolvedValue(summary);
    const file = { buffer: Buffer.from('xlsx-bytes') };
    await expect(controller.uploadExcel(file)).resolves.toBe(summary);
    expect(importService.importExcel).toHaveBeenCalledWith(file.buffer);
  });

  it('collectEnum forwards the datasource id', async () => {
    service.collectEnums.mockResolvedValue({ fields: [] });
    await controller.collectEnum(4);
    expect(service.collectEnums).toHaveBeenCalledWith(4);
  });
});
