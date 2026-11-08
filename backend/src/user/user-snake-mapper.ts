// user-snake-mapper. The frontend (User.vue) reads the
// mgmt-page user as snake_case: `create_time`/`update_time` ISO strings,
// `oid_list` (the multi-workspace membership array, derived from the UserWs
// join — there is no `oid_list` column), Int `status`/`origin`, and
// `system_variables` (a Json blob of variable overrides whose inner shape
// {variableId, variableValues, variableValue} must pass through verbatim — a
// global camelToSnake interceptor would mangle those keys). Applied in the
// controller, not the service, so existing service specs stay green.
//
// `name` is passed through as-is (null for legacy rows); the /user/info auth
// shape applies the `name ?? account` fallback separately (UserService.getInfo).
import type { User } from '@prisma/client';

export interface UserSnake {
  id: number;
  account: string;
  name: string | null;
  email: string | null;
  oid: number;
  oid_list: number[];
  status: number;
  origin: number;
  language: string;
  system_variables: unknown;
  create_time: string;
  update_time: string;
}

/** Prisma User with the userWorkspaces relation included — the shape the
 *  controller asks the service to findMany with, so the mapper can derive
 *  oid_list. */
export type UserWithWorkspaces = User & { userWorkspaces: { oid: number }[] };

const ISO = (d: Date): string => d.toISOString();

/** Map a User (with userWorkspaces) to the frontend's snake_case shape. */
export function toUserSnake(u: UserWithWorkspaces): UserSnake {
  return {
    id: u.id,
    account: u.account,
    name: u.name,
    email: u.email,
    oid: u.oid,
    oid_list: u.userWorkspaces.map((uw) => uw.oid),
    status: u.status,
    origin: u.origin,
    language: u.language,
    system_variables: u.systemVariables,
    create_time: ISO(u.createdAt),
    update_time: ISO(u.updatedAt),
  };
}
