// Unit spec for the env-parsing configuration factory. configuration() reads
// process.env DIRECTLY (it is the ConfigModule load fn, not a parametrized
// factory), so each test swaps process.env for a crafted plain object and
// afterEach restores the real one. Every ?? default, parseInt/parseFloat
// coercion and the DATABASE_URL guard get both arms exercised.
import { configuration } from './configuration';
import { EMBEDDED_SIGN_DEV_SECRET } from '../constants/embedded-sign-dev-secret';

const PG_URL = 'postgresql://user:pw@localhost:5432/queryprism';

const ORIGINAL_ENV = process.env;

/** Run the factory against a crafted env (replaces process.env wholesale). */
function configWith(env: Record<string, string | undefined>) {
  process.env = env;
  return configuration();
}

describe('configuration', () => {
  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  describe('DATABASE_URL guard', () => {
    it('fails fast when DATABASE_URL is missing', () => {
      expect(() => configWith({})).toThrow(/DATABASE_URL must be a PostgreSQL/);
    });

    it('fails fast when DATABASE_URL is an empty string', () => {
      expect(() => configWith({ DATABASE_URL: '' })).toThrow(
        /DATABASE_URL must be a PostgreSQL/,
      );
    });

    it('fails fast on a non-PostgreSQL URL', () => {
      expect(() =>
        configWith({ DATABASE_URL: 'mysql://user:pw@localhost:3306/db' }),
      ).toThrow(/DATABASE_URL must be a PostgreSQL/);
    });

    it('accepts the postgresql:// scheme', () => {
      expect(() => configWith({ DATABASE_URL: PG_URL })).not.toThrow();
    });

    it('accepts the short postgres:// scheme', () => {
      expect(() =>
        configWith({ DATABASE_URL: 'postgres://user:pw@localhost/db' }),
      ).not.toThrow();
    });

    it('matches the scheme case-insensitively', () => {
      expect(() =>
        configWith({ DATABASE_URL: 'POSTGRESQL://user@localhost/db' }),
      ).not.toThrow();
    });
  });

  describe('defaults (only DATABASE_URL set)', () => {
    it('returns every documented default', () => {
      expect(configWith({ DATABASE_URL: PG_URL })).toEqual({
        port: 3000,
        nodeEnv: 'development',
        frontendUrl: 'http://localhost:5173',
        aes: { key: 'queryprism-aes-key-change-me-32b' },
        jwt: {
          secret: 'queryprism-jwt-secret-change-me',
          expiresIn: '11520m',
          tokenKey: 'X-QUERYPRISM-TOKEN',
        },
        embeddedSign: { secret: EMBEDDED_SIGN_DEV_SECRET },
        llm: {
          defaultSupplier: 'openai',
          defaultModel: '',
          apiKey: '',
          apiDomain: '',
        },
        embedding: {
          provider: 'openai',
          apiKey: '',
          apiDomain: '',
          model: 'text-embedding-3-small',
          dimension: undefined,
          localModel: 'Xenova/all-MiniLM-L6-v2',
        },
        chat: {
          queryprismName: 'QueryPrism',
          limitRows: 1000,
          historyRoundCount: 3,
          chatLimit: 20,
          sampleDataEnabled: true,
        },
        g2ssr: { host: 'http://localhost:3001', imagePath: './images' },
        assistant: { uploadDir: 'uploads/assistant' },
        excel: { uploadDir: 'uploads/excel', storeSchema: 'excel_store' },
        importError: { dir: 'uploads/import-errors' },
        appearance: { uploadDir: 'uploads/appearance' },
      });
    });
  });

  describe('env overrides', () => {
    it('prefers every env var over its default', () => {
      const cfg = configWith({
        DATABASE_URL: PG_URL,
        PORT: '4000',
        NODE_ENV: 'production',
        FRONTEND_URL: 'https://qp.example.com',
        AES_KEY: 'k',
        JWT_SECRET: 's',
        JWT_EXPIRES_IN: '60m',
        TOKEN_KEY: 'X-OTHER-TOKEN',
        EMBEDDED_SIGN_SECRET: 'embed-secret',
        LLM_DEFAULT_SUPPLIER: 'anthropic',
        LLM_DEFAULT_MODEL: 'claude-3',
        LLM_API_KEY: 'sk-x',
        LLM_API_DOMAIN: 'https://llm.example.com',
        EMBEDDING_PROVIDER: 'local',
        EMBEDDING_API_KEY: 'emb-key',
        EMBEDDING_API_DOMAIN: 'https://emb.example.com',
        EMBEDDING_MODEL: 'bge-small',
        EMBEDDING_DIMENSION: '768',
        EMBEDDING_LOCAL_MODEL: 'bge/local',
        QUERYPRISM_NAME: 'CorpBI',
        CHAT_LIMIT_ROWS: '50',
        CHAT_HISTORY_ROUND_COUNT: '7',
        CHAT_LIMIT: '5',
        G2_SSR_HOST: 'http://g2.example.com',
        MCP_IMAGE_PATH: '/srv/images',
        ASSISTANT_UPLOAD_DIR: '/srv/assistant',
        EXCEL_UPLOAD_DIR: '/srv/excel',
        EXCEL_STORE_SCHEMA: 'excel_other',
        IMPORT_ERROR_DIR: '/srv/import-errors',
        APPEARANCE_UPLOAD_DIR: '/srv/appearance',
      });
      expect(cfg).toEqual({
        port: 4000,
        nodeEnv: 'production',
        frontendUrl: 'https://qp.example.com',
        aes: { key: 'k' },
        jwt: { secret: 's', expiresIn: '60m', tokenKey: 'X-OTHER-TOKEN' },
        embeddedSign: { secret: 'embed-secret' },
        llm: {
          defaultSupplier: 'anthropic',
          defaultModel: 'claude-3',
          apiKey: 'sk-x',
          apiDomain: 'https://llm.example.com',
        },
        embedding: {
          provider: 'local',
          apiKey: 'emb-key',
          apiDomain: 'https://emb.example.com',
          model: 'bge-small',
          dimension: 768,
          localModel: 'bge/local',
        },
        chat: {
          queryprismName: 'CorpBI',
          limitRows: 50,
          historyRoundCount: 7,
          chatLimit: 5,
          sampleDataEnabled: true,
        },
        g2ssr: { host: 'http://g2.example.com', imagePath: '/srv/images' },
        assistant: { uploadDir: '/srv/assistant' },
        excel: { uploadDir: '/srv/excel', storeSchema: 'excel_other' },
        importError: { dir: '/srv/import-errors' },
        appearance: { uploadDir: '/srv/appearance' },
      });
    });

    it('keeps empty strings (?? only treats null/undefined as missing)', () => {
      const cfg = configWith({
        DATABASE_URL: PG_URL,
        NODE_ENV: '',
        FRONTEND_URL: '',
        JWT_SECRET: '',
        LLM_API_KEY: '',
      });
      expect(cfg.nodeEnv).toBe('');
      expect(cfg.frontendUrl).toBe('');
      expect(cfg.jwt.secret).toBe('');
      expect(cfg.llm.apiKey).toBe('');
    });
  });

  describe('EMBEDDING_DIMENSION parsing (parseOptionalPositiveInt)', () => {
    it('returns undefined when unset', () => {
      expect(configWith({ DATABASE_URL: PG_URL }).embedding.dimension).toBe(
        undefined,
      );
    });

    it('returns undefined for an empty string', () => {
      expect(
        configWith({ DATABASE_URL: PG_URL, EMBEDDING_DIMENSION: '' }).embedding
          .dimension,
      ).toBe(undefined);
    });

    it('parses a positive integer', () => {
      expect(
        configWith({ DATABASE_URL: PG_URL, EMBEDDING_DIMENSION: '768' })
          .embedding.dimension,
      ).toBe(768);
    });

    it('accepts a trailing-garbage prefix (parseInt semantics — pinned)', () => {
      expect(
        configWith({ DATABASE_URL: PG_URL, EMBEDDING_DIMENSION: '768abc' })
          .embedding.dimension,
      ).toBe(768);
    });

    it.each(['0', '-3', 'abc'])('rejects "%s"', (raw) => {
      expect(() =>
        configWith({ DATABASE_URL: PG_URL, EMBEDDING_DIMENSION: raw }),
      ).toThrow('EMBEDDING_DIMENSION must be a positive integer');
    });
  });

  describe('parseInt coercions (no validation outside dimension)', () => {
    it('parses PORT when numeric', () => {
      expect(configWith({ DATABASE_URL: PG_URL, PORT: '4000' }).port).toBe(
        4000,
      );
    });

    it('yields NaN for an empty PORT (pinned: no fallback after parseInt)', () => {
      expect(configWith({ DATABASE_URL: PG_URL, PORT: '' }).port).toBeNaN();
    });

    it('yields NaN for a non-numeric PORT', () => {
      expect(configWith({ DATABASE_URL: PG_URL, PORT: 'abc' }).port).toBeNaN();
    });

    it('parses the chat row/round/limit ints', () => {
      const chat = configWith({
        DATABASE_URL: PG_URL,
        CHAT_LIMIT_ROWS: '50',
        CHAT_HISTORY_ROUND_COUNT: '7',
        CHAT_LIMIT: '5',
      }).chat;
      expect(chat).toMatchObject({
        limitRows: 50,
        historyRoundCount: 7,
        chatLimit: 5,
      });
    });

    it('yields NaN for a non-numeric CHAT_LIMIT_ROWS', () => {
      expect(
        configWith({ DATABASE_URL: PG_URL, CHAT_LIMIT_ROWS: 'x' }).chat
          .limitRows,
      ).toBeNaN();
    });
  });

  describe('CHAT_SAMPLE_DATA_ENABLED toggle', () => {
    it('defaults to true when unset', () => {
      expect(configWith({ DATABASE_URL: PG_URL }).chat.sampleDataEnabled).toBe(
        true,
      );
    });

    it('is false only for the exact string "false"', () => {
      expect(
        configWith({
          DATABASE_URL: PG_URL,
          CHAT_SAMPLE_DATA_ENABLED: 'false',
        }).chat.sampleDataEnabled,
      ).toBe(false);
    });

    it.each(['true', '0', 'FALSE', 'no'])('treats "%s" as enabled', (raw) => {
      expect(
        configWith({
          DATABASE_URL: PG_URL,
          CHAT_SAMPLE_DATA_ENABLED: raw,
        }).chat.sampleDataEnabled,
      ).toBe(true);
    });
  });
});
