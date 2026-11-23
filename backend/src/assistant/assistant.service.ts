// AssistantService — workspace-scoped (oid) assistant admin CRUD (snake_case
// wire shape) + public embedded-page lookup by appId + dynamic-CORS
// origin source.
//
// Admin surface (reverse-engineered from frontend api/embedded.ts +
// views/system/embedded/iframe.vue): list excludes type==4 (embedded,
// cycle 3), ordered by name+create_time; create generates appId (UUID) +
// AES-encrypted appSecret (plaintext NOT returned for type 0/1 — only the
// type-4 embedded create/rotate returns plaintext, cycle 3); update takes
// id-in-body (frontend PUT sends {id, ...}); remove is oid-scoped
// (ownership). Plain typed body interface (ValidationPipe passthrough, no
// DTO class).
//
// Public surface (findByAppId/getInfo) + dynamic-CORS source
// (listAllowedOrigins/isOriginAllowed) are Phase 8 / Phase 11 —
// PRESERVED here, untouched by cycle 2. main.ts pulls listAllowedOrigins for
// the dynamic CORS origin callback; every admin mutation invalidates the
// 60s cache so a freshly-set domain is picked up on the next preflight.
//
// Json writes use `as unknown as Prisma.InputJsonValue`. `configuration`
// arrives as a JSON STRING (frontend JSON.stringify's it) and is parsed before
// storage; on read the snake-mapper re-stringifies.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type Assistant } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { decrypt, encrypt } from '../common/utils/aes';
import {
  AssistantFileService,
  FILE_FLAGS,
  type FileFlag,
} from './assistant-file.service';
import { tr } from '../common/i18n/translate';

/** Assistant row with the encrypted appSecret stripped — every caller-facing
 *  return uses this shape so the secret never leaves the service except via
 *  the one-time plaintext return on type-4 embedded create/rotate (cycle 3). */
export type SafeAssistant = Omit<Assistant, 'appSecret'>;

/** Public render projection returned by `getInfo` — the embedded page reads
 *  only what it needs to render, with no internal/admin fields leaked. */
export interface AssistantInfo {
  name: string;
  type: number;
  domain: string | null;
  picture: string | null;
  configuration: unknown;
  ui: unknown;
  enableCustomModel: boolean;
}

/** Plain typed body for POST/PUT /system/assistant (ValidationPipe
 *  passthrough; snake_case from frontend). `id` is present on update, absent
 *  on create (frontend deletes id when empty). `name`/`type` are required on
 *  both create and update (frontend always sends them). `configuration` is a
 *  JSON STRING the frontend JSON.stringify'd — service parses it before storage. */
export interface AssistantMutateBody {
  id?: number | string;
  name: string;
  type: number;
  description?: string | null;
  configuration?: string | null;
  domain?: string | null;
  enable_custom_model?: boolean;
  custom_model?: unknown;
  status?: string;
}

/** Plain typed body for POST/PUT /system/embedded (the embedded-
 *  management page, type==4). `name` is required; `id` present on update;
 *  `type` is optional (service forces 4 on create, ignores it on update —
 *  the embedded route is type-4-only by definition). `configuration` is a
 *  JSON STRING (frontend JSON.stringify'd). */
export interface EmbeddedMutateBody {
  id?: number | string;
  name: string;
  domain?: string | null;
  type?: number;
  configuration?: string | null;
  description?: string | null;
  enable_custom_model?: boolean;
  custom_model?: unknown;
}

const ORIGIN_CACHE_TTL_MS = 60_000;

@Injectable()
export class AssistantService {
  private originCache: { value: string[]; expires: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly fileService: AssistantFileService,
  ) {}

  // --- admin (oid-scoped, snake wire shape) ------------------------------

