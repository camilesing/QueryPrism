// AssistantPublicController + AssistantBootstrapController spec — locks the
// guard-less embedded entry points. The public controller is pure delegation
// by appId. The bootstrap controller reads four headers off req, maps a
// missing `virtual` query to null, and flattens the service result to
// `{...assistant, token}` — sign verification itself lives in
// embedded-sign.service.spec.
import type { Request } from 'express';
import {
  AssistantBootstrapController,
  AssistantPublicController,
} from './assistant-public.controller';
import { AssistantService } from './assistant.service';
import { EmbeddedSignService } from './embedded-sign.service';

/** Express-style case-insensitive header stub (missing → null). */
function reqWith(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()] ?? null,
  } as unknown as Request;
}

describe('AssistantPublicController', () => {
  let assistantService: { getInfo: jest.Mock; findByAppId: jest.Mock };
  let controller: AssistantPublicController;

  beforeEach(() => {
    assistantService = {
      getInfo: jest.fn(),
      findByAppId: jest.fn(),
    };
    controller = new AssistantPublicController(
      assistantService as unknown as AssistantService,
    );
  });

  it('getInfo delegates by appId', async () => {
    const info = { name: 'helper', theme: 'dark' };
    assistantService.getInfo.mockResolvedValue(info);
    await expect(controller.getInfo('app-9')).resolves.toEqual(info);
    expect(assistantService.getInfo).toHaveBeenCalledWith('app-9');
  });

  it('findByAppId delegates by appId', async () => {
    const row = { id: 3, name: 'helper', app_id: 'app-9' };
    assistantService.findByAppId.mockResolvedValue(row);
    await expect(controller.findByAppId('app-9')).resolves.toEqual(row);
    expect(assistantService.findByAppId).toHaveBeenCalledWith('app-9');
  });
});

describe('AssistantBootstrapController', () => {
  let embeddedSignService: { bootstrap: jest.Mock };
  let controller: AssistantBootstrapController;

  beforeEach(() => {
    embeddedSignService = { bootstrap: jest.fn() };
    controller = new AssistantBootstrapController(
      embeddedSignService as unknown as EmbeddedSignService,
    );
  });

  it('forwards id, virtual, sign and browser headers, flattening the result', async () => {
    embeddedSignService.bootstrap.mockResolvedValue({
      assistant: { id: 3, name: 'helper' },
      token: 'assistant-jwt',
    });
    const req = reqWith({
      'queryprism-embedded-sign': 'sig-abc',
      'user-agent': 'Mozilla/5.0',
      origin: 'https://embed.example',
      referer: 'https://embed.example/page',
    });

    await expect(controller.bootstrap(3, '42', req)).resolves.toEqual({
      id: 3,
      name: 'helper',
      token: 'assistant-jwt',
    });
    expect(embeddedSignService.bootstrap).toHaveBeenCalledWith(
      3,
      42,
      'sig-abc',
      'Mozilla/5.0',
      'https://embed.example',
      'https://embed.example/page',
    );
  });

  it('maps a missing virtual query to null and absent headers to undefined/empty', async () => {
    embeddedSignService.bootstrap.mockResolvedValue({
      assistant: { id: 4 },
      token: 't',
    });
    const req = reqWith({});

    await controller.bootstrap(4, undefined, req);

    expect(embeddedSignService.bootstrap).toHaveBeenCalledWith(
      4,
      null,
      undefined,
      '',
      undefined,
      undefined,
    );
  });

  it('treats empty-string origin/referer as absent (|| undefined)', async () => {
    embeddedSignService.bootstrap.mockResolvedValue({
      assistant: { id: 5 },
      token: 't',
    });
    const req = reqWith({ origin: '', referer: '' });

    await controller.bootstrap(5, '1', req);

    expect(embeddedSignService.bootstrap).toHaveBeenCalledWith(
      5,
      1,
      undefined,
      '',
      undefined,
      undefined,
    );
  });
});
