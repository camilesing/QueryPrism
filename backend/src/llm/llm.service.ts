// LlmService — the chat-model factory + streaming + reasoning extraction.
// Self-contained (mirrors EmbeddingService): it queries the AiModel table
// directly and AES-decrypts the apiKey, rather than depending on
// AiModelService. That keeps AiModelModule → LlmModule a one-way dependency
// (AiModelService.testStatus calls back into here for a real connectivity
// probe).
//
// Supplier routing: everything routes through the OpenAI-compatible base_url
// (openai/tongyi/vllm/ollama/deepseek/qwen… all accept it); only
// protocol='azure' switches to AzureChatOpenAI. Reasoning is surfaced two
// ways — DeepSeek-style  think…/think  tags interleaved in `content`
// (split by ReasoningParser) and Qwen-style `reasoning_content` in
// additional_kwargs (read directly).
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { AiModel } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { decrypt } from '../common/utils/aes';
import { ReasoningParser } from './reasoning';
import { tr } from '../common/i18n/translate';

/** P2-5: reserved id for the env-config fallback model row fabricated in
 *  resolveModel() — autoincrement ids start at 1, so 0 can never collide
 *  with a stored AiModel. */
export const ENV_FALLBACK_MODEL_ID = 0;

/** A single streamed token group: visible content + reasoning (either may be
 *  empty for a given chunk). `usage` is set on the final chunk when
 *  the provider emits LangChain's `usage_metadata` (DeepSeek/OpenAI attach it
 *  to the last AIMessageChunk); camelCase to match the ChatLog column + the
 *  getRecordUsage reader (deliberately NOT snake_case). */
export interface LlmStreamChunk {
  content: string;
  reasoning: string;
  usage?: TokenUsage;
}

/** Token-usage snapshot in QueryPrism's camelCase shape (the
 *  ChatLog.tokenUsage JSONB column + getRecordUsage reader both use this). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Minimal structural view of a chat model the service can stream from.
 *  ChatOpenAI / AzureChatOpenAI satisfy it (their `.stream()` returns an
 *  async-iterable ReadableStream); tests can pass a fake async iterable. */
export interface ChatLike {
  stream(
    messages: BaseMessage[] | unknown[],
  ): Promise<AsyncIterable<ChatChunk>>;
}

