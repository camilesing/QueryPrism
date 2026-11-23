// AiModelController spec — locks the /system/aimodel wiring plus the
// controller-owned contracts: list vs single snake mapping (api_key omitted
// + has_api_key on lists, decrypted api_key on GET /:id), the REAL
// fromAiModelSnake body normalization on create/update (snake keys →
// camelCase service payload, explicit config wins over config_list),
// 400-on-missing-id on update, the ws_mapping string[] CRUD delegation, and
// POST /status: SSE drain of {success,message} (content vs error frame) with
// plain-text 404 (the service's NotFoundException, locale-independent) / 400
// fallbacks before the stream opens.
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AiModelController } from './ai-model.controller';
import { AiModelService } from './ai-model.service';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import type { LogConfig } from '../audit/log-config.interface';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const T0 = new Date('2026-03-04T05:06:07.890Z');

const modelRow = {
  id: 3,
  supplier: '1',
  name: 'gpt-4o',
  modelType: '2',
  baseModel: 'gpt-4o-2024',
  defaultModel: false,
  apiKey: 'plain-key',
  apiDomain: 'https://api.x.com',
  protocol: '1',
  config: { k: 'v' },
  status: 'active',
  createdAt: T0,
  updatedAt: T0,
};

/** List-mode expectation: api_key omitted, has_api_key surfaced, enums
 *  coerced back to numbers, timestamps ISO. */
const MODEL_SNAKE_LIST = {
  id: 3,
  supplier: 1,
  name: 'gpt-4o',
  model_type: 2,
  base_model: 'gpt-4o-2024',
  default_model: false,
  has_api_key: true,
  api_domain: 'https://api.x.com',
  protocol: 1,
  config: { k: 'v' },
  status: 'active',
  create_time: T0.toISOString(),
  update_time: T0.toISOString(),
};

/** Minimal express Response stand-in good enough for SseWriter
 *  (EventEmitter + write/end/flushHeaders/setHeader) and for the
 *  chained status().type().send() error path. */
