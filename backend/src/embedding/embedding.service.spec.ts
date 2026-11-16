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

// The local (transformers.js) first-load path needs a real dynamic
// `import('@xenova/transformers')` (native under module:nodenext — jest's
// CJS runtime cannot intercept it), so it stays uncovered. The local paths
// are exercised by pre-seeding the cached pipeline below instead.
function localService(
  pipe: (text: string, opts: unknown) => Promise<{ data: Float32Array }>,
) {
  const svc = new EmbeddingService(
    makeConfig({
      'embedding.provider': 'local',
      'embedding.localModel': 'Xenova/test-model',
    }),
  );

  svc['localPipe'] = pipe;
  return svc;
}

describe('EmbeddingService residual arms', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('defaults the provider to openai when config has none', async () => {
    const svc = new EmbeddingService(
      makeConfig({ 'embedding.apiKey': 'sk-x' }),
    );
    expect(svc.available).toBe(true);
    const mocks = embedMocks();
    mocks.embedQuery.mockResolvedValue([0.5]);
    await expect(svc.embed('hi')).resolves.toEqual([0.5]);
  });

  it('embedBatch throws when not configured', async () => {
    const svc = new EmbeddingService(
      makeConfig({ 'embedding.provider': 'openai', 'embedding.apiKey': '' }),
    );
    await expect(svc.embedBatch(['a'])).rejects.toThrow('not configured');
  });

  it('reuses the constructed OpenAIEmbeddings client across calls', async () => {
    const mocks = embedMocks();
    mocks.embedQuery.mockResolvedValue([0.1]);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { OpenAIEmbeddings } = require('@langchain/openai') as {
      OpenAIEmbeddings: jest.Mock;
    };
    const svc = new EmbeddingService(
      makeConfig({ 'embedding.provider': 'openai', 'embedding.apiKey': 'sk' }),
    );
    await svc.embed('one');
    await svc.embed('two');
    expect(OpenAIEmbeddings).toHaveBeenCalledTimes(1);
    expect(mocks.embedQuery).toHaveBeenCalledTimes(2);
  });

  it('embed routes to the local pipeline with mean pooling + normalize', async () => {
    const pipe = jest.fn(() =>
      Promise.resolve({ data: new Float32Array([0.25, 0.75]) }),
    );
    const svc = localService(pipe);
    await expect(svc.embed('hello')).resolves.toEqual([0.25, 0.75]);
    expect(pipe).toHaveBeenCalledWith('hello', {
      pooling: 'mean',
      normalize: true,
    });
    // the cached pipeline is reused (no second load)
    await expect(svc.embed('again')).resolves.toEqual([0.25, 0.75]);
    expect(pipe).toHaveBeenCalledTimes(2);
  });

  it('embedBatch embeds local texts one-at-a-time', async () => {
    const pipe = jest.fn((text: string) =>
      Promise.resolve({ data: new Float32Array([text.charCodeAt(0) / 100]) }),
    );
    const svc = localService(pipe);
    const vecs = await svc.embedBatch(['a', 'b', 'c']);
    // Float32Array→number[] conversion, one pipe call per text
    expect(vecs.map((v) => v[0])).toEqual(
      [0.97, 0.98, 0.99].map((x) => Math.fround(x)),
    );
    expect(pipe).toHaveBeenCalledTimes(3);
  });
});
