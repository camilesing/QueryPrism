# LangChain 原生供应商注册表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 模型接入页面支持 LangChain 框架层已内置的全部 chat 供应商（GLM/Claude/Grok 等 13 个新供应商 + 存量 5 家切原生类），后端按 `AiModel.protocol` 路由到 LangChain 原生 chat 类。

**Architecture:** 双端注册表扩展。前端 `supplier.ts` 条目新增 `protocol` 字段并登记新供应商；后端新增 `chat-model-registry.ts`（protocol id → 原生类工厂），`LlmService.getChatModel()` 查表路由，未命中保持现有 `ChatOpenAI`+baseURL 行为。零 schema 变更，存量行不受影响。

**Tech Stack:** NestJS 11 + LangChain.js 1.x（`@langchain/community` 子路径 + 9 个第一方包）；Vue 3 + Element Plus。

**Spec:** `docs/superpowers/specs/2026-11-14-langchain-provider-registry-design.md`

**关键背景（零上下文执行者必读）:**

- `AiModel.protocol` 是 Prisma String 列，存的是前端注册表数字 id 的字符串（`'1'`/`'2'`…）。现状：除 legacy `'azure'` 外全部走 `ChatOpenAI` + OpenAI 兼容 baseURL。
- 前后端 protocol id 必须人工同步：本计划锁定的分配见下表。前端 `supplierList` 的 `id`（供应商 id，1~28）与 `protocol`（协议 id，1~20）是**两个不同序列**，不要混淆。
- 所有命令的工作目录：backend 任务在 `backend/`（用 pnpm），frontend 任务在 `frontend/`（用 npm）。
- 测试证据要求：报告实际跑过的命令；过滤器匹配 0 个测试不算通过。

**Protocol 分配（锁定，勿改）**

| id | 含义 | 类 | import |
|----|------|----|--------|
| 1 | openai / 兼容端点（现状） | `ChatOpenAI` | `@langchain/openai`（已装） |
| 2 | vllm（现状，同 1 路径） | `ChatOpenAI` | 同上 |
| 3 | zhipuai | `ChatZhipuAI` | `@langchain/community/chat_models/zhipuai` |
| 4 | anthropic | `ChatAnthropic` | `@langchain/anthropic` |
| 5 | google_genai | `ChatGoogleGenerativeAI` | `@langchain/google-genai` |
| 6 | xai | `ChatXAI` | `@langchain/xai` |
| 7 | groq | `ChatGroq` | `@langchain/groq` |
| 8 | mistral | `ChatMistral` | `@langchain/mistralai` |
| 9 | ollama | `ChatOllama` | `@langchain/ollama` |
| 10 | deepseek | `ChatDeepSeek` | `@langchain/deepseek` |
| 11 | fireworks | `ChatFireworks` | `@langchain/fireworks` |
| 12 | cohere | `ChatCohere` | `@langchain/cohere` |
| 13 | moonshot | `ChatMoonshot` | `@langchain/community/chat_models/moonshot` |
| 14 | minimax | `ChatMinimax` | `@langchain/community/chat_models/minimax` |
| 15 | tongyi | `ChatAlibabaTongyi` | `@langchain/community/chat_models/alibaba_tongyi` |
| 16 | perplexity | `ChatPerplexity` | `@langchain/community/chat_models/perplexity` |
| 17 | together | `ChatTogetherAI` | `@langchain/community/chat_models/togetherai` |
| 18 | deepinfra | `ChatDeepInfra` | `@langchain/community/chat_models/deepinfra` |
| 19 | friendli | `ChatFriendli` | `@langchain/community/chat_models/friendli` |
| 20 | novita | `ChatNovita` | `@langchain/community/chat_models/novita` |

**各原生类构造参数（已对照 npm 最新版 .d.ts 核实）：**

- key 参数名：`apiKey`（3,5,6,7,8,10,11,12,13,14,16,17,18,20）、`anthropicApiKey`（4）、`friendliToken`（19）、`alibabaApiKey`（15）、无需 key（9 ollama）
- URL 覆盖参数：`apiUrl`（3,13,14,18）、`anthropicApiUrl`（4）、`baseUrl`（5,7,9,19）、`baseURL`（6）、`serverURL`（8）、`configuration:{baseURL}`（10,11，OpenAI 派生类）；无 URL 参数（12,16,17,20 —— apiDomain 忽略）；15 tongyi 不吃原样 URL（其 `apiUrl` 是原生生成端点而非兼容端点），由 apiDomain 推断 `region`（含 `dashscope-intl` → singapore，含 `dashscope-us` → us，否则 china）
- `model` 是 union 类型的（3,13,14,15）：传 `as never`；其余传 string
- **不要传 `streaming: true`**：各原生类 input 类型不一，多余的属性会触发对象字面量 excess-property 编译错误；LangChain `BaseChatModel.stream()` 本身按需流式，无需该标志

---

### Task 1: 安装后端依赖

**Files:**
- Modify: `backend/package.json`（经 pnpm 自动写入）

- [ ] **Step 1: 安装 10 个 LangChain 供应商包**

```bash
cd backend
pnpm add @langchain/community @langchain/anthropic @langchain/google-genai @langchain/groq @langchain/mistralai @langchain/ollama @langchain/deepseek @langchain/xai @langchain/fireworks @langchain/cohere
```

Expected: 安装成功，无 native build 报错（这些包纯 JS；若 pnpm 报 allowBuilds 相关失败，检查 `backend/pnpm-workspace.yaml` 但预期不需要改）。

