// user-snake-mapper tests. The frontend (User.vue) reads the
// mgmt-page user as snake_case — `create_time`, `oid_list` (derived
// from UserWs rows), Int `status`/`origin`, `system_variables` Json blob
// passed through verbatim (a global camelToSnake would mangle its inner
// {variableId, variableValues} keys).
import { toUserSnake } from './user-snake-mapper';

const baseUser = {
  id: 7,
  account: 'alice',
  password: 'x',
  email: 'alice@example.com',
  name: 'Alice Lee' as string | null,
  oid: 1,
  status: 1,
  origin: 0,
  language: 'zh-CN',
  systemVariables: { overrides: [{ variableId: 3, variableValues: [1] }] },
  createdAt: new Date('2026-07-25T10:00:00.000Z'),
  updatedAt: new Date('2026-07-25T11:00:00.000Z'),
};

const withWorkspaces = (
  oids: number[],
  overrides: Partial<typeof baseUser> = {},
) => ({
  ...baseUser,
  ...overrides,
  userWorkspaces: oids.map((oid) => ({ oid })),
});

describe('toUserSnake', () => {
  it('maps scalar fields to snake_case names', () => {
    const u = toUserSnake(withWorkspaces([1, 2]));
    expect(u.id).toBe(7);
    expect(u.account).toBe('alice');
    expect(u.name).toBe('Alice Lee');
    expect(u.email).toBe('alice@example.com');
    expect(u.oid).toBe(1);
    expect(u.status).toBe(1);
    expect(u.origin).toBe(0);
    expect(u.language).toBe('zh-CN');
  });

  it('derives oid_list from userWorkspaces', () => {
    const u = toUserSnake(withWorkspaces([1, 2, 4]));
    expect(u.oid_list).toEqual([1, 2, 4]);
  });

  it('returns ISO strings for create_time + update_time', () => {
    const u = toUserSnake(withWorkspaces([1]));
    expect(u.create_time).toBe('2026-07-25T10:00:00.000Z');
    expect(u.update_time).toBe('2026-07-25T11:00:00.000Z');
  });

  it('passes system_variables through verbatim (no camelToSnake mangling)', () => {
    const u = toUserSnake(withWorkspaces([1]));
    expect(u.system_variables).toEqual({
      overrides: [{ variableId: 3, variableValues: [1] }],
    });
  });

  it('preserves null name (no fallback — getInfo does the fallback, not the mapper)', () => {
    const u = toUserSnake(withWorkspaces([1], { name: null }));
    expect(u.name).toBeNull();
  });

  it('returns oid_list: [] when userWorkspaces is empty', () => {
    const u = toUserSnake({ ...baseUser, userWorkspaces: [] });
    expect(u.oid_list).toEqual([]);
  });
});
