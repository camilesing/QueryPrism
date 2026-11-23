// g2-ssr-client spec — verifies the thin HTTP client that POSTs a G2 spec to
// the g2-ssr microservice and returns the base64 PNG. Failure paths (host
// unset, non-ok response, missing image field, fetch throw) all degrade to
// `{image: null}` so the MCP tool skips the image content block instead of
// throwing — g2-ssr is an optional rendering path (decision §51).
import { ConfigService } from '@nestjs/config';
import { G2SsrClient } from './g2-ssr-client.service';
import type { G2Spec } from '../chart/chart-spec.builder';

const spec: G2Spec = { type: 'interval', data: [], encode: { x: 'a', y: 'b' } };

// Jest's node environment does not always expose undici's global fetch, so
// replace it directly instead of relying on jest.spyOn(globalThis, 'fetch').
const originalFetch = globalThis.fetch;

/** Build a client backed by a mocked ConfigService + a mocked global fetch. */
function makeClient(host: string | undefined): {
  client: G2SsrClient;
  fetchMock: jest.Mock;
} {
  const config = {
    get: jest.fn((key: string) => (key === 'g2ssr.host' ? host : undefined)),
  };
  const fetchMock = jest.fn();
  globalThis.fetch = fetchMock;
  const client = new G2SsrClient(config as unknown as ConfigService);
  return { client, fetchMock };
}

afterEach(() => {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
  } else {
    delete (globalThis as { fetch?: unknown }).fetch;
  }
  jest.restoreAllMocks();
});

describe('G2SsrClient', () => {
  it('POSTs the spec to <g2ssr.host>/render and returns the image + path + url', async () => {
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => ({
        image: 'base64-png',
        path: 'abc.png',
        url: 'http://localhost:3001/images/abc.png',
      }),
    });

    const res = await client.render(spec);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/render',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // JSON.stringify drops undefined width/height — exact literal match.
        body: JSON.stringify({ spec }),
      }),
    );
    expect(res).toEqual({
      image: 'base64-png',
      path: 'abc.png',
      url: 'http://localhost:3001/images/abc.png',
    });
  });

  it('aborts a render that does not answer within the timeout', async () => {
    // Without a signal a g2-ssr that accepts the connection but never
    // answers holds the MCP tool call until the HTTP stack's own default.
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockResolvedValue({ ok: false });

    await client.render(spec);

    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('threads width/height through the body when provided', async () => {
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => ({ image: 'x' }),
    });

    await client.render(spec, { width: 800, height: 600 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3001/render',
      expect.objectContaining({
        body: JSON.stringify({ spec, width: 800, height: 600 }),
      }),
    );
  });

  it('degrades to {image:null} when the host is unset', async () => {
    const { client, fetchMock } = makeClient(undefined);
    const res = await client.render(spec);
    expect(res).toEqual({ image: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to {image:null} on a non-ok response', async () => {
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const res = await client.render(spec);
    expect(res).toEqual({ image: null });
  });

  it('degrades to {image:null} when the response body has no image field', async () => {
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockResolvedValue({ ok: true, json: () => ({}) });
    const res = await client.render(spec);
    expect(res).toEqual({ image: null });
  });

  it('degrades to {image:null} when fetch throws (g2-ssr down)', async () => {
    const { client, fetchMock } = makeClient('http://localhost:3001');
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await client.render(spec);
    expect(res).toEqual({ image: null });
  });
});
