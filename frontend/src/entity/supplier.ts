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
// LangChain native classes (14 reserved for MiniMax — not registered).
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
    // no native class in @langchain/community v1 — stays OpenAI-compatible
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
    // ChatTencentHunyuan needs CAM secretId+secretKey (does not fit the
    // single api_key form) — stays on the OpenAI-compatible endpoint.
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
    // ChatMinimax hardcodes the legacy China endpoint (api.minimax.chat, and
    // requires a groupId) — NOT this international OpenAI-compatible
    // endpoint, so it stays on protocol 1 (native id 14 reserved).
    protocol: 1,
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
        // self-hosted endpoints take user-typed model names (allow-create)
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
