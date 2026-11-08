// Jest global setup for the e2e suite.
//
// Resets the derived `_test` PostgreSQL database (drops the schema, reapplies
// migrations, runs the seed) exactly once per run. The `_test` suffix guard in
// test-db-url.ts prevents this from ever touching a development/production DB.
import { execFileSync } from 'child_process';
import * as path from 'path';
import { Client } from 'pg';
import { applyTestDatabaseUrl, backendRoot } from './test-db-url';

export default async function globalSetup(): Promise<void> {
  const databaseUrl = applyTestDatabaseUrl();

  console.log(
    `[e2e] resetting test database: ${databaseUrl.replace(/:[^:@/]+@/, ':***@')}`,
  );

  // vector_store / excel_store are intentionally outside Prisma's managed
  // schemas, so reset them explicitly before migrations recreate them. This
  // guarantees no stale vectors or imported Excel tables leak between runs.
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS vector_store CASCADE');
    await client.query('DROP SCHEMA IF EXISTS excel_store CASCADE');
  } finally {
    await client.end();
  }

  const prismaBin = path.join(
    backendRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'prisma.cmd' : 'prisma',
  );

  execFileSync(prismaBin, ['migrate', 'reset', '--force'], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  });
}