- [ ] **Step 2: 验证子路径导入可用（编译探测）**

```bash
cd backend && node -e "const z=require('@langchain/community/chat_models/zhipuai'); console.log(typeof z.ChatZhipuAI)"
```

Expected: 输出 `function`。

- [ ] **Step 3: 提交**

```bash
cd /Users/camile/Work/TypeScript/QueryPrism
git add backend/package.json backend/pnpm-lock.yaml
git commit -m "build(backend): add langchain native provider packages"
```

---

### Task 2: chat-model-registry.ts（TDD）

**Files:**
- Create: `backend/src/llm/chat-model-registry.ts`
- Test: `backend/src/llm/chat-model-registry.spec.ts`

- [ ] **Step 1: 写失败测试**

创建 `backend/src/llm/chat-model-registry.spec.ts`：

```ts
// Spec for CHAT_MODEL_FACTORIES — instantiates every registered factory with
// a fake AiModel row and asserts the LangChain class + parameter mapping.
// No network: LangChain chat-model constructors are lazy (they only hold
// config; the first HTTP call happens on invoke/stream).
import { ChatZhipuAI } from '@langchain/community/chat_models/zhipuai';
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
    ['8', 'ChatMistral'],
    ['9', 'ChatOllama'],
    ['10', 'ChatDeepSeek'],
    ['11', 'ChatFireworks'],
    ['12', 'ChatCohere'],
    ['13', 'ChatMoonshot'],
    ['14', 'ChatMinimax'],
    ['15', 'ChatAlibabaTongyi'],
    ['16', 'ChatPerplexity'],
    ['17', 'ChatTogetherAI'],
    ['18', 'ChatDeepInfra'],
    ['19', 'ChatFriendli'],
    ['20', 'ChatNovita'],
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

  it('passes apiDomain through to the native URL override', () => {
    const factory = CHAT_MODEL_FACTORIES['3'] as ChatModelFactory;
    const chat = factory(
      row({ apiDomain: 'https://glm-proxy.internal/api/paas/v4' }),
      'sk-test',
    ) as unknown as ChatZhipuAI;
    expect(chat.apiUrl).toBe('https://glm-proxy.internal/api/paas/v4');
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
```

- [ ] **Step 2: 运行确认失败**

```bash
cd backend && pnpm exec jest chat-model-registry
```

Expected: FAIL —— `Cannot find module './chat-model-registry'`。

- [ ] **Step 3: 实现 registry**

创建 `backend/src/llm/chat-model-registry.ts`：

```ts
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
//  - Bedrock/VertexAI/watsonx need cloud credential chains; llama_cpp/webllm
//    run in-process; arcjet/portkey/premai are gateway wrappers with extra
//    required config. None fit the {api_key, api_domain} form — unsupported.
//
// apiDomain mapping (null → the class's built-in default): apiUrl for
// zhipuai/moonshot/minimax/deepinfra, baseUrl for google-genai/groq/ollama/
// friendli, serverURL for mistral, anthropicApiUrl for anthropic, baseURL
// for xai, configuration.baseURL for the OpenAI-derived deepseek/fireworks;
// ignored for cohere/perplexity/together/novita (no URL override param);
// tongyi derives its region from the domain (its apiUrl is the native
// generation endpoint, not an OpenAI-compatible base).
//
// No `streaming: true` here on purpose: the per-class input types disagree
// on the field (excess-property compile errors) and BaseChatModel.stream()
// streams on demand anyway.
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatGroq } from '@langchain/groq';
import { ChatMistral } from '@langchain/mistralai';
import { ChatOllama } from '@langchain/ollama';
import { ChatDeepSeek } from '@langchain/deepseek';
import { ChatXAI } from '@langchain/xai';
import { ChatFireworks } from '@langchain/fireworks';
import { ChatCohere } from '@langchain/cohere';
import { ChatZhipuAI } from '@langchain/community/chat_models/zhipuai';
import { ChatMoonshot } from '@langchain/community/chat_models/moonshot';
import { ChatMinimax } from '@langchain/community/chat_models/minimax';
import { ChatAlibabaTongyi } from '@langchain/community/chat_models/alibaba_tongyi';
import { ChatPerplexity } from '@langchain/community/chat_models/perplexity';
import { ChatTogetherAI } from '@langchain/community/chat_models/togetherai';
import { ChatDeepInfra } from '@langchain/community/chat_models/deepinfra';
import { ChatFriendli } from '@langchain/community/chat_models/friendli';
import { ChatNovita } from '@langchain/community/chat_models/novita';
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
      ...(m.apiDomain ? { apiUrl: m.apiDomain } : {}),
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
    }) as unknown as ChatLike,
  '7': (m, apiKey) =>
    new ChatGroq({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '8': (m, apiKey) =>
    new ChatMistral({
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
    }) as unknown as ChatLike,
  '11': (m, apiKey) =>
    new ChatFireworks({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { configuration: { baseURL: m.apiDomain } } : {}),
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
      ...(m.apiDomain ? { apiUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '14': (m, apiKey) =>
    new ChatMinimax({
      apiKey,
      model: nameOf(m) as never,
      ...(m.apiDomain ? { apiUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '15': (m, apiKey) =>
    new ChatAlibabaTongyi({
      alibabaApiKey: apiKey,
      model: nameOf(m) as never,
      region: tongyiRegion(m),
    }) as unknown as ChatLike,
  '16': (m, apiKey) =>
    new ChatPerplexity({
      apiKey,
      model: nameOf(m),
    }) as unknown as ChatLike,
  '17': (m, apiKey) =>
    new ChatTogetherAI({
      apiKey,
      model: nameOf(m),
    }) as unknown as ChatLike,
  '18': (m, apiKey) =>
    new ChatDeepInfra({
      apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { apiUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '19': (m, apiKey) =>
    new ChatFriendli({
      friendliToken: apiKey,
      model: nameOf(m),
      ...(m.apiDomain ? { baseUrl: m.apiDomain } : {}),
    }) as unknown as ChatLike,
  '20': (m, apiKey) =>
    new ChatNovita({
      apiKey,
      model: nameOf(m),
    }) as unknown as ChatLike,
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && pnpm exec jest chat-model-registry
```

