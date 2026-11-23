// Request-parsing guards of the g2-ssr HTTP server (no port is bound here).
import { parseRequestUrl } from './http-utils';

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