function fakeRes() {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const headers: string[] = [];
  const res = {
    chunks,
    headers,
    emitter,
    ended: false,
    setHeader: (n: string, v: string) => headers.push(`${n}: ${v}`),
    write: (c: string) => {
      chunks.push(c);
      return true;
    },
    end: () => {
      res.ended = true;
      return res;
    },
    flushHeaders: () => undefined,
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    get writableEnded() {
      return res.ended;
    },
    status: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  return res as unknown as typeof res & Response;
}

describe('AiModelController', () => {
  let service: Record<string, jest.Mock>;
  let controller: AiModelController;

  beforeEach(() => {
    setI18n(createTestI18n());
    service = {
      findAll: jest.fn(),
      findDefault: jest.fn(),
      listByWorkspace: jest.fn(),
      query: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      setDefault: jest.fn(),
      remove: jest.fn(),
      testStatus: jest.fn(),
      listMappingsByModel: jest.fn(),
      addMappings: jest.fn(),
      setMappings: jest.fn(),
      removeMappings: jest.fn(),
    };
    controller = new AiModelController(service as unknown as AiModelService);
  });

  // ─── queries ────────────────────────────────────────────────────────────

  it('findAll maps rows in list mode (no api_key) and forwards the keyword', async () => {
    service.findAll.mockResolvedValue([modelRow]);
    const out = await controller.findAll('gpt');
    expect(service.findAll).toHaveBeenCalledWith('gpt');
    expect(out).toEqual([MODEL_SNAKE_LIST]);
    expect('api_key' in out[0]).toBe(false);
  });

  it('findDefault maps the row, or returns null when none is default', async () => {
    service.findDefault.mockResolvedValue(modelRow);
    await expect(controller.findDefault()).resolves.toEqual(MODEL_SNAKE_LIST);

    service.findDefault.mockResolvedValue(null);
    await expect(controller.findDefault()).resolves.toBeNull();
  });

  it('listByWorkspace merges binding weight onto the list-mode snake shape', async () => {
    service.listByWorkspace.mockResolvedValue([{ model: modelRow, weight: 2 }]);
    const out = await controller.listByWorkspace({
      id: 1,
      account: 'u',
      oid: 4,
      language: 'en',
    });
    expect(service.listByWorkspace).toHaveBeenCalledWith(4);
    expect(out).toEqual([{ ...MODEL_SNAKE_LIST, weight: 2 }]);
  });

  it('query returns single mode — the decrypted api_key is surfaced', async () => {
    service.query.mockResolvedValue(modelRow);
    const out = await controller.query(3);
    expect(service.query).toHaveBeenCalledWith(3);
    expect(out).toEqual({ ...MODEL_SNAKE_LIST, api_key: 'plain-key' });
  });

  // ─── mutations + fromAiModelSnake normalization (real mapper) ──────────

  it('create normalizes the snake body to the service payload', async () => {
    service.create.mockResolvedValue(modelRow);
    const out = await controller.create({
      supplier: 1,
      name: 'gpt-4o',
      model_type: 2,
      base_model: 'gpt-4o-2024',
      api_key: 'plain-key',
      api_domain: 'https://api.x.com',
      protocol: 1,
      config_list: [{ k: 'v' }],
      status: 'active',
    });
    expect(service.create).toHaveBeenCalledWith({
      id: undefined,
      supplier: 1,
      name: 'gpt-4o',
      modelType: 2,
      baseModel: 'gpt-4o-2024',
      apiKey: 'plain-key',
      apiDomain: 'https://api.x.com',
      protocol: 1,
      config: [{ k: 'v' }],
      status: 'active',
    });
    expect(out).toEqual(MODEL_SNAKE_LIST);
  });

  it('update 400s when dto.id is undefined', async () => {
    await expect(controller.update({ name: 'x' })).rejects.toThrow(
      BadRequestException,
    );
    await expect(controller.update({ name: 'x' })).rejects.toThrow(
      'id is required',
    );
    expect(service.update).not.toHaveBeenCalled();
  });

  it('update normalizes the body, preferring camelCase spellings + explicit config', async () => {
    service.update.mockResolvedValue(modelRow);
    await controller.update({
      id: 3,
      modelType: 7,
      model_type: 2,
      apiKey: 'a',
      api_key: 'b',
      baseModel: 'm1',
      base_model: 'm2',
      config: { x: 1 },
      config_list: { y: 2 },
    });
    expect(service.update).toHaveBeenCalledWith(3, {
      id: 3,
      supplier: undefined,
      name: undefined,
      modelType: 7,
      baseModel: 'm1',
      apiKey: 'a',
      apiDomain: undefined,
      protocol: undefined,
      config: { x: 1 },
      status: undefined,
    });
  });

  it('setDefault / remove delegate and map', async () => {
    service.setDefault.mockResolvedValue({ ...modelRow, defaultModel: true });
    const out = await controller.setDefault(3);
    expect(service.setDefault).toHaveBeenCalledWith(3);
    expect(out.default_model).toBe(true);

    service.remove.mockResolvedValue({ success: true });
    await expect(controller.remove(3)).resolves.toEqual({ success: true });
    expect(service.remove).toHaveBeenCalledWith(3);
  });

  // ─── POST /status (SSE drain + pre-stream 4xx) ──────────────────────────

  it('testStatus streams a content frame for a successful ping', async () => {
    service.testStatus.mockResolvedValue({
      success: true,
      message: 'ok: models listed',
    });
    const res = fakeRes();
    await controller.testStatus({ id: 3 }, res);
    expect(service.testStatus).toHaveBeenCalledWith(3);
    expect(res.chunks.join('')).toBe(
      'data:{"content":"ok: models listed","type":"content"}\n\n',
    );
    expect(res.ended).toBe(true);
  });

  it('testStatus streams an error frame (data.error) for a failed ping', async () => {
    service.testStatus.mockResolvedValue({
      success: false,
      message: 'connect timeout',
    });
    const res = fakeRes();
    await controller.testStatus({ id: 3 }, res);
    expect(res.chunks.join('')).toBe(
      'data:{"error":"connect timeout","type":"error"}\n\n',
    );
    expect(res.ended).toBe(true);
  });

  it('testStatus returns a plain-text 404 when the model id is unknown, whatever the locale', async () => {
    // AiModelService.findOne throws NotFoundException(tr('ai-model.not_found')).
    // The message is localized ("... 不存在" only under zh-CN), so the status
    // must come from the exception, not from a substring of its message.
    service.testStatus.mockRejectedValue(
      new NotFoundException('AI model #99 not found'),
    );
    const res = fakeRes();
    await controller.testStatus({ id: 99 }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('text/plain');
    expect(res.send).toHaveBeenCalledWith('AI model #99 not found');
    expect(res.chunks).toEqual([]);
  });

  it('testStatus returns a plain-text 400 for other Error failures', async () => {
    service.testStatus.mockRejectedValue(new Error('bad gateway'));
    const res = fakeRes();
    await controller.testStatus({ id: 3 }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('bad gateway');
  });

  it('testStatus stringifies a non-Error rejection', async () => {
    service.testStatus.mockRejectedValue('boom');
    const res = fakeRes();
    await controller.testStatus({ id: 3 }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('boom');
  });

  // ─── ws_mapping CRUD (string[] of oid) ──────────────────────────────────

  it('ws_mapping routes delegate with the model id and oid array', async () => {
    service.listMappingsByModel.mockResolvedValue(['1', '4']);
    await expect(controller.listMappings(3)).resolves.toEqual(['1', '4']);
    expect(service.listMappingsByModel).toHaveBeenCalledWith(3);

    service.addMappings.mockResolvedValue({ success: true });
    await expect(controller.addMappings(3, ['4'])).resolves.toEqual({
      success: true,
    });
    expect(service.addMappings).toHaveBeenCalledWith(3, ['4']);

    service.setMappings.mockResolvedValue({ success: true });
    await expect(controller.setMappings(3, ['1', '4'])).resolves.toEqual({
      success: true,
    });
    expect(service.setMappings).toHaveBeenCalledWith(3, ['1', '4']);

    service.removeMappings.mockResolvedValue({ success: true });
    await expect(controller.removeMappings(3, ['4'])).resolves.toEqual({
      success: true,
    });
    expect(service.removeMappings).toHaveBeenCalledWith(3, ['4']);
  });

  // ─── @SystemLog audit metadata (normally invoked by the audit
  //     interceptor with the handler's return value) ──────────────────────

  it('create/update/setDefault @SystemLog resources callbacks extract name+id', () => {
    for (const method of ['create', 'update', 'setDefault']) {
      const cfg = Reflect.getMetadata(
        SYSTEMLOG_KEY,
        AiModelController.prototype[method as keyof AiModelController] as never,
      ) as LogConfig;
      expect(cfg.resources(MODEL_SNAKE_LIST)).toEqual([
        { name: 'gpt-4o', originId: 3 },
      ]);
    }
  });
});