/** Minimal structural view of a streamed chunk. */
export interface ChatChunk {
  content: string | object | unknown[];
  additional_kwargs?: Record<string, unknown>;
  /** LangChain's AIMessageChunk.usage_metadata (final chunk only). */
  usage_metadata?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface ResolvedModel {
  model: AiModel;
  chat: ChatLike;
}

/** Coerce a chunk's content to a plain string (text models send a string;
 *  multimodal sends an array of blocks — we only forward text here). */
function contentToString(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** Cheap sync hint: is the env-config default key present? For a definitive
   *  DB-backed check (including workspace-mapped models) use resolveModel(). */
  get available(): boolean {
    return Boolean(this.config.get<string>('llm.apiKey'));
  }

  private aesKey(): string {
    // P2-5: a missing key used to flow into decrypt() → deriveKey() and die
    // with an opaque crypto error — fail HERE with the actionable message.
    const key = this.config.get<string>('aes.key');
    if (!key) {
      throw new Error(tr('llm.aes_key_missing'));
    }
    return key;
  }

  /** Build a chat model from a stored AiModel row. Decrypts the apiKey and
   *  routes azure → AzureChatOpenAI, everything else → ChatOpenAI with an
   *  OpenAI-compatible base_url. */
  getChatModel(model: AiModel, apiKey: string): ChatLike {
    const modelName = model.baseModel || model.name;
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

  /** Resolve a usable model: by id → by default flag → env-config default.
   *  Returns null when no model + no apiKey is available (callers degrade
   *  gracefully). */
  async resolveModel(modelId?: number): Promise<ResolvedModel | null> {
    let row: AiModel | null = null;
    if (modelId) {
      row = await this.prisma.aiModel.findUnique({ where: { id: modelId } });
    }
    if (!row) {
      row = await this.prisma.aiModel.findFirst({
        where: { defaultModel: true },
      });
    }
    if (row && row.apiKey) {
      const apiKey = decrypt(row.apiKey, this.aesKey());
      if (apiKey) return { model: row, chat: this.getChatModel(row, apiKey) };
    }
    // Fall back to the env-config default model (no DB row needed).
    const envKey = this.config.get<string>('llm.apiKey') ?? '';
    if (envKey) {
      const domain = this.config.get<string>('llm.apiDomain') ?? '';
      const name = this.config.get<string>('llm.defaultModel') || 'gpt-4o-mini';
      // P2-5: id 0 is the RESERVED id for this env-fallback row — autoincrement
      // ids start at 1, so 0 can never collide with a stored AiModel. It is
      // an explicit sentinel now, not an accidental fabrication.
      const fake: AiModel = {
        id: ENV_FALLBACK_MODEL_ID,
        supplier: this.config.get<string>('llm.defaultSupplier') ?? 'openai',
        name,
        modelType: 'llm',
        baseModel: name,
        defaultModel: true,
        apiKey: envKey,
        apiDomain: domain || null,
        protocol: 'openai',
        config: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      return { model: fake, chat: this.getChatModel(fake, envKey) };
    }
    return null;
  }

  /** Core streaming + reasoning extraction. Iterates the chat model's stream,
   *  forwards Qwen reasoning_content directly, and runs DeepSeek-style
   *  content tags through the ReasoningParser. Public so callers (and tests)
   *  can supply a pre-built / fake chat. */
  async *streamWith(
    chat: ChatLike,
    messages: BaseMessage[] | unknown[],
  ): AsyncGenerator<LlmStreamChunk> {
    const parser = new ReasoningParser();
    const stream = await chat.stream(messages);
    for await (const chunk of stream) {
      const reasoning = chunk.additional_kwargs?.reasoning_content;
      if (typeof reasoning === 'string' && reasoning) {
        yield { content: '', reasoning };
      }
      const content = contentToString(chunk.content);
      if (content) {
        const r = parser.feed(content);
        if (r.contentDelta) yield { content: r.contentDelta, reasoning: '' };
        if (r.reasoningDelta)
          yield { content: '', reasoning: r.reasoningDelta };
      }
      // Providers attach usage_metadata to the final AIMessageChunk
      // (LangChain standard). Map snake_case → camelCase (ChatLog column shape).
      // Some providers omit total_tokens — derive it instead of logging 0.
      if (chunk.usage_metadata) {
        const promptTokens = chunk.usage_metadata.input_tokens ?? 0;
        const completionTokens = chunk.usage_metadata.output_tokens ?? 0;
        yield {
          content: '',
          reasoning: '',
          usage: {
            promptTokens,
            completionTokens,
            totalTokens:
              chunk.usage_metadata.total_tokens ??
              promptTokens + completionTokens,
          },
        };
      }
    }
    const f = parser.flush();
    if (f.contentDelta || f.reasoningDelta) {
      yield { content: f.contentDelta, reasoning: f.reasoningDelta };
    }
  }

  /** Stream a chat completion from the resolved model. Throws if no model is
   *  configured. */
  async *stream(
    messages: BaseMessage[] | unknown[],
    modelId?: number,
  ): AsyncGenerator<LlmStreamChunk> {
    const resolved = await this.resolveModel(modelId);
    if (!resolved) {
      throw new Error(tr('llm.model_no_apikey'));
    }
    yield* this.streamWith(resolved.chat, messages);
  }

  /** Non-streaming convenience: aggregate a stream into final content +
   *  reasoning. */
  async chat(
    messages: BaseMessage[] | unknown[],
    modelId?: number,
  ): Promise<{ content: string; reasoning: string }> {
    let content = '';
    let reasoning = '';
    for await (const c of this.stream(messages, modelId)) {
      content += c.content;
      reasoning += c.reasoning;
    }
    return { content, reasoning };
  }

  /** One-token connectivity probe for AiModelService.testStatus. Never throws
   *  — degrades to {success:false, message}. */
  async testConnection(
    modelId?: number,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const resolved = await this.resolveModel(modelId);
      if (!resolved) {
        return {
          success: false,
          message: tr('llm.model_no_apikey'),
        };
      }
      const stream = await resolved.chat.stream([new HumanMessage('ping')]);
      // Just confirm the model produces at least one chunk; we don't need its
      // content. The chat contract returns an async iterable (LangChain's
      // ReadableStream or a fake async iterable in tests).
      let responded = false;
      for await (const chunk of stream) {
        responded = chunk !== undefined;
        break;
      }
      return responded
        ? { success: true, message: tr('llm.connection_ok') }
        : { success: false, message: tr('llm.model_empty_response') };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`LLM connectivity test failed: ${message}`);
      return { success: false, message };
    }
  }
}
