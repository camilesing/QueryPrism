// Runs in every Jest worker before the test modules load. Ensures AppModule /
// PrismaClient connect to the `_test` database derived from DATABASE_URL.
import { applyTestDatabaseUrl } from './test-db-url';

applyTestDatabaseUrl();
