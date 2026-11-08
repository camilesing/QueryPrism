// ai-model-snake-mapper — maps an AiModel row to the
// snake_case shape the frontend reads. Applied in the controller,
// not the service, so existing service specs stay green.
//
// Three contract-specific behaviors:
//   - `api_key` asymmetry: `api_key`/`api_domain` arrive at the
//     backend as PLAINTEXT. The service AES-256-GCM-encrypts
//     `api_key` at rest (`encrypt(plaintext, AES_KEY)`, mirror
//     Assistant.appSecret); `api_domain` is stored PLAINTEXT (never encrypted).
//     `GET /:id` returns the DECRYPTED `api_key` (the admin edit form's
//     API Key field needs plaintext); `GET /` (list) OMITS `api_key` + surfaces
//     `has_api_key` (keys are not leaked in a list). The service pre-
//     decrypts `apiKey` to plaintext for the single GET BEFORE mapping; this
//     mapper is a pure function over the row it receives (no AES here — the
//     aesKey lives on the service, not the mapper).
//   - `supplier`/`model_type`/`protocol` are stored as String (Prisma columns)
//     but the frontend sends + reads them as NUMERIC enum indices (registry
//     ids — `entity/supplier.ts`). The service coerces `String(...)` on write;
//     the mapper coerces to Number on read so the round-trip is `1 → "1" → 1`.
//     Rows written before the snake_case input fix can hold literal
//     "undefined" — toEnum falls back to 0 instead of emitting NaN.
//     LlmService routes by `protocol === 'azure'` only (llm.service.ts:80)
//     — the new frontend's 1/2 enum never reaches 'azure', so the azure branch
//     is dead but harmless.
//   - `config` is a Json blob — passes through verbatim (a global camelToSnake
//     interceptor would mangle its inner keys). `supplier_item` is NOT a
//     backend field — the frontend enriches it client-side via
//     `get_supplier(supplier)` (Model.vue:74), so the backend only emits the
//     numeric `supplier`.
const ISO = (d: Date): string => d.toISOString();

/** Stored enum columns are strings coerced from the frontend's numeric ids.
 *  Rows written through the old camelCase-only input path can hold literal
 *  "undefined"/"null"; Number() would yield NaN (JSON-serialized as null),
 *  blanking the edit form and re-saving "null". Fall back to 0 (llm) so a
 *  legacy row is repaired on its next save. */
const toEnum = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

export interface AiModelRow {
  id: number;
  supplier: string;
  name: string;
  modelType: string;
  baseModel: string | null;
  defaultModel: boolean;
  apiKey: string | null;
  apiDomain: string | null;
  protocol: string;
  config: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Request-body shape the admin frontend POSTs/PUTs (ModelForm.vue): the same
 *  snake_case keys the list/get responses use — `api_key`, `api_domain`,
 *  `base_model`, `model_type`, `config_list`. camelCase spellings are also
 *  accepted so programmatic clients / e2e fixtures keep working. */
export interface AiModelMutateSnake {
  id?: number;
  supplier?: number | string;
  name?: string;
  model_type?: number | string;
  modelType?: number | string;
  base_model?: string;
  baseModel?: string;
  api_key?: string;
  apiKey?: string;
  api_domain?: string;
  apiDomain?: string;
  protocol?: number | string;
  config?: unknown;
  config_list?: unknown;
  status?: string;
}

/** Normalized (camelCase) payload handed to AiModelService. */
export interface AiModelMutate {
  id?: number;
  supplier?: number | string;
  name?: string;
  modelType?: number | string;
  baseModel?: string;
  apiKey?: string;
  apiDomain?: string;
  protocol?: number | string;
  config?: unknown;
  status?: string;
}

/** Normalize an admin request body to the service's camelCase payload.
 *  Before this normalization the frontend's snake_case keys were
 *  silently dropped on write: `api_key` never reached the encrypt path (so
 *  chat failed with "未配置可用的 AI 模型（缺少 apiKey）"), and `base_model`/
 *  `api_domain` were lost too. `config_list` (the form's advanced-parameter
 *  rows) maps onto the Json `config` column; an explicit `config` wins. */
export function fromAiModelSnake(dto: AiModelMutateSnake): AiModelMutate {
  return {
    id: dto.id,
    supplier: dto.supplier,
    name: dto.name,
    modelType: dto.modelType ?? dto.model_type,
    baseModel: dto.baseModel ?? dto.base_model,
    apiKey: dto.apiKey ?? dto.api_key,
    apiDomain: dto.apiDomain ?? dto.api_domain,
    protocol: dto.protocol,
    config: dto.config !== undefined ? dto.config : dto.config_list,
    status: dto.status,
  };
}

export interface AiModelSnake {
  id: number;
  supplier: number;
  name: string;
  model_type: number;
  base_model: string | null;
  default_model: boolean;
  has_api_key: boolean;
  api_domain: string | null;
  protocol: number;
  config: unknown;
  status: string;
  create_time: string;
  update_time: string;
  /** Present only for `GET /:id` (single). The service pre-decrypts the
   *  at-rest ciphertext to plaintext; the mapper just surfaces it. Omitted in
   *  list mode to avoid leaking keys in a list response. */
  api_key?: string;
}

/** Map an AiModel row to the snake_case list/get shape.
 *  - `withApiKey: true` for `GET /:id` (single) — includes the service-pre-
 *    decrypted `api_key` plaintext.
 *  - `withApiKey: false` (default) for `GET /` (list) — omits `api_key`,
 *    surfaces `has_api_key` only. */
export function toAiModelSnake(
  row: AiModelRow,
  opts: { withApiKey?: boolean } = {},
): AiModelSnake {
  const out: AiModelSnake = {
    id: row.id,
    supplier: toEnum(row.supplier),
    name: row.name,
    model_type: toEnum(row.modelType),
    base_model: row.baseModel,
    default_model: row.defaultModel,
    has_api_key: Boolean(row.apiKey),
    api_domain: row.apiDomain,
    protocol: toEnum(row.protocol),
    config: row.config,
    status: row.status,
    create_time: ISO(row.createdAt),
    update_time: ISO(row.updatedAt),
  };
  if (opts.withApiKey) {
    out.api_key = row.apiKey ?? '';
  }
  return out;
}
