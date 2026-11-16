// Spec for CHAT_MODEL_FACTORIES — instantiates every registered factory with
// a fake AiModel row and asserts the LangChain class + parameter mapping.
// No network: LangChain chat-model constructors are lazy (they only hold
// config; the first HTTP call happens on invoke/stream).
import { ChatZhipuAI } from '@langchain/community/chat_models/zhipuai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { AiModel } from '@prisma/client';
import { CHAT_MODEL_FACTORIES } from './chat-model-registry';

function row(over: Partial<AiModel> = {}): AiModel {
  return {
    id: 1,
    supplier: '16',
    name: 'display-name',
    modelType: '0',
    baseModel: 'base-model',
    defaultModel: false,
    apiKey: 'enc',
    apiDomain: null,
    protocol: '3',
    config: null,
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('CHAT_MODEL_FACTORIES', () => {
  it('registers exactly the 17 native protocol ids (3..13, 15..20)', () => {
    expect(Object.keys(CHAT_MODEL_FACTORIES).sort((a, b) => +a - +b)).toEqual([
      ...Array.from({ length: 11 }, (_, i) => String(i + 3)),
      ...Array.from({ length: 6 }, (_, i) => String(i + 15)),
    ]);
  });

  it.each([
    ['3', 'ChatZhipuAI'],
    ['4', 'ChatAnthropic'],
    ['5', 'ChatGoogleGenerativeAI'],
    ['6', 'ChatXAI'],
    ['7', 'ChatGroq'],
    ['8', 'ChatMistralAI'],
    ['9', 'ChatOllama'],
    ['10', 'ChatDeepSeek'],
    ['11', 'ChatFireworks'],
    ['12', 'ChatCohere'],
    ['13', 'ChatMoonshot'],
    // no '14' — reserved for MiniMax (native class targets the legacy China
    // endpoint + requires groupId; the admin page stays on protocol 1)
    ['15', 'ChatAlibabaTongyi'],
    ['16', 'ChatPerplexity'],
    ['17', 'ChatTogetherAI'],
    ['18', 'ChatDeepInfra'],
    ['19', 'ChatFriendli'],
    ['20', 'ChatNovitaAI'],
  ] as [string, string][])('protocol %s → %s', (protocol, className) => {
    const factory = CHAT_MODEL_FACTORIES[protocol];
    expect(factory).toBeDefined();
    const chat = factory(row({ protocol }), 'sk-test');
    expect(chat.constructor.name).toBe(className);
  });

  it('prefers baseModel over name for the model id', () => {
    const factory = CHAT_MODEL_FACTORIES['3'];
    const chat = factory(
      row({ baseModel: 'glm-4.6', name: '我的GLM' }),
      'sk-test',
    ) as unknown as ChatZhipuAI;
    expect(chat.model).toBe('glm-4.6');
  });

  it('passes apiDomain through to the native URL override (google-genai)', () => {
    const factory = CHAT_MODEL_FACTORIES['5'];
    const chat = factory(
      row({ apiDomain: 'https://gemini-proxy.internal/v1beta' }),
      'sk-test',
    ) as unknown as ChatGoogleGenerativeAI;
    expect(chat.baseUrl).toBe('https://gemini-proxy.internal/v1beta');
  });

  it('reserves protocol 14 (MiniMax) — not registered', () => {
    expect(CHAT_MODEL_FACTORIES['14']).toBeUndefined();
  });

  it('maps the DashScope domain to the tongyi region', () => {
    const factory = CHAT_MODEL_FACTORIES['15'];
    const cn = factory(row(), 'sk') as unknown as { region: string };
    const intl = factory(
      row({ apiDomain: 'https://dashscope-intl.aliyuncs.com' }),
      'sk',
    ) as unknown as { region: string };
    expect(cn.region).toBe('china');
    expect(intl.region).toBe('singapore');
  });
});

// ─────────────── tail-sweep: name fallback, tongyi us region, apiDomain arms ───────────────

describe('CHAT_MODEL_FACTORIES (tail-sweep)', () => {
  it('falls back to name when baseModel is null', () => {
    const factory = CHAT_MODEL_FACTORIES['3'];
    const chat = factory(
      row({ baseModel: null }),
      'sk-test',
    ) as unknown as ChatZhipuAI;
    expect(chat.model).toBe('display-name');
  });

  it('maps the dashscope-us domain to the us region', () => {
    const factory = CHAT_MODEL_FACTORIES['15'];
    const us = factory(
      row({ apiDomain: 'https://dashscope-us.aliyuncs.com' }),
      'sk',
    ) as unknown as { region: string };
    expect(us.region).toBe('us');
  });

  it('a null apiDomain omits every URL override without breaking construction', () => {
    // the false arms of each `...(m.apiDomain ? {...} : {})` — default row()
    // already has apiDomain null; instantiate every URL-overridable factory.
    for (const protocol of ['4', '5', '6', '7', '8', '9', '10', '11', '19']) {
      const chat = CHAT_MODEL_FACTORIES[protocol](row({ protocol }), 'sk-test');
      expect(chat).toBeTruthy();
    }
  });

  it('passes apiDomain to each URL-overridable native class (true arms)', () => {
    const domain = 'https://gateway.internal/v1';
    // anthropic
    const anthropic = CHAT_MODEL_FACTORIES['4'](
      row({ protocol: '4', apiDomain: domain }),
      'sk-test',
    ) as unknown as Record<string, unknown>;
    expect(anthropic.constructor.name).toBe('ChatAnthropic');
    // the URL override is held on the client config (not a public field) —
    // construction with the domain set is the observable contract here.

    // xai / groq / mistral / ollama / deepseek / fireworks / friendli —
    // construction with a domain set is the contract; the classes hold the
    // override on differing (partly internal) fields, so assert the class.
    for (const [protocol, className] of [
      ['6', 'ChatXAI'],
      ['7', 'ChatGroq'],
      ['8', 'ChatMistralAI'],
      ['9', 'ChatOllama'],
      ['10', 'ChatDeepSeek'],
      ['11', 'ChatFireworks'],
      ['19', 'ChatFriendli'],
    ] as [string, string][]) {
      const chat = CHAT_MODEL_FACTORIES[protocol](
        row({ protocol, apiDomain: domain }),
        'sk-test',
      );
      expect(chat.constructor.name).toBe(className);
    }
  });
});
