// CustomPromptController spec — locks the route → service wiring for the
// /system/custom_prompt admin surface. The per-type path segment (`:type`)
// threads through page/export/uploadExcel (the exported filename embeds it
// and every imported row receives it); uploadExcel throws the translated
// BadRequest for a missing multipart file (sync throw). Blob routes
// (template/export) set the xlsx attachment headers and send the buffer via
// @Res() so the envelope interceptor is bypassed. The page filters body
// passes through verbatim (snake_case filters, no remap here).
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { CustomPromptController } from './custom-prompt.controller';
import { CustomPromptService } from './custom-prompt.service';
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

describe('CustomPromptController', () => {
  let service: {
    getTemplate: jest.Mock;
    upsert: jest.Mock;
    remove: jest.Mock;
    page: jest.Mock;
    exportAll: jest.Mock;
    importExcel: jest.Mock;
  };
  let controller: CustomPromptController;

  beforeEach(() => {
    setI18n(createTestI18n());
    service = {
      getTemplate: jest.fn(),
      upsert: jest.fn(),
      remove: jest.fn(),
      page: jest.fn(),
      exportAll: jest.fn(),
      importExcel: jest.fn(),
    };
    controller = new CustomPromptController(
      service as unknown as CustomPromptService,
    );
  });

  it('template sends the template blob with attachment headers', async () => {
    const buf = Buffer.from('tpl');
    service.getTemplate.mockResolvedValue(buf);
    const res = mkRes();

    await controller.template(res);

    expect(service.getTemplate).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition':
        'attachment; filename="custom_prompt_template.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it('upsert delegates the snake_case body verbatim', async () => {
    const info = { id: 3, name: 'strict', prompt_type: 'system' };
    service.upsert.mockResolvedValue(info);
    await expect(controller.upsert(info)).resolves.toBe(info);
    expect(service.upsert).toHaveBeenCalledWith(info);
  });

  it('remove delegates the bare id-array body', async () => {
    service.remove.mockResolvedValue([3]);
    await controller.remove([3]);
    expect(service.remove).toHaveBeenCalledWith([3]);
  });

  it('page forwards type, pager and the filter body untouched', async () => {
    const out = { current_page: 1, page_size: 20, data: [] };
    service.page.mockResolvedValue(out);
    const filters = { name: 'nn', ds_list: [1], adv_list: [2] };
    await expect(controller.page('chat', 1, 20, filters)).resolves.toBe(out);
    expect(service.page).toHaveBeenCalledWith('chat', 1, 20, filters);
  });

  it('export sends the xlsx blob with the type-embedded filename', async () => {
    const buf = Buffer.from('xlsx');
    service.exportAll.mockResolvedValue(buf);
    const res = mkRes();
    const filters = { name: 'nn' };

    await controller.export('agent', filters, res);

    expect(service.exportAll).toHaveBeenCalledWith('agent', filters);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="custom_prompt_agent.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  it('uploadExcel throws a translated BadRequest for a missing multipart file', () => {
    // the handler is sync — a missing file throws before any promise exists
    expect(() => controller.uploadExcel('chat', undefined as never)).toThrow(
      new BadRequestException('No file uploaded'),
    );
    expect(service.importExcel).not.toHaveBeenCalled();
  });

  it('uploadExcel forwards type + file buffer to importExcel', async () => {
    const summary = { total: 2, success: 2, failed: 0 };
    service.importExcel.mockResolvedValue(summary);
    const file = { buffer: Buffer.from('xlsx-bytes'), originalname: 'c.xlsx' };
    await expect(controller.uploadExcel('chat', file)).resolves.toBe(summary);
    expect(service.importExcel).toHaveBeenCalledWith('chat', file.buffer);
  });

  it('upsert/remove @SystemLog resources callbacks derive audit rows', () => {
    const cfg = (method: unknown) =>
      Reflect.getMetadata(SYSTEMLOG_KEY, method) as {
        resources: (r: unknown) => Array<{ name: string; originId: number }>;
      };
    expect(cfg(controller.upsert).resources({ id: 4, name: 'strict' })).toEqual(
      [{ name: 'strict', originId: 4 }],
    );
    expect(cfg(controller.remove).resources([{ id: 6 }])).toEqual([
      { name: '6', originId: 6 },
    ]);
    // a null handler result → no rows, no crash
    expect(cfg(controller.remove).resources(null)).toEqual([]);
  });
});
