// assistant-snake-mapper spec — pure-function mapper coverage for the
// /system/assistant admin wire shape (§100: reverse-engineered from
// frontend api/embedded.ts + views/system/embedded/iframe.vue).
import type { Assistant } from '@prisma/client';
import {
  toAdvancedApplicationSnake,
  toAssistantSnake,
} from './assistant-snake-mapper';

/** Build a minimal-but-typed Assistant row for mapper tests. */
function row(over: Partial<Assistant> = {}): Assistant {
  return {
    id: 1,
    oid: 1,
    name: 'demo',
    type: 0,
    description: 'a helper',
    domain: 'https://a.example.com,https://b.example.com',
    configuration: { oid: 1, public_list: [1, 2] },
    appId: 'app-uuid-123',
    appSecret: 'encrypted-blob',
    enableCustomModel: false,
    customModel: null,
    picture: null,
    ui: { theme: 'light' },
    status: 'active',
    createdAt: new Date('2026-07-26T00:00:00Z'),
    updatedAt: new Date('2026-07-26T01:00:00Z'),
    ...over,
  };
}

describe('toAssistantSnake', () => {
  it('emits the 12 snake_case fields the iframe.vue list reads', () => {
    const out = toAssistantSnake(row());
    // Frontend reads exactly: id, name, type, description, configuration,
    // domain, enable_custom_model, custom_model (+ create_time/update_time
    // metadata; app_id emitted for parity; status harmless). app_secret MUST
    // be absent (security — encrypted at rest, never leak).
    expect(out).toEqual({
      id: 1,
      name: 'demo',
      type: 0,
      description: 'a helper',
      configuration: JSON.stringify({ oid: 1, public_list: [1, 2] }),
      domain: 'https://a.example.com,https://b.example.com',
      app_id: 'app-uuid-123',
      enable_custom_model: false,
      custom_model: null,
      status: 'active',
      create_time: new Date('2026-07-26T00:00:00Z').getTime(),
      update_time: new Date('2026-07-26T01:00:00Z').getTime(),
    });
    // app_secret must never appear in the wire shape
    expect(out).not.toHaveProperty('app_secret');
    // internal fields must not leak
    expect(out).not.toHaveProperty('oid');
    expect(out).not.toHaveProperty('appSecret');
    expect(out).not.toHaveProperty('picture');
    expect(out).not.toHaveProperty('ui');
  });

  it('serializes configuration as a JSON STRING (frontend JSON.parse it)', () => {
    const cfg = { oid: 7, auto_ds: true, logo: 'file-abc.svg' };
    const out = toAssistantSnake(row({ configuration: cfg }));
    expect(typeof out.configuration).toBe('string');
    // frontend does JSON.parse(res.configuration) and reads .logo
    expect(JSON.parse(out.configuration)).toEqual(cfg);
  });

  it('emits "{}" for null/undefined configuration so frontend JSON.parse never throws', () => {
    expect(
      JSON.parse(toAssistantSnake(row({ configuration: null })).configuration),
    ).toEqual({});
    expect(
      JSON.parse(
        toAssistantSnake(row({ configuration: undefined })).configuration,
      ),
    ).toEqual({});
  });

  it('passes custom_model through verbatim (number id, string id, object)', () => {
    expect(toAssistantSnake(row({ customModel: 5 })).custom_model).toBe(5);
    expect(toAssistantSnake(row({ customModel: 'gpt-4o' })).custom_model).toBe(
      'gpt-4o',
    );
    expect(
      toAssistantSnake(row({ customModel: { model: 'gpt-4o' } })).custom_model,
    ).toEqual({
      model: 'gpt-4o',
    });
    expect(
      toAssistantSnake(row({ customModel: null })).custom_model,
    ).toBeNull();
  });

  it('emits app_id from appId (public identifier, parity; not secret)', () => {
    const out = toAssistantSnake(row({ appId: 'pub-id-xyz' }));
    expect(out.app_id).toBe('pub-id-xyz');
  });

  it('emits enable_custom_model as a JSON boolean', () => {
    expect(
      toAssistantSnake(row({ enableCustomModel: true })).enable_custom_model,
    ).toBe(true);
    expect(
      toAssistantSnake(row({ enableCustomModel: false })).enable_custom_model,
    ).toBe(false);
  });

  it('emits domain as the raw delimited string (frontend splits on /[,;]/)', () => {
    const out = toAssistantSnake(row({ domain: 'http://x.com;http://y.com' }));
    expect(out.domain).toBe('http://x.com;http://y.com');
    expect(toAssistantSnake(row({ domain: null })).domain).toBeNull();
  });

  it('emits create_time/update_time as epoch-ms', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const updated = new Date('2026-02-02T00:00:00Z');
    const out = toAssistantSnake(
      row({ createdAt: created, updatedAt: updated }),
    );
    expect(out.create_time).toBe(created.getTime());
    expect(out.update_time).toBe(updated.getTime());
    expect(typeof out.create_time).toBe('number');
  });
});

describe('toAdvancedApplicationSnake', () => {
  it('emits {id, name} only (frontend el-option :key/:label/:value)', () => {
    const out = toAdvancedApplicationSnake(row({ id: 42, name: 'adv-app' }));
    expect(out).toEqual({ id: 42, name: 'adv-app' });
    // strips everything else
    expect(Object.keys(out).sort()).toEqual(['id', 'name']);
  });
});