Expected: PASS（5+ 用例）。若个别字段断言失败（如 tongyi `region` 未暴露为实例字段），先核对 `.d.ts` 再调整断言，不得删除用例凑绿。

- [ ] **Step 5: 提交**

```bash
git add backend/src/llm/chat-model-registry.ts backend/src/llm/chat-model-registry.spec.ts
git commit -m "feat(llm): add protocol registry for langchain native chat classes"
```

---

### Task 3: getChatModel 接入 registry

**Files:**
- Modify: `backend/src/llm/llm.service.ts:1-13`（头注释）, `:105-123`（getChatModel）
- Modify: `backend/src/llm/llm.service.spec.ts`（routing describe 增用例）

- [ ] **Step 1: 先加失败测试**

在 `llm.service.spec.ts` 的 `describe('LlmService.getChatModel routing')` 内追加：

```ts
  it('routes native protocol ids through the registry (no ChatOpenAI)', () => {
    const { svc } = makeService({});
    const chat = svc.getChatModel(fakeModel({ protocol: '3' }), 'decrypted');
    expect(chat.constructor.name).toBe('ChatZhipuAI');
    expect(ChatOpenAI).not.toHaveBeenCalled();
    expect(AzureChatOpenAI).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 运行确认失败**

```bash
cd backend && pnpm exec jest llm.service
```

Expected: 新用例 FAIL（现实现无 registry 路由，`getChatModel` 返回 mock 的 ChatOpenAI 实例）。其余既有用例应仍 PASS。

- [ ] **Step 3: 修改 llm.service.ts**

文件头部注释（第 8-13 行）中 `Supplier routing:` 段落替换为：

```
// Supplier routing: the AiModel.protocol column stores the numeric protocol
// id. Native ids (3..20) route through CHAT_MODEL_FACTORIES
// (chat-model-registry.ts — LangChain provider classes: ChatZhipuAI,
// ChatAnthropic, …); protocol 'azure' switches to AzureChatOpenAI; anything
// else (1/2/legacy) stays on the OpenAI-compatible base_url path
// (openai/tongyi-compat/vllm/ollama-compat/deepseek-compat/qwen…).
// Reasoning is surfaced two ways — DeepSeek-style  think…/think  tags
// interleaved in `content` (split by ReasoningParser) and Qwen-style
// `reasoning_content` in additional_kwargs (read directly).
```

在 import 区（`@langchain/openai` import 之后）加：

```ts
import { CHAT_MODEL_FACTORIES } from './chat-model-registry';
```

`getChatModel`（原 105-123 行）整体替换为：

```ts
  /** Build a chat model from a stored AiModel row. Decrypts the apiKey and
   *  routes: native protocol ids (3..20) through CHAT_MODEL_FACTORIES
   *  (LangChain provider classes), azure → AzureChatOpenAI, everything else
   *  → ChatOpenAI with an OpenAI-compatible base_url. */
  getChatModel(model: AiModel, apiKey: string): ChatLike {
    const modelName = model.baseModel || model.name;
    const factory = CHAT_MODEL_FACTORIES[model.protocol];
    if (factory) return factory(model, apiKey);
    if (model.protocol === 'azure') {
      return new AzureChatOpenAI({
        apiKey,
        model: modelName,
        streaming: true,
      }) as unknown as ChatLike;
    }
    return new ChatOpenAI({
      apiKey,
      model: modelName,
      configuration: model.apiDomain ? { baseURL: model.apiDomain } : undefined,
      streaming: true,
    }) as unknown as ChatLike;
  }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd backend && pnpm exec jest llm.service
