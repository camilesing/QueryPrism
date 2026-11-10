// Runs in every Jest worker before the test modules load. Ensures AppModule /
// PrismaClient connect to the `_test` database derived from DATABASE_URL, and
// wires the production i18n facade to the test dictionary — e2e bootstraps
// Test.createTestingModule directly (main.ts is not executed), so without this
// `tr()` would return raw keys instead of messages.
import { setI18n } from '../src/common/i18n/translate';
import { createTestI18n } from '../src/common/i18n/test-i18n';
import { applyTestDatabaseUrl } from './test-db-url';

applyTestDatabaseUrl();
setI18n(createTestI18n());
