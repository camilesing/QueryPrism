# LangChain 原生供应商注册表 — 设计文档

日期：2026-11-14
状态：已确认（方案 A）

## 背景与问题

模型接入页面（`frontend/src/views/system/model/`）的供应商列表硬编码于
`frontend/src/entity/supplier.ts`，仅 12 个供应商，缺少智谱 GLM、Claude、Grok 等。
后端 `LlmService.getChatModel()`（`backend/src/llm/llm.service.ts:108`）是唯一路由点，
除一个 legacy azure 死分支外全部走 `ChatOpenAI` + OpenAI 兼容 baseURL；
`backend/` 只安装了 `@langchain/openai`。

LangChain 框架层已内置大量供应商的原生集成：

- `@langchain/community`（子路径导出）：ChatZhipuAI、ChatMoonshot、ChatMinimax、
  ChatAlibabaTongyi、ChatPerplexity、ChatTogetherAI、ChatDeepInfra、ChatFriendli、
  ChatNovita、ChatTencentHunyuan、ChatIflytekXinghuo、ChatBedrock 等
- 第一方包：anthropic、google-genai、groq、mistralai、ollama、deepseek、xai、
  fireworks、cohere

目标：用框架层原生类接入"框架已支持的所有供应商"，而非逐家手写兼容配置。

## 已确认的决策

1. **范围**：框架全量约 30 个 chat 供应商中，接入凭 `{api_key, api_domain}` 单 key
   表单即可完成鉴权的全部供应商（25 个页面条目，17 种原生 protocol；执行期修订：
   MiniMax 除外，见 protocol 表 14 的说明）。
2. **存量供应商**：LangChain 有原生类的（百炼/Kimi/DeepSeek/Gemini），新建
   模型行走原生类；存量 `AiModel` 行 protocol 仍为 1，继续走原 OpenAI 兼容路径，
   不迁移、不受影响。
3. **实现方案**：方案 A —— 扩展现有双端注册表（前端 `supplier.ts` + 后端新增
   `chat-model-registry.ts`），零 schema 变更。

## Protocol 分配

`AiModel.protocol`（String 列，存数字 id 字符串）继续复用：

| id | 含义 | 路由类 |
|----|------|--------|
| 1 | openai / 兼容端点（现状） | `ChatOpenAI` + baseURL |
| 2 | vllm（现状） | 同上 |
| 3 | zhipuai（智谱 GLM） | `ChatZhipuAI` |
| 4 | anthropic | `ChatAnthropic` |
| 5 | google_genai | `ChatGoogleGenerativeAI` |
| 6 | xai（Grok） | `ChatXAI` |
| 7 | groq | `ChatGroq` |
| 8 | mistral | `ChatMistral` |
| 9 | ollama | `ChatOllama`（无需 key，`is_private` 模式） |
| 10 | deepseek | `ChatDeepSeek` |
| 11 | fireworks | `ChatFireworks` |
| 12 | cohere | `ChatCohere` |
| 13 | moonshot（Kimi） | `ChatMoonshot` |
| 14 | ~~minimax~~（保留） | 不注册 — ChatMinimax 硬编码国内 `api.minimax.chat` 旧端点且强制 groupId，与国际站 `api.minimax.io`（页面现供的 OpenAI 兼容端点）不是同一服务；MiniMax 保留 protocol 1 |
| 15 | tongyi（阿里百炼） | `ChatAlibabaTongyi` |
| 16 | perplexity | `ChatPerplexity` |
| 17 | together | `ChatTogetherAI` |
| 18 | deepinfra | `ChatDeepInfra` |
| 19 | friendli | `ChatFriendli` |
| 20 | novita | `ChatNovita` |

存量行 protocol 为 1/2（或 toEnum 兜底的 0）时行为与现状完全一致。

## 后端设计

新增 `backend/src/llm/chat-model-registry.ts`：

- 导出 `CHAT_MODEL_FACTORIES: Record<string, (model: AiModel, apiKey: string) => ChatLike>`
- 每个工厂 deep-import 原生类（如 `@langchain/community/chat_models/zhipuai`）。
  必须子路径引入：`nest build` 是 tsc 编译（无打包 tree-shake），根入口整包加载
  会拖慢启动。
- 统一参数映射：`model → baseModel || name`；`apiKey → 各类对应的 key 参数`
  （`apiKey` / `apiToken` / 等）；`apiDomain → apiUrl` 或 `baseUrl`（空则用类内置
  默认，非空即自建网关覆盖）；`streaming: true`。
