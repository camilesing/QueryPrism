// Pure request-parsing helpers for the g2-ssr HTTP server. They live outside
// server.ts so they can be unit-tested without binding a port.
import type http from 'node:http';

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

/** A G2 spec is a few KB; payloads that embed data rows stay far below this. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const MIN_CANVAS = 64;
export const MAX_CANVAS = 4096;

/** Canvas dimensions must be integers within [MIN_CANVAS, MAX_CANVAS]. The
 *  renderer scales by the device pixel ratio, so the largest accepted canvas
 *  (4096²) still costs ~270 MB; node-canvas itself would allow 32767², which
 *  measured at 3 GB RSS and a render that outlasted the caller's timeout. */
export function isCanvasSizeOk(width: number, height: number): boolean {
  return [width, height].every(
    (n) => Number.isInteger(n) && n >= MIN_CANVAS && n <= MAX_CANVAS,
  );
}

export class BodyTooLargeError extends Error {
  readonly status = 413;
  constructor() {
    super('request body too large');
  }
}

/** Buffer the request body up to `maxBytes`; beyond that the promise rejects
 *  with BodyTooLargeError and the rest of the body is drained unread, so the
 *  413 still reaches the client and the keep-alive socket stays usable. */
export function readBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        chunks.length = 0;
        reject(new BodyTooLargeError());
        req.removeListener('data', onData);
        req.resume();
        return;
      }
      chunks.push(c);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
