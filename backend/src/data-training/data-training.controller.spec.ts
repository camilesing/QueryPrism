// DataTrainingController spec — locks the route → service wiring for the
// /system/data-training admin surface (mirrors terminology). Focus on the
// in-controller normalization: toIdList turns repeated `?ds_list=1&ds_list=2`
// query params into a NaN-filtered number[], the enable route maps the
// 'true'/'false' path string to a boolean, and uploadExcel throws the
// translated BadRequest for a missing multipart file (sync throw — no
// promise involved). Blob routes set the xlsx attachment headers and send
// the buffer via @Res() (individual res.set calls here, not one object).
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { DataTrainingController } from './data-training.controller';
import { DataTrainingService } from './data-training.service';
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

describe('DataTrainingController', () => {
  let service: {
    page: jest.Mock;
    exportAll: jest.Mock;
    getTemplate: jest.Mock;
    setEnabled: jest.Mock;
    upsert: jest.Mock;
    remove: jest.Mock;
    importExcel: jest.Mock;
  };
  let controller: DataTrainingController;

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
    controller = new DataTrainingController(
      service as unknown as DataTrainingService,
    );
  });

  it('page forwards pager + keyword and normalizes repeated id params', async () => {
    const out = { current_page: 1, page_size: 20, total_count: 0, data: [] };
    service.page.mockResolvedValue(out);
    await expect(
      controller.page(1, 20, 'orders?', ['2', 'oops'], ['9']),
    ).resolves.toBe(out);
    expect(service.page).toHaveBeenCalledWith(1, 20, 'orders?', [2], [9]);
  });

  it('page defaults missing id params to empty lists', async () => {
    service.page.mockResolvedValue({ data: [] });
    await controller.page(1, 20);
    expect(service.page).toHaveBeenCalledWith(1, 20, undefined, [], []);
  });

  it('exportExcel sends the xlsx blob with attachment headers', async () => {
    const buf = Buffer.from('xlsx');
    service.exportAll.mockResolvedValue(buf);
    const res = mkRes();

    await controller.exportExcel('q', '3', ['4', 'bad'], res);

    expect(service.exportAll).toHaveBeenCalledWith('q', [3], [4]);
    expect(res.set).toHaveBeenCalledWith('Content-Type', XLSX_TYPE);
    expect(res.set).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="data-training.xlsx"',
    );
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it('template sends the template blob with its own filename', async () => {
    const buf = Buffer.from('tpl');
    service.getTemplate.mockResolvedValue(buf);
    const res = mkRes();

    await controller.template(res);

    expect(service.getTemplate).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Content-Type', XLSX_TYPE);
    expect(res.set).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="data-training-template.xlsx"',
    );
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('enable maps the path-param "%s" to %s', async (raw, expected) => {
    service.setEnabled.mockResolvedValue({ id: 6 });
    await controller.enable(6, raw);
    expect(service.setEnabled).toHaveBeenCalledWith(6, expected);
  });

  it('upsert delegates the snake_case body verbatim', async () => {
    const info = { question: 'sales per city', sql: 'SELECT 1' };
    service.upsert.mockResolvedValue(info);
    await expect(controller.upsert(info)).resolves.toBe(info);
    expect(service.upsert).toHaveBeenCalledWith(info);
  });

  it('remove delegates the bare id-array body', async () => {
    service.remove.mockResolvedValue([5]);
    await controller.remove([5]);
    expect(service.remove).toHaveBeenCalledWith([5]);
  });

  it('uploadExcel throws a translated BadRequest for a missing multipart file', () => {
    // the handler is sync — a missing file throws before any promise exists
    expect(() => controller.uploadExcel(undefined as never)).toThrow(
      new BadRequestException('No file uploaded'),
    );
    expect(service.importExcel).not.toHaveBeenCalled();
  });

  it('uploadExcel forwards the file buffer to importExcel', async () => {
    const summary = { total: 1, success: 1, failed: 0 };
    service.importExcel.mockResolvedValue(summary);
    const file = { buffer: Buffer.from('xlsx-bytes'), originalname: 'd.xlsx' };
    await expect(controller.uploadExcel(file)).resolves.toBe(summary);
    expect(service.importExcel).toHaveBeenCalledWith(file.buffer);
  });

  it('upsert/remove @SystemLog resources callbacks derive audit rows', () => {
    const cfg = (method: unknown) =>
      Reflect.getMetadata(SYSTEMLOG_KEY, method) as {
        resources: (r: unknown) => Array<{ name: string; originId: number }>;
      };
    expect(
      cfg(controller.upsert).resources({ id: 2, question: 'sales?' }),
    ).toEqual([{ name: 'sales?', originId: 2 }]);
    expect(cfg(controller.remove).resources([{ id: 8 }])).toEqual([
      { name: '8', originId: 8 },
    ]);
    // a null handler result → no rows, no crash
    expect(cfg(controller.remove).resources(null)).toEqual([]);
  });
});
