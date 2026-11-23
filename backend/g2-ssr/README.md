# QueryPrism g2-ssr

Chart → PNG microservice for the QueryPrism MCP server. Renders an
[AntV G2 5.x](https://g2.antv.antgroup.com/) spec to a PNG via
[`@antv/g2-ssr`](https://www.npmjs.com/package/@antv/g2-ssr) + `node-canvas`.

This is a **separate Node sub-project** (isolated from the NestJS backend):
it has its own `package.json` / `tsconfig.json` and is NOT part of the
backend four-gate (`pnpm run build && lint && test && test:e2e`). The backend
talks to it over HTTP through
[`backend/src/mcp/g2-ssr-client.service.ts`](../src/mcp/g2-ssr-client.service.ts).
When it's unreachable the MCP `mcp_question` tool simply omits the image
content block (decision §51) — the backend keeps working.

## API

| Method | Path                  | Body / Notes                                   | Response                                           |
| ------ | --------------------- | ---------------------------------------------- | -------------------------------------------------- |
| POST   | `/render`             | `{ spec, width?, height? }` (G2 5.x spec JSON) | `{ image: <base64 PNG>, path: "<uuid>.png", url }` |
| GET    | `/images/<uuid>.png`  | —                                              | `image/png`                                        |
| GET    | `/healthz`            | —                                              | `{ ok: true }`                                      |

CORS is permissive (`*`); the Nest backend is cross-origin.

Errors are JSON: `{ "error": "<message>" }` with the HTTP status.

### Limits

| Condition                                            | Status |
| --------------------------------------------------- | ------ |
| Request body larger than 2 MB                       | `413`  |
| `width` / `height` outside 64–4096, or not integers | `400`  |
| A render G2 rejects, or that takes longer than 8 s   | `500`  |

The backend only sends specs built by `backend/src/chart/chart-spec.builder.ts`
and never sets `width` / `height` (640×480 is used).

### Failed renders

When G2 throws while rendering, `@antv/g2-ssr` neither resolves nor rejects
its promise: the server logs the rejection (`a G2 render failed outside its
request promise`), answers the request with `500` after the 8 s timeout and
keeps serving. **Known limitation:** such a render keeps its canvas — there is
no chart handle to destroy — and the synchronous `toBuffer()` step cannot be
interrupted.

## Setup

```bash
cd backend/g2-ssr
npm install
npm run build
npm start          # listens on :3001
```

### Native canvas libs (macOS)

`node-canvas` needs cairo/pango/jpeg/giflib/rsvg. Install once:

```bash
brew install cairo pango libjpeg giflib librsvg
```

If those are absent, `npm install` still succeeds but rendering at runtime
throws — the vitest suite auto-skips (see `src/render.spec.ts`), and the
backend client degrades to `{ image: null }`.

## Config (env)

| Var               | Default                          | Meaning                                  |
| ----------------- | -------------------------------- | ---------------------------------------- |
| `G2_SSR_PORT`     | `3001`                           | HTTP listen port.                        |
| `G2_SSR_BASE_URL` | `http://localhost:${PORT}`       | Base used for the `url` field in /render.|
| `G2_SSR_IMAGE_DIR`| `./images` (cwd-relative)        | Where rendered PNGs are written.         |

The Nest backend reads `G2_SSR_HOST` (default `http://localhost:3001`) +
`MCP_IMAGE_PATH` from its own config — keep `G2_SSR_HOST` pointed at this
service's `G2_SSR_PORT`.

## Scripts

| Script    | Command                  |
| --------- | ------------------------ |
| `build`   | `tsc`                    |
| `dev`     | `tsx watch src/server.ts`|
| `start`   | `node dist/server.js`    |
| `test`    | `vitest run`             |
