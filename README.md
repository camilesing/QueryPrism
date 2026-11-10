# QueryPrism

[English](README.md) | [简体中文](README_zh.md)

An intelligent data-visualization chatbot — connect your databases, ask questions in natural language, and get charts generated automatically.

## Features

- 🔌 **Multi-datasource support** — connect and manage multiple data sources
- 💬 **Natural language chat** — query your data through conversation
- 📊 **Auto charting** — chart type is chosen by the LLM and rendered automatically
- 📝 **Chat history** — keeps the 20 most recent conversations
- 🔄 **Chart regeneration** — regenerate a chart with a different chart type

## Tech Stack

### Backend

- **Framework**: NestJS 11.x
- **Language**: TypeScript 5.x
- **Database**: PostgreSQL 18 + pgvector
- **ORM**: Prisma 6.x

### Frontend

- **Framework**: Vue 3.5.x
- **Language**: TypeScript 6.x
- **Build tool**: Vite 8.x
- **UI components**: Element Plus
- **Charts**: AntV G2
- **State management**: Pinia
- **Routing**: Vue Router 4.x

## Project Structure

```
QueryPrism/
├── backend/          # NestJS backend API
│   ├── prisma/       # Database schema and migrations
│   ├── src/
│   │   ├── datasource/  # Datasource management module
│   │   ├── chat/        # Chat conversation module
│   │   └── common/      # Shared modules
│   └── test/        # Test files
└── frontend/         # Vue 3 frontend app
    ├── src/
    │   ├── views/      # Page components
    │   ├── stores/     # Pinia stores
    │   ├── api/        # API clients
    │   └── utils/      # Utilities
```

## Getting Started

### Backend

Start PostgreSQL 18 + pgvector first (devcontainer recommended; running only the database is fine too):

```bash
# From the repo root: start only the database (host-machine development)
docker compose up -d db

# Or: Reopen in Container (starts app + db automatically and installs dependencies)
```

Then:

```bash
cd backend
pnpm install
pnpm run prisma:generate
pnpm run prisma:migrate
pnpm run start:dev
```

The backend runs at http://localhost:3000

### Frontend

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at http://localhost:5173

### Default Login

Admin account available after initial startup (once `prisma:seed` has run):

| Username | Password |
| -------- | -------- |
| `admin`  | `admin`  |

> Note: `123456` is the default password (`DEFAULT_PWD`) an admin uses to reset other users' passwords in User Management — it is not admin's initial password.

## Development Commands

### Backend

```bash
cd backend

# Development mode
pnpm run start:dev

# Production build
pnpm run build

# Tests
pnpm run test
pnpm run test:e2e
pnpm run test:cov

# Lint & format
pnpm run lint
pnpm run format

# Prisma
pnpm run prisma:studio    # Open the database GUI
pnpm run prisma:generate  # Generate the Prisma Client
pnpm run prisma:migrate   # Run database migrations
```

### Frontend

```bash
cd frontend

# Development mode
npm run dev

# Production build (includes type checking via vue-tsc)
npm run build

# Preview the production build
npm run preview
```

## API Reference

Base prefix: `/api/v1`

### Datasources (`/api/datasource`)

- `POST /api/datasource` - Create a datasource
- `GET /api/datasource` - List all datasources
- `GET /api/datasource/:id` - Get a single datasource
- `PATCH /api/datasource/:id` - Update a datasource
- `DELETE /api/datasource/:id` - Delete a datasource
- `POST /api/datasource/:id/test` - Test the datasource connection
- `POST /api/datasource/:id/sync` - Sync table schemas from the datasource

### Chat sessions (`/api/chat`)

- `POST /api/chat` - Create a new chat session
- `GET /api/chat` - List recent chat sessions (up to 20)
- `GET /api/chat/:id` - Get chat session details
- `DELETE /api/chat/:id` - Delete a chat session

### Messages (`/api/chat/:id/message`)

- `POST /api/chat/:id/message` - Send a message and generate a chart
- `POST /api/chat/:id/message/regenerate` - Regenerate the chart

## Data Model

- **Datasource**: datasource connection configuration
- **Table**: table schema metadata
- **Field**: field definitions
- **Chat / ChatRecord**: chat sessions and message records
- **Vector index**: `vec_*` tables in the `vector_store` schema (pgvector + HNSW, maintained by the application)

## Environment Configuration

### Backend (`.env`)

```env
# Local host-machine development; overridden to the db host by compose inside devcontainer
DATABASE_URL="postgresql://queryprism:queryprism@localhost:5432/queryprism"
FRONTEND_URL="http://localhost:5173"
PORT=3000
```

