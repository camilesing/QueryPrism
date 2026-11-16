// McpIntegrationController spec — locks the admin MCP-integration surface.
// The controller applies the snake mapper in-process (REAL pure function):
// list never carries a token, create threads the one-time plaintext token
// through, and reveal/rotate wrap the token in `{token}`. Token generation,
// AES and oid scoping live in mcp-integration.service.spec.
import type { McpIntegration } from '@prisma/client';
import { McpIntegrationController } from './mcp-integration.controller';
import { McpIntegrationService } from './mcp-integration.service';

function row(overrides: Partial<McpIntegration> = {}): McpIntegration {
  return {
    id: 1,
    oid: 7,
    name: 'ci-bot',
    description: 'CI trigger',
    accessKey: 'ak_abc123',
    secretKey: 'enc',
    createdBy: 3,
    status: 'active',
    lastUsedAt: null,
    createdAt: new Date('2026-02-01T00:00:00Z'),
    updatedAt: new Date('2026-02-02T00:00:00Z'),
    ...overrides,
  };
}

describe('McpIntegrationController', () => {
  let service: {
    list: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
    revealToken: jest.Mock;
    rotateToken: jest.Mock;
  };
  let controller: McpIntegrationController;

  beforeEach(() => {
    service = {
      list: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      revealToken: jest.fn(),
      rotateToken: jest.fn(),
    };
    controller = new McpIntegrationController(
      service as unknown as McpIntegrationService,
    );
  });

  it('list maps rows to snake shape with an empty token', async () => {
    service.list.mockResolvedValue([
      row({ id: 1, lastUsedAt: new Date('2026-03-01T00:00:00Z') }),
      row({ id: 2, name: 'never-used', lastUsedAt: null }),
    ]);

    const out = await controller.list();

    expect(service.list).toHaveBeenCalledWith(undefined);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      id: 1,
      name: 'ci-bot',
      description: 'CI trigger',
      access_key: 'ak_abc123',
      token: '',
      status: 'active',
      last_used_at: '2026-03-01T00:00:00.000Z',
      created_at: '2026-02-01T00:00:00.000Z',
      updated_at: '2026-02-02T00:00:00.000Z',
    });
    expect(out[1].last_used_at).toBeNull();
  });

  it('list forwards the keyword filter', async () => {
    service.list.mockResolvedValue([]);
    await controller.list('bot');
    expect(service.list).toHaveBeenCalledWith('bot');
  });

  it('create maps the row and threads the one-time token', async () => {
    service.create.mockResolvedValue({
      row: row({ id: 5 }),
      token: 'tok-once',
    });

    await expect(controller.create({ name: 'ci-bot' })).resolves.toMatchObject({
      id: 5,
      token: 'tok-once',
    });
    expect(service.create).toHaveBeenCalledWith({ name: 'ci-bot' });
  });

  it('update maps the row with an empty token', async () => {
    service.update.mockResolvedValue(row({ id: 5, name: 'renamed' }));
    await expect(
      controller.update({ id: 5, name: 'renamed' }),
    ).resolves.toMatchObject({ id: 5, name: 'renamed', token: '' });
  });

  it('remove coerces the string id via Number', async () => {
    service.remove.mockResolvedValue({ success: true });
    await expect(controller.remove('5')).resolves.toEqual({ success: true });
    expect(service.remove).toHaveBeenCalledWith(5);
  });

  it('revealSecret wraps the revealed token', async () => {
    service.revealToken.mockResolvedValue('tok-plain');
    await expect(controller.revealSecret('5')).resolves.toEqual({
      token: 'tok-plain',
    });
    expect(service.revealToken).toHaveBeenCalledWith(5);
  });

  it('rotateSecret wraps the rotated token', async () => {
    service.rotateToken.mockResolvedValue('tok-new');
    await expect(controller.rotateSecret('5')).resolves.toEqual({
      token: 'tok-new',
    });
    expect(service.rotateToken).toHaveBeenCalledWith(5);
  });
});
