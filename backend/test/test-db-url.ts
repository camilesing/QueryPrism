// Derive the e2e database URL from DATABASE_URL (or an explicit
// TEST_DATABASE_URL). The database name must end with `_test`; global-setup
// refuses to run otherwise so a misconfigured run can never reset development
// or production data.
import { config } from 'dotenv';
import * as path from 'path';

config({ quiet: true });

export function testDatabaseUrl(): string {
  const base = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'DATABASE_URL (or TEST_DATABASE_URL) must be set before running e2e tests',
    );
  }

  const url = new URL(base);
  const database = url.pathname.replace(/^\//, '');
  if (!database) {
    throw new Error(`DATABASE_URL has no database name: ${base}`);
  }
  if (!database.endsWith('_test')) {
    url.pathname = `/${database}_test`;
  }
  return url.toString();
}

/** Apply the derived URL to process.env (idempotent). */
export function applyTestDatabaseUrl(): string {
  const url = testDatabaseUrl();
  process.env.DATABASE_URL = url;
  return url;
}

export const backendRoot = path.resolve(__dirname, '..');
