# QueryPrism - Agent Instructions

QueryPrism is an intelligent data-visualization chatbot: connect databases, ask questions in natural language, and get LLM-generated SQL + charts. It is multi-workspace (tenant-scoped) and also ships dashboards, embedded assistants, and an MCP server.

Monorepo with independent projects — no monorepo workspace. Use **pnpm for `backend/`**, **npm for `frontend/` and `backend/g2-ssr/`**; install dependencies separately per project. (`backend/pnpm-workspace.yaml` only allow-lists pnpm postinstall builds, not packages.)

## Project Structure

- `backend/` — NestJS API (port 3000, prefix `/api/v1`)
- `frontend/` — Vue 3 SPA (port 5173, hash router)
- `backend/g2-ssr/` — standalone G2 chart→PNG microservice (port 3001), NOT part of the Nest build
- `backend/prisma/` — schema + migrations; `backend/docs/postgres.md` — PostgreSQL/pgvector details
- `docs/` — one-off rename/upgrade notes and review plans

## Backend

**Stack:** NestJS 11.x, TypeScript 5.7, Prisma 6.19, PostgreSQL 18 + pgvector, LangChain.js

**Setup:**
```bash
# From the repo root — start PostgreSQL 18 + pgvector
docker compose up -d db        # or: Reopen in Container (devcontainer)

cd backend
pnpm install
pnpm run prisma:generate
pnpm run prisma:migrate
pnpm run prisma:seed           # admin user / baseline rows
```

**Commands:**
- Dev: `pnpm run start:dev`
- Build: `pnpm run build`
- Test: `pnpm run test` (unit, no DB)
- E2E: `pnpm run test:e2e` (requires the compose DB; resets `<db>_test`)
- Coverage: `pnpm run test:cov`
- Lint: `pnpm run lint` (ESLint + Prettier, auto-fixes, `--max-warnings 0`)
- Format: `pnpm run format`
- Prisma Studio / deploy: `pnpm run prisma:studio` / `pnpm run prisma:deploy`
- Embedded-sign helper: `pnpm run sign:embedded`

**Verification gate:** `pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e` (the "four gates"). `backend/g2-ssr` is excluded — it has its own `npm run build` / `npm test`.

**Important:**
- `DATABASE_URL` must be a PostgreSQL URL — startup fails fast otherwise (see `backend/.env.example`)
- `pnpm run prisma:seed` creates workspace `default` + dev admin `admin` / `admin` (also the e2e fixture)
- Prisma CLI loads `.env` via `backend/prisma.config.ts`; schema is `backend/prisma/schema.prisma`
- Vector index: derived tables in the unmanaged `vector_store` schema (pgvector/HNSW), managed by `VectorService`; Prisma `embedding Json` columns are the source of truth and the index is rebuildable
- Excel datasources import into the unmanaged `excel_store` schema (created lazily)
- API prefix is `/api/v1` (`main.ts`); CORS is dynamic — `FRONTEND_URL` + each Assistant's `domain`, fail-closed for unknown origins
- No global auth guard: controllers opt in with `@UseGuards(JwtAuthGuard)`. `AdminGuard` (uid 1) and `WsAdminGuard` (workspace admin) must run AFTER it
- Auth is JWT via `X-QUERYPRISM-TOKEN: Bearer <jwt>` (Authorization fallback). The user is attached to `req.user` and AsyncLocalStorage; use `@CurrentUser()` or `RequestContext.getUser()`
- Workspace isolation: business rows carry `oid` (workspace id). Every tenant-data query MUST filter by the current user's `oid` (see `DatasourceService.currentOid()`); system admin is uid 1
- Response protocol: success `{ success: true, code: 0, msg: 'success', data }`; errors are plain-text bodies with the HTTP status (the frontend displays `.toString()`)
- i18n: user-facing strings go through `tr('module.key')` (`common/i18n/translate.ts`); add keys to BOTH `src/i18n/en/*.json` and `src/i18n/zh-CN/*.json`. Language = user profile → `Accept-Language`
- DTO validation is global (`I18nValidationPipe`, `whitelist` + `transform`); declare `class-validator` DTOs instead of trusting raw bodies

