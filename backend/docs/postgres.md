# PostgreSQL + pgvector

QueryPrism stores its metadata in **PostgreSQL 18** (latest stable major,
supported until 2030; PostgreSQL has no separate LTS release line) and uses
**pgvector 0.8.7** for semantic recall.

## Local development

Two supported ways to run the database:

```bash
# 1. Host-based development: only the database runs in Docker
docker compose up -d db
cd backend && pnpm install && pnpm prisma:generate && pnpm prisma:migrate

# 2. Full devcontainer: app + db, dependencies installed automatically
#    (VS Code: "Reopen in Container")
```

Connection string (host-based):

```env
DATABASE_URL="postgresql://queryprism:queryprism@localhost:5432/queryprism"
```

Inside the devcontainer the compose service sets `DATABASE_URL` to the `db`
host instead. `.env` is loaded by `@nestjs/config`; real environment variables
take precedence over `.env`.

The compose file also creates `queryprism_test` and enables `vector` in both
databases. e2e tests derive their URL from `DATABASE_URL` (append/replace the
database name with `_test`), reset that database, and seed it.

## Schema layout

- Prisma models live in the `public` schema (`backend/prisma/schema.prisma`).
- Derived vector tables live in the **`vector_store`** schema:
  `vec_terminology`, `vec_data_training`, `vec_datasource`, `vec_table`.
  Each has an HNSW index using `vector_cosine_ops`.
- `vector_store` is deliberately *not* in Prisma's managed schemas, so the
  runtime-created tables never show up as `prisma migrate dev` drift.
- The `embedding Json` columns on `Terminology`, `DataTraining`, `Datasource`
  and `Table` remain the source of truth. The vector tables are a rebuildable
  index.

The baseline migration runs:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS "vector_store";
```

The application DB role must be allowed to create the extension (migrations)
and to create tables/indexes in `vector_store` (first vector write). If you
deploy with a separate migration role, grant the runtime role:

```sql
GRANT USAGE, CREATE ON SCHEMA vector_store TO <app_role>;
```

## Vector search

`VectorService` uses the pgvector cosine operator `<=>` (distance `0` =
identical, `2` = opposite), matching the previous sqlite-vec semantics:

```sql
SELECT id, embedding <=> $1::vector AS distance
FROM "vector_store"."vec_terminology"
ORDER BY embedding <=> $1::vector
LIMIT $2;
```

- Table creation and HNSW index creation are serialised with
  `pg_advisory_xact_lock`, so multiple app instances can start safely.
- The vector dimension is inferred from the first vector written (or checked
  against an explicitly configured `EMBEDDING_DIMENSION`). Changing embedding
  models with a different dimension requires dropping/rebuilding the affected
  `vec_*` table.
- If the extension/schema is missing, `VectorService` logs an error and recall
  degrades to keyword-only. Requests keep working.

## Production deployment

1. Provision PostgreSQL 18 with the pgvector extension available
   (`pgvector/pgvector:0.8.7-pg18` or an equivalent managed service).
2. Inject `DATABASE_URL` (and the other secrets) into the process environment.
3. Apply migrations: `pnpm prisma:deploy`.
4. Seed once: `NODE_ENV=production pnpm prisma:seed`
   (skips the demo SQLite datasource).
5. Build and start: `pnpm build && node dist/src/main`.

`prisma migrate deploy` is idempotent and safe to run on every release.

## Troubleshooting

- **`pgvector extension is not installed`**: run `pnpm prisma:deploy`, or
  manually `CREATE EXTENSION vector;` as a privileged role.
- **`Schema "vector_store" is missing`**: run `pnpm prisma:deploy`;
  the baseline migration creates it.
- **`Embedding dimension mismatch`**: the embedding model changed. Existing
  rows keep their old vectors, and `/embedding/backfill` only fills NULL
  embeddings — re-embed the affected rows (or clear the affected
  `vector_store.vec_*` table and repopulate it from the `embedding` JSON
  columns with a one-off script) after switching back or updating
  `EMBEDDING_DIMENSION`.
- **e2e refuses to reset**: the derived database name must end in `_test`.
  Set `TEST_DATABASE_URL` explicitly if your naming differs.