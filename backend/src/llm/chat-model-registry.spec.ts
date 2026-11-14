// Spec for CHAT_MODEL_FACTORIES — instantiates every registered factory with
// a fake AiModel row and asserts the LangChain class + parameter mapping.
// No network: LangChain chat-model constructors are lazy (they only hold
// config; the first HTTP call happens on invoke/stream).
import { ChatZhipuAI } from '@langchain/community/chat_models/zhipuai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { AiModel } from '@prisma/client';
import {
  CHAT_MODEL_FACTORIES,
  type ChatModelFactory,
} from './chat-model-registry';

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
  it('registers exactly the 18 native protocol ids (3..20)', () => {
    expect(Object.keys(CHAT_MODEL_FACTORIES).sort((a, b) => +a - +b)).toEqual(
      Array.from({ length: 18 }, (_, i) => String(i + 3)),
    );
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
    // '14' (ChatMinimax) is covered by its own test below — the class throws
    // at construction without a groupId (or MINIMAX_GROUP_ID env), so a bare
    // row() can never instantiate it.
    ['15', 'ChatAlibabaTongyi'],
    ['16', 'ChatPerplexity'],
    ['17', 'ChatTogetherAI'],
    ['18', 'ChatDeepInfra'],
    ['19', 'ChatFriendli'],
    ['20', 'ChatNovitaAI'],
  ] as [string, string][])('protocol %s → %s', (protocol, className) => {
    const factory = CHAT_MODEL_FACTORIES[protocol] as ChatModelFactory;
    expect(factory).toBeDefined();
    const chat = factory(row({ protocol }), 'sk-test');
    expect(chat.constructor.name).toBe(className);
  });

  it('prefers baseModel over name for the model id', () => {
    const factory = CHAT_MODEL_FACTORIES['3'] as ChatModelFactory;
    const chat = factory(
      row({ baseModel: 'glm-4.6', name: '我的GLM' }),
      'sk-test',
    ) as unknown as ChatZhipuAI;
    expect(chat.model).toBe('glm-4.6');
  });

  it('passes apiDomain through to the native URL override (google-genai)', () => {
    const factory = CHAT_MODEL_FACTORIES['5'] as ChatModelFactory;
    const chat = factory(
      row({ apiDomain: 'https://gemini-proxy.internal/v1beta' }),
      'sk-test',
    ) as unknown as ChatGoogleGenerativeAI;
    expect(chat.baseUrl).toBe('https://gemini-proxy.internal/v1beta');
  });

  it('reads minimax_group_id from the stored config rows (ChatMinimax throws without it)', () => {
    const factory = CHAT_MODEL_FACTORIES['14'] as ChatModelFactory;
    const withGroup = factory(
      row({ config: [{ key: 'minimax_group_id', val: '1234567890' }] }),
      'sk-test',
    ) as unknown as { minimaxGroupId?: string };
    expect(withGroup.constructor.name).toBe('ChatMinimax');
    expect(withGroup.minimaxGroupId).toBe('1234567890');
    // Without the config row (and no env) the native class fails loud —
    // that error surfaces at chat time with an actionable message.
    expect(() =>
      factory(row({ config: [{ key: 'temperature', val: 0.7 }] }), 'sk-test'),
    ).toThrow('Minimax GroupID not found');
  });

  it('maps the DashScope domain to the tongyi region', () => {
    const factory = CHAT_MODEL_FACTORIES['15'] as ChatModelFactory;
    const cn = factory(row(), 'sk') as unknown as { region: string };
    const intl = factory(
      row({ apiDomain: 'https://dashscope-intl.aliyuncs.com' }),
      'sk',
    ) as unknown as { region: string };
    expect(cn.region).toBe('china');
    expect(intl.region).toBe('singapore');
  });
});
