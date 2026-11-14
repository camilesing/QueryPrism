// chat-model-registry — protocol-id → LangChain native chat-class factory.
// Mirrors the frontend supplier registry (frontend/src/entity/supplier.ts):
// the AiModel.protocol column stores the numeric protocol id as a string, and
// this table is the backend half of that registry. Adding a provider = one
// row here + one supplierList entry there (keep the ids in sync).
//
// Known limitations (why some suppliers are NOT here):
//  - Tencent Hunyuan: ChatTencentHunyuan needs CAM secretId+secretKey (two
//    credentials) — does not fit the single api_key form; stays on the
//    OpenAI-compatible endpoint (protocol 1).
//  - iFlytek Xinghuo: ChatIflytekXinghuo needs appid+apiKey+apiSecret — same
//    story; stays on protocol 1.
//  - Baidu Qianfan: no native class in @langchain/community v1 — protocol 1.
//  - MiniMax: ChatMinimax hardcodes the legacy China endpoint
//    (api.minimax.chat/v1/text/chatcompletion_pro) and requires a groupId —
//    NOT the same service as the international OpenAI-compatible
//    api.minimax.io the admin page offers. Stays on protocol 1; protocol id
//    14 is reserved if a native class for the Intl endpoint ever lands.
//  - Bedrock/VertexAI/watsonx need cloud credential chains; llama_cpp/webllm
//    run in-process; arcjet/portkey/premai are gateway wrappers with extra
//    required config. None fit the {api_key, api_domain} form — unsupported.
//
// @langchain/community is in maintenance mode (langchainjs-community#61);
// the classes it still hosts (zhipuai/moonshot/minimax/tongyi/…) remain
// published and maintained. Perplexity/Together also ship standalone packages
// (@langchain/perplexity, @langchain/together-ai) — switch those two rows if
// community ever drops them.
//
// apiDomain mapping is per IMPLEMENTATION (several community classes ignore
// a URL override — their .d.ts lies — so the field is verified against each
// constructor, not the docs): applied for anthropic (anthropicApiUrl),
// google-genai (baseUrl), xai (baseURL), groq (baseUrl), mistral (serverURL),
// ollama (baseUrl), deepseek/fireworks (configuration.baseURL — OpenAI-
// derived), friendli (baseUrl), tongyi (region derived from the domain);
// IGNORED for zhipuai/cohere/moonshot/perplexity/together/deepinfra/novita
// (they hardcode their official endpoint; together/novita even delete a
// user-passed configuration) — for those, api_domain is stored for form
// display only.
//
// `streaming: true` is passed only where the class input declares the field
// (zhipuai/moonshot/perplexity read it into their request payload; the
// OpenAI-derived classes share BaseChatOpenAI's streaming flag);
// everywhere else BaseChatModel.stream() streams on demand regardless.
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatMistralAI } from '@langchain/mistralai';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatXAI } from '@langchain/xai';
import { ChatFireworks } from '@langchain/fireworks';
import { ChatCohere } from '@langchain/cohere';
import { ChatZhipuAI } from '@langchain/community/chat_models/zhipuai';
import { ChatMoonshot } from '@langchain/community/chat_models/moonshot';
import { ChatAlibabaTongyi } from '@langchain/community/chat_models/alibaba_tongyi';
import { ChatPerplexity } from '@langchain/community/chat_models/perplexity';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { ChatDeepInfra } from '@langchain/community/chat_models/deepinfra';
import { ChatFriendli } from '@langchain/community/chat_models/friendli';
import { ChatNovitaAI } from '@langchain/community/chat_models/novita';
import type { AiModel } from '@prisma/client';
import type { ChatLike } from './llm.service';

export type ChatModelFactory = (model: AiModel, apiKey: string) => ChatLike;

/** `baseModel || name` — the same precedence getChatModel always used. */
const nameOf = (m: AiModel): string => m.baseModel || m.name;

/** Derive the DashScope region from the stored api_domain (custom gateways
 *  fall back to 'china' — the Tongyi class has no raw-URL override). */
const tongyiRegion = (m: AiModel): 'china' | 'singapore' | 'us' => {
  const d = m.apiDomain ?? '';
  if (d.includes('dashscope-intl')) return 'singapore';
  if (d.includes('dashscope-us')) return 'us';
  return 'china';
};

export const CHAT_MODEL_FACTORIES: Record<string, ChatModelFactory> = {
  '3': (m, apiKey) =>
    new ChatZhipuAI({
      apiKey,
      model: nameOf(m) as never,
      streaming: true,
    }) as unknown as ChatLike,
  '4': (m, apiKey) =>
    new ChatAnthropic({
      anthropicApiKey: apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { anthropicApiUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '5': (m, apiKey) =>
    new ChatGoogleGenerativeAI({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '6': (m, apiKey) =>
    new ChatXAI({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseURL: m.apiDomain } : {}),
      streaming: true,
    }) as unknown as ChatLike,
  '7': (m, apiKey) =>
    new ChatGroq({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '8': (m, apiKey) =>
    new ChatMistralAI({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { serverURL: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '9': (m) =>
    new ChatOllama({
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '10': (m, apiKey) =>
    new ChatDeepSeek({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { configuration: { baseURL: m.apiDomain } } : {}),
      streaming: true,
    }) as unknown as ChatLike,
  '11': (m, apiKey) =>
    new ChatFireworks({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { configuration: { baseURL: m.apiDomain } } : {}),
      streaming: true,
    }) as unknown as ChatLike,
  '12': (m, apiKey) =>
    new ChatCohere({
      apiKey,
      model: nameOf(m),
    }) as unknown as ChatLike,
  '13': (m, apiKey) =>
    new ChatMoonshot({
      apiKey,
      model: nameOf(m) as never,
      streaming: true,
    }) as unknown as ChatLike,
  // '14' reserved for MiniMax — see the limitations note above.
  '15': (m, apiKey) =>
    new ChatAlibabaTongyi({
      alibabaApiKey: apiKey,
      model: nameOf(m),
      region: tongyiRegion(m),
    }) as unknown as ChatLike,
  '16': (m, apiKey) =>
    new ChatPerplexity({
      apiKey,
      model: nameOf(m),
      streaming: true,
    }) as unknown as ChatLike,
  '17': (m, apiKey) =>
    new ChatTogetherAI({
      apiKey,
      model: nameOf(m),
      streaming: true,
    }) as unknown as ChatLike,
  '18': (m, apiKey) =>
    new ChatDeepInfra({
      apiKey,
      model: nameOf(m),
    }) as unknown as ChatLike,
  '19': (m, apiKey) =>
    new ChatFriendli({
      friendliToken: apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '20': (m, apiKey) =>
    new ChatNovitaAI({
      apiKey,
      model: nameOf(m),
      streaming: true,
    }) as unknown as ChatLike,
};
