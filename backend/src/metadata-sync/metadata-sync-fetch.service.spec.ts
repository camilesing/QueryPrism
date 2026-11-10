// Fetch-layer tests: HTTP (native fetch mocked) + MCP (SDK client mocked).
import { ConfigService } from '@nestjs/config';
import type { MetadataSyncSource } from '@prisma/client';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import { encryptJson } from '../common/utils/aes';
import { MetadataSyncFetchService } from './metadata-sync-fetch.service';

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const connect = jest.fn();
  const callTool = jest.fn();
  const close = jest.fn();
  return {
    Client: jest.fn().mockImplementation(() => ({ connect, callTool, close })),
    __mock: { connect, callTool, close },
  };
});

jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({})),
}));

const sdkMock = jest.requireMock<{
  __mock: {
    connect: jest.Mock;
    callTool: jest.Mock;
    close: jest.Mock;
  };
}>('@modelcontextprotocol/sdk/client/index.js').__mock;

const AES_KEY = 'test-aes-key';
/** Node's fetch is inherited from globalThis in some runtimes, so spyOn is
 *  brittle here — swap the property and restore it around each test. */
const originalFetch = globalThis.fetch;
let fetchMock: jest.Mock;

function makeService() {
  return new MetadataSyncFetchService({
    get: (key: string) => (key === 'aes.key' ? AES_KEY : undefined),
  } as unknown as ConfigService);
}

function source(over: Partial<MetadataSyncSource> = {}): MetadataSyncSource {
  return {
    id: 1,
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

describe('MetadataSyncFetchService', () => {
  beforeEach(() => {
    setI18n(createTestI18n());
    sdkMock.connect.mockReset().mockResolvedValue(undefined);
    sdkMock.callTool.mockReset();
    sdkMock.close.mockReset().mockResolvedValue(undefined);
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('pulls an HTTP batch with auth headers', async () => {
    const fetchSpy = fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [{ table_name: 'users' }] }),
    });
    const authJson = encryptJson({ headers: { 'X-API-Key': 'k' } }, AES_KEY);

    const rows = await makeService().fetchRows(source({ authJson }));

    expect(rows).toEqual([{ table_name: 'users' }]);
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://meta.example.com/rows',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          'X-API-Key': 'k',
        }),
      }),
    );
  });

  it('sends a JSON body for POST sources', async () => {
    const fetchSpy = fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve([]),
    });

    await makeService().fetchRows(
      source({ httpMethod: 'POST', httpBody: { scope: 'all' } }),
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://meta.example.com/rows',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ scope: 'all' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('reports a non-2xx HTTP status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });

    await expect(makeService().fetchRows(source())).rejects.toThrow(
      'External API returned HTTP 503',
    );
  });

  it('maps an aborted fetch to the localized timeout message', async () => {
    fetchMock.mockRejectedValue({ name: 'TimeoutError' });

    await expect(makeService().fetchRows(source())).rejects.toThrow(
      'did not respond within 30 seconds',
    );
  });

  it('rejects a non-array HTTP payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ nope: [] }),
    });

    await expect(makeService().fetchRows(source())).rejects.toThrow(
      'must return a JSON array',
    );
  });

  it('calls the configured MCP tool and parses its text block', async () => {
    sdkMock.callTool.mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify([{ table_name: 'orders' }]) },
      ],
    });

    const rows = await makeService().fetchRows(
      source({
        kind: 'MCP',
        endpoint: 'https://mcp.example.com/mcp',
        mcpTool: 'get_metadata',
        mcpArgs: { target: 'semantic' },
      }),
    );

    expect(rows).toEqual([{ table_name: 'orders' }]);
    expect(sdkMock.connect).toHaveBeenCalledTimes(1);
    expect(sdkMock.callTool).toHaveBeenCalledWith({
      name: 'get_metadata',
      arguments: { target: 'semantic' },
    });
    expect(sdkMock.close).toHaveBeenCalledTimes(1);
  });

  it('rejects MCP sources without a tool and empty tool output', async () => {
    await expect(
      makeService().fetchRows(
        source({ kind: 'MCP', endpoint: 'https://mcp.example.com/mcp' }),
      ),
    ).rejects.toThrow('require a tool name');

    sdkMock.callTool.mockResolvedValue({ content: [] });
    await expect(
      makeService().fetchRows(
        source({
          kind: 'MCP',
          endpoint: 'https://mcp.example.com/mcp',
          mcpTool: 'get_metadata',
        }),
      ),
    ).rejects.toThrow('returned no text content');
  });

  it('rejects auth that cannot be decrypted', async () => {
    await expect(
      makeService().fetchRows(source({ authJson: 'not-ciphertext' })),
    ).rejects.toThrow('Invalid authentication configuration');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
