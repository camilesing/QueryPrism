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
