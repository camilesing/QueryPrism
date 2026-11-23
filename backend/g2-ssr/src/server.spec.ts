// Request-parsing guards of the g2-ssr HTTP server (no port is bound here).
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { BodyTooLargeError, parseRequestUrl, readBody } from './http-utils';

describe('g2-ssr request parsing', () => {
  it('returns null for a malformed Host header instead of throwing', () => {
    // `new URL()` throws on this input; inside the async request listener the
    // unhandled rejection used to terminate the process.
    expect(parseRequestUrl('/healthz', '[')).toBeNull();
    expect(parseRequestUrl('/healthz', 'example.com')?.pathname).toBe(
      '/healthz',
    );
    expect(parseRequestUrl(undefined, undefined)?.pathname).toBe('/');
  });
});

describe('g2-ssr request body', () => {
  it('rejects a body over the cap and stops buffering it', async () => {
    const req = new PassThrough() as unknown as IncomingMessage;
    const pending = readBody(req, 4);
    req.write(Buffer.alloc(5));
    await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
    // The rest of the body is drained, so the socket stays in a clean state.
    const ended = new Promise((resolve) => req.once('end', resolve));
    req.end(Buffer.alloc(1024));
    await ended;
  });

  it('resolves the buffered body when it stays within the cap', async () => {
    const req = new PassThrough() as unknown as IncomingMessage;
    const pending = readBody(req, 64);
    req.end(Buffer.from('{"spec":{}}'));
    await expect(pending).resolves.toBe('{"spec":{}}');
  });
});
