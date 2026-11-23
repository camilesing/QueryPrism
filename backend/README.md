# QueryPrism backend

NestJS 11 + Prisma 6 API on PostgreSQL 18 + pgvector, serving `/api/v1`.
It is one project of the QueryPrism monorepo; the project-wide documentation
lives at the repository root:

- [README.md](../README.md) / [README_zh.md](../README_zh.md) — setup, environment, API reference
- [AGENTS.md](../AGENTS.md) — project structure, working rules, API design
- [docs/postgres.md](docs/postgres.md) — pgvector schema, `vector_store` permissions, test database
- [g2-ssr/README.md](g2-ssr/README.md) — the chart → PNG microservice (its own `package.json`, npm)

## Setup

```bash
cd backend
pnpm install
pnpm run prisma:generate
pnpm run prisma:migrate
pnpm run prisma:seed   # first time: admin / admin + baseline rows
pnpm run start:dev     # http://localhost:3000/api/v1
```

`DATABASE_URL` must point at the PostgreSQL database started from the
repository root (`docker compose up -d db`); see `backend/.env.example`.

## Commands

| Command               | What it does                                         |
| --------------------- | ---------------------------------------------------- |
| `pnpm run build`      | Compile to `dist/`                                   |
| `pnpm run start:dev`  | Watch mode                                           |
| `pnpm run start:prod` | Run `dist/src/main` (build first)                    |
| `pnpm run test`       | Unit tests (no database)                             |
| `pnpm run test:e2e`   | E2E tests (needs the compose DB; resets `<db>_test`) |
| `pnpm run test:cov`   | Unit tests with coverage                             |
| `pnpm run lint`       | ESLint + Prettier, auto-fixes, fails on warnings     |
| `pnpm run format`     | Prettier                                             |
| `pnpm run prisma:*`   | `generate`, `migrate`, `deploy`, `studio`, `seed`    |

The verification gate is `pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e`.

## Layout

| Path           | Contents                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------- |
| `src/<module>` | One Nest module per feature (`chat`, `datasource`, `semantic`, `mcp`, …) with colocated `*.spec.ts` |
| `prisma/`      | `schema.prisma`, migrations, `seed.ts`                                                              |
| `test/`        | E2E specs (`*.e2e-spec.ts`) and their helpers                                                       |
| `scripts/`     | Maintenance scripts (e.g. embedded-sign helper)                                                     |
| `docs/`        | Backend-specific notes                                                                              |

## License

QueryPrism is licensed under the GNU Affero General Public License v3.0 — see the [LICENSE](../LICENSE) file at the repository root.