## Frontend

**Stack:** Vue 3.5, TypeScript 5.7, Vite 6, Element Plus (`element-plus-secondary` fork), AntV G2, Pinia, Vue Router 4

**Setup:**
```bash
cd frontend
npm install
```

**Commands:**
- Dev: `npm run dev` (runs `vue-tsc -b` first, so type errors block startup)
- Build/typecheck: `npm run build` (`vue-tsc -b` + Vite)
- Preview: `npm run preview`
- Lint: `npm run lint` (ESLint, auto-fixes)
- i18n check: `npm run check:i18n` (en/zh-CN key parity; run after adding strings)

**Important:**
- Path alias `@` → `src/`; strict TS with `noUnusedLocals` / `noUnusedParameters`
- UI: Element Plus auto-import via `unplugin-vue-components-secondary` + `ElementPlusResolver`; explicit runtime imports may need their CSS (`main.ts` imports `el-menu.css`)
- Charts: Use AntV G2 for all visualizations
- State: Pinia stores in `src/stores/`; API clients in `src/api/`
- API base URL: `VITE_API_BASE_URL` in `.env.development` (`http://localhost:3000/api/v1`) / `.env.production` (`./api/v1`)
- `src/utils/request.ts` unwraps `{ code: 0, data }` to `data` and shows errors globally. Auth headers are custom: `X-QUERYPRISM-TOKEN`, plus `X-QUERYPRISM-ASSISTANT-*` for embedded/assistant flows
- Router uses `createWebHashHistory` — URLs look like `/#/chat/index`
- i18n: `src/i18n/en.json` + `zh-CN.json` (vue-i18n, locale persisted in `user.language`); keep keys aligned
- Build targets Chrome 81 with `@vitejs/plugin-legacy` — avoid browser APIs newer than that

## Testing

**Backend:**
- Unit tests: colocated `src/**/*.spec.ts`, Jest + ts-jest, no database
- E2E: `backend/test/*.e2e-spec.ts`, Jest config `test/jest-e2e.json` (`maxWorkers: 1`)
- E2E global setup derives `<DATABASE_URL database>_test`, refuses to run if the derived name does not end in `_test`, drops `vector_store` / `excel_store`, then runs `prisma migrate reset`
- Audit writes are fire-and-forget; use `test/helpers/wait-for.ts` instead of fixed sleeps
- Config: `backend/jest.config.js` (rootDir `src`), `backend/test/jest-e2e.json`

**Frontend:** No test framework configured. Typecheck with `npm run build` (or `npx vue-tsc -b`).

**g2-ssr:** `cd backend/g2-ssr && npm test` (vitest; render tests skip if native canvas libs are missing).

**Evidence:** report what actually ran — do not claim build/lint/test passed unless the command was executed. Confirm a focused run really matched the intended tests (a filter that matches nothing proves nothing). A regression test should fail without the fix; one that passes either way only pins current behavior.

## Code Quality

- Backend: type-checked ESLint + Prettier; `pnpm run lint` auto-fixes and fails on warnings; `pnpm run format`
- Frontend: `npm run lint` (ESLint flat config + Prettier, auto-fixes)
- Prettier: backend `singleQuote` + `trailingComma: all`; frontend `singleQuote`, no semicolons, `printWidth: 100`, `trailingComma: es5`
- Strict TypeScript enabled in both projects

## Development Workflow

1. Start PostgreSQL: `docker compose up -d db` (or Reopen in Container)
2. Start backend: `cd backend && pnpm run start:dev`
3. Start frontend: `cd frontend && npm run dev`
4. Backend: http://localhost:3000/api/v1 — frontend: http://localhost:5173
5. Optional (MCP chart images): `cd backend/g2-ssr && npm run dev` on port 3001

## API Design