```

Expected: PASS（含新用例与既有全部用例）。

**已知风险（ contingency ）：** 本 spec 顶部 `jest.mock('@langchain/openai')` 会 auto-mock，而 registry 引入的 `@langchain/deepseek`/`fireworks`/`xai` 内部 extends `@langchain/openai` 的类。若模块加载报错（extends mock 类失败），在 spec 的 `jest.mock('@langchain/openai')` 之后补 `jest.mock('@langchain/deepseek'); jest.mock('@langchain/fireworks'); jest.mock('@langchain/xai');`，并保持断言不变。若 Google/Anthropic 等类构造时报缺 env 之类错误，同样按包补 jest.mock（构造断言只针对 ChatZhipuAI，不受影响）。

- [ ] **Step 5: 提交**

```bash
git add backend/src/llm/llm.service.ts backend/src/llm/llm.service.spec.ts
git commit -m "feat(llm): route native protocol ids through chat-model registry"
```

---

### Task 4: 前端 supplier 注册表扩展

**Files:**
- Modify: `frontend/src/entity/supplier.ts`（全文件重写为下述内容）
- Modify: `frontend/src/views/system/model/ModelForm.vue:178-185`（supplierChang）

- [ ] **Step 1: 重写 supplier.ts**

用以下内容整体替换 `frontend/src/entity/supplier.ts`。相对现状的语义变化：
(a) 类型加 `protocol: number`；(b) 存量 5 家切原生 protocol（百炼→15 且默认域改为 DashScope 基础域、Kimi→13、MiniMax→14、DeepSeek→10、Gemini→5）；(c) 新增 13 家（id 16~28，避开已用 id 1~10/13/15）；(d) 新增 `letterIcon` 兜底图标。

```ts
import icon_alybl_colorful from '@/assets/model/icon_alybl_colorful.png'
import icon_bdyzn_colorful from '@/assets/model/icon_bdyzn_colorful.png'
import icon_deepseek_colorful from '@/assets/model/icon_deepseek_colorful.png'
import icon_txy_colorful from '@/assets/model/icon_txy_colorful.png'
import icon_xfhx_colorful from '@/assets/model/icon_xfhx_colorful.png'
import icon_gemini_colorful from '@/assets/model/icon_gemini_colorful.png'
import icon_openai_colorful from '@/assets/model/icon_openai_colorful.png'
import icon_kimi_colorful from '@/assets/model/icon_kimi_colorful.png'
import icon_txhy_colorful from '@/assets/model/icon_txhy_colorful.png'
import icon_hsyq_colorful from '@/assets/model/icon_hsyq_colorful.png'
// import icon_vllm_colorful from '@/assets/model/icon_vllm_colorful.png'
import icon_common_openai from '@/assets/model/icon_common_openai.png'
import icon_minimax_colorful from '@/assets/model/icon_minimax_colorful.png'
import icon_ollama_gray from '@/assets/model/icon_ollama_gray.png'
// import icon_azure_openAI_colorful from '@/assets/model/icon_Azure_OpenAI_colorful.png'