- `LlmService.getChatModel()` 改为查表构建；查表未命中（1/2/0/undefined/legacy
  `'azure'`）保持现行 `ChatOpenAI` / `AzureChatOpenAI` 行为。azure 分支保留不删
  （防老 DB 行）。
- 推理流与 token 统计无需改动：原生类均遵循 LangChain 标准
  （`additional_kwargs.reasoning_content` + `usage_metadata`），`streamWith()`
  现有解析直接覆盖。

### 已知限制（写在 registry 文件头注释）

- **保留 OpenAI 兼容层的三家**：腾讯混元（`ChatTencentHunyuan` 要求 CAM
  secretId+secretKey 双凭证，装不进单 key 表单）、讯飞星火
  （`ChatIflytekXinghuo` 要求 appid+apiKey+apiSecret 三元组）、百度千帆
  （`@langchain/community` v1 已无原生类）。它们现有的兼容端点工作正常，不动。
- **不接入**：Bedrock/VertexAI/watsonx（云角色凭证链/多字段凭证）、
  llama_cpp/webllm（进程内本地模型）、arcjet/portkey/premai（网关包装/附加配置项）。
- 前后端 protocol 枚举仍需人工同步（与现状一致）；接入新供应商 = 双端各登记一行。

## 前端设计

`frontend/src/entity/supplier.ts`：

- 条目类型新增 `protocol: number` 字段；`ModelForm.supplierChang()` 改为直接取
  `supplier.protocol`（替代现在 `type === 'vllm' ? 2 : 1` 的推导，vllm 条目直接
  声明 `protocol: 2`）。
- 存量条目改原生 protocol：百炼→15、Kimi→13、MiniMax→14、DeepSeek→10、Gemini→5。
  OpenAI 保持 1（`ChatOpenAI` 即其原生类）。混元/星火/千帆/腾讯云/火山/通用OpenAI
  保持 1。
- 新增 13 个供应商条目：智谱GLM、Claude(Anthropic)、Grok(xAI)、Groq、Mistral、
  Ollama、Perplexity、Together、Fireworks、Cohere、DeepInfra、Friendli、Novita。
  每条配默认 `api_domain` + 3~6 个当前主力模型（下拉是 `allow-create`，列表仅为
  建议值）。
- 图标：复用现有 `icon_ollama_gray`、`icon_tyqw_colorful`；其余新增条目用新增的
  `letterIcon(text, color)` 帮助函数生成首字母色块 SVG data-URI，零新增二进制素材。
- Ollama 条目标 `is_private: true`（api_key 非必填），默认
  `http://127.0.0.1:11434`。

### 表单语义

- `api_domain` 必填规则不变；原生条目预填各家官方默认域（GLM
  `https://open.bigmodel.cn/api/paas/v4` 等），可改为自建网关地址，工厂映射到
  `apiUrl`/`baseUrl`。

### i18n

- `supplier.*` 13 个新 key 同步加入 `src/i18n/en.json` + `zh-CN.json`，
  跑 `npm run check:i18n` 保证键位对齐。

## 测试与验证

- 新增 `backend/src/llm/chat-model-registry.spec.ts`：每个注册 protocol 实例化出
  正确类；参数映射（model/apiKey/apiDomain）正确；未知 protocol 兜底
  `ChatOpenAI`。
- `llm.service.spec.ts` 既有用例保持绿（getChatModel 对 protocol 1/2 行为不变）。
- 后端四 gates：`pnpm run build && pnpm run lint && pnpm run test && pnpm run test:e2e`。
- 前端：`npm run build`（含 vue-tsc 类型检查）+ `npm run check:i18n`。
- 不新增连通性 e2e（会打真实 LLM）；连通性测试沿用现有 `POST /status` SSE 手工验证。

## 依赖变更

`backend/` 新增（pnpm）：

```
@langchain/community @langchain/anthropic @langchain/google-genai @langchain/groq
@langchain/mistralai @langchain/ollama @langchain/deepseek @langchain/xai
@langchain/fireworks @langchain/cohere
```

均为纯 JS 包（无 native build），不触碰 `pnpm-workspace.yaml` allowBuilds。
版本需与已装 `@langchain/core@^1.2.3` 兼容（均为 1.x 线）。

## 文档同步

- `AGENTS.md` Key Implementation Notes：LLM 路由描述更新为 protocol 注册表。
- `README.md` + `README_zh.md`：模型接入供应商清单双语同步更新。