In production, `DATABASE_URL` is injected by the deployment platform. Before starting:

```bash
cd backend
pnpm run prisma:deploy
NODE_ENV=production pnpm run prisma:seed   # first time only
node dist/src/main
```

### Frontend (`.env`)

```env
VITE_API_BASE_URL=http://localhost:3000/api
```

## How It Works

- **Datasource management**: connect databases and sync table schemas automatically
- **LLM-powered SQL generation**: NL2SQL pipeline built on LangChain with SSE streaming (not rule-based)
- **Automatic chart selection**: the LLM picks the chart type (`generate_chart`); the frontend renders it with AntV G2
- **Table recall**: keyword-fused hybrid ranking (LLM keyword extraction → synonym expansion → α·vector + (1-α)·keyword); explicitly mentioned tables are always retained, with fallback to all checked tables
- **Ask-to-narrow (clarify)**: when a question is ambiguous across `clarify.table_threshold`+ candidate tables (default 3) and names none of them, the pipeline pauses and asks the user to pick tables / add a supplement / skip before generating SQL (`POST /chat/record/:rid/clarify` resumes the same record; MCP `ask_question` returns `needs_clarification` for a two-phase flow)
- **Business semantics (M2)**: curated table/field meanings in three scope layers (personal > workspace > global, cross-layer changes go through an approval queue, every save is versioned) — covered questions stuff only `semantic.max_tables` (default 1) tables into the SQL prompt and the LLM may ask for more via `need_clarify`. Effective semantics decorate every stuffed schema (table meaning, field notes, cached enums), not just the narrowed set. Ingestion: admin UI (`/set/semantic`), Excel import/export, API-key-authenticated `POST /meta/semantic/import`
- **Join topology (M3)**: the relation editor's graph (`Datasource.tableRelation`, stored as raw X6 cells) is normalized into FK edges at read time — cell/port ids resolve through the synced Table/Field rows, falling back to canvas labels. FK lines in the SQL prompt cover only the stuffed tables' checked fields, and BFS ≤2-hop bridge tables connecting recalled tables are stuffed automatically (and offered as clarify options) so multi-table questions carry their real join path. Every save also appends an immutable version snapshot (`POST /table_relation/versions/:dsId`) for review; runtime keeps reading the latest graph
- **Dimension enums (M3)**: one-click enum collection for `role=dimension` fields — bounded DISTINCT sampling (`semantic.enum_scan_rows`, default 10000) with a low-cardinality check (`semantic.enum_max_values`, default 50) backfills the versioned `enumValues` cache; per-datasource rate limit `semantic.enum_cooldown` (default 60s). Admin button on the field-semantics page, `POST /system/semantic/collect_enum/:datasource_id`
- **Metric system (M4)**: atomic metrics (aggregation over a bound field), modifiers (statistical-scope filters), time periods, derived metrics and composite metrics (arithmetic over derived/composite codes) — the same three-layer scope, approval queue and version history as M2. When a question names a metric (name/alias), its full caliber is injected into the generate_sql prompt and its tables are force-stuffed into the schema (`metric.enabled`, cap `metric.max_definitions`, default 5). Ingestion: admin UI (`/set/metric`), six-sheet Excel import/export, API-key-authenticated `POST /meta/metric/import` + `POST /meta/standard/import`. Composite metrics are the simple arithmetic version; deeper composition is a future extension
- **Data standards (M4)**: units-of-measure dictionary (advisory — feeds management/autocomplete) and a naming dictionary (business words/word roots → standard translations) on the same governance stack; matched naming entries inject `<naming_rules>` into the SQL prompt (`naming.enabled`)
- **External metadata sync (M5)**: workspace admins configure HTTP-API or MCP pull sources at `/set/metadata-sync`; each source fetches the same row format as `/meta/*` and imports it into the workspace layer on a 5-field cron or on demand. Credentials are AES-encrypted and never returned; every run records applied/failed counts and row-level failures. The scheduler is single-instance by design (documented limitation)
- **Vector search**: PostgreSQL pgvector with cosine distance and HNSW indexes; degrades to keyword-only search if the extension is unavailable
- **Chat history**: the 20 most recent conversations are retained
- **Data storage**: query results and chart configs are stored as JSON

## Development Notes

- **TypeScript versions differ**: the frontend uses TS 6.x, the backend TS 5.x
- Run `prisma:generate` after changing the Prisma schema
- **Ports**: backend 3000, frontend 5173
- **CORS**: make sure `FRONTEND_URL` in `.env` is correct

## License

This project is licensed under the GNU Affero General Public License v3.0 — see the [LICENSE](LICENSE) file for the full text.
