// embedded-snake-mapper spec — pure-function mapper coverage for the
// /system/embedded admin wire shape (§100: reverse-engineered from frontend
// api/embedded.ts embeddedApi + views/system/embedded/Page.vue R8).
import type { Assistant } from '@prisma/client';
import { toEmbeddedSnake } from './embedded-snake-mapper';

function row(over: Partial<Assistant> = {}): Assistant {
  return {
    id: 1,
    oid: 1,
    name: 'embedded-app',
    type: 4,
    description: 'an embedded app',
    domain: 'http://embed.example.com,http://alt.example.com',
    configuration: { welcome: 'hi', auto_ds: true },
    appId: 'app-uuid-xyz',
    appSecret: 'encrypted-blob',
    enableCustomModel: false,
    customModel: null,
    picture: null,
    ui: null,
    status: 'active',
    createdAt: new Date('2026-07-26T00:00:00Z'),
    updatedAt: new Date('2026-07-26T02:00:00Z'),
    ...over,
  };
}

describe('toEmbeddedSnake', () => {
  it('emits the 11 snake fields Page.vue reads (incl. plaintext app_secret via opts)', () => {
    const out = toEmbeddedSnake(row(), { appSecretPlain: 'the-real-secret' });
    expect(out).toEqual({
      id: 1,
      name: 'embedded-app',
      app_id: 'app-uuid-xyz',
      app_secret: 'the-real-secret', // plaintext (decrypted by service, passed via opts)
      domain: 'http://embed.example.com,http://alt.example.com',
      type: 4,
      configuration: JSON.stringify({ welcome: 'hi', auto_ds: true }),
      description: 'an embedded app',
      status: 'active',
      create_time: new Date('2026-07-26T00:00:00Z').getTime(),
      update_time: new Date('2026-07-26T02:00:00Z').getTime(),
    });
    // internal fields must not leak
    expect(out).not.toHaveProperty('appSecret');
    expect(out).not.toHaveProperty('oid');
    expect(out).not.toHaveProperty('picture');
    expect(out).not.toHaveProperty('ui');
    expect(out).not.toHaveProperty('enableCustomModel');
  });

  it('emits app_secret=null when no opts (create/update responses — frontend re-fetches list)', () => {
    expect(toEmbeddedSnake(row()).app_secret).toBeNull();
  });

  it('serializes configuration as a JSON STRING (frontend JSON.parse it)', () => {
    const out = toEmbeddedSnake(row({ configuration: { welcome: 'hi' } }));
    expect(typeof out.configuration).toBe('string');
    expect(JSON.parse(out.configuration)).toEqual({ welcome: 'hi' });
  });

  it('emits "{}" for null/undefined configuration so frontend JSON.parse never throws', () => {
    expect(
      JSON.parse(toEmbeddedSnake(row({ configuration: null })).configuration),
    ).toEqual({});
    expect(
      JSON.parse(
        toEmbeddedSnake(row({ configuration: undefined })).configuration,
      ),
    ).toEqual({});
  });

  it('emits domain as the raw delimited string (frontend splits on /[,;]/)', () => {
    expect(toEmbeddedSnake(row({ domain: 'http://a;http://b' })).domain).toBe(
      'http://a;http://b',
    );
    expect(toEmbeddedSnake(row({ domain: null })).domain).toBeNull();
  });

  it('emits create_time/update_time as epoch-ms', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const updated = new Date('2026-03-03T00:00:00Z');
    const out = toEmbeddedSnake(
      row({ createdAt: created, updatedAt: updated }),
    );
    expect(out.create_time).toBe(created.getTime());
    expect(out.update_time).toBe(updated.getTime());
    expect(typeof out.create_time).toBe('number');
  });

  it('emits type as-is (embedded module is type==4; service forces 4 on create)', () => {
    expect(toEmbeddedSnake(row({ type: 4 })).type).toBe(4);
  });
});
