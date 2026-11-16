// Spec for the semantic-layer pure policy: scope authority + resolution
// priority (MetaDataImprove M2).
import {
  ADMIN_UID,
  canEditDirect,
  canReview,
  pickEffectiveRow,
  scopeOwnership,
  type ScopedRow,
} from './semantic-policy';

const member = { id: 7, oid: 1, weight: 0 };
const wsAdmin = { id: 5, oid: 1, weight: 1 };
const sysAdmin = { id: ADMIN_UID, oid: 1, weight: 0 };

describe('canEditDirect', () => {
  it('anyone edits their own PERSONAL layer', () => {
    expect(canEditDirect(member, 'PERSONAL')).toBe(true);
    expect(canEditDirect(wsAdmin, 'PERSONAL')).toBe(true);
  });

  it('WORKSPACE only for workspace admins (system admin included)', () => {
    expect(canEditDirect(member, 'WORKSPACE')).toBe(false);
    expect(canEditDirect(wsAdmin, 'WORKSPACE')).toBe(true);
    expect(canEditDirect(sysAdmin, 'WORKSPACE')).toBe(true);
  });

  it('GLOBAL only for the system admin (uid 1)', () => {
    expect(canEditDirect(member, 'GLOBAL')).toBe(false);
    expect(canEditDirect(wsAdmin, 'GLOBAL')).toBe(false);
    expect(canEditDirect(sysAdmin, 'GLOBAL')).toBe(true);
  });
});

describe('canReview', () => {
  it('WORKSPACE target reviewed by workspace admins', () => {
    expect(canReview(member, 'WORKSPACE')).toBe(false);
    expect(canReview(wsAdmin, 'WORKSPACE')).toBe(true);
  });

  it('GLOBAL target reviewed only by the system admin', () => {
    expect(canReview(wsAdmin, 'GLOBAL')).toBe(false);
    expect(canReview(sysAdmin, 'GLOBAL')).toBe(true);
  });
});

describe('pickEffectiveRow', () => {
  const row = (scope: ScopedRow['scope'], over = {}): ScopedRow => ({
    scope,
    oid: 1,
    ownerUid: null,
    updatedAt: '2026-01-01',
    ...over,
  });

  it('PERSONAL beats WORKSPACE beats GLOBAL', () => {
    const picked = pickEffectiveRow([
      row('GLOBAL'),
      row('WORKSPACE'),
      row('PERSONAL'),
    ]);
    expect(picked?.scope).toBe('PERSONAL');
  });

  it('falls through to the highest existing layer', () => {
    expect(pickEffectiveRow([row('GLOBAL'), row('WORKSPACE')])?.scope).toBe(
      'WORKSPACE',
    );
    expect(pickEffectiveRow([row('GLOBAL')])?.scope).toBe('GLOBAL');
  });

  it('empty input → null', () => {
    expect(pickEffectiveRow([])).toBeNull();
  });
});

describe('scopeOwnership', () => {
  it('PERSONAL pins to the actor workspace + uid', () => {
    expect(scopeOwnership(member, 'PERSONAL')).toEqual({
      scope: 'PERSONAL',
      oid: 1,
      ownerUid: 7,
    });
  });

  it('WORKSPACE pins to the actor workspace, no owner', () => {
    expect(scopeOwnership(member, 'WORKSPACE')).toEqual({
      scope: 'WORKSPACE',
      oid: 1,
      ownerUid: null,
    });
  });

  it('GLOBAL carries no owner fields', () => {
    expect(scopeOwnership(sysAdmin, 'GLOBAL')).toEqual({
      scope: 'GLOBAL',
      oid: null,
      ownerUid: null,
    });
  });
});

// ─────────────── residual branch arms (coverage tail) ──────────────────────

describe('isWorkspaceAdmin without an explicit weight (coverage tail)', () => {
  it('treats a missing weight as 0 (plain member)', () => {
    expect(canEditDirect({ id: 7, oid: 1 }, 'WORKSPACE')).toBe(false);
    expect(canReview({ id: 7, oid: 1 }, 'WORKSPACE')).toBe(false);
    // uid 1 still passes without a weight (system-admin short-circuit)
    expect(canEditDirect({ id: ADMIN_UID, oid: 1 }, 'WORKSPACE')).toBe(true);
  });
});

describe('pickEffectiveRow tie-breaks + unknown scopes (coverage tail)', () => {
  type Row = { scope: string; updatedAt: unknown };

  it('same-scope ties resolve to the newest updatedAt (Date objects)', () => {
    const picked = pickEffectiveRow([
      { scope: 'PERSONAL', updatedAt: new Date('2026-01-01T00:00:00Z') },
      { scope: 'PERSONAL', updatedAt: new Date('2026-02-01T00:00:00Z') },
    ]);
    expect((picked as { updatedAt: Date }).updatedAt.toISOString()).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });

  it('same-scope ties resolve on string timestamps; unusable ones sort last', () => {
    const picked = pickEffectiveRow<Row>([
      { scope: 'PERSONAL', updatedAt: '2026-03-01' },
      { scope: 'PERSONAL', updatedAt: '2026-04-01' },
    ]);
    expect(picked?.updatedAt).toBe('2026-04-01');
    // updatedAt that is neither Date nor string coerces to '' (oldest)
    const weird = pickEffectiveRow<Row>([
      { scope: 'PERSONAL', updatedAt: 42 },
      { scope: 'PERSONAL', updatedAt: '2026-01-01' },
    ]);
    expect(weird?.updatedAt).toBe('2026-01-01');
  });

  it('unknown scopes rank below GLOBAL', () => {
    const picked = pickEffectiveRow<Row>([
      { scope: 'WEIRD', updatedAt: '2026-01-01' },
      { scope: 'GLOBAL', updatedAt: '2026-01-01' },
    ]);
    expect(picked?.scope).toBe('GLOBAL');
  });

  it('two unknown scopes tie-break on updatedAt', () => {
    const picked = pickEffectiveRow<Row>([
      { scope: 'WEIRD_A', updatedAt: '2026-01-01' },
      { scope: 'WEIRD_B', updatedAt: '2026-05-01' },
    ]);
    expect(picked?.scope).toBe('WEIRD_B');
  });
});

describe('scopeOwnership unknown scope (coverage tail)', () => {
  it('returns null for a scope outside the enum', () => {
    expect(scopeOwnership(member, 'bogus' as unknown as 'PERSONAL')).toBeNull();
  });
});
