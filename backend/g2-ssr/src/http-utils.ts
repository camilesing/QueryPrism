// Pure request-parsing helpers for the g2-ssr HTTP server. They live outside
// server.ts so they can be unit-tested without binding a port.

/** Parse the request URL against the Host header. `new URL()` throws on a
 *  malformed Host (e.g. `[`); inside the async request listener that
 *  rejection would be unhandled and take the whole process down, so callers
 *  get null here and answer 400 instead. */
export function parseRequestUrl(
  requestUrl: string | undefined,
  host: string | undefined,
): URL | null {
  try {
    return new URL(requestUrl ?? '/', `http://${host ?? 'localhost'}`);
  } catch {
    return null;
  }
}
