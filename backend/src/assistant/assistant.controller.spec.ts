// AssistantController spec — locks the admin assistant surface (type 0/1 +
// the Phase 11 picture/ui routes). The snake mappers are REAL pure functions:
// list/create/update assert the mapped wire shape (configuration serialized
// to a JSON string, custom_model verbatim), picture covers the 404 / svg /
// jpeg branches, and updateUi covers JSON-parse failure (translated
// BadRequest) plus the missing-files fallback. Business logic lives in
// assistant.service.spec.
import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantFileService } from './assistant-file.service';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import type { Assistant } from '@prisma/client';

function row(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: 1,
    oid: 7,
    name: 'helper',
    type: 1,
    appId: 'app-1',
    appSecret: null,
    domain: 'a.com',
    configuration: { logo: 'x.png' },
    description: 'desc',
    status: 'active',
    enableCustomModel: true,
    customModel: 5,
    createdAt: new Date('2026-01-02T03:04:05Z'),
    updatedAt: new Date('2026-01-03T03:04:05Z'),
    ...overrides,
  } as Assistant;
}

describe('AssistantController', () => {
  let assistantService: {
    list: jest.Mock;
    listAdvancedApplications: jest.Mock;
    listRuntimeDatasources: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    updateUi: jest.Mock;
  };
  let fileService: { exists: jest.Mock; pathFor: jest.Mock };
  let controller: AssistantController;

  beforeEach(() => {
    setI18n(createTestI18n());
    assistantService = {
      list: jest.fn(),
      listAdvancedApplications: jest.fn(),
      listRuntimeDatasources: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      updateUi: jest.fn(),
    };
    fileService = { exists: jest.fn(), pathFor: jest.fn() };
    controller = new AssistantController(
      assistantService as unknown as AssistantService,
      fileService as unknown as AssistantFileService,
    );
  });

  it('list maps rows through toAssistantSnake', async () => {
    assistantService.list.mockResolvedValue([
      row({ id: 1, customModel: null, configuration: null }),
    ]);

    const out = await controller.list();

    expect(out).toEqual([
      {
        id: 1,
        name: 'helper',
        type: 1,
        description: 'desc',
        configuration: '{}', // null configuration → "{}" (frontend JSON.parse)
        domain: 'a.com',
        app_id: 'app-1',
        enable_custom_model: true,
        custom_model: null,
        status: 'active',
        create_time: Date.parse('2026-01-02T03:04:05Z'),
        update_time: Date.parse('2026-01-03T03:04:05Z'),
      },
    ]);
  });

  it('advancedApplication maps rows to the {id, name} picker shape', async () => {
    assistantService.listAdvancedApplications.mockResolvedValue([
      row({ id: 2, name: 'pro' }),
    ]);
    await expect(controller.advancedApplication()).resolves.toEqual([
      { id: 2, name: 'pro' },
    ]);
  });

  it('listRuntimeDatasources delegates to the service', async () => {
    const ds = [{ id: 1, name: 'warehouse' }];
    assistantService.listRuntimeDatasources.mockResolvedValue(ds);
    await expect(controller.listRuntimeDatasources()).resolves.toEqual(ds);
  });

  it('create returns the mapped snake row', async () => {
    assistantService.create.mockResolvedValue(row({ id: 3 }));
    await expect(
      controller.create({ name: 'helper' } as never),
    ).resolves.toMatchObject({
      id: 3,
      app_id: 'app-1',
      custom_model: 5,
      configuration: JSON.stringify({ logo: 'x.png' }),
    });
    expect(assistantService.create).toHaveBeenCalledWith({ name: 'helper' });
  });

  it('update returns the mapped snake row', async () => {
    assistantService.update.mockResolvedValue(row({ id: 3, name: 'renamed' }));
    await expect(
      controller.update({ id: 3, name: 'renamed' } as never),
    ).resolves.toMatchObject({ id: 3, name: 'renamed' });
    expect(assistantService.update).toHaveBeenCalledWith({
      id: 3,
      name: 'renamed',
    });
  });

  it('remove coerces the string id via Number', async () => {
    assistantService.remove.mockResolvedValue({ success: true });
    await expect(controller.remove('3')).resolves.toEqual({ success: true });
    expect(assistantService.remove).toHaveBeenCalledWith(3);
  });

  it('SystemLog resources callbacks project the raw row to {name, originId}', () => {
    // Direct calls never run the interceptor; exercise the decorator metadata
    // so the audit resource projection is pinned too.
    const handlers = [
      controller.create,
      controller.update,
      controller.updateUi,
    ];
    for (const handler of handlers) {
      const config = Reflect.getMetadata(SYSTEMLOG_KEY, handler) as {
        resources: (r: unknown) => { name: string; originId: number }[];
      };
      expect(config.resources({ id: 8, name: 'helper' })).toEqual([
        { name: 'helper', originId: 8 },
      ]);
    }
  });

  describe('picture', () => {
    it('404s when the file is not on disk', async () => {
      fileService.exists.mockResolvedValue(false);
      const res = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
        sendFile: jest.fn(),
      } as unknown as Response;

      await controller.picture('missing.png', res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.send).toHaveBeenCalledWith('File not found');
      expect(res.sendFile).not.toHaveBeenCalled();
    });

    it('streams an svg with image/svg+xml', async () => {
      fileService.exists.mockResolvedValue(true);
      fileService.pathFor.mockReturnValue('/files/logo.svg');
      const res = { sendFile: jest.fn() } as unknown as Response;

      await controller.picture('logo.SVG', res);

      expect(res.sendFile).toHaveBeenCalledWith('/files/logo.svg', {
        headers: { 'Content-Type': 'image/svg+xml' },
      });
    });

    it('streams any non-svg file as image/jpeg', async () => {
      fileService.exists.mockResolvedValue(true);
      fileService.pathFor.mockReturnValue('/files/logo.png');
      const res = { sendFile: jest.fn() } as unknown as Response;

      await controller.picture('logo.png', res);

      expect(res.sendFile).toHaveBeenCalledWith('/files/logo.png', {
        headers: { 'Content-Type': 'image/jpeg' },
      });
    });
  });

  describe('updateUi', () => {
    it('parses the multipart data JSON and forwards schema + files', async () => {
      assistantService.updateUi.mockResolvedValue(row({ id: 6 }));
      const files = [
        {
          fieldname: 'files',
          originalname: 'logo.png,logo',
          buffer: Buffer.of(1),
        },
      ] as unknown as Express.Multer.File[];

      await expect(
        controller.updateUi('{"logo":"f1.png"}', files),
      ).resolves.toMatchObject({ id: 6 });
      expect(assistantService.updateUi).toHaveBeenCalledWith(
        { logo: 'f1.png' },
        files,
      );
    });

    it('defaults the data field to {} and files to []', async () => {
      assistantService.updateUi.mockResolvedValue(row({ id: 6 }));
      await controller.updateUi(undefined, undefined);
      expect(assistantService.updateUi).toHaveBeenCalledWith({}, []);
    });

    it('rejects a non-JSON data field with a translated BadRequest', async () => {
      await expect(controller.updateUi('not-json', [])).rejects.toThrow(
        BadRequestException,
      );
      await expect(controller.updateUi('not-json', [])).rejects.toThrow(
        'data must be a valid JSON string',
      );
      expect(assistantService.updateUi).not.toHaveBeenCalled();
    });
  });
});
