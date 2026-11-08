// EmbeddingService — turns text into vectors for the RAG recall paths.
// Provider is config-selected:
//   - "openai" (default): @langchain/openai's OpenAIEmbeddings against an
//     OpenAI-compatible endpoint (apiDomain/baseURL overrides the host, so
//     Azure/DeepSeek/Tongyi-compatible gateways work too).
//   - "local": @xenova/transformers feature-extraction pipeline, lazy-loaded
//     (dynamic import) so it never burdens startup or the no-key path.
//
// When no API key is configured (openai provider), `available` is false and
// `embed`/`embedBatch` throw — callers catch and skip vector indexing, so
// recall degrades to ILIKE only. The app never crashes on a missing key.
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

type EmbeddingProvider = 'openai' | 'local';

// Minimal shape of a transformers.js feature-extraction pipeline callable.
// The real type is heavy/optional; we cast to this to stay strict-TS clean.
interface FeaturePipe {
  (
    text: string,
    options: { pooling: 'mean'; normalize: true },
  ): Promise<{ data: Float32Array }>;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly provider: EmbeddingProvider;
  private readonly apiKey: string;
  private readonly apiDomain: string;
  private readonly model: string;
  private readonly localModel: string;
  private openaiClient: OpenAIEmbeddings | null = null;
  private localPipe: FeaturePipe | null = null;

  constructor(private readonly config: ConfigService) {
    this.provider = (this.config.get<string>('embedding.provider') ??
      'openai') as EmbeddingProvider;
    this.apiKey = this.config.get<string>('embedding.apiKey') ?? '';
    this.apiDomain = this.config.get<string>('embedding.apiDomain') ?? '';
    this.model =
      this.config.get<string>('embedding.model') ?? 'text-embedding-3-small';
    this.localModel =
      this.config.get<string>('embedding.localModel') ??
      'Xenova/all-MiniLM-L6-v2';
  }

  /** Whether embedding is usable (openai needs a key; local downloads on use). */
  get available(): boolean {
    if (this.provider === 'local') return true;
    return this.apiKey.length > 0;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.available) {
      throw new Error('Embedding service not configured (missing API key)');
    }
    if (this.provider === 'local') return this.embedLocal(text);
    return this.getOpenAIClient().embedQuery(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!this.available) {
      throw new Error('Embedding service not configured (missing API key)');
    }
    if (texts.length === 0) return [];
    if (this.provider === 'local') {
      // transformers.js has no clean batch API; embed one-at-a-time (backfill
      // runs in the background, so latency is acceptable here).
      return Promise.all(texts.map((t) => this.embedLocal(t)));
    }
    return this.getOpenAIClient().embedDocuments(texts);
  }

  private getOpenAIClient(): OpenAIEmbeddings {
    if (this.openaiClient) return this.openaiClient;
    this.openaiClient = new OpenAIEmbeddings({
      apiKey: this.apiKey,
      model: this.model,
      configuration: this.apiDomain ? { baseURL: this.apiDomain } : undefined,
    });
    this.logger.log(`OpenAI-compatible embeddings: model=${this.model}`);
    return this.openaiClient;
  }

  private async embedLocal(text: string): Promise<number[]> {
    const pipe = await this.getLocalPipe();
    const out = await pipe(text, { pooling: 'mean', normalize: true });
    return Array.from(out.data);
  }

  private async getLocalPipe(): Promise<FeaturePipe> {
    if (this.localPipe) return this.localPipe;
    // Lazy-load so the (heavy) transformers dependency only loads when the
    // local provider is actually used.
    const { pipeline } = await import('@xenova/transformers');
    this.localPipe = (await pipeline('feature-extraction', this.localModel, {
      quantized: true,
    })) as unknown as FeaturePipe;
    this.logger.log(`Local embeddings loaded: ${this.localModel}`);
    return this.localPipe;
  }
}
