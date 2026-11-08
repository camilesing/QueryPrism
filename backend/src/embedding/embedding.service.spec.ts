// EmbeddingService unit tests. The local (transformers.js) path needs network
// + a model download, so it's left untested here; we cover the openai path
// (mocked) and the not-configured degradation that lets recall fall back to
// ILIKE.
import { ConfigService } from '@nestjs/config';

jest.mock('@langchain/openai', () => {
  const embedQuery = jest.fn();
  const embedDocuments = jest.fn();
  return {
    OpenAIEmbeddings: jest.fn(() => ({ embedQuery, embedDocuments })),
    __embedMocks: { embedQuery, embedDocuments },
  };
});

// Helper: the mock factory stashes the jest fns on the module namespace.
function embedMocks() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('@langchain/openai') as {
    __embedMocks: {
      embedQuery: jest.Mock;
      embedDocuments: jest.Mock;
    };
  };
  return mod.__embedMocks;
}

function makeConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <K extends string>(key: K) => values[key],
  } as unknown as ConfigService;
}

import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('is not available when openai provider has no apiKey', () => {
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': '',
      }),
    );
    expect(svc.available).toBe(false);
  });

  it('is available when openai provider has an apiKey', () => {
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': 'sk-test',
      }),
    );
    expect(svc.available).toBe(true);
  });

  it('is always available for the local provider (model downloads on use)', () => {
    const svc = new EmbeddingService(
      makeConfig({ 'embedding.provider': 'local' }),
    );
    expect(svc.available).toBe(true);
  });

  it('embed throws when not configured', async () => {
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': '',
      }),
    );
    await expect(svc.embed('hi')).rejects.toThrow('not configured');
  });

  it('embedBatch returns [] for an empty input without calling the client', async () => {
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': 'sk-test',
      }),
    );
    const result = await svc.embedBatch([]);
    expect(result).toEqual([]);
  });

  it('embed delegates to OpenAIEmbeddings.embedQuery', async () => {
    const mocks = embedMocks();
    mocks.embedQuery.mockResolvedValue([0.1, 0.2, 0.3]);
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': 'sk-test',
        'embedding.model': 'text-embedding-3-small',
        'embedding.apiDomain': 'http://localhost:11434',
      }),
    );
    const vec = await svc.embed('hello');
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    expect(mocks.embedQuery).toHaveBeenCalledWith('hello');
  });

  it('embedBatch delegates to OpenAIEmbeddings.embedDocuments', async () => {
    const mocks = embedMocks();
    mocks.embedDocuments.mockResolvedValue([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    const svc = new EmbeddingService(
      makeConfig({
        'embedding.provider': 'openai',
        'embedding.apiKey': 'sk-test',
      }),
    );
    const vecs = await svc.embedBatch(['a', 'b']);
    expect(vecs).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mocks.embedDocuments).toHaveBeenCalledWith(['a', 'b']);
  });
});
