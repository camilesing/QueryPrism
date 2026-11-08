import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModel, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { encrypt, decrypt } from '../common/utils/aes';
import { LlmService } from '../llm/llm.service';
import { CreateAiModelDto } from './dto/create-ai-model.dto';
import { UpdateAiModelDto } from './dto/update-ai-model.dto';
import { tr } from '../common/i18n/translate';

/**
 * AiModel service — Phase 10 §67/§89. Returns RAW AiModel rows (the snake
 * mapping is applied at the controller layer, §77/§88) so the controller can
 * shape list (omit api_key + has_api_key) vs single (§67 decrypted api_key)
 * responses via the same row.
 *
 * - §89: `api_key`/`api_domain` arrive PLAINTEXT.
 *   `create`/`update` AES-256-GCM-encrypt `apiKey` at rest; `apiDomain` is
 *   stored PLAINTEXT (never encrypted).
 * - §67: `query(id)` (GET /:id) returns the row with `apiKey` DECRYPTED to
 *   plaintext — the admin edit form's API Key field needs plaintext.
 * - `supplier`/`modelType`/`protocol` are stored as String but the frontend
 *   sends NUMERIC enum ids; the service coerces `String(...)` on write.
 */
@Injectable()
export class AiModelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly llm: LlmService,
  ) {}

  // ---------------------------------------------------------------- helpers

  private aesKey(): string {
    return this.config.get<string>('aes.key')!;
  }

  /** Fetch a model or throw 404. Returns the raw (encrypted apiKey) row. */
  private async findOne(id: number): Promise<AiModel> {
    const model = await this.prisma.aiModel.findUnique({ where: { id } });
    if (!model) {
      throw new NotFoundException(tr('ai-model.not_found', { id }));
    }
    return model;
  }

  // ---------------------------------------------------------------- queries

  /** 1. GET /system/aimodel — list all (raw rows; apiKey stays encrypted —
   *  the controller's list-mode mapper omits api_key + surfaces has_api_key).
   *  Optional keyword filters by name substring (case-insensitive). */
  async findAll(keyword?: string): Promise<AiModel[]> {
    return this.prisma.aiModel.findMany({
      ...(keyword && keyword.trim()
        ? {
            where: {
              name: { contains: keyword.trim(), mode: 'insensitive' },
            },
          }
        : {}),
      orderBy: [{ defaultModel: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** 6. GET /system/aimodel/default — the currently default model (or null). */
  async findDefault(): Promise<AiModel | null> {
    return this.prisma.aiModel.findFirst({ where: { defaultModel: true } });
  }

  /** 5. GET /system/aimodel/:id — §67: returns the row with apiKey DECRYPTED
   *  to plaintext (for the admin edit form's API Key field). */
  async query(id: number): Promise<AiModel> {
    const row = await this.findOne(id);
    if (row.apiKey) {
      return { ...row, apiKey: decrypt(row.apiKey, this.aesKey()) };
    }
    return row;
  }

  /** 8. GET /system/aimodel/list/by_ws — models bound to a workspace, with
   *  weight. Returns raw mappings `{ id, modelId, oid, weight, model }` (the
   *  mapper flattens + snake-cases). apiKey stays encrypted (list mode). */
  async listByWorkspace(oid: number) {
    return this.prisma.aiModelWorkspaceMapping.findMany({
      where: { oid },
      include: { model: true },
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    });
  }

  // --------------------------------------------------------------- mutations

  /** 2. POST /system/aimodel — create (§89: plaintext apiKey → AES-256-GCM
   *  at rest; numeric supplier/modelType/protocol coerced to String). */
  async create(dto: CreateAiModelDto): Promise<AiModel> {
    const data: Prisma.AiModelCreateInput = {
      supplier: String(dto.supplier),
      name: dto.name,
      modelType: String(dto.modelType),
      protocol: String(dto.protocol),
    };
    if (dto.baseModel !== undefined) data.baseModel = dto.baseModel;
    if (dto.apiKey) data.apiKey = encrypt(dto.apiKey, this.aesKey());
    if (dto.apiDomain !== undefined) data.apiDomain = dto.apiDomain;
    if (dto.config !== undefined) data.config = dto.config;
    if (dto.status !== undefined) data.status = dto.status;
    return this.prisma.aiModel.create({ data });
  }

  /** 3. PUT /system/aimodel (body contains id) — update only the provided
   *  fields (coerce + re-encrypt apiKey if provided). */
  async update(id: number, dto: UpdateAiModelDto): Promise<AiModel> {
    await this.findOne(id);
    const data: Prisma.AiModelUpdateInput = {};
    if (dto.supplier !== undefined) data.supplier = String(dto.supplier);
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.modelType !== undefined) data.modelType = String(dto.modelType);
    if (dto.baseModel !== undefined) data.baseModel = dto.baseModel;
    if (dto.apiKey) data.apiKey = encrypt(dto.apiKey, this.aesKey());
    if (dto.apiDomain !== undefined) data.apiDomain = dto.apiDomain;
    if (dto.protocol !== undefined) data.protocol = String(dto.protocol);
    if (dto.config !== undefined) data.config = dto.config;
    if (dto.status !== undefined) data.status = dto.status;
    return this.prisma.aiModel.update({ where: { id }, data });
  }

  /** 4. DELETE /system/aimodel/:id — delete (cascade drops mappings). */
  async remove(id: number): Promise<{ success: true }> {
    await this.findOne(id);
    await this.prisma.aiModel.delete({ where: { id } });
    return { success: true };
  }

  /** 7. POST /system/aimodel/status (SSE) — real LLM connectivity test. The
   *  controller wraps the result as an SSE stream (§61/§62 frames). findOne
   *  gives a clean 404 for an unknown id; LlmService resolves the model
   *  (decrypt apiKey, route protocol → ChatOpenAI/AzureChatOpenAI) + fires a
   *  1-token ping. */
  async testStatus(id: number): Promise<{ success: boolean; message: string }> {
    await this.findOne(id);
    return this.llm.testConnection(id);
  }

  /** 8b. PUT /system/aimodel/:id/default — atomically set this model default. */
  async setDefault(id: number): Promise<AiModel> {
    await this.findOne(id);
    await this.prisma.$transaction([
      this.prisma.aiModel.updateMany({
        where: { defaultModel: true },
        data: { defaultModel: false },
      }),
      this.prisma.aiModel.update({
        where: { id },
        data: { defaultModel: true },
      }),
    ]);
    return this.prisma.aiModel.findUnique({
      where: { id },
    }) as Promise<AiModel>;
  }

  /** 9. GET /system/aimodel/:aiModelId/ws_mapping — workspaces bound to this
   *  model, as `string[]` of oid. Frontend uses `.includes(`${id}`)` (which is
   *  SameValueZero — would FAIL on a number[] comparing against a string arg)
   *  + `.map(id => `${id}`)`, so we return string elements. §100. */
  async listMappingsByModel(modelId: number): Promise<string[]> {
    const rows = await this.prisma.aiModelWorkspaceMapping.findMany({
      where: { modelId },
      select: { oid: true },
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map((r) => String(r.oid));
  }

  /** 10. POST /system/aimodel/:aiModelId/ws_mapping — bulk-ADD bindings (body
   *  `string[]` of oid). Pre-filter existing oids, and let `skipDuplicates`
   *  absorb a concurrent insert of the same @@unique([modelId, oid]) row. §100. */
  async addMappings(id: number, oids: string[]): Promise<{ success: true }> {
    await this.findOne(id);
    if (oids.length === 0) return { success: true };
    const oidNumbers = oids.map((oid) => Number(oid));
    const existing = await this.prisma.aiModelWorkspaceMapping.findMany({
      where: { modelId: id, oid: { in: oidNumbers } },
      select: { oid: true },
    });
    const existingOids = new Set(existing.map((r) => r.oid));
    const toCreate = oidNumbers.filter((oid) => !existingOids.has(oid));
    if (toCreate.length > 0) {
      await this.prisma.aiModelWorkspaceMapping.createMany({
        data: toCreate.map((oid) => ({ modelId: id, oid, weight: 0 })),
        skipDuplicates: true,
      });
    }
    return { success: true };
  }

  /** 11. PUT /system/aimodel/:aiModelId/ws_mapping — bulk-REPLACE the model's
   *  bindings (body `string[]` of oid). Transaction: wipe existing, then
   *  createMany the new set (no duplicates possible post-wipe). §100. */
  async setMappings(id: number, oids: string[]): Promise<{ success: true }> {
    await this.findOne(id);
    const oidNumbers = oids.map((oid) => Number(oid));
    const ops: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.aiModelWorkspaceMapping.deleteMany({
        where: { modelId: id },
      }),
    ];
    if (oidNumbers.length > 0) {
      ops.push(
        this.prisma.aiModelWorkspaceMapping.createMany({
          data: oidNumbers.map((oid) => ({ modelId: id, oid, weight: 0 })),
        }),
      );
    }
    await this.prisma.$transaction(ops);
    return { success: true };
  }

  /** 12. DELETE /system/aimodel/:aiModelId/ws_mapping — bulk-REMOVE the given
   *  bindings (body `string[]` of oid). Idempotent: deleteMany matches 0 rows
   *  if the binding is already gone. §100. */
  async removeMappings(id: number, oids: string[]): Promise<{ success: true }> {
    await this.prisma.aiModelWorkspaceMapping.deleteMany({
      where: { modelId: id, oid: { in: oids.map(Number) } },
    });
    return { success: true };
  }
}
