// workspace-snake-mapper. The frontend reads
// workspace + user-workspace-binding rows as snake_case. Three shapes:
//   - `toWorkspaceSnake`: route 1 (list) + route 2 (detail) — `{id, name,
//     description, create_time}` + optional `member_count` (harmless extra;
//     AuthorizedWorkspaceDraw.vue:249-251 has a fallback chain but the column
//     is `v-if="false"`, so member_count is never rendered — kept only for
//     completeness with the existing `findAll` `_count` include).
//   - `toUwsItemSnake`: route 6 (uwsPager) — unified flattened user shape
//     `{id (=user.id, NOT binding id — frontend workspace/index.vue:182 uses
//     row.id as the uid in uwsDelete), name, account, status, email, weight,
//     create_time}`. The service produces this shape for BOTH the with-oid
//     case (UserWs row + nested user, weight from binding) and the without-oid
//     case (User row, weight = max binding weight).
//   - `toUserSnake`: route 7 (uwsOptionPager — users NOT in workspace) +
//     route 8 (uwsOption single — find-user-by-keyword lookup). Shape
//     `{id, name, account, status, email, create_time}` (no weight — these
//     users have no binding to the target workspace).
//
// Name fallback: User.name is nullable; the frontend's user.service
// getInfo already falls back name→account. We mirror that here so workspace
// views show account when name is null (consistency across admin pages).

const ISO = (d: Date): string => d.toISOString();

export interface WorkspaceRow {
  id: number;
  name: string;
  description?: string | null;
  archivedAt?: Date | null;
  createdAt: Date;
  _count?: { users: number };
}

export interface WorkspaceSnake {
  id: number;
  name: string;
  description: string | null;
  create_time: string;
  archived_at: string | null;
  member_count?: number;
}

/** Route 1 (list) + route 2 (detail). `member_count` is included only when
 *  the row carries `_count.users` (the existing findAll include); the
 *  frontend tolerates its absence (falls back to 0, never displays). */
export function toWorkspaceSnake(row: WorkspaceRow): WorkspaceSnake {
  const snake: WorkspaceSnake = {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    create_time: ISO(row.createdAt),
    // NULL = active. The archive page renders this timestamp; the normal
    // workspace list never includes archived rows.
    archived_at: row.archivedAt ? ISO(row.archivedAt) : null,
  };
  if (row._count !== undefined) {
    snake.member_count = row._count.users;
  }
  return snake;
}

/** Unified uwsPager item shape produced by the service for both oid cases.
 *  `id` is the USER id (flattened from UserWs.user.id or User.id); the
 *  frontend uses `row.id` as the uid in uwsDelete (workspace/index.vue:182,
 *  member/index.vue:87). */
export interface UwsItem {
  id: number;
  name: string | null;
  account: string;
  status: number;
  email?: string | null;
  weight: number;
  createdAt: Date;
}

export interface UwsItemSnake {
  id: number;
  name: string;
  account: string;
  status: number;
  email: string | null;
  weight: number;
  create_time: string;
}

/** Route 6 (uwsPager) — unified shape for with-oid (binding weight) and
 *  without-oid (max binding weight) cases. §85: name falls back to account. */
export function toUwsItemSnake(item: UwsItem): UwsItemSnake {
  return {
    id: item.id,
    name: item.name ?? item.account,
    account: item.account,
    status: item.status,
    email: item.email ?? null,
    weight: item.weight,
    create_time: ISO(item.createdAt),
  };
}

export interface UserRow {
  id: number;
  account: string;
  name: string | null;
  email?: string | null;
  status: number;
  createdAt: Date;
}

export interface UserSnake {
  id: number;
  name: string;
  account: string;
  status: number;
  email: string | null;
  create_time: string;
}

/** Route 7 (uwsOptionPager — users NOT in workspace) + route 8 (uwsOption
 *  single — find by keyword). No weight (no binding to target workspace).
 *  §85: name falls back to account. */
export function toUserSnake(user: UserRow): UserSnake {
  return {
    id: user.id,
    name: user.name ?? user.account,
    account: user.account,
    status: user.status,
    email: user.email ?? null,
    create_time: ISO(user.createdAt),
  };
}