RESTful, prefix `/api/v1`:
- `/login`, `/user`, `/system/workspace` — auth, profile, workspace/member admin
- `/datasource`, `/table_relation` — CRUD, test connection, sync/choose tables, Excel import, relationships, relation version history
- `/chat` — sessions (limited to 20 recent) + `/chat/:id/message` SSE, regenerate chart
- `/dashboard` — dashboard builder CRUD
- `/system/{terminology,data-training,custom_prompt,aimodel,parameter,appearance,audit,apikey,embedded,assistant,mcp-integration}` — RAG context + admin surfaces
- `/recommended_problem`, `/ds_permission`, `/sys_variable` — recommended questions, row permissions, system variables
- `/assistant` — public embedded-assistant entry by appId
- `/mcp` — stateless Streamable HTTP MCP server (per-integration Bearer tokens)
- `/system/metadata-sync` — external metadata pull sources (HTTP API / MCP), manual run + run history, cron-scheduled

## Key Implementation Notes

- Data source connection management in `backend/src/datasource/` (MySQL/PostgreSQL/SQLite/Excel connectors under `db-connector/`)
- SQL generation: LLM-driven NL2SQL pipeline (LangChain, SSE streaming) in `backend/src/chat/chat.service.ts` + `backend/src/llm/` — NOT rule-based
- Chat streaming: raw `@Res()` + `SseWriter` (`chat/sse-writer.ts`); `TransformInterceptor` skips wrapping once headers are sent. Keep streaming endpoints out of the JSON envelope
- Chart analysis: Chart type picked by the LLM (`generate_chart`), rendered with AntV G2 on the frontend
- Table recall: keyword-fused ranking in `recallTables` (LLM keyword extraction → terminology synonym expansion → α·vector + (1-α)·keyword, explicit table mentions always retained; pure functions in `backend/src/datasource/table-recall.ts`); falls back to all checked tables
- Retrieval strategy params: 23 runtime parameters (10 `embedding.*` + 4 `clarify.*` + 5 `semantic.*` + 4 `metric.*`/`naming.*`) in `backend/src/common/config/embedding-config.ts`, priority saved SystemVariable > env > code default; snapshot per chat task; admin parameter page validates strictly and rejects whole save on invalid input
- Clarify gate (ask-to-narrow): when a question matches ≥ `clarify.table_threshold` candidate tables and names none of them, the pipeline pauses (`clarify` SSE event, ChatRecord `clarifyStatus='pending'`, no SQL yet); the user answers via `POST /chat/record/:rid/clarify` (pick tables / supplement text / skip — resumes the SAME record); MCP `ask_question` returns `needs_clarification` and resumes via `clarify_record_id`. Candidates carry the effective `meaning` (comment fallback) and the payload may add `suggested_table_ids`; the generate_sql prompt gets a `{candidate_tables}` block while the record's clarify-round budget remains and recall narrowed the schema. Each pause increments `ChatRecord.clarifyRound`; `clarify.max_rounds` (default 1) caps pauses per record — above 1 the gate and `need_clarify` can ask again, supplement texts accumulate in `clarifyAnswer.texts`, and the previous round's candidate pool stays pickable (table picks are per-round, latest answer wins). `need_clarify.tables` (already parsed by `parseSqlResult`) is matched case-insensitively against the candidate pool; suggestions = current stuffed set + matched tables (or matched only when the stuffed set exceeds `max_select`), capped for the UI. Advisory only — resume still enforces `clarify.max_select`
- Semantic layer (`backend/src/semantic/`): TableSemantic/FieldSemantic hold curated business meanings in three scopes (PERSONAL > WORKSPACE > GLOBAL; natural keys `datasourceId+tableName[+fieldName]`, no Table FK). Natural-key uniqueness is DB-enforced by the partial unique indexes from migration `20261110130000_semantic_natural_key_unique` (not expressible in Prisma PSL); a concurrent create race retries the whole transaction once on P2002, then returns 409 `*.write_conflict`. Cross-layer edits by non-admins become SemanticChangeRequests (ws admin / uid 1 approves; approval applies payload + version history in ONE transaction; review() first claims the request with a conditional `updateMany(status='pending')`, so two concurrent approvals apply it once and the loser gets 400). Rule 2: when `semantic.enabled` and candidates carry meanings, only the top `semantic.max_tables` are stuffed; `generate_sql` may answer `{"need_clarify":true,"reason":...}` which reuses the clarify flow. The parser (`generator.service.ts` `parseSqlResult`) maps `need_clarify`/`needClarify` + `reason` + `tables` — do not drop them, or a real ask-for-more degrades to "SQL is empty" (and the clarify card loses its preselection). Effective semantics decorate the FINAL stuffed set (single recalled table, forced/clarify picks, metric force-stuff, join bridges, degraded all-checked path), not just the rule-2 narrowed set. Cached dimension enums keep `{value,label}` through `effectiveAnnotations` and render as `value(label)` in the M-Schema; `collectEnums` preserves labels for still-sampled values. `clarify.max_select` is enforced server-side on resume. Ingestion: admin UI `/set/semantic`, Excel import/export, and `POST /meta/semantic/import` guarded by ApiKeyGuard (`X-QUERYPRISM-APIKEY`/`X-QUERYPRISM-APISECRET`). Import rows accept `scope` (default WORKSPACE) + `enabled`, are written directly only with layer authority (PERSONAL: own rows; WORKSPACE: ws admin; GLOBAL: uid 1), and unauthorized rows fail per row (never auto-propose); exports carry `scope`
- Metric system + data standards (M4, `backend/src/semantic/metric-*.ts` / `standard.*`): MetricDef kinds atomic/modifier/period/derived/composite + DataStandard kinds unit/naming on the shared GovernedDictService governance (same scopes/approval/version table as M2, entityType `metric`/`standard`; definition JSON is snake-keyed and strictly parsed by `metric-policy.ts`). Runtime: question matches by name/alias inclusion → `<metric_definitions>` caliber block + force-stuffed atomic tables in runCore (after the clarify gate, before bridge expansion; `metric.enabled` / cap `metric.max_definitions`), naming matches → `<naming_rules>` (`naming.enabled`). Composite expressions are whitelist-tokenized; dangling refs/cycles skip the metric, never the request. Ingestion: `/set/metric` admin UI, six-sheet Excel, `/meta/metric|standard/import`; rows accept `scope` (default WORKSPACE) + `enabled` under the same per-layer direct-write rules, and exports carry `scope`. Matching is literal-first: name/alias substring hits render first, then metric vectors (collection `vec_metric_def`; per-row write hook after direct edit/approval/enable, plus a null-embedding backfill on startup/manual run/`metric.enabled` flip) may fill the remaining `metric.max_definitions` slots with ATOMIC metrics whose cosine similarity strictly exceeds `metric.similarity_threshold` (default 0.55). Derived/composite and modifier/period matching stay literal-only; invisible/disabled rows are re-filtered after the vector search, and no embedding key / pgvector / provider error degrades to literal-only with a log
- External metadata sync (M5, `backend/src/metadata-sync/`): workspace admins configure `MetadataSyncSource` rows (kind `HTTP_API`/`MCP`, target `semantic`/`metric`/`standard`, endpoint, optional cron + encrypted auth) at `/set/metadata-sync`. The runner resolves `createdBy` as the run-as identity (must still be a workspace admin), fetches a batch (top-level array or `{data|rows:[]}`, max 5000), and reuses `SemanticImportService.importJson` / `MetricImportService.importJsonMetrics|importJsonStandards` so validation/upsert/versioning stay in ONE place. Rows may carry `scope`, so the run-as identity must hold direct authority for the target layer (GLOBAL only when uid 1; unauthorized rows fail). Every attempt writes a `MetadataSyncRun` + audit row; secrets are AES-encrypted and never returned (`has_auth` only). Scheduling uses the CommonJS `cron` package with an in-process job map — single-instance only (a second replica would duplicate runs); 30s timeout, per-source concurrency guard
- Join relation versions: every `POST /table_relation/save/:dsId` runs in ONE transaction that increments `Datasource.relationVersion` and appends `DatasourceRelationVersion` (full X6 cells snapshot, `changedBy`). Runtime still reads `Datasource.tableRelation` (the latest); history is exposed via `POST /table_relation/versions/:dsId` and the editor's history drawer. `POST /table_relation/restore/:dsId/:version` writes a snapshot back and appends a NEW version (never rewrites history) and is audited; `POST /table_relation/compare/:dsId` diffs two saved versions as normalized FK edges (node positions ignored). Both are WsAdminGuard + workspace-scoped. There is still no per-version approval flow
- **Multi-step DB writes must run in ONE `prisma.$transaction`** (interactive form when a read informs a later write — dup checks, existence checks). A mid-sequence failure must never leave half-applied state (see permission/workspace/system-variable/user services for the pattern)
- **Vector search uses pgvector** (`VectorService`): cosine distance via `<=>`, HNSW indexes, tables in the unmanaged `vector_store` schema. If the extension/schema is missing, recall degrades to keyword-only instead of failing requests
- Chat history: Limited to 20 conversations
- Message data: Stored as JSON strings (query results, chart configs)
- g2-ssr: Nest calls `G2_SSR_HOST` over HTTP; when unreachable the MCP `mcp_question` tool omits the image block and the backend keeps working

