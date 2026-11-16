// EmbeddedController spec — locks the type-4 embedded-app admin surface. The
// controller applies the snake mapper in-process (a REAL pure function — not
// mocked): list decrypts appSecret per row (null when absent), create/update
// omit the secret, and :id params coerce via Number. Service logic is covered
// by assistant.service.spec.
import type { Assistant } from '@prisma/client';
import { EmbeddedController } from './embedded.controller';
import { AssistantService } from '../assistant/assistant.service';

/** Minimal Assistant-shaped row for the snake mapper (cast, not constructed). */
function row(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: 1,
    oid: 1,
    name: 'widget',
    type: 4,
    appId: 'app-1',
    appSecret: null,
    domain: 'a.com;b.com',
    configuration: { theme: 'dark' },
    description: null,
    status: 'active',
    enableCustomModel: false,
    customModel: null,
    createdAt: new Date('2026-01-02T03:04:05Z'),
    updatedAt: new Date('2026-01-03T03:04:05Z'),
    ...overrides,
  } as Assistant;
}

describe('EmbeddedController', () => {
  let assistantService: {
    listEmbedded: jest.Mock;
    decryptAppSecret: jest.Mock;
    createEmbedded: jest.Mock;
    updateEmbedded: jest.Mock;
    removeEmbedded: jest.Mock;
    rotateSecret: jest.Mock;
  };
  let controller: EmbeddedController;

  beforeEach(() => {
    assistantService = {
      listEmbedded: jest.fn(),
      decryptAppSecret: jest.fn(),
      createEmbedded: jest.fn(),
      updateEmbedded: jest.fn(),
      removeEmbedded: jest.fn(),
      rotateSecret: jest.fn(),
    };
    controller = new EmbeddedController(
      assistantService as unknown as AssistantService,
    );
  });

  it('list maps rows to snake shape and decrypts app_secret per row', async () => {
    assistantService.listEmbedded.mockResolvedValue({
      items: [
        row({ id: 1, appSecret: 'cipher-1' }),
        row({ id: 2, appSecret: null }),
      ],
      total: 2,
    });
    assistantService.decryptAppSecret.mockReturnValue('plain-1');

    const out = await controller.list('1', '10', 'widget');

    expect(assistantService.listEmbedded).toHaveBeenCalledWith(1, 10, 'widget');
    expect(assistantService.decryptAppSecret).toHaveBeenCalledWith('cipher-1');
    expect(out.total).toBe(2);
    expect(out.items[0]).toMatchObject({
      id: 1,
      app_id: 'app-1',
      app_secret: 'plain-1',
      domain: 'a.com;b.com',
      configuration: JSON.stringify({ theme: 'dark' }),
      create_time: Date.parse('2026-01-02T03:04:05Z'),
    });
    // Row without stored secret: no decrypt call, null on the wire.
    expect(out.items[1].app_secret).toBeNull();
    expect(assistantService.decryptAppSecret).toHaveBeenCalledTimes(1);
  });

  it('list works without a keyword filter', async () => {
    assistantService.listEmbedded.mockResolvedValue({ items: [], total: 0 });
    await controller.list('2', '5');
    expect(assistantService.listEmbedded).toHaveBeenCalledWith(2, 5, undefined);
  });

  it('create returns the snake row with app_secret omitted (null)', async () => {
    assistantService.createEmbedded.mockResolvedValue(
      row({ id: 3, appSecret: 'cipher-3' }),
    );
    await expect(controller.create({ name: 'widget' })).resolves.toMatchObject({
      id: 3,
      app_secret: null,
      status: 'active',
    });
    expect(assistantService.createEmbedded).toHaveBeenCalledWith({
      name: 'widget',
    });
  });

  it('update returns the snake row with app_secret omitted', async () => {
    assistantService.updateEmbedded.mockResolvedValue(
      row({ id: 3, name: 'renamed' }),
    );
    await expect(
      controller.update({ id: 3, name: 'renamed' }),
    ).resolves.toMatchObject({ id: 3, name: 'renamed', app_secret: null });
  });

  it('remove forwards the bare id array', async () => {
    assistantService.removeEmbedded.mockResolvedValue({ success: true });
    await expect(controller.remove([1, 2])).resolves.toEqual({ success: true });
    expect(assistantService.removeEmbedded).toHaveBeenCalledWith([1, 2]);
  });

  it('rotateSecret coerces the string id via Number', async () => {
    assistantService.rotateSecret.mockResolvedValue({ success: true });
    await expect(controller.rotateSecret('7')).resolves.toEqual({
      success: true,
    });
    expect(assistantService.rotateSecret).toHaveBeenCalledWith(7);
  });
});
