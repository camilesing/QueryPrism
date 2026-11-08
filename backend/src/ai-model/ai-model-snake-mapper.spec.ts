// ai-model-snake-mapper spec — the frontend reads
// the ai-model list/get rows as snake_case:
//   - `api_key`/`api_domain` arrive at the backend as PLAINTEXT (the
//     frontend's `LicenseGenerator.queryprismEncrypt` is an identity stub,
//     returns input unchanged). The service AES-256-GCM-encrypts `api_key` at
//     rest (`encrypt(plaintext, AES_KEY)`, mirror Assistant.appSecret);
//     `api_domain` is stored PLAINTEXT (never encrypted — the existing service
//     never encrypts it).
//   - `GET /:id` returns the DECRYPTED `api_key` (plaintext, for the admin
//     edit form's API Key field). `GET /` (list) OMITS `api_key` + surfaces
//     `has_api_key` — keys are not leaked in a list. The service
//     pre-decrypts `apiKey` to plaintext for the single GET before mapping; the
//     mapper is a pure function over the row it receives.
//   - `supplier`/`model_type`/`protocol` are stored as String (Prisma columns)
//     but the frontend sends + reads them as NUMERIC enum indices (registry
//     ids). The service coerces `String(...)` on write; the mapper coerces
//     `Number(...)` on read so the round-trip is `1 → "1" → 1`. (No seed data
//     exists for AiModel; LlmService routes by `protocol === 'azure'` only,
//     which the new frontend's 1/2 enum never reaches — dead branch, harmless.)
//   - `config` is a Json blob — passes through verbatim (no camelToSnake of
//     inner keys). `supplier_item` is NOT a backend field — the frontend
//     enriches it client-side via `get_supplier(supplier)` (Model.vue:74).
import { fromAiModelSnake, toAiModelSnake } from './ai-model-snake-mapper';

const baseRow = {
  id: 7,
  supplier: '1',
  name: 'qwen-plus',
  modelType: '0',
  baseModel: 'qwen-plus',
  defaultModel: false,
  apiKey: 'enc-deadbeef',
  apiDomain: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  protocol: '1',
  config: { temperature: 0.7, extra_body: { enable_thinking: false } },
  status: 'active',
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
  updatedAt: new Date('2026-07-25T11:00:00.000Z'),
};

describe('toAiModelSnake', () => {
  it('maps scalar fields to snake_case + ISO timestamps (list mode, no api_key)', () => {
    const m = toAiModelSnake(baseRow);
    expect(m.id).toBe(7);
    expect(m.name).toBe('qwen-plus');
    expect(m.base_model).toBe('qwen-plus');
    expect(m.default_model).toBe(false);
    expect(m.api_domain).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    expect(m.status).toBe('active');
    expect(m.create_time).toBe('2026-07-25T10:00:00.000Z');
    expect(m.update_time).toBe('2026-07-25T11:00:00.000Z');
  });

  it('coerces supplier/model_type/protocol from stored string to number', () => {
    const m = toAiModelSnake(baseRow);
    expect(m.supplier).toBe(1);
    expect(m.model_type).toBe(0);
    expect(m.protocol).toBe(1);
    expect(typeof m.supplier).toBe('number');
    expect(typeof m.model_type).toBe('number');
    expect(typeof m.protocol).toBe('number');
  });

  it('falls back to 0 for legacy corrupt enum strings ("undefined"/"null")', () => {
    const m = toAiModelSnake({
      ...baseRow,
      modelType: 'undefined',
      protocol: 'null',
    });
    expect(m.model_type).toBe(0);
    expect(m.protocol).toBe(0);
    expect(Number.isNaN(m.model_type)).toBe(false);
  });

  it('passes config through verbatim (no camelToSnake of inner keys)', () => {
    const m = toAiModelSnake(baseRow);
    expect(m.config).toEqual({
      temperature: 0.7,
      extra_body: { enable_thinking: false },
    });
  });

  it('list mode (default) OMITS api_key + surfaces has_api_key=true', () => {
    const m = toAiModelSnake(baseRow) as unknown as Record<string, unknown>;
    expect(m.has_api_key).toBe(true);
    expect(m.api_key).toBeUndefined();
  });

  it('list mode surfaces has_api_key=false when apiKey is null', () => {
    const m = toAiModelSnake({ ...baseRow, apiKey: null });
    expect(m.has_api_key).toBe(false);
    expect((m as unknown as Record<string, unknown>).api_key).toBeUndefined();
  });

  it('single mode (withApiKey) includes the (service-pre-decrypted) api_key plaintext', () => {
    const m = toAiModelSnake(
      { ...baseRow, apiKey: 'sk-plaintext-from-service' },
      { withApiKey: true },
    );
    expect(m.api_key).toBe('sk-plaintext-from-service');
    expect(m.has_api_key).toBe(true);
  });

  it('single mode returns empty api_key string when the row has no key', () => {
    const m = toAiModelSnake(
      { ...baseRow, apiKey: null },
      { withApiKey: true },
    );
    expect(m.api_key).toBe('');
    expect(m.has_api_key).toBe(false);
  });

  it('exposes default_model (not is_default) — frontend reads model.default_model', () => {
    const m = toAiModelSnake({ ...baseRow, defaultModel: true });
    expect(m.default_model).toBe(true);
    expect(
      (m as unknown as Record<string, unknown>).is_default,
    ).toBeUndefined();
  });
});

describe('fromAiModelSnake', () => {
  it('normalizes the admin form snake_case body to the service camelCase payload', () => {
    const dto = fromAiModelSnake({
      id: 3,
      supplier: 1,
      name: 'deepseek-v4.1-flash',
      model_type: 0,
      base_model: 'deepseek-v4.1-flash',
      api_key: 'sk-live',
      api_domain: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      protocol: 1,
      config_list: [{ key: 'temperature', name: 'temperature', val: 0.7 }],
    });
    expect(dto.modelType).toBe(0);
    expect(dto.baseModel).toBe('deepseek-v4.1-flash');
    expect(dto.apiKey).toBe('sk-live');
    expect(dto.apiDomain).toBe(
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    // config_list (advanced params) lands on the Json config column.
    expect(dto.config).toEqual([
      { key: 'temperature', name: 'temperature', val: 0.7 },
    ]);
  });

  it('still accepts camelCase bodies (programmatic clients / e2e fixtures)', () => {
    const dto = fromAiModelSnake({
      supplier: 1,
      name: 'qwen-plus',
      modelType: 0,
      baseModel: 'qwen-plus',
      apiKey: 'sk-camel',
      apiDomain: 'http://127.0.0.1:39999/v1',
      protocol: 1,
      config: { temperature: 0.7 },
    });
    expect(dto.modelType).toBe(0);
    expect(dto.baseModel).toBe('qwen-plus');
    expect(dto.apiKey).toBe('sk-camel');
    expect(dto.apiDomain).toBe('http://127.0.0.1:39999/v1');
    expect(dto.config).toEqual({ temperature: 0.7 });
  });

  it('prefers an explicit config over config_list', () => {
    const dto = fromAiModelSnake({
      config: { a: 1 },
      config_list: [{ key: 'b', val: 2 }],
    });
    expect(dto.config).toEqual({ a: 1 });
  });
});