## Working Rules

- Inspect `git status` and existing call sites/module patterns before editing; preserve unrelated dirty or untracked work.
- Prefer extending the existing module/service over adding a parallel abstraction. A new layer must name what it replaces; otherwise edit the original.
- Prefer the smallest change that preserves observable API/DB contracts. A rewrite needs a product reason, not a shortcut around reading existing code.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Treat this file as durable guidance: derive versions, commands, ports, and paths from `package.json`, configs, and migrations — README/plan prose drifts (e.g. the stale TS 6 / Vite 8 claim).
- Misconfiguration should fail loud at startup/load. Silent fallback is allowed only where explicitly designed (e.g. vector recall degrading to keyword-only).
- Write down a feature's known limitations next to the code that owns it, so the next reader does not assume an unbuilt capability.
- A user-facing feature or API change lands with its docs and i18n keys in the same change. `README.md` and `README_zh.md` are a bilingual pair — update both.
- Commit messages are English and use Conventional Commits (`type(scope): summary`). Total length (subject + body) must be ≤200 characters; put detailed evidence in the PR body or turn report, not the message.

## Docs Worth Reading Before Sensitive Changes

- `backend/docs/postgres.md` — pgvector schema/indexes, vector_store permissions, test DB setup
- `docs/queryprism-migration.md` — one-off rename/DB upgrade steps (do not run these on fresh installs)
- `plan.md` is the original plan (SQLite, NestJS 10) and is historical — prefer this file and `package.json`

