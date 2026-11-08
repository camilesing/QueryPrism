// Spec for LlmService. The streaming + reasoning-extraction logic is tested
// against a plain fake chat (no network, no @langchain mock). Supplier
// routing (azure vs OpenAI-compatible base_url) and the resolveModel fallback
// use an auto-mocked @langchain/openai + mocked Prisma/ConfigService.
import {
  ChatOpenAI as ChatOpenAICtor,
  AzureChatOpenAI as AzureChatOpenAICtor,
} from '@langchain/openai';
import {
  LlmService,
  type ChatChunk,
  type ChatLike,
  type LlmStreamChunk,
} from './llm.service';
import { OPEN_TAG, CLOSE_TAG } from './reasoning';
import { AiModel } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';

jest.mock('@langchain/openai');
jest.mock('../common/utils/aes', () => ({
  encrypt: jest.fn(() => 'enc'),
  decrypt: jest.fn(() => 'decrypted-key'),
}));

// The auto-mocked constructors (jest.mock above is hoisted above this import),
// re-typed as jest.Mock so .mockReset / .mockImplementation are type-checked
// (a `require()` import would resolve to `any` and trip no-unsafe-call).
const ChatOpenAI = ChatOpenAICtor as unknown as jest.Mock;
const AzureChatOpenAI = AzureChatOpenAICtor as unknown as jest.Mock;

/** Wrap a plain array as an AsyncIterable. Object-form (no async generator)
 *  because the `require-await` lint rule flags async generators that contain
 *  no `await` — and a real async generator isn't needed to drive the stream. */
function asyncFrom<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => {
      let i = 0;
      return {
        next: (): Promise<IteratorResult<T>> =>
          i >= items.length
            ? Promise.resolve({ done: true as const, value: undefined })
            : Promise.resolve({ done: false as const, value: items[i++] }),
      };
    },
  };
}

/** Build a fake chat whose stream yields the given chunks. */
function fakeChat(chunks: ChatChunk[]): ChatLike {
  return {
    stream: () => Promise.resolve(asyncFrom(chunks)),
  };
}

/** Build a chunk: text content and/or a Qwen reasoning_content field. */
function chunk(content = '', reasoning?: string): ChatChunk {
  return {
    content,
    additional_kwargs: reasoning ? { reasoning_content: reasoning } : undefined,
  };
}

