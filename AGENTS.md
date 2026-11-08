# QueryPrism - Agent Instructions

Monorepo with two independent projects (backend/frontend). No workspace configuration - install dependencies separately.

## Project Structure

- `backend/` - NestJS API (port 3000)
- `frontend/` - Vue 3 SPA (port 5173)

## Backend

**Stack:** NestJS 11.x, TypeScript 5.x, Prisma 6.x, PostgreSQL 18 + pgvector

**Setup:**
```bash
# From the repo root — start PostgreSQL 18 + pgvector
docker compose up -d db        # or: Reopen in Container (devcontainer)

cd backend
pnpm install
pnpm run prisma:generate
pnpm run prisma:migrate
```

**Commands:**
- Dev: `pnpm run start:dev`
- Build: `pnpm run build`
- Test: `pnpm run test`
- E2E: `pnpm run test:e2e` (requires the compose DB; resets `<db>_test`)
- Coverage: `pnpm run test:cov`
- Lint: `pnpm run lint`
- Prisma Studio: `pnpm run prisma:studio`
- Deploy migrations: `pnpm run prisma:deploy`

**Important:**
- Database: PostgreSQL 18 + pgvector, configured by `DATABASE_URL` (see `backend/.env.example`)
- Prisma schema: `backend/prisma/schema.prisma`
- Vector index: derived tables in the `vector_store` schema (pgvector/HNSW), managed by `VectorService`; Prisma `embedding Json` columns remain the source of truth
- API prefix: `/api/v1` (configured in main.ts)
- CORS enabled for `http://localhost:5173`

## Frontend

**Stack:** Vue 3.5.x, TypeScript 6.x, Vite 8.x, Element Plus, AntV G2, Pinia

**Setup:**
```bash
cd frontend
npm install
```

**Commands:**
- Dev: `npm run dev`
- Build: `npm run build` (includes `vue-tsc -b` for type checking)
- Preview: `npm run preview`

**Important:**
- Element Plus: Auto-import enabled via unplugin-vue-components
- Path alias: `@` → `src/`
- API base URL: Configure in `.env` or `src/utils/request.ts`
- Charts: Use AntV G2 for all visualizations
- State: Pinia stores in `src/stores/`

## Testing

**Backend:**
- Unit tests: `*.spec.ts` files (no database required)
- E2E tests: `backend/test/*.e2e-spec.ts` (PostgreSQL; global setup resets the derived `_test` database)
- Config: `backend/jest.config.js`, `backend/test/jest-e2e.json`

**Frontend:** No test framework configured yet

## Code Quality

**Backend:**
- Lint: `pnpm run lint` (ESLint with Prettier)
- Format: `pnpm run format` (Prettier)
- Strict TypeScript mode enabled

**Frontend:**
- Lint: Check for ESLint errors (check config file)
- Format: Prettier (`.prettierrc`)
- Strict TypeScript mode enabled

## Development Workflow

1. Start PostgreSQL: `docker compose up -d db` (or Reopen in Container)
2. Start backend: `cd backend && pnpm run start:dev`
3. Start frontend: `cd frontend && npm run dev`
4. Backend runs on http://localhost:3000
5. Frontend runs on http://localhost:5173

## API Design

RESTful API with prefix `/api`:
- `/api/datasource` - CRUD, test connection, sync tables
- `/api/chat` - Chat sessions (limited to 20 recent)
- `/api/chat/:id/message` - Send messages, regenerate charts

## Key Implementation Notes

- Data source connection management in `backend/src/datasource/`
- SQL generation: LLM-driven NL2SQL pipeline (LangChain, SSE streaming) in `backend/src/chat/chat.service.ts` + `backend/src/llm/` — NOT rule-based
- Chart analysis: Chart type picked by the LLM (`generate_chart`), rendered with AntV G2 on the frontend
- Table recall: keyword-fused ranking in `recallTables` (LLM keyword extraction → terminology synonym expansion → α·vector + (1-α)·keyword, explicit table mentions always retained; pure functions in `backend/src/datasource/table-recall.ts`); falls back to all checked tables
- Retrieval strategy params: 10 `embedding.*` runtime parameters (`backend/src/common/config/embedding-config.ts`), priority saved SystemVariable > env > code default; snapshot per chat task; admin parameter page validates strictly and rejects whole save on invalid input
- **Multi-step DB writes must run in ONE `prisma.$transaction`** (interactive form when a read informs a later write — dup checks, existence checks). A mid-sequence failure must never leave half-applied state (see permission/workspace/system-variable/user services for the pattern)
- **Vector search uses pgvector** (`VectorService`): cosine distance via `<=>`, HNSW indexes, tables in the unmanaged `vector_store` schema. If the extension/schema is missing, recall degrades to keyword-only instead of failing requests
- Chat history: Limited to 20 conversations
- Message data: Stored as JSON strings (query results, chart configs)

## Common Issues

- **TypeScript version mismatch:** Frontend uses TS 6.x, backend uses TS 5.x
- **Prisma migration:** Run `prisma:generate` after schema changes
- **pgvector missing:** The baseline migration runs `CREATE EXTENSION vector` and creates schema `vector_store`; the DB role needs permission to create the extension. If the app log says vector search is disabled, run `pnpm prisma:deploy`
- **E2E database:** `pnpm test:e2e` derives `<DATABASE_URL database>_test`, resets it, and seeds it. It refuses to run if the derived name does not end in `_test`
- **Port conflicts:** Backend uses 3000, frontend uses 5173
- **CORS errors:** Ensure `.env` has correct `FRONTEND_URL`