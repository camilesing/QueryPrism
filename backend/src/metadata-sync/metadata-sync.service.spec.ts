// CRUD tests for metadata sync sources (MetaDataImprove M5): oid scoping,
// secret encryption/masking, validation and scheduler refresh.
import type { MetadataSyncSource } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { decryptJson, encryptJson } from '../common/utils/aes';
import {
  requestContextStorage,
  type RequestContextData,
} from '../common/context/request-context';
import { MetadataSyncService } from './metadata-sync.service';

const AES_KEY = 'test-aes-key';
const ACTOR = { id: 1, account: 'admin', oid: 1, language: 'zh-CN' };

function run<T>(fn: () => Promise<T>): Promise<T> {
  return requestContextStorage.run(
    { user: ACTOR } satisfies RequestContextData,
    fn,
  );
}

function row(over: Partial<MetadataSyncSource> = {}): MetadataSyncSource {
  return {
    id: 5,
    oid: 1,
    name: 's',
    kind: 'HTTP_API',
    target: 'semantic',
    endpoint: 'https://meta.example.com/rows',
    httpMethod: 'GET',
    httpBody: null,
    authJson: null,
    mcpTool: null,
    mcpArgs: null,
    cron: null,
    enabled: true,
    createdBy: 1,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function makeService() {
  const prisma = {
    metadataSyncSource: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    metadataSyncRun: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const scheduler = {
    refresh: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn(),
  };
  const config = {
    get: (key: string) => (key === 'aes.key' ? AES_KEY : undefined),
  };
  const service = new MetadataSyncService(
    prisma as never,
    config as unknown as ConfigService,
    scheduler as never,
  );
  return { service, prisma, scheduler };
}

describe('MetadataSyncService', () => {
  beforeEach(() => setI18n(createTestI18n()));

  it('encrypts auth and never returns the ciphertext', async () => {
    const m = makeService();
    const auth = { headers: { 'X-API-Key': 'secret' } };
    m.prisma.metadataSyncSource.create.mockResolvedValue(
      row({ authJson: encryptJson(auth, AES_KEY) }),
    );

    const result = await run(() =>
      m.service.create({
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        auth,
      }),
    );

    const data = m.prisma.metadataSyncSource.create.mock.calls[0][0].data;
    expect(String(data.authJson)).not.toContain('secret');
    expect(decryptJson(String(data.authJson), AES_KEY)).toEqual(auth);
    expect(data.createdBy).toBe(1);
    expect(result.has_auth).toBe(true);
    expect(result).not.toHaveProperty('authJson');
    expect(m.scheduler.refresh).toHaveBeenCalledWith(5);
  });

  it('keeps auth when omitted and clears it on null', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(row());
    m.prisma.metadataSyncSource.update.mockResolvedValue(row());

    await run(() =>
      m.service.update({
        id: 5,
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
      }),
    );
    expect(
      m.prisma.metadataSyncSource.update.mock.calls[0][0].data.authJson,
    ).toBeUndefined();

    await run(() =>
      m.service.update({
        id: 5,
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        auth: null,
      }),
    );
    expect(
      m.prisma.metadataSyncSource.update.mock.calls[1][0].data.authJson,
    ).toBeNull();
  });

  it('scopes reads and writes to the actor workspace', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(null);
    await expect(
      run(() =>
        m.service.update({
          id: 5,
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(m.prisma.metadataSyncSource.update).not.toHaveBeenCalled();
  });

  it('validates endpoint, cron, MCP tool and auth shape', async () => {
    const m = makeService();
    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'ftp://bad',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/x',
          cron: 'nope',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'MCP',
          target: 'semantic',
          endpoint: 'https://meta.example.com/mcp',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/x',
          auth: { headers: { 'X-Key': 1 } } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.prisma.metadataSyncSource.create).not.toHaveBeenCalled();
  });

  it('maps a duplicate name to a 400', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.create.mockRejectedValue({ code: 'P2002' });
    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toThrow('同名同步源已存在');
  });

  it('deletes the source and removes its cron job', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(row());
    m.prisma.metadataSyncSource.delete.mockResolvedValue(row());

    await expect(run(() => m.service.remove(5))).resolves.toEqual({
      success: true,
      id: 5,
      name: 's',
    });
    expect(m.prisma.metadataSyncSource.delete).toHaveBeenCalledWith({
      where: { id: 5 },
    });
    expect(m.scheduler.remove).toHaveBeenCalledWith(5);
  });

  it('lists runs with a page envelope', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(row());
    m.prisma.metadataSyncRun.count.mockResolvedValue(11);
    m.prisma.metadataSyncRun.findMany.mockResolvedValue([
      {
        id: 1,
        sourceId: 5,
        trigger: 'manual',
        status: 'success',
        applied: 2,
        failedCount: 0,
        failed: null,
        error: null,
        startedAt: new Date('2026-01-01T00:00:00Z'),
        finishedAt: new Date('2026-01-01T00:00:01Z'),
      },
    ]);

    const result = await run(() => m.service.listRuns(5, 2, 10));

    expect(result.total_count).toBe(11);
    expect(result.data[0]).toMatchObject({
      source_id: 5,
      trigger: 'manual',
      status: 'success',
      applied: 2,
      failed_count: 0,
    });
    expect(m.prisma.metadataSyncRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
  });

  it('lists sources snake-mapped for the actor workspace', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findMany.mockResolvedValue([
      row({ id: 7, name: 'seven', cron: '0 * * * *', authJson: 'cipher' }),
    ]);
    const out = await run(() => m.service.list());
    expect(m.prisma.metadataSyncSource.findMany).toHaveBeenCalledWith({
      where: { oid: 1 },
      orderBy: { createdAt: 'desc' },
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 7,
      name: 'seven',
      cron: '0 * * * *',
      has_auth: true,
    });
  });

  it('stores http_body / mcp_tool / mcp_args per kind on create', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.create.mockResolvedValue(row());
    await run(() =>
      m.service.create({
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        http_method: 'POST',
        http_body: { page: 1 },
      }),
    );
    expect(m.prisma.metadataSyncSource.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ httpMethod: 'POST', httpBody: { page: 1 } }),
    );

    m.prisma.metadataSyncSource.create.mockResolvedValue(
      row({ kind: 'MCP', mcpTool: 'pull', mcpArgs: { q: 'x' } }),
    );
    await run(() =>
      m.service.create({
        name: 'm',
        kind: 'MCP',
        target: 'metric',
        endpoint: 'https://meta.example.com/mcp',
        mcp_tool: ' pull ',
        mcp_args: { q: 'x' },
      }),
    );
    expect(m.prisma.metadataSyncSource.create.mock.calls[1][0].data).toEqual(
      expect.objectContaining({
        kind: 'MCP',
        mcpTool: 'pull',
        mcpArgs: { q: 'x' },
        // MCP create never stores an HTTP body
        httpBody: undefined,
      }),
    );
  });

  it('encrypts token-only auth (headers ?? {} fallback)', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.create.mockImplementation(({ data }) =>
      Promise.resolve(row({ authJson: String(data.authJson) })),
    );
    const result = await run(() =>
      m.service.create({
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        auth: { token: 'bearer-value' },
      }),
    );
    const data = m.prisma.metadataSyncSource.create.mock.calls[0][0].data;
    expect(decryptJson(String(data.authJson), AES_KEY)).toEqual({
      token: 'bearer-value',
    });
    expect(result.has_auth).toBe(true);
  });

  it('rejects an empty name and requires a user context', async () => {
    const m = makeService();
    await expect(
      run(() =>
        m.service.create({
          name: '   ',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.prisma.metadataSyncSource.create).not.toHaveBeenCalled();

    await expect(
      requestContextStorage.run({}, () => m.service.list()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('fails loudly when the AES key is not configured', async () => {
    const prisma = {
      metadataSyncSource: { findMany: jest.fn(), findFirst: jest.fn() },
    };
    const service = new MetadataSyncService(
      prisma as never,
      { get: () => undefined } as unknown as ConfigService,
      { refresh: jest.fn(), remove: jest.fn() } as never,
    );
    await expect(
      run(() =>
        service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
          auth: { token: 't' },
        }),
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('rethrows non-P2002 create errors untouched', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.create.mockRejectedValue(
      new Error('connection refused'),
    );
    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toThrow('connection refused');
  });

  it('keeps the save working when the scheduler refresh fails', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.create.mockResolvedValue(row({ id: 9 }));
    m.scheduler.refresh
      .mockRejectedValueOnce(new Error('cron engine down'))
      .mockRejectedValueOnce('raw non-error rejection');
    await expect(
      run(() =>
        m.service.create({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).resolves.toMatchObject({ id: 9 });
    await expect(
      run(() =>
        m.service.create({
          name: 's2',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).resolves.toMatchObject({ id: 9 });
    expect(m.scheduler.refresh).toHaveBeenCalledTimes(2);
  });

  it('rejects an update without id before touching the DB', async () => {
    const m = makeService();
    await expect(
      run(() =>
        m.service.update({
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(m.prisma.metadataSyncSource.findFirst).not.toHaveBeenCalled();
    expect(m.prisma.metadataSyncSource.update).not.toHaveBeenCalled();
  });

  it('updates HTTP_API fields: method, body set/clear, auth set/empty, cron set/clear', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(
      row({ httpMethod: 'GET', httpBody: { old: 1 } }),
    );
    m.prisma.metadataSyncSource.update.mockResolvedValue(row());

    // http_method present + http_body present + content-bearing auth + cron
    await run(() =>
      m.service.update({
        id: 5,
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        http_method: 'POST',
        http_body: { page: 2 },
        auth: { headers: { Authorization: 'Bearer t' } },
        cron: ' 0 0 * * * ',
      }),
    );
    let data = m.prisma.metadataSyncSource.update.mock.calls[0][0].data;
    expect(data.httpMethod).toBe('POST');
    expect(data.httpBody).toEqual({ page: 2 });
    expect(decryptJson(String(data.authJson), AES_KEY)).toEqual({
      headers: { Authorization: 'Bearer t' },
    });
    expect(data.cron).toBe('0 0 * * *');

    // explicit nulls clear http_body/cron; empty auth object clears authJson
    await run(() =>
      m.service.update({
        id: 5,
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
        http_body: null,
        auth: {},
        cron: null,
      }),
    );
    data = m.prisma.metadataSyncSource.update.mock.calls[1][0].data;
    expect(data.httpBody).toBe(Prisma.DbNull);
    expect(data.authJson).toBeNull();
    expect(data.cron).toBeNull();

    // omitted http_method keeps the stored one
    await run(() =>
      m.service.update({
        id: 5,
        name: 's',
        kind: 'HTTP_API',
        target: 'semantic',
        endpoint: 'https://meta.example.com/rows',
      }),
    );
    data = m.prisma.metadataSyncSource.update.mock.calls[2][0].data;
    expect(data.httpMethod).toBe('GET');
  });

  it('updates MCP rows: tool set/absent, args value/null/omitted, http cleared', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(
      row({ kind: 'MCP', mcpTool: 'old', mcpArgs: { a: 1 } }),
    );
    m.prisma.metadataSyncSource.update.mockResolvedValue(row({ kind: 'MCP' }));

    // tool + args value
    await run(() =>
      m.service.update({
        id: 5,
        name: 'm',
        kind: 'MCP',
        target: 'semantic',
        endpoint: 'https://meta.example.com/mcp',
        http_body: { ignore: true },
        mcp_tool: ' pull ',
        mcp_args: { q: 'x' },
      }),
    );
    let data = m.prisma.metadataSyncSource.update.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        mcpTool: 'pull',
        mcpArgs: { q: 'x' },
        // an MCP row never keeps an HTTP body
        httpBody: Prisma.DbNull,
      }),
    );

    // args null clears (validate requires MCP rows to always carry a tool)
    await run(() =>
      m.service.update({
        id: 5,
        name: 'm',
        kind: 'MCP',
        target: 'semantic',
        endpoint: 'https://meta.example.com/mcp',
        mcp_tool: 'pull',
        mcp_args: null,
      }),
    );
    data = m.prisma.metadataSyncSource.update.mock.calls[1][0].data;
    expect(data.mcpArgs).toBe(Prisma.DbNull);
    expect(data.mcpTool).toBe('pull');

    // args omitted keeps the stored value
    await run(() =>
      m.service.update({
        id: 5,
        name: 'm',
        kind: 'MCP',
        target: 'semantic',
        endpoint: 'https://meta.example.com/mcp',
        mcp_tool: 'keep',
      }),
    );
    data = m.prisma.metadataSyncSource.update.mock.calls[2][0].data;
    expect(data.mcpArgs).toBeUndefined();
    expect(data.mcpTool).toBe('keep');
  });

  it('maps an update name conflict to a 400', async () => {
    const m = makeService();
    m.prisma.metadataSyncSource.findFirst.mockResolvedValue(row());
    m.prisma.metadataSyncSource.update.mockRejectedValue({ code: 'P2002' });
    await expect(
      run(() =>
        m.service.update({
          id: 5,
          name: 's',
          kind: 'HTTP_API',
          target: 'semantic',
          endpoint: 'https://meta.example.com/rows',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
