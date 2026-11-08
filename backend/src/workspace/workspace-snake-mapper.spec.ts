import {
  toWorkspaceSnake,
  toUwsItemSnake,
  toUserSnake,
} from './workspace-snake-mapper';

describe('workspace-snake-mapper (§101 cycle 3)', () => {
  describe('toWorkspaceSnake', () => {
    it('maps id/name/description + create_time', () => {
      const row = {
        id: 5,
        name: 'Sales',
        description: 'Sales team workspace',
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      };
      const snake = toWorkspaceSnake(row);
      expect(snake.id).toBe(5);
      expect(snake.name).toBe('Sales');
      expect(snake.description).toBe('Sales team workspace');
      expect(snake.create_time).toBe('2026-01-02T03:04:05.000Z');
      expect(snake).not.toHaveProperty('member_count');
    });

    it('coerces null description to null (not undefined)', () => {
      const row = {
        id: 1,
        name: 'default',
        description: null,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      };
      expect(toWorkspaceSnake(row).description).toBeNull();
    });

    it('includes member_count when _count.users present (harmless extra)', () => {
      const row = {
        id: 2,
        name: 'Eng',
        description: null,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
        _count: { users: 7 },
      };
      const snake = toWorkspaceSnake(row);
      expect(snake.member_count).toBe(7);
    });

    it('omits member_count when _count absent', () => {
      const row = {
        id: 2,
        name: 'Eng',
        description: null,
        createdAt: new Date('2026-01-02T03:04:05.000Z'),
      };
      expect(toWorkspaceSnake(row)).not.toHaveProperty('member_count');
    });
  });

  describe('toUwsItemSnake (route 6 — unified user+weight, both oid cases)', () => {
    it('flattens id (=user id) + name/account/status/email/weight/create_time', () => {
      const item = {
        id: 42, // user id (frontend uses row.id as uid in uwsDelete)
        name: 'Alice',
        account: 'alice',
        status: 1,
        email: 'alice@x.io',
        weight: 1, // admin binding
        createdAt: new Date('2026-03-04T05:06:07.000Z'),
      };
      const snake = toUwsItemSnake(item);
      expect(snake.id).toBe(42);
      expect(snake.name).toBe('Alice');
      expect(snake.account).toBe('alice');
      expect(snake.status).toBe(1);
      expect(snake.email).toBe('alice@x.io');
      expect(snake.weight).toBe(1);
      expect(snake.create_time).toBe('2026-03-04T05:06:07.000Z');
    });

    it('falls back name → account when name null (§85 user.name fallback)', () => {
      const item = {
        id: 9,
        name: null,
        account: 'bob',
        status: 0,
        email: null,
        weight: 0,
        createdAt: new Date('2026-03-04T05:06:07.000Z'),
      };
      const snake = toUwsItemSnake(item);
      expect(snake.name).toBe('bob'); // fallback to account
      expect(snake.email).toBeNull();
    });

    it('coerces null email to null (frontend tolerates)', () => {
      const item = {
        id: 1,
        name: 'admin',
        account: 'admin',
        status: 1,
        email: null,
        weight: 1,
        createdAt: new Date('2026-03-04T05:06:07.000Z'),
      };
      expect(toUwsItemSnake(item).email).toBeNull();
    });
  });

  describe('toUserSnake (route 7 option pager + route 8 uwsOption single)', () => {
    it('maps id/name/account/status/email + create_time (no weight)', () => {
      const user = {
        id: 7,
        account: 'carol',
        name: 'Carol',
        email: 'carol@x.io',
        status: 1,
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
      };
      const snake = toUserSnake(user);
      expect(snake.id).toBe(7);
      expect(snake.name).toBe('Carol');
      expect(snake.account).toBe('carol');
      expect(snake.status).toBe(1);
      expect(snake.email).toBe('carol@x.io');
      expect(snake.create_time).toBe('2026-02-03T04:05:06.000Z');
      expect(snake).not.toHaveProperty('weight');
    });

    it('falls back name → account when name null (§85)', () => {
      const user = {
        id: 8,
        account: 'dave',
        name: null,
        email: null,
        status: 0,
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
      };
      expect(toUserSnake(user).name).toBe('dave');
    });

    it('coerces null email to null', () => {
      const user = {
        id: 9,
        account: 'eve',
        name: 'Eve',
        email: null,
        status: 1,
        createdAt: new Date('2026-02-03T04:05:06.000Z'),
      };
      expect(toUserSnake(user).email).toBeNull();
    });
  });
});