function fakeModel(over: Partial<AiModel> = {}): AiModel {
  return {
    id: 1,
    supplier: 'openai',
    name: 'gpt-4o',
    modelType: 'llm',
    baseModel: 'gpt-4o',
    defaultModel: false,
    apiKey: 'enc',
    apiDomain: 'https://api.example.com',
    protocol: 'openai',
    config: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** The aiModel delegate mock, exposed so tests assert on typed jest.Mocks
 *  (jest.Mocked<PrismaService> is shallow and leaves nested delegates as their
 *  real types, which resolve to `any` and trip no-unsafe-call / unbound-method). */
interface AiModelDelegateMock {
  findUnique: jest.Mock;
  findFirst: jest.Mock;
}

function makeService(opts: {
  prisma?: Partial<PrismaService>;
  config?: Record<string, unknown>;
}): {
  svc: LlmService;
  aiModel: AiModelDelegateMock;
  config: jest.Mocked<ConfigService>;
} {
  const aiModel: AiModelDelegateMock = {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
  };
  const prisma = { aiModel, ...opts.prisma } as unknown as PrismaService;
  const configMap: Record<string, unknown> = {
    'aes.key': 'aes-key',
    'llm.apiKey': '',
    'llm.apiDomain': '',
    'llm.defaultModel': '',
    'llm.defaultSupplier': 'openai',
    ...opts.config,
  };
  const config = {
    get: jest.fn((k: string) => configMap[k]),
  } as unknown as jest.Mocked<ConfigService>;
  const svc = new LlmService(prisma, config);
  return { svc, aiModel, config };
}

describe('LlmService.streamWith (reasoning extraction)', () => {
  async function drain(chat: ChatLike) {
    const { svc } = makeService({});
    const out = { content: '', reasoning: '' };
    for await (const c of svc.streamWith(chat, [])) {
      out.content += c.content;
      out.reasoning += c.reasoning;
    }
    return out;
  }

  it('forwards plain content and no reasoning', async () => {
    const out = await drain(fakeChat([chunk('hello '), chunk('world')]));
    expect(out).toEqual({ content: 'hello world', reasoning: '' });
  });

  it('splits DeepSeek-style think tags out of content', async () => {
    const out = await drain(
      fakeChat([chunk(`PREFIX${OPEN_TAG}REASONING${CLOSE_TAG}SUFFIX`)]),
    );
    expect(out).toEqual({ content: 'PREFIXSUFFIX', reasoning: 'REASONING' });
  });

  it('handles tags split across chunks', async () => {
    const out = await drain(
      fakeChat([
        chunk(`PREFIX${OPEN_TAG.slice(0, 4)}`),
        chunk(`${OPEN_TAG.slice(4)}R${CLOSE_TAG}TAIL`),
      ]),
    );
    expect(out).toEqual({ content: 'PREFIXTAIL', reasoning: 'R' });
  });

  it('reads Qwen reasoning_content directly', async () => {
    const out = await drain(
      fakeChat([chunk('', 'plan the query'), chunk('SELECT 1')]),
    );
    expect(out).toEqual({
      content: 'SELECT 1',
      reasoning: 'plan the query',
    });
  });

  it('emits a held-back tail on flush when a chunk ends mid-tag', async () => {
    // ends with a partial open-tag prefix that is NOT a tag
    const out = await drain(fakeChat([chunk('visible<')]));
    expect(out).toEqual({ content: 'visible<', reasoning: '' });
  });

  it('§115(f): reads usage_metadata from the final chunk → camelCase usage', async () => {
    const { svc } = makeService({});
    const chat = fakeChat([
      chunk('hello'),
      {
        content: '',
        usage_metadata: {
          input_tokens: 12,
          output_tokens: 34,
          total_tokens: 46,
        },
      },
    ]);
    const chunks: LlmStreamChunk[] = [];
    for await (const c of svc.streamWith(chat, [])) chunks.push(c);
    const usageChunk = chunks.find((c) => c.usage);
    expect(usageChunk?.usage).toEqual({
      promptTokens: 12,
      completionTokens: 34,
      totalTokens: 46,
    });
  });

  it('§115(f): no usage_metadata → no usage chunk on the stream', async () => {
    const { svc } = makeService({});
    const chunks: LlmStreamChunk[] = [];
    for await (const c of svc.streamWith(
      fakeChat([chunk('hello'), chunk('world')]),
      [],
    )) {
      chunks.push(c);
    }
    expect(chunks.some((c) => c.usage)).toBe(false);
  });
});

describe('LlmService.available', () => {
  it('is true when the env-config default key is present', () => {
    const { svc } = makeService({ config: { 'llm.apiKey': 'sk-x' } });
    expect(svc.available).toBe(true);
  });
  it('is false when no env key is configured', () => {
    const { svc } = makeService({ config: { 'llm.apiKey': '' } });
    expect(svc.available).toBe(false);
  });
});

describe('LlmService.getChatModel routing', () => {
  beforeEach(() => {
    ChatOpenAI.mockReset();
    AzureChatOpenAI.mockReset();
  });

  it('uses ChatOpenAI with the OpenAI-compatible base_url for non-azure', () => {
    const { svc } = makeService({});
    svc.getChatModel(fakeModel(), 'decrypted');
    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
    expect(AzureChatOpenAI).not.toHaveBeenCalled();
  });

  it('uses AzureChatOpenAI for protocol=azure', () => {
    const { svc } = makeService({});
    svc.getChatModel(fakeModel({ protocol: 'azure' }), 'decrypted');
    expect(AzureChatOpenAI).toHaveBeenCalledTimes(1);
    expect(ChatOpenAI).not.toHaveBeenCalled();
  });
});

describe('LlmService.resolveModel', () => {
  beforeEach(() => {
    ChatOpenAI.mockReset();
    AzureChatOpenAI.mockReset();
  });

  it('resolves by id, decrypting the stored key', async () => {
    const { svc, aiModel } = makeService({});
    aiModel.findUnique.mockResolvedValue(fakeModel());
    const resolved = await svc.resolveModel(1);
    expect(resolved).not.toBeNull();
    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default model when no id given', async () => {
    const { svc, aiModel } = makeService({});
    aiModel.findFirst.mockResolvedValue(fakeModel({ defaultModel: true }));
    const resolved = await svc.resolveModel();
    expect(resolved).not.toBeNull();
    expect(aiModel.findFirst).toHaveBeenCalledWith({
      where: { defaultModel: true },
    });
  });

  it('returns null when no DB model and no env key', async () => {
    const { svc, aiModel } = makeService({ config: { 'llm.apiKey': '' } });
    aiModel.findUnique.mockResolvedValue(null);
    aiModel.findFirst.mockResolvedValue(null);
    const resolved = await svc.resolveModel(999);
    expect(resolved).toBeNull();
  });

  it('falls back to the env-config default when no DB model exists', async () => {
    const { svc, aiModel } = makeService({
      config: { 'llm.apiKey': 'sk-env', 'llm.defaultModel': 'gpt-4o-mini' },
    });
    aiModel.findUnique.mockResolvedValue(null);
    aiModel.findFirst.mockResolvedValue(null);
    const resolved = await svc.resolveModel();
    expect(resolved).not.toBeNull();
    expect(ChatOpenAI).toHaveBeenCalledTimes(1);
  });
});

describe('LlmService.chat / testConnection', () => {
  beforeEach(() => {
    ChatOpenAI.mockReset();
    AzureChatOpenAI.mockReset();
  });

  it('aggregates a stream into final content + reasoning', async () => {
    ChatOpenAI.mockImplementation(() => fakeChat([chunk('a'), chunk('b')]));
    const { svc, aiModel } = makeService({});
    aiModel.findUnique.mockResolvedValue(fakeModel());
    const out = await svc.chat([], 1);
    expect(out).toEqual({ content: 'ab', reasoning: '' });
  });

  it('reports a working model on testConnection', async () => {
    ChatOpenAI.mockImplementation(() => fakeChat([chunk('pong')]));
    const { svc, aiModel } = makeService({});
    aiModel.findUnique.mockResolvedValue(fakeModel());
    const res = await svc.testConnection(1);
    expect(res.success).toBe(true);
  });

  it('reports failure when the model stream throws', async () => {
    ChatOpenAI.mockImplementation(() => ({
      stream: () => Promise.reject(new Error('upstream down')),
    }));
    const { svc, aiModel } = makeService({});
    aiModel.findUnique.mockResolvedValue(fakeModel());
    const res = await svc.testConnection(1);
    expect(res).toEqual({ success: false, message: 'upstream down' });
  });
});
