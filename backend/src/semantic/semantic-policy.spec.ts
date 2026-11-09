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