// Fallback tile for suppliers without a brand asset in this repo — an SVG
// letter tile generated at import time (Chrome 81-safe data URI in <img>).
const letterIcon = (text: string, color: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${color}"/><text x="32" y="43" font-family="Helvetica,Arial,sans-serif" font-size="28" font-weight="600" fill="#ffffff" text-anchor="middle">${text}</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

type ModelArg = { key: string; val?: string | number; type: string; range?: string }
type ModelOption = { name: string; api_domain?: string; args?: ModelArg[] }
type ModelConfig = Record<
  number,
  {
    api_domain: string
    common_args?: ModelArg[]
    model_options: ModelOption[]
  }
>

// protocol ids MUST stay in sync with the backend registry
// (backend/src/llm/chat-model-registry.ts): 1/2 openai-compatible, 3..20 =
// LangChain native classes.
export const supplierList: Array<{
  id: number
  name: string
  i18nKey: string
  icon: any
  type?: string
  is_private?: boolean
  protocol: number
  model_config: ModelConfig
}> = [
  {
    id: 1,
    name: '阿里云百炼',
    i18nKey: 'supplier.alibaba_cloud_bailian',
    icon: icon_alybl_colorful,
    protocol: 15,
    model_config: {
      0: {
        // DashScope base domain — the Tongyi native class derives its region
        // from it ('dashscope-intl' → singapore, 'dashscope-us' → us).
        api_domain: 'https://dashscope.aliyuncs.com',
        common_args: [
          { key: 'temperature', val: 1.0, type: 'number', range: '[0, 2)' },
          { key: 'extra_body', val: '{"enable_thinking": false}', type: 'json' },
        ],
        model_options: [
          { name: 'qwen3.6-plus' },
          { name: 'qwen3.5-plus' },
          { name: 'qwen3.5-flash' },
          { name: 'qwen3-coder-next' },
          { name: 'qwen3-coder-plus' },
          { name: 'qwen3-coder-flash' },
          { name: 'qwen-plus' },
          /* { name: 'qwen-plus-latest' }, */
          { name: 'qwen-max' },
          { name: 'qwen-max-latest' },
          { name: 'qwen-turbo' },
          { name: 'qwen-turbo-latest' },
          { name: 'qwen-long' },
          { name: 'qwen-long-latest' },
        ],
      },
    },
  },
  {
    id: 2,
    name: '千帆大模型',
    i18nKey: 'supplier.qianfan_model',
    icon: icon_bdyzn_colorful,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://qianfan.baidubce.com/v2/',
        model_options: [{ name: 'ernie-x1-turbo-32k' }],
      },
    },
  },
  {
    id: 3,
    name: 'DeepSeek',
    i18nKey: 'supplier.deepseek',
    icon: icon_deepseek_colorful,
    protocol: 10,
    model_config: {
      0: {
        api_domain: 'https://api.deepseek.com',
        model_options: [
          { name: 'deepseek-chat' },
          /* { name: 'deepseek-reasoner' } */
        ],
      },
    },
  },
  {
    id: 4,
    name: '腾讯混元',
    i18nKey: 'supplier.tencent_hunyuan',
    icon: icon_txhy_colorful,
    // ChatTencentHunyuan needs CAM secretId+secretKey (does not fit the single
    // api_key form) — stays on the OpenAI-compatible endpoint.
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://api.hunyuan.cloud.tencent.com/v1/',
        common_args: [{ key: 'temperature', val: 1.0, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'hunyuan-turbos-latest' },
          /* { name: 'hunyuan-turbos-longtext-128k-20250325' },
          { name: 'hunyuan-large' }, */
          { name: 'hunyuan-standard-256K' },
          { name: 'hunyuan-standard' },
          /* { name: 'hunyuan-lite' }, */
        ],
      },
    },
  },
  {
    id: 5,
    name: '讯飞星火',
    i18nKey: 'supplier.iflytek_spark',
    icon: icon_xfhx_colorful,
    // ChatIflytekXinghuo needs appid+apiKey+apiSecret — stays on the
    // OpenAI-compatible (APIPassword) endpoint.
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://spark-api-open.xf-yun.com/v1/',
        common_args: [
          { key: 'temperature', val: 1.0, type: 'number', range: '[0, 2]' },
          { key: 'max_tokens', val: 4096, type: 'number', range: '[1, 32768]' },
        ],
        model_options: [
          {
            name: '4.0Ultra',
            args: [
              { key: 'temperature', val: 0.5, type: 'number', range: '[0, 1]' },
              { key: 'max_tokens', val: 8192, type: 'number', range: '[1, 8192]' },
            ],
            api_domain: 'https://spark-api-open.xf-yun.com/v1/',
          },
          /* {
            name: 'generalv3.5',
            args: [{ key: 'max_tokens', val: 4096, type: 'number', range: '[1, 8192]' }],
          },
          {
            name: 'max-32k',
            args: [{ key: 'max_tokens', val: 4096, type: 'number', range: '[1, 32768]' }],
          },
          {
            name: 'generalv3',
            args: [{ key: 'max_tokens', val: 4096, type: 'number', range: '[1, 8192]' }],
          },
          {
            name: 'pro-128k',
            args: [{ key: 'max_tokens', val: 4096, type: 'number', range: '[1, 131072]' }],
          },
          {
            name: 'lite',
            args: [{ key: 'max_tokens', val: 4096, type: 'number', range: '[1, 4096]' }],
          }, */
          {
            name: 'x1',
            args: [
              { key: 'max_tokens', val: 32768, type: 'number', range: '[1, 32768]' },
              { key: 'temperature', val: 1.2, type: 'number', range: '(0, 2]' },
            ],
            api_domain: 'https://spark-api-open.xf-yun.com/v2/',
          },
        ],
      },
    },
  },
  {
    id: 6,
    name: 'Gemini',
    i18nKey: 'supplier.gemini',
    icon: icon_gemini_colorful,
    protocol: 5,
    model_config: {
      0: {
        api_domain: 'https://generativelanguage.googleapis.com/v1beta',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '(0, 1]' }],
        model_options: [
          { name: 'gemini-2.5-pro' },
          { name: 'gemini-2.5-flash' },
          { name: 'gemini-2.5-flash-lite' },
          { name: 'gemini-2.0-flash' },
          { name: 'gemini-2.0-flash-lite' },
        ],
      },
    },
  },
  {
    id: 7,
    name: 'OpenAI',
    i18nKey: 'supplier.openai',
    icon: icon_openai_colorful,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://api.openai.com/v1',
        common_args: [{ key: 'temperature', val: 1.0, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'gpt-4.1' },
          { name: 'gpt-4.1-mini' },
          { name: 'gpt-4.1-nano' },
          { name: 'gpt-4o' },
          { name: 'gpt-4o-mini' },
          { name: 'chatgpt-4o' },
          { name: 'o4-mini' },
          { name: 'o4-mini-deep-research' },
          { name: 'o3' },
          { name: 'o3-pro' },
          { name: 'o3-mini' },
          { name: 'o3-deep-research' },
          { name: 'o1' },
          { name: 'o1-pro' },
          { name: 'o1-mini' },
        ],
      },
    },
  },
  {
    id: 8,
    name: 'Kimi',
    i18nKey: 'supplier.kimi',
    icon: icon_kimi_colorful,
    protocol: 13,
    model_config: {
      0: {
        api_domain: 'https://api.moonshot.cn/v1',
        common_args: [{ key: 'temperature', val: 0.3, type: 'number', range: '[0, 1]' }],
        model_options: [
          {
            name: 'kimi-k2-0711-preview',
            args: [{ key: 'temperature', val: 0.3, type: 'number', range: '[0, 1]' }],
          },
          {
            name: 'kimi-k2-turbo-preview',
            args: [{ key: 'temperature', val: 0.3, type: 'number', range: '[0, 1]' }],
          },
          { name: 'moonshot-v1-8k' },
          { name: 'moonshot-v1-32k' },
          { name: 'moonshot-v1-128k' },
          { name: 'moonshot-v1-auto' },
          { name: 'kimi-latest' },
          { name: 'moonshot-v1-8k-vision-preview' },
          { name: 'moonshot-v1-32k-vision-preview' },
          { name: 'moonshot-v1-128k-vision-preview' },
          { name: 'kimi-thinking-preview' },
        ],
      },
    },
  },
  {
    id: 9,
    name: '腾讯云',
    i18nKey: 'supplier.tencent_cloud',
    icon: icon_txy_colorful,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://api.lkeap.cloud.tencent.com/v1',
        common_args: [{ key: 'temperature', val: 0.6, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'deepseek-r1' },
          { name: 'deepseek-r1-0528' },
          { name: 'deepseek-v3' },
          { name: 'deepseek-v3-0324' },
        ],
      },
    },
  },
  {
    id: 10,
    name: '火山引擎',
    i18nKey: 'supplier.volcano_engine',
    icon: icon_hsyq_colorful,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://ark.cn-beijing.volces.com/api/v3',
        common_args: [{ key: 'temperature', val: 0.6, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'doubao-seed-1-6-250615' },
          { name: 'doubao-seed-1-6-flash-250715' },
          { name: 'doubao-1-5-pro-32k-character-250715' },
          { name: 'kimi-k2-250711' },
          { name: 'deepseek-v3-250324' },
          { name: 'deepseek-v4-pro-260425' },
        ],
      },
    },
  },
  {
    id: 13,
    name: 'MiniMax',
    i18nKey: 'supplier.minimax',
    icon: icon_minimax_colorful,
    protocol: 14,
    model_config: {
      0: {
        api_domain: 'https://api.minimax.io/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 1]' }],
        // 53ac1375: upstream model list — M3.1-Flash first, M2.7 retired
        model_options: [{ name: 'MiniMax-M3.1-Flash' }, { name: 'MiniMax-M3' }],
      },
    },
  },
  /* {
    id: 11,
    name: 'vLLM',
    icon: icon_vllm_colorful,
    type: 'vllm',
    is_private: true,
    protocol: 2,
    model_config: {
      0: {
        api_domain: 'http://127.0.0.1:8000/v1',
        common_args: [{ key: 'temperature', val: 0.6, type: 'number', range: '[0, 1]' }],
        model_options: [],
      },
    },
  }, */
  /* {
    id: 12,
    name: 'Azure OpenAI',
    icon: icon_azure_openAI_colorful,
    type: 'azure',
    is_private: true,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'https://{your resource name}.openai.azure.cn/',
        common_args: [{ key: 'temperature', val: 0.6, type: 'number', range: '[0, 1]' }],
        model_options: [
          {
            name: 'Azure OpenAI',
            args: [
              { key: 'api_version', val: '2024-02-15-preview', type: 'string' },
              { key: 'deployment_name', val: '', type: 'string' },
            ],
          },
          {
            name: 'gpt-4',
            args: [
              { key: 'api_version', val: '2024-02-15-preview', type: 'string' },
              { key: 'deployment_name', val: '', type: 'string' },
            ],
          },
        ],
      },
    },
  }, */
  {
    id: 15,
    name: '通用OpenAI',
    i18nKey: 'supplier.generic_openai',
    icon: icon_common_openai,
    is_private: true,
    protocol: 1,
    model_config: {
      0: {
        api_domain: 'http://127.0.0.1:8000/v1',
        common_args: [{ key: 'temperature', val: 0.6, type: 'number', range: '[0, 1]' }],
        model_options: [],
      },
    },
  },
  {
    id: 16,
    name: '智谱GLM',
    i18nKey: 'supplier.zhipu_glm',
    icon: letterIcon('GLM', '#3859FF'),
    protocol: 3,
    model_config: {
      0: {
        api_domain: 'https://open.bigmodel.cn/api/paas/v4',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'glm-4.6' },
          { name: 'glm-4.5' },
          { name: 'glm-4.5-air' },
          { name: 'glm-4.5-flash' },
          { name: 'glm-4-flash' },
        ],
      },
    },
  },
  {
    id: 17,
    name: 'Anthropic',
    i18nKey: 'supplier.anthropic',
    icon: letterIcon('A', '#D97757'),
    protocol: 4,
    model_config: {
      0: {
        api_domain: 'https://api.anthropic.com',
        common_args: [{ key: 'temperature', val: 1.0, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'claude-opus-4-5' },
          { name: 'claude-sonnet-4-5' },
          { name: 'claude-haiku-4-5' },
          { name: 'claude-sonnet-4-20250514' },
        ],
      },
    },
  },
  {
    id: 18,
    name: 'xAI',
    i18nKey: 'supplier.xai',
    icon: letterIcon('X', '#111111'),
    protocol: 6,
    model_config: {
      0: {
        api_domain: 'https://api.x.ai/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'grok-4' },
          { name: 'grok-4-fast-reasoning' },
          { name: 'grok-4-fast-non-reasoning' },
          { name: 'grok-3' },
          { name: 'grok-3-mini' },
        ],
      },
    },
  },
  {
    id: 19,
    name: 'Groq',
    i18nKey: 'supplier.groq',
    icon: letterIcon('Gq', '#F55036'),
    protocol: 7,
    model_config: {
      0: {
        api_domain: 'https://api.groq.com/openai/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'llama-3.3-70b-versatile' },
          { name: 'llama-3.1-8b-instant' },
          { name: 'openai/gpt-oss-120b' },
          { name: 'qwen/qwen3-32b' },
        ],
      },
    },
  },
  {
    id: 20,
    name: 'Mistral AI',
    i18nKey: 'supplier.mistral',
    icon: letterIcon('M', '#FF7000'),
    protocol: 8,
    model_config: {
      0: {
        api_domain: 'https://api.mistral.ai/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'mistral-large-latest' },
          { name: 'mistral-medium-latest' },
          { name: 'mistral-small-latest' },
          { name: 'codestral-latest' },
        ],
      },
    },
  },
  {
    id: 21,
    name: 'Ollama',
    i18nKey: 'supplier.ollama',
    icon: icon_ollama_gray,
    is_private: true,
    protocol: 9,
    model_config: {
      0: {
        api_domain: 'http://127.0.0.1:11434',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'qwen3:8b' },
          { name: 'llama3.1:8b' },
          { name: 'deepseek-r1:8b' },
        ],
      },
    },
  },
  {
    id: 22,
    name: 'Perplexity',
    i18nKey: 'supplier.perplexity',
    icon: letterIcon('P', '#20808D'),
    protocol: 16,
    model_config: {
      0: {
        api_domain: 'https://api.perplexity.ai',
        common_args: [{ key: 'temperature', val: 0.2, type: 'number', range: '[0, 1]' }],
        model_options: [
          { name: 'sonar' },
          { name: 'sonar-pro' },
          { name: 'sonar-reasoning' },
          { name: 'sonar-reasoning-pro' },
          { name: 'sonar-deep-research' },
        ],
      },
    },
  },
  {
    id: 23,
    name: 'Together AI',
    i18nKey: 'supplier.together',
    icon: letterIcon('T', '#0F6FFF'),
    protocol: 17,
    model_config: {
      0: {
        api_domain: 'https://api.together.xyz/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
          { name: 'deepseek-ai/DeepSeek-V3' },
          { name: 'Qwen/Qwen2.5-72B-Instruct-Turbo' },
        ],
      },
    },
  },
  {
    id: 24,
    name: 'Fireworks AI',
    i18nKey: 'supplier.fireworks',
    icon: letterIcon('F', '#7842F5'),
    protocol: 11,
    model_config: {
      0: {
        api_domain: 'https://api.fireworks.ai/inference/v1',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
          { name: 'accounts/fireworks/models/qwen2p5-72b-instruct' },
          { name: 'accounts/fireworks/models/deepseek-v3' },
        ],
      },
    },
  },
  {
    id: 25,
    name: 'Cohere',
    i18nKey: 'supplier.cohere',
    icon: letterIcon('C', '#39594D'),
    protocol: 12,
    model_config: {
      0: {
        api_domain: 'https://api.cohere.com',
        common_args: [{ key: 'temperature', val: 0.3, type: 'number', range: '[0.0, 2.0]' }],
        model_options: [
          { name: 'command-a-03-2025' },
          { name: 'command-r-plus-08-2024' },
          { name: 'command-r7b-12-2024' },
        ],
      },
    },
  },
  {
    id: 26,
    name: 'DeepInfra',
    i18nKey: 'supplier.deepinfra',
    icon: letterIcon('DI', '#1E6FF4'),
    protocol: 18,
    model_config: {
      0: {
        api_domain: 'https://api.deepinfra.com/v1/openai',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'meta-llama/Llama-3.3-70B-Instruct' },
          { name: 'deepseek-ai/DeepSeek-V3.1' },
          { name: 'Qwen/Qwen2.5-72B-Instruct' },
        ],
      },
    },
  },
  {
    id: 27,
    name: 'FriendliAI',
    i18nKey: 'supplier.friendli',
    icon: letterIcon('Fr', '#29D1A5'),
    protocol: 19,
    model_config: {
      0: {
        api_domain: 'https://gateway.friendli.ai',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'meta-llama-3.1-8b-instruct' },
          { name: 'deepseek-v3.1' },
          { name: 'qwen2.5-7b-instruct' },
        ],
      },
    },
  },
  {
    id: 28,
    name: 'Novita AI',
    i18nKey: 'supplier.novita',
    icon: letterIcon('N', '#16E0A8'),
    protocol: 20,
    model_config: {
      0: {
        api_domain: 'https://api.novita.ai/v3/openai',
        common_args: [{ key: 'temperature', val: 0.7, type: 'number', range: '[0, 2]' }],
        model_options: [
          { name: 'deepseek/deepseek-v3.1' },
          { name: 'meta-llama/llama-3.3-70b-instruct' },
          { name: 'qwen/qwen3-32b' },
        ],
      },
    },
  },
]

