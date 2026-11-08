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
