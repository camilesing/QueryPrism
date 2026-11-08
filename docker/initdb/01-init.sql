-- Runs once when the pgdata volume is first initialised.
-- The application database (queryprism) is created by POSTGRES_DB; the
-- e2e suite uses a separate database so `prisma migrate reset` can never
-- touch development data.

CREATE DATABASE queryprism_test;

\connect queryprism_test
CREATE EXTENSION IF NOT EXISTS vector;

\connect queryprism
CREATE EXTENSION IF NOT EXISTS vector;