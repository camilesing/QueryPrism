// Centralized, typed application configuration.
// Loaded via @nestjs/config ConfigModule.forRoot({ load: [configuration] }).
// Add new keys here as later phases introduce them (auth/llm/embedding/chat/g2-ssr...).
import { EMBEDDED_SIGN_DEV_SECRET } from '../constants/embedded-sign-dev-secret';

/** The application's metadata database is PostgreSQL 18 + pgvector. Fail fast
 *  on a missing/legacy SQLite URL instead of letting Prisma report a confusing
 *  connection error at startup. */
function assertDatabaseUrl(): void {
  const url = process.env.DATABASE_URL;
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
    throw new Error(
      'DATABASE_URL must be a PostgreSQL connection string (postgresql://...). ' +
        'See backend/.env.example and backend/docs/postgres.md.',
    );
  }
}

function parseOptionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `EMBEDDING_DIMENSION must be a positive integer, got "${raw}"`,
    );
  }
  return value;
}

export function configuration() {
  assertDatabaseUrl();
  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:5173',

    // Used by the AES crypto util (datasource configuration / ai_model api_key).
    // Should be a stable secret; rotated manually (rotation requires re-encryption).
    aes: {
      key: process.env.AES_KEY ?? 'queryprism-aes-key-change-me-32b',
    },

    // JWT auth (Phase 1). Local login only — no SSO.
    jwt: {
      secret: process.env.JWT_SECRET ?? 'queryprism-jwt-secret-change-me',
      // token TTL in minutes; default 8 days.
      expiresIn: process.env.JWT_EXPIRES_IN ?? '11520m',
      tokenKey: process.env.TOKEN_KEY ?? 'X-QUERYPRISM-TOKEN',
    },

    // Embedded sign verification (Phase 11F). HMAC-SHA256 key for the
    // QUERYPRISM-EMBEDDED-SIGN envelope — a QueryPrism-defined scheme.
    // CHANGE IN PRODUCTION. The client signing SDK is a separate deliverable.
    embeddedSign: {
      secret: process.env.EMBEDDED_SIGN_SECRET ?? EMBEDDED_SIGN_DEV_SECRET,
    },

    // LLM provider config (Phase 4). Multi-provider via LangChain.js.
    llm: {
      defaultSupplier: process.env.LLM_DEFAULT_SUPPLIER ?? 'openai',
      defaultModel: process.env.LLM_DEFAULT_MODEL ?? '',
      apiKey: process.env.LLM_API_KEY ?? '',
      apiDomain: process.env.LLM_API_DOMAIN ?? '',
    },

    // Embeddings (Phase 3). Default OpenAI-compatible API; local via transformers.js optional.
    embedding: {
      provider: process.env.EMBEDDING_PROVIDER ?? 'openai', // 'openai' | 'local'
      apiKey: process.env.EMBEDDING_API_KEY ?? '',
      apiDomain: process.env.EMBEDDING_API_DOMAIN ?? '',
      model: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
      // Optional sanity check for the vector column dimension. When omitted the
      // VectorService infers the dimension from the first vector it writes,
      // which keeps 384-d local models and 1536-d OpenAI models both usable.
      dimension: parseOptionalPositiveInt(process.env.EMBEDDING_DIMENSION),
      localModel:
        process.env.EMBEDDING_LOCAL_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    },

    // Chat pipeline behaviour (Phase 5).
    chat: {
      queryprismName: process.env.QUERYPRISM_NAME ?? 'QueryPrism',
      limitRows: parseInt(process.env.CHAT_LIMIT_ROWS ?? '1000', 10),
      historyRoundCount: parseInt(
        process.env.CHAT_HISTORY_ROUND_COUNT ?? '3',
        10,
      ),
      chatLimit: parseInt(process.env.CHAT_LIMIT ?? '20', 10),
      // 0b5588b5: fetch table sample data into the SQL prompt? Disabling
      // speeds up first-token latency (no per-table preview round-trips).
      // Runtime override: SystemVariable chat.sample_data_enabled.
      sampleDataEnabled: process.env.CHAT_SAMPLE_DATA_ENABLED !== 'false',
    },

    // g2-ssr chart→PNG microservice (Phase 7).
    g2ssr: {
      host: process.env.G2_SSR_HOST ?? 'http://localhost:3001',
      imagePath: process.env.MCP_IMAGE_PATH ?? './images',
    },

    // Assistant logo/float_icon file storage (Phase 11). Local on-disk dir.
    // Relative paths anchor to the backend cwd; .gitignored. Override via
    // ASSISTANT_UPLOAD_DIR (absolute recommended in production + a persistent
    // volume — the dir is created on first upload).
    assistant: {
      uploadDir: process.env.ASSISTANT_UPLOAD_DIR ?? 'uploads/assistant',
    },

    // Excel datasources: uploaded source files + the app-DB schema holding the
    // imported tables. The schema is created lazily and is intentionally
    // outside Prisma's managed schema.
    excel: {
      uploadDir: process.env.EXCEL_UPLOAD_DIR ?? 'uploads/excel',
      storeSchema: process.env.EXCEL_STORE_SCHEMA ?? 'excel_store',
    },

    // Import failure workbooks (custom-prompt / user batch import) +
    // the /system/download-fail-info download route.
    importError: {
      dir: process.env.IMPORT_ERROR_DIR ?? 'uploads/import-errors',
    },

    // Appearance branding images (logo / login background / nav background ...).
    appearance: {
      uploadDir: process.env.APPEARANCE_UPLOAD_DIR ?? 'uploads/appearance',
    },
  };
}

export default configuration;
export type AppConfig = ReturnType<typeof configuration>;