## Common Issues

- **Stale README stack:** `README.md` claims TypeScript 6.x / Vite 8.x; actual `frontend/package.json` is TypeScript ~5.7 and Vite 6. Trust package.json
- **Prisma migration:** Run `prisma:generate` after schema changes; `prisma migrate dev` for new migrations
- **pnpm native builds:** `backend/pnpm-workspace.yaml` keeps `allowBuilds` and `onlyBuiltDependencies` in sync (pnpm ≤10 ignores `allowBuilds`). If `better-sqlite3` / `sharp` / Prisma engines fail to build, check both lists
- **pgvector missing:** The baseline migration runs `CREATE EXTENSION vector` and creates schema `vector_store`; the DB role needs permission to create the extension. If the app log says vector search is disabled, run `pnpm prisma:deploy`
- **E2E database:** `pnpm test:e2e` derives `<DATABASE_URL database>_test`, resets it, and seeds it. It refuses to run if the derived name does not end in `_test`
- **Lint scripts mutate files:** both `lint` scripts pass `--fix`; review the diff before committing
- **Frontend dev won't start on type errors:** `npm run dev` runs `vue-tsc -b` first
- **Embedded CORS:** allowed origins are `FRONTEND_URL` + each Assistant's `domain`; unknown origins are rejected (fail-closed), so add the domain to the Assistant record
- **Port conflicts:** Backend 3000, frontend 5173, g2-ssr 3001
- **API prefix:** backend uses `/api/v1`, not `/api` (older notes/docs may say otherwise)