  /** GET /system/assistant — list type!=4 assistants (excludes embedded,
   *  which is the /system/embedded page, cycle 3). Ordered name+create_time.
   *  Returns raw rows; controller maps via snake-mapper. */
  async list(): Promise<Assistant[]> {
    const oid = this.currentOid();
    return this.prisma.assistant.findMany({
      where: { oid, type: { not: 4 } },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** GET /system/assistant/advanced_application — list type==1 (advanced)
   *  only, for the custom-prompt el-option picker. */
  async listAdvancedApplications(): Promise<Assistant[]> {
    const oid = this.currentOid();
    return this.prisma.assistant.findMany({
      where: { oid, type: 1 },
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** POST /system/assistant — create. appId (UUID) + appSecret
   *  (AES-encrypted) are server-generated; plaintext secret is NOT returned
   *  for type 0/1 (only type-4 embedded create/rotate returns it, cycle 3). */
  async create(body: AssistantMutateBody): Promise<Assistant> {
    const oid = this.currentOid();
    const appId = randomUUID();
    const appSecret = encrypt(randomBytes(32).toString('hex'), this.aesKey());

    const data: Prisma.AssistantCreateInput = {
      oid,
      name: body.name,
      type: body.type,
      appId,
      appSecret,
    };
    if (body.description !== undefined) data.description = body.description;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.configuration !== undefined) {
      const parsed = parseJsonString(body.configuration);
      if (parsed !== undefined) data.configuration = parsed;
    }
    if (body.enable_custom_model !== undefined) {
      data.enableCustomModel = body.enable_custom_model;
    }
    if (body.custom_model !== undefined) {
      data.customModel = body.custom_model as Prisma.InputJsonValue;
    }
    if (body.status !== undefined) data.status = body.status;

    const row = await this.prisma.assistant.create({ data });
    this.invalidateOriginCache();
    return row; // raw row; controller maps via snake-mapper (appSecret stripped)
  }

  /** PUT /system/assistant — update. id arrives IN THE BODY (frontend sends
   *  {id, name, ...}, not a path param). Ownership verified via oid scope. */
  async update(body: AssistantMutateBody): Promise<Assistant> {
    if (body.id == null || body.id === '') {
      throw new BadRequestException('id is required');
    }
    const id = Number(body.id);
    await this.findOneOrFail(id); // oid-scoped ownership check
    const data: Prisma.AssistantUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.type !== undefined) data.type = body.type;
    if (body.description !== undefined) data.description = body.description;
    if (body.domain !== undefined) data.domain = body.domain; // null clears
    if (body.configuration !== undefined) {
      const parsed = parseJsonString(body.configuration);
      if (parsed !== undefined) data.configuration = parsed;
    }
    if (body.enable_custom_model !== undefined) {
      data.enableCustomModel = body.enable_custom_model;
    }
    if (body.custom_model !== undefined) {
      data.customModel = body.custom_model as Prisma.InputJsonValue;
    }
    if (body.status !== undefined) data.status = body.status;

    const row = await this.prisma.assistant.update({ where: { id }, data });
    this.invalidateOriginCache();
    return row;
  }

  /** PATCH /system/assistant/ui — merge an AssistantUiSchema (+ optional
   *  logo/float_icon file uploads) into the assistant's `configuration`.
   *  The frontend (SetUi.vue:134) sends multipart `data` (JSON-stringified
   *  schema) + `files` whose originalname is `"<name>,<flag>"`; we route
   *  each file to its flag, validate (.jpg/.jpeg/.png ≤10 MB), persist via
   *  AssistantFileService, and write the returned file_id into
   *  configuration.<flag>.
   *
   *  Clearing semantics: for each flag, if the existing config
   *  already holds a file_id AND the incoming schema does NOT set that flag to
   *  a truthy value (no new upload, no explicit resend), the old file is
   *  deleted + the config field is nulled. Non-file schema attrs (theme,
   *  name, welcome, x_type, …) merge in with null values skipped
   *  (exclude-none semantics). */
  async updateUi(
    uiSchema: Record<string, unknown>,
    files: Express.Multer.File[],
  ): Promise<Assistant> {
    const id = uiSchema.id as number;
    if (id == null) throw new BadRequestException('id is required');
    await this.findOneOrFail(id); // oid-scoped ownership check
    const row = await this.prisma.assistant.findUnique({ where: { id } });
    if (!row)
      throw new NotFoundException(tr('assistant.assistant_not_found', { id }));
    const configObj: Record<string, unknown> =
      (row.configuration as Record<string, unknown> | null) ?? {};

    // exclude_none semantics: drop null/undefined entries so a client that
    // omits an attr doesn't clobber the stored value.
    const uiDict: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(uiSchema)) {
      if (v != null) uiDict[k] = v;
    }

    // Route each uploaded file to its flag.
    for (const file of files) {
      const { flagName } = this.fileService.splitFilenameAndFlag(
        file.originalname,
      );
      if (!FILE_FLAGS.includes(flagName as FileFlag)) {
        throw new BadRequestException(
          tr('assistant.flag_unsupported', { flag: flagName }),
        );
      }
      const flag = flagName as FileFlag;
      this.fileService.checkFile(file);
      // delete the prior file for this flag (if any) before overwriting.
      const oldFileId = configObj[flag];
      if (typeof oldFileId === 'string')
        await this.fileService.delete(oldFileId);
      const fileId = await this.fileService.upload(file);
      configObj[flag] = fileId;
      uiDict[flag] = fileId;
    }

    // Clear flags the client didn't resend.
    for (const flag of FILE_FLAGS) {
      const fileVal = configObj[flag];
      if (typeof fileVal === 'string' && fileVal && !uiDict[flag]) {
        configObj[flag] = null;
        await this.fileService.delete(fileVal);
      }
    }

    // Merge the (non-id, non-dunder) schema attrs into config.
    for (const [attr, value] of Object.entries(uiDict)) {
      if (attr !== 'id' && !attr.startsWith('__')) configObj[attr] = value;
    }

    const updated = await this.prisma.assistant.update({
      where: { id },
      data: {
        configuration: configObj as unknown as Prisma.InputJsonValue,
      },
    });
    this.invalidateOriginCache();
    return updated;
  }

  /** DELETE /system/assistant/:id — oid-scoped delete. */
  async remove(id: number): Promise<{ success: true }> {
    await this.findOneOrFail(id);
    await this.prisma.assistant.delete({ where: { id } });
    this.invalidateOriginCache();
    return { success: true };
  }

  // --- embedded admin (type==4, /system/embedded) ------------------------
  // Implemented purely from the frontend contract (api/embedded.ts + Page.vue
  // R8-R12). app_secret is AES-encrypted at rest and DECRYPTED on read for
  // the list (Page.vue shows plaintext + a copy button). The plaintext is
  // NEVER returned for type 0/1 (cycle 2) — only the type-4 embedded list
  // decrypts.

  /** GET /system/embedded/:pageNum/:pageSize?keyword= → {items, total}.
   *  1-indexed pageNum; keyword is a name-contains filter. */
  async listEmbedded(
    pageNum: number,
    pageSize: number,
    keyword?: string,
  ): Promise<{ items: Assistant[]; total: number }> {
    const oid = this.currentOid();
    const where: Prisma.AssistantWhereInput = { oid, type: 4 };
    if (keyword) where.name = { contains: keyword, mode: 'insensitive' };
    const [items, total] = await Promise.all([
      this.prisma.assistant.findMany({
        where,
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
        orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.assistant.count({ where }),
    ]);
    return { items, total };
  }

  /** POST /system/embedded — create type==4 (forced). Generates appId (UUID)
   *  + AES-encrypted appSecret. Plaintext is NOT returned here — the list
   *  decrypts on read (Page.vue re-fetches). */
  async createEmbedded(body: EmbeddedMutateBody): Promise<Assistant> {
    const oid = this.currentOid();
    const appId = randomUUID();
    const appSecret = encrypt(randomBytes(32).toString('hex'), this.aesKey());
    const data: Prisma.AssistantCreateInput = {
      oid,
      name: body.name,
      type: 4, // forced — embedded module is type-4-only by definition
      appId,
      appSecret,
    };
    if (body.description !== undefined) data.description = body.description;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.configuration !== undefined) {
      const parsed = parseJsonString(body.configuration);
      if (parsed !== undefined) data.configuration = parsed;
    }
    if (body.enable_custom_model !== undefined) {
      data.enableCustomModel = body.enable_custom_model;
    }
    if (body.custom_model !== undefined) {
      data.customModel = body.custom_model as Prisma.InputJsonValue;
    }
    const row = await this.prisma.assistant.create({ data });
    this.invalidateOriginCache();
    return row;
  }

  /** PUT /system/embedded — update. id-in-body, ownership, type immutable
   *  (the embedded route is type-4-only; body.type is ignored). */
  async updateEmbedded(body: EmbeddedMutateBody): Promise<Assistant> {
    if (body.id == null || body.id === '') {
      throw new BadRequestException('id is required');
    }
    const id = Number(body.id);
    await this.findOneOrFail(id);
    const data: Prisma.AssistantUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.description !== undefined) data.description = body.description;
    if (body.domain !== undefined) data.domain = body.domain;
    if (body.configuration !== undefined) {
      const parsed = parseJsonString(body.configuration);
      if (parsed !== undefined) data.configuration = parsed;
    }
    if (body.enable_custom_model !== undefined) {
      data.enableCustomModel = body.enable_custom_model;
    }
    if (body.custom_model !== undefined) {
      data.customModel = body.custom_model as Prisma.InputJsonValue;
    }
    const row = await this.prisma.assistant.update({ where: { id }, data });
    this.invalidateOriginCache();
    return row;
  }

  /** DELETE /system/embedded — batch delete (body = bare JSON array of ids).
   *  oid-scoped deleteMany — only this workspace's assistants are removed. */
  async removeEmbedded(ids: number[]): Promise<{ success: true }> {
    const oid = this.currentOid();
    await this.prisma.assistant.deleteMany({
      where: { id: { in: ids }, oid },
    });
    this.invalidateOriginCache();
    return { success: true };
  }

  /** PATCH /system/embedded/secret/:id — rotate app_secret. Generates a new
   *  plaintext, AES-encrypts + stores. The new value surfaces via the next
   *  list read (decrypt-on-read). */
  async rotateSecret(id: number): Promise<{ success: true }> {
    await this.findOneOrFail(id);
    const newSecret = encrypt(randomBytes(32).toString('hex'), this.aesKey());
    await this.prisma.assistant.update({
      where: { id },
      data: { appSecret: newSecret },
    });
    return { success: true };
  }

  /** Decrypt the AES-at-rest appSecret to plaintext for the list wire shape
   *  (Page.vue shows + copies the real secret). Called per-row by the
   *  controller after `listEmbedded`; implements the frontend contract. */
  decryptAppSecret(ciphertext: string): string {
    return decrypt(ciphertext, this.aesKey());
  }

  // --- public (no oid scope; embedded page lookup by appId) ---------------
  // Preserved from Phase 8.

  async findByAppId(appId: string): Promise<SafeAssistant> {
    const row = await this.prisma.assistant.findFirst({
      where: { appId, status: 'active' },
    });
    if (!row)
      throw new NotFoundException(
        tr('assistant.app_not_found_or_offline', { appId }),
      );
    return stripSecret(row);
  }

  async getInfo(appId: string): Promise<AssistantInfo> {
    const row = await this.findByAppId(appId);
    return {
      name: row.name,
      type: row.type,
      domain: row.domain,
      picture: row.picture,
      configuration: row.configuration,
      ui: row.ui,
      enableCustomModel: row.enableCustomModel,
    };
  }

  /** GET /system/assistant/ds — runtime datasource list for the assistant
   *  token that authorized the request. Type-0
   *  assistants expose their workspace datasources (public_list when not
   *  online); type-1 host-API datasources are not supported here. */
  async listRuntimeDatasources(): Promise<
    Array<{
      id: number;
      name: string;
      description: string | null;
      type: string;
      type_name: string;
      num: string | null;
    }>
  > {
    const assistant = RequestContext.currentAssistant();
    if (!assistant) {
      throw new UnauthorizedException(tr('auth.not_logged_in'));
    }
    if (assistant.type !== 0) return [];

    const config = this.parseConfiguration(assistant.configuration);
    const oid = Number(config.oid);
    if (!Number.isInteger(oid) || oid <= 0) return [];

    const online = assistant.online === true;
    const publicList = Array.isArray(config.public_list)
      ? config.public_list
          .map((id) => Number(id))
          .filter((id) => Number.isInteger(id))
      : [];
    if (!online && publicList.length === 0) return [];

    const rows = await this.prisma.datasource.findMany({
      where: {
        oid,
        ...(online ? {} : { id: { in: publicList } }),
      },
      select: {
        id: true,
        name: true,
        description: true,
        type: true,
        num: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((row) => ({
      ...row,
      type_name: row.type,
    }));
  }

  private parseConfiguration(raw: unknown): Record<string, unknown> {
    if (raw == null) return {};
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    }
    return typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  }

  // --- dynamic CORS source ------------------------------------------------

  /** Distinct non-null `domain` values of active assistants (cached 60s).
   *  main.ts' dynamic CORS origin function consults this to allow embedded
   *  pages' origins beyond the static admin frontend URL. */
  async listAllowedOrigins(): Promise<string[]> {
    const now = Date.now();
    if (this.originCache && this.originCache.expires > now) {
      return this.originCache.value;
    }
    const rows = await this.prisma.assistant.findMany({
      where: { domain: { not: null }, status: 'active' },
      select: { domain: true },
    });
    // domain is a delimited multi-URL string — split into individual origins
    // so each published host is allowed independently.
    const origins = [
      ...new Set(
        rows.flatMap((r) =>
          (r.domain as string)
            .split(/[,;]/)
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ),
    ];
    this.originCache = { value: origins, expires: now + ORIGIN_CACHE_TTL_MS };
    return origins;
  }

  /** True if the given Origin is a published assistant domain. Fails closed
   *  (returns false) on any error so a DB outage never opens CORS. */
  async isOriginAllowed(origin: string): Promise<boolean> {
    try {
      const origins = await this.listAllowedOrigins();
      return origins.includes(origin);
    } catch {
      return false;
    }
  }

  // --- helpers -----------------------------------------------------------

  private invalidateOriginCache(): void {
    this.originCache = null;
  }

  private currentOid(): number {
    const oid = RequestContext.getUser()?.oid;
    if (oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return oid;
  }

  private aesKey(): string {
    const key = this.config.get<string>('aes.key');
    if (!key) throw new Error(tr('assistant.aes_key_missing'));
    return key;
  }

  private async findOneOrFail(id: number): Promise<Assistant> {
    const oid = this.currentOid();
    const row = await this.prisma.assistant.findFirst({
      where: { id, oid },
    });
    if (!row)
      throw new NotFoundException(tr('assistant.assistant_not_found', { id }));
    return row;
  }
}

/** Parse a frontend-supplied JSON STRING into a Prisma.InputJsonValue for
 *  storage. Returns undefined for null/empty so the field is skipped (not
 *  overwritten with null on partial update). Mirrors dashboard's
 *  parseCanvasJson (Json↔string conversion). */
function parseJsonString(
  v: string | null | undefined,
): Prisma.InputJsonValue | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
  return v;
}

/** Strip the encrypted `appSecret` from a row for any caller-facing return
 *  (public path). The admin path returns the raw row and the snake-mapper
 *  strips app_secret from the wire shape. Explicit field-pick so no
 *  lint-unused var or rest-sibling config is needed. */
function stripSecret(row: Assistant): SafeAssistant {
  return {
    id: row.id,
    oid: row.oid,
    name: row.name,
    type: row.type,
    description: row.description,
    domain: row.domain,
    configuration: row.configuration,
    appId: row.appId,
    enableCustomModel: row.enableCustomModel,
    customModel: row.customModel,
    picture: row.picture,
    ui: row.ui,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