export const base_model_options = (supplier_id: number, model_type?: number) => {
  const supplier = get_supplier(supplier_id)
  return supplier?.model_config[model_type || 0].model_options
}

export const get_supplier = (supplier_id: number) => {
  return supplierList.find((item: any) => item.id === supplier_id)
}
```

注意：`通用OpenAI`（id 15）的 `model_options` 原来是一份 OpenAI 模型列表的拷贝；改为空数组（该条目本来就走自建端点，模型名必是用户自填，`allow-create` 下拉不受影响）。

- [ ] **Step 2: 修改 ModelForm.vue supplierChang**

`frontend/src/views/system/model/ModelForm.vue` 中（约 178-185 行）：

```ts
const supplierChang = (supplier: any) => {
  modelForm.supplier = supplier.id
  const config = supplier.model_config[modelForm.model_type || 0]
  modelForm.api_domain = config.api_domain
  modelForm.base_model = ''
  modelForm.protocol = supplier.type === 'vllm' ? 2 : 1
  advancedSetting.value = []
}
```

替换为：

```ts
const supplierChang = (supplier: any) => {
  modelForm.supplier = supplier.id
  const config = supplier.model_config[modelForm.model_type || 0]
  modelForm.api_domain = config.api_domain
  modelForm.base_model = ''
  modelForm.protocol = supplier.protocol ?? 1
  advancedSetting.value = []
}
```

（vllm/azure 注释条目已在 supplier.ts 里显式声明 `protocol`，`supplier.type` 推导不再需要。）

- [ ] **Step 3: 类型检查**

```bash
cd frontend && npm run build
```

Expected: vue-tsc 0 错误 + Vite 构建成功。若 `letterIcon` 返回值类型与 `icon: any` 冲突报错，按报错修类型（`icon` 保持 `any` 应无冲突）。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/entity/supplier.ts frontend/src/views/system/model/ModelForm.vue
git commit -m "feat(frontend): register native-protocol suppliers incl glm/claude/grok"
```

