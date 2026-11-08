import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma CLI configuration. Loading .env explicitly keeps `prisma migrate` /
// `generate` working from `backend/.env` even when this config file is present
// (Prisma 7 no longer loads .env automatically when a config file exists).
config({ quiet: true });
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    seed: 'ts-node prisma/seed.ts',
  },
});