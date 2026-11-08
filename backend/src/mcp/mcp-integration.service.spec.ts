// McpIntegrationService spec — token lifecycle + workspace-scoped CRUD +
// Bearer authentication. The admin methods read the workspace from the ALS
// RequestContext; authenticateBearer() runs outside ALS because the MCP
// endpoint has no user session.
import { UnauthorizedException } from '@nestjs/common';
import type { McpIntegration } from '@prisma/client';
import { McpIntegrationService } from './mcp-integration.service';
import { requestContextStorage } from '../common/context/request-context';
import { decrypt, encrypt } from '../common/utils/aes';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const AES_KEY = 'unit-test-aes-key';

function row(overrides: Partial<McpIntegration> = {}): McpIntegration {
  return {
    id: 1,
    oid: 1,
    name: 'agent',
    description: null,
    accessKey: 'qp_abc123',
    secretKey: encrypt('secret-1', AES_KEY),
    createdBy: 1,
    status: 'active',
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeService() {
  const prisma = {
    mcpIntegration: {
      findMany: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
      findUnique: jest.fn(),
    },
    workspace: { findUnique: jest.fn() },
    // Interactive transactions run on the same mocked client.
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) =>
    fn(prisma),
  );
  const config = { get: jest.fn(() => AES_KEY) };
  const service = new McpIntegrationService(prisma as never, config as never);
  return { service, prisma };
}

function withUser<T>(fn: () => Promise<T>, oid = 2, id = 3): Promise<T> {
  return requestContextStorage.run(
    {
      user: { id, account: 'admin', oid, language: 'zh-CN', weight: 0 },
    },
    fn,
  );
}

describe('McpIntegrationService admin CRUD', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('creates a workspace-scoped integration and returns a qp_ token', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) => ({
        id: 9,
        ...data,
        lastUsedAt: null,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      }),
    );

    const result = await withUser(() =>
      service.create({ name: '  Claude  ', description: 'desk' }),
    );

    const data = prisma.mcpIntegration.create.mock.calls[0][0].data as {
      oid: number;
      name: string;
      description: string | null;
      accessKey: string;
      secretKey: string;
      createdBy: number;
    };
    expect(data.oid).toBe(2);
    expect(data.name).toBe('Claude');
    expect(data.description).toBe('desk');
    expect(data.createdBy).toBe(3);
    expect(data.accessKey).toMatch(/^qp_[0-9a-f]{32}$/);

    const [accessKey, secret] = result.token.split('.');
    expect(accessKey).toBe(data.accessKey);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // Only the encrypted form is stored.
    expect(data.secretKey).not.toBe(secret);
    expect(decrypt(data.secretKey, AES_KEY)).toBe(secret);
  });

  it('rejects an empty name', async () => {
    const { service } = makeService();
    await expect(
      withUser(() => service.create({ name: '   ' })),
    ).rejects.toThrow('name is required');
  });

  it('lists only current-workspace integrations with an optional keyword', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findMany.mockResolvedValue([row({ oid: 2 })]);

    await withUser(() => service.list('cLa'), 2);

    expect(prisma.mcpIntegration.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          oid: 2,
          name: { contains: 'cLa', mode: 'insensitive' },
        },
      }),
    );
  });

  it('updates only owned rows and validates status', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findFirst.mockResolvedValue({ id: 1 });
    prisma.mcpIntegration.update.mockResolvedValue(
      row({ oid: 2, name: 'new', status: 'disabled' }),
    );

    await withUser(() =>
      service.update({ id: 1, name: ' new ', status: 'disabled' }),
    );
    expect(prisma.mcpIntegration.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { name: 'new', status: 'disabled' },
    });

    await expect(
      withUser(() => service.update({ id: 1, status: 'bogus' })),
    ).rejects.toThrow('status must be active or disabled');
  });

  it('rejects updating a row owned by another workspace', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findFirst.mockResolvedValue(null);

    await expect(
      withUser(() => service.update({ id: 1, name: 'x' })),
    ).rejects.toThrow('MCP 集成 #1 不存在');
  });

  it('update runs the ownership check + write in ONE transaction', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findFirst.mockResolvedValue({ id: 1 });
    prisma.mcpIntegration.update.mockResolvedValue(row({ oid: 2 }));

    await withUser(() => service.update({ id: 1, name: 'x' }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.mcpIntegration.findFirst).toHaveBeenCalledWith({
      where: { id: 1, oid: 2 },
      select: { id: true },
    });
  });

  it('rotateToken runs the ownership check + write in ONE transaction', async () => {
    const { service, prisma } = makeService();
    const owned = row({ oid: 2 });
    prisma.mcpIntegration.findFirst.mockResolvedValue(owned);
    prisma.mcpIntegration.update.mockResolvedValue(owned);

    await withUser(() => service.rotateToken(1), 2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('removes only owned rows', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.deleteMany.mockResolvedValue({ count: 1 });

    await expect(withUser(() => service.remove(1))).resolves.toEqual({
      success: true,
    });
    expect(prisma.mcpIntegration.deleteMany).toHaveBeenCalledWith({
      where: { id: 1, oid: 2 },
    });

    prisma.mcpIntegration.deleteMany.mockResolvedValue({ count: 0 });
    await expect(withUser(() => service.remove(2))).rejects.toThrow(
      'MCP 集成 #2 不存在',
    );
  });

  it('reveals the full token on demand', async () => {
    const { service, prisma } = makeService();
    const owned = row({
      oid: 2,
      accessKey: 'qp_abc123',
      secretKey: encrypt('secret-1', AES_KEY),
    });
    prisma.mcpIntegration.findFirst.mockResolvedValue(owned);

    await expect(withUser(() => service.revealToken(1), 2)).resolves.toBe(
      'qp_abc123.secret-1',
    );
  });

  it('rotates the secret and invalidates the old token', async () => {
    const { service, prisma } = makeService();
    const owned = row({
      oid: 2,
      accessKey: 'qp_abc123',
      secretKey: encrypt('old-secret', AES_KEY),
    });
    prisma.mcpIntegration.findFirst.mockResolvedValue(owned);
    prisma.mcpIntegration.update.mockResolvedValue(owned);

    const token = await withUser(() => service.rotateToken(1), 2);

    const [accessKey, secret] = token.split('.');
    expect(accessKey).toBe('qp_abc123');
    expect(secret).not.toBe('old-secret');
    const updateData = prisma.mcpIntegration.update.mock.calls[0][0].data as {
      secretKey: string;
    };
    expect(decrypt(updateData.secretKey, AES_KEY)).toBe(secret);
  });
});