---

### Task 5: i18n 键

**Files:**
- Modify: `frontend/src/i18n/en.json`（`supplier` 对象）
- Modify: `frontend/src/i18n/zh-CN.json`（`supplier` 对象）

- [ ] **Step 1: en.json 的 supplier 对象追加（保持字母序无关，追加在对象末尾即可）**

```json
{
  "zhipu_glm": "Zhipu GLM",
  "anthropic": "Anthropic (Claude)",
  "xai": "xAI (Grok)",
  "groq": "Groq",
  "mistral": "Mistral AI",
  "ollama": "Ollama (Local)",
  "perplexity": "Perplexity",
  "together": "Together AI",
  "fireworks": "Fireworks AI",
  "cohere": "Cohere",
  "deepinfra": "DeepInfra",
  "friendli": "FriendliAI",
  "novita": "Novita AI"
}
```

（即在该对象内追加 13 个键；不要破坏 JSON 其余部分。）

- [ ] **Step 2: zh-CN.json 的 supplier 对象追加**

```json
{
  "zhipu_glm": "智谱GLM",
  "anthropic": "Anthropic（Claude）",
  "xai": "xAI（Grok）",
  "groq": "Groq",
  "mistral": "Mistral AI",
  "ollama": "Ollama（本地）",
  "perplexity": "Perplexity",
  "together": "Together AI",
  "fireworks": "Fireworks AI",
  "cohere": "Cohere",
  "deepinfra": "DeepInfra",
  "friendli": "FriendliAI",
  "novita": "Novita AI"
}
```

