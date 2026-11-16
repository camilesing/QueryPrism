// TerminologyController spec — locks the route → service wiring for the
// /system/terminology admin surface, with focus on the in-controller
// normalization: toIdList turns repeated `?ds_list=1&ds_list=2` query params
// (string | string[]) into a NaN-filtered number[], and the enable route maps
// the 'true'/'false' path-param string to a boolean. Blob routes (export /
// template) are asserted to set the xlsx attachment headers and send the
// buffer via @Res(); uploadExcel rejects a missing multipart file with the
// translated BadRequest before touching the service.
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { TerminologyController } from './terminology.controller';
import { TerminologyService } from './terminology.service';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function mkRes() {
  return {
    set: jest.fn(),
    send: jest.fn(),
  } as unknown as Response & { set: jest.Mock; send: jest.Mock };
}

describe('TerminologyController', () => {
  let service: {
    page: jest.Mock;
    exportAll: jest.Mock;
    getTemplate: jest.Mock;
    setEnabled: jest.Mock;
    upsert: jest.Mock;
    remove: jest.Mock;
    importExcel: jest.Mock;
  };
  let controller: TerminologyController;

  beforeEach(() => {
    setI18n(createTestI18n());
    service = {
      page: jest.fn(),
      exportAll: jest.fn(),
      getTemplate: jest.fn(),
      setEnabled: jest.fn(),
      upsert: jest.fn(),
      remove: jest.fn(),
      importExcel: jest.fn(),
    };
    controller = new TerminologyController(
      service as unknown as TerminologyService,
    );
  });

  it('page forwards pager + keyword and normalizes repeated id params', async () => {
    const out = { current_page: 2, page_size: 10, total_count: 0, data: [] };
    service.page.mockResolvedValue(out);
    await expect(
      controller.page(2, 10, 'kw', ['1', '2', 'x'], '5'),
    ).resolves.toBe(out);
    // 'x' is filtered out by toIdList (NaN), array + single forms normalized
    expect(service.page).toHaveBeenCalledWith(2, 10, 'kw', [1, 2], [5]);
  });

  it('page defaults missing id params to empty lists', async () => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page(1, 20, undefined, undefined, undefined);
    expect(service.page).toHaveBeenCalledWith(1, 20, undefined, [], []);
  });

  it('export sends the xlsx blob with attachment headers', async () => {
    const buf = Buffer.from('xlsx');
    service.exportAll.mockResolvedValue(buf);
    const res = mkRes();

    await controller.export('w', ['1', 'bad'], undefined, res);

    expect(service.exportAll).toHaveBeenCalledWith('w', [1], []);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="terminology.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it('template sends the template blob with its own filename', async () => {
    const buf = Buffer.from('tpl');
    service.getTemplate.mockResolvedValue(buf);
    const res = mkRes();

    await controller.template(res);

    expect(service.getTemplate).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="terminology_template.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('enable maps the path-param "%s" to %s', async (raw, expected) => {
    service.setEnabled.mockResolvedValue({ id: 3 });
    await controller.enable(3, raw);
    expect(service.setEnabled).toHaveBeenCalledWith(3, expected);
  });

  it('upsert delegates the snake_case body verbatim', async () => {
    const info = { word: 'DAU', description: 'daily active users' };
    service.upsert.mockResolvedValue(info);
    await expect(controller.upsert(info)).resolves.toBe(info);
    expect(service.upsert).toHaveBeenCalledWith(info);
  });

  it('remove delegates the bare id-array body', async () => {
    service.remove.mockResolvedValue([1, 2]);
    await controller.remove([1, 2]);
    expect(service.remove).toHaveBeenCalledWith([1, 2]);
  });

  it('uploadExcel throws a translated BadRequest for a missing multipart file', () => {
    // the handler is sync — a missing file throws before any promise exists
    expect(() => controller.uploadExcel(undefined as never)).toThrow(
      new BadRequestException('No file uploaded'),
    );
    expect(service.importExcel).not.toHaveBeenCalled();
  });

  it('uploadExcel forwards the file buffer to importExcel', async () => {
    const summary = { total: 3, success: 3, failed: 0 };
    service.importExcel.mockResolvedValue(summary);
    const file = { buffer: Buffer.from('xlsx-bytes'), originalname: 't.xlsx' };
    await expect(controller.uploadExcel(file)).resolves.toBe(summary);
    expect(service.importExcel).toHaveBeenCalledWith(file.buffer);
  });

  it('upsert/remove @SystemLog resources callbacks derive audit rows', () => {
    const cfg = (method: unknown) =>
      Reflect.getMetadata(SYSTEMLOG_KEY, method) as {
        resources: (r: unknown) => Array<{ name: string; originId: number }>;
      };
    expect(cfg(controller.upsert).resources({ id: 4, word: 'DAU' })).toEqual([
      { name: 'DAU', originId: 4 },
    ]);
    expect(cfg(controller.remove).resources([{ id: 1 }, { id: 2 }])).toEqual([
      { name: '1', originId: 1 },
      { name: '2', originId: 2 },
    ]);
    // a null handler result (service returned nothing) → no rows, no crash
    expect(cfg(controller.remove).resources(null)).toEqual([]);
  });
});