describe('McpIntegrationService.authenticateBearer', () => {
  beforeEach(() => setI18n(createTestI18n()));
  it('rejects malformed tokens', async () => {
    const { service } = makeService();
    await expect(service.authenticateBearer('')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.authenticateBearer('nope')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.authenticateBearer('qp_x.')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unknown access key', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findUnique.mockResolvedValue(null);

    await expect(
      service.authenticateBearer('qp_missing.secret'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a disabled integration', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findUnique.mockResolvedValue(
      row({ status: 'disabled' }),
    );

    await expect(
      service.authenticateBearer('qp_abc123.secret-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a wrong secret with a constant-time compare', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findUnique.mockResolvedValue(row());

    await expect(
      service.authenticateBearer('qp_abc123.wrong'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an archived workspace', async () => {
    const { service, prisma } = makeService();
    prisma.mcpIntegration.findUnique.mockResolvedValue(row());
    prisma.workspace.findUnique.mockResolvedValue({
      archivedAt: new Date('2026-01-01T00:00:00Z'),
    });

    await expect(
      service.authenticateBearer('qp_abc123.secret-1'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the integration + synthetic user and stamps lastUsedAt', async () => {
    const { service, prisma } = makeService();
    const owned = row({ oid: 7, createdBy: 42, name: 'Cursor' });
    prisma.mcpIntegration.findUnique.mockResolvedValue(owned);
    prisma.workspace.findUnique.mockResolvedValue({ archivedAt: null });
    prisma.mcpIntegration.update.mockResolvedValue(owned);

    const auth = await service.authenticateBearer('qp_abc123.secret-1');

    expect(auth.integration).toBe(owned);
    expect(auth.user).toEqual({
      id: 42,
      account: 'mcp:Cursor',
      oid: 7,
      language: 'zh-CN',
      weight: 0,
    });
    expect(prisma.mcpIntegration.update).toHaveBeenCalledWith({
      where: { id: owned.id },
      data: { lastUsedAt: expect.any(Date) },
    });
  });
});