- [ ] **Step 3: 键位对齐检查**

```bash
cd frontend && npm run check:i18n
```

Expected: 通过（en/zh-CN 键位一致）。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/i18n/en.json frontend/src/i18n/zh-CN.json
git commit -m "feat(i18n): add supplier keys for new native providers"
```

---

### Task 6: AGENTS.md + README 双语

**Files:**
- Modify: `AGENTS.md`（Key Implementation Notes）
- Modify: `README.md`（Features）
- Modify: `README_zh.md`（功能特性）

- [ ] **Step 1: AGENTS.md**

在 Key Implementation Notes 中 `SQL generation:` 条目之前插入一行（保持现有 bullet 风格）：

```
- LLM provider routing: `AiModel.protocol` stores the numeric protocol id; ids 3–20 route through `backend/src/llm/chat-model-registry.ts` (LangChain native classes — ChatZhipuAI/ChatAnthropic/…), `azure` → AzureChatOpenAI, everything else (1/2) → ChatOpenAI + OpenAI-compatible base_url. The ids MUST stay in sync with the frontend registry `frontend/src/entity/supplier.ts`. Hunyuan/Xinghuo/Qianfan stay on protocol 1 (their native classes need multi-field credentials — see registry header); Bedrock/Vertex/watsonx/llama_cpp/webllm are unsupported
```

- [ ] **Step 2: README.md Features 列表追加（`## Features` 末尾）**

```
- 🧠 **20+ LLM providers** — native LangChain integrations (OpenAI, Zhipu GLM, Claude, Grok, Gemini, DeepSeek, Kimi, Qwen/Tongyi, MiniMax, Ollama, …) plus any OpenAI-compatible endpoint
```

- [ ] **Step 3: README_zh.md 功能特性列表追加（对应位置）**

```
- 🧠 20+ 大模型接入 - LangChain 原生集成(OpenAI、智谱GLM、Claude、Grok、Gemini、DeepSeek、Kimi、通义千问、MiniMax、Ollama 等),另支持任意 OpenAI 兼容端点
```

- [ ] **Step 4: 提交**

```bash
git add AGENTS.md README.md README_zh.md
git commit -m "docs: document native llm provider registry"
```

---

### Task 7: 验证 gates

- [ ] **Step 1: 后端四 gates（需要 compose DB 跑 e2e）**

```bash
cd backend && pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e
```

Expected: 全绿。lint 带 `--fix`，提交前检查 `git diff`。e2e 需要 `docker compose up -d db`（从仓库根目录）。

- [ ] **Step 2: 前端 gates**

```bash
cd frontend && npm run build && npm run lint && npm run check:i18n
```

Expected: 全绿。lint 带 `--fix`，提交前检查 `git diff`。

- [ ] **Step 3: 若 lint 改动了文件，提交**

```bash
git add -A && git commit -m "style: apply lint fixes for provider registry"
```

（若无改动则跳过，不要提交空提交。）

- [ ] **Step 4: 汇报实际执行结果**

逐条报告每个命令的实际退出状态与关键输出；明确列出跳过或失败的部分。不得声称未运行的命令通过。

---

## Self-Review 记录

- **Spec coverage**：协议表（Task 2/4）、getChatModel 路由（Task 3）、13 新供应商+5 切换（Task 4）、图标 letterIcon（Task 4）、i18n（Task 5）、依赖（Task 1）、AGENTS/README（Task 6）、四 gates（Task 7）——spec 各节均有对应任务。
- **Placeholder scan**：无 TBD/TODO；所有代码步骤含完整代码。
- **Type consistency**：`CHAT_MODEL_FACTORIES`（Task 2 定义 / Task 3 消费）、`ChatModelFactory`、`supplier.protocol ?? 1`（Task 4）前后一致；protocol/supplier 两套 id 序列已在开头区分。
