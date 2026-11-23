// g2-ssr HTTP microservice — a tiny Node http server (no framework) that
// turns a G2 5.x spec into a PNG. NestJS calls it via G2SsrClient
// (backend/src/mcp/g2-ssr-client.service.ts); the MCP mcp_question tool uses
// the returned base64 as an image content block (decision §51).
//
// Endpoints:
//   POST /render { spec, width?, height? } → { image: <base64>, path, url }
//   GET  /images/:file                    → static PNG
//   GET  /healthz                         → { ok: true }
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { renderChart, type G2Spec } from './render';
import {
  BodyTooLargeError,
  parseRequestUrl,
  readBody,
} from './http-utils';

const PORT = parseInt(process.env.G2_SSR_PORT ?? '3001', 10);
const BASE_URL =
  process.env.G2_SSR_BASE_URL ?? `http://localhost:${PORT}`;
const IMAGE_DIR =
  process.env.G2_SSR_IMAGE_DIR ?? path.join(process.cwd(), 'images');

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  // A malformed Host header makes `new URL` throw; inside this async
  // listener the rejection is unhandled and would terminate the process.
  const url = parseRequestUrl(req.url, req.headers.host);
  if (!url) {
    sendJson(res, 400, { error: 'bad request' });
    return;
  }

  // CORS preflight + permissive headers (the Nest backend is cross-origin).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }
  res.setHeader('access-control-allow-origin', '*');

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
    const file = path.basename(url.pathname); // guards against traversal
    const fp = path.join(IMAGE_DIR, file);
    try {
      const stat = await fs.promises.stat(fp);
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': stat.size,
        'cache-control': 'public, max-age=86400',
      });
      fs.createReadStream(fp).pipe(res);
    } catch {
      sendJson(res, 404, { error: 'image not found' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/render') {
    try {
      const parsed = JSON.parse(await readBody(req)) as {
        spec?: G2Spec;
        width?: number;
        height?: number;
      };
      if (!parsed.spec) {
        sendJson(res, 400, { error: 'spec is required' });
        return;
      }
      const { buffer } = await renderChart({
        spec: parsed.spec,
        width: parsed.width,
        height: parsed.height,
      });
      const filename = `${randomUUID()}.png`;
      await fs.promises.mkdir(IMAGE_DIR, { recursive: true });
      await fs.promises.writeFile(path.join(IMAGE_DIR, filename), buffer);
      sendJson(res, 200, {
        image: buffer.toString('base64'),
        path: filename,
        url: `${BASE_URL}/images/${filename}`,
      });
    } catch (e) {
      // BodyTooLargeError carries 413; everything else is a render failure.
      sendJson(res, e instanceof BodyTooLargeError ? e.status : 500, {
        error: (e as Error).message,
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[g2-ssr] listening on :${PORT} (base ${BASE_URL}, images ${IMAGE_DIR})`,
  );
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
