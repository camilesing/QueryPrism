import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ExcelStoreService } from '../datasource/excel-store.service';
import { decryptFrontendConfig } from '../datasource/frontend-config-crypto';
import { parseStrictInt } from '../common/utils/parse-int';
import { ADMIN_UID } from '../auth/admin.guard';
import type { CurrentUserInfo } from '../common/context/request-context';
import type { UwsItem, UserRow } from './workspace-snake-mapper';
import { tr } from '../common/i18n/translate';

/**
 * Workspace service.
 *
 * Workspaces have three lifecycle states: active, archived (soft-deleted) and
 * permanently removed. Archiving hides the workspace from non-admins but keeps
 * every business row and membership intact; only the system admin can restore
 * it or delete it permanently.
 *
 * Role model:
 *  - uid 1 = system admin: manages workspaces, archive, member roles, and may
 *    enter any workspace (including archived ones).
 *  - UserWs.weight != 0 = workspace admin: manages the CURRENT workspace's
 *    members (ordinary members only) and resources.
 *  - UserWs.weight == 0 = ordinary member.
 *
 * The uws routes stay polymorphic by `oid` presence for compatibility, but a
 * non-admin can only ever target the current workspace; the "system-wide"
 * semantics (no oid) are reserved for the system admin.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excelStore: ExcelStoreService,
  ) {}

  // ─── workspace CRUD/lifecycle ──────────────────────────────────────────

  /** Active workspaces only (the normal admin page / dropdowns). */
  findAll() {
    return this.prisma.workspace.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { users: true } } },
    });
  }

  /** Archived workspaces (the admin-only archive page). */
  findArchived() {
    return this.prisma.workspace.findMany({
      where: { archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      include: { _count: { select: { users: true } } },
    });
  }

  async findOne(id: number) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id },
      include: { _count: { select: { users: true } } },
    });
    if (!workspace) {
      throw new NotFoundException(tr('workspace.not_found', { id }));
    }
    return workspace;
  }

  async create(dto: { name: string; description?: string | null }) {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException(tr('workspace.name_required'));
    }
    try {
      return await this.prisma.workspace.create({
        data: {
          name,
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
        },
        include: { _count: { select: { users: true } } },
      });
    } catch (e) {
      this.rethrowDuplicateName(e);
    }
  }

  /** Review P1-1: the existence check and the write run in ONE interactive
   *  $transaction — the old check-then-act pair raced with concurrent
   *  deletes (check passed → update hit a missing row → opaque 500). */
  async update(dto: {
    id: number;
    name?: string;
    description?: string | null;
  }) {
    if (dto.name !== undefined && !dto.name.trim()) {
      throw new BadRequestException(tr('workspace.name_required'));
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.findUnique({
          where: { id: dto.id },
          include: { _count: { select: { users: true } } },
        });
        if (!workspace) {
          throw new NotFoundException(
            tr('workspace.not_found', { id: dto.id }),
          );
        }
        return tx.workspace.update({
          where: { id: dto.id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.description !== undefined
              ? { description: dto.description }
              : {}),
          },
          include: { _count: { select: { users: true } } },
        });
      });
    } catch (e) {
      this.rethrowDuplicateName(e);
    }
  }

  /** Soft delete: keep all data + memberships, hide from non-admins, and move
   *  every user whose current workspace is this one to another active
   *  workspace (or 0 when they have none left). */
  async archive(id: number): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id } });
      if (!workspace) {
        throw new NotFoundException(tr('workspace.not_found', { id }));
      }
      if (id === 1) {
        throw new BadRequestException(tr('workspace.default_not_deletable'));
      }
      if (workspace.archivedAt != null) {
        throw new BadRequestException(tr('workspace.ws_archived'));
      }
      await tx.workspace.update({
        where: { id },
        data: { archivedAt: new Date() },
      });
      await this.resetUsersInWorkspace(tx, id);
    });
    return { success: true };
  }

  async restore(id: number): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id } });
      if (!workspace) {
        throw new NotFoundException(tr('workspace.not_found', { id }));
      }
      if (workspace.archivedAt == null) {
        throw new BadRequestException(tr('workspace.not_archived'));
      }
      await tx.workspace.update({
        where: { id },
        data: { archivedAt: null },
      });
      // Re-enable members who lost their current workspace while archived:
      // their oid was reset to 0, so they could not log in. Give them this
      // restored workspace as their current one.
      await tx.user.updateMany({
        where: {
          oid: 0,
          userWorkspaces: { some: { oid: id } },
        },
        data: { oid: id },
      });
    });
    return { success: true };
  }

  /** Hard delete, only from the archive (two-step safety). Removes every
   *  workspace-scoped business row; audit logs are retained with oid = null
   *  so the global audit trail is not destroyed. The excel datasources'
   *  physical tables (shared excel_store schema) are dropped after the row
   *  transaction commits — the bulk deleteMany bypasses
   *  DatasourceService.remove(), which normally drops them. */
  async permanentRemove(id: number): Promise<{ success: true }> {
    const excelSheets = await this.collectExcelSheets(id);
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({ where: { id } });
      if (!workspace) {
        throw new NotFoundException(tr('workspace.not_found', { id }));
      }
      if (id === 1) {
        throw new BadRequestException(tr('workspace.default_not_deletable'));
      }
      if (workspace.archivedAt == null) {
        throw new BadRequestException(tr('workspace.archive_before_delete'));
      }

      // Users still pointing at the archived workspace (normally only the
      // system admin inspecting it) go back to the default workspace.
      await this.resetUsersInWorkspace(tx, id);

      await tx.chat.deleteMany({ where: { oid: id } }); // cascades records + logs
      await tx.chatRecord.deleteMany({ where: { oid: id } }); // orphan safety
      await tx.datasource.deleteMany({ where: { oid: id } }); // cascades tables/fields/recommended
      await tx.dataTraining.deleteMany({ where: { oid: id } });
      await tx.coreDashboard.deleteMany({ where: { oid: id } });
      await tx.assistant.deleteMany({ where: { oid: id } });
      await tx.mcpIntegration.deleteMany({ where: { oid: id } });
      await tx.customPrompt.deleteMany({ where: { oid: id } });
      await tx.dsRules.deleteMany({ where: { oid: id } }); // cascades permissions
      await tx.systemLog.updateMany({
        where: { oid: id },
        data: { oid: null },
      });
      await tx.userWs.deleteMany({ where: { oid: id } });
      await tx.workspace.delete({ where: { id } });
    });
    // Best effort (mirrors DatasourceService.remove): a failure leaves
    // orphan tables, never rows pointing at dropped ones.
    if (excelSheets.length > 0) {
      await this.excelStore.dropTables(excelSheets);
    }
    return { success: true };
  }

  /** Imported sheet tables of the workspace's excel datasources: the
   *  configured sheet names plus every synced Table row (an unreadable
   *  configuration decrypts to {} — the Table rows still name the tables). */
  private async collectExcelSheets(oid: number): Promise<string[]> {
    const datasources = await this.prisma.datasource.findMany({
      where: { oid, type: 'excel' },
      select: { configuration: true },
    });
    const configured = datasources.flatMap((ds) => {
      const raw = (
        decryptFrontendConfig(ds.configuration) as Record<string, unknown>
      ).sheets;
      return Array.isArray(raw)
        ? raw
            .map((s) =>
              s && typeof s === 'object'
                ? (s as { tableName?: unknown }).tableName
                : null,
            )
            .filter((n): n is string => typeof n === 'string')
        : [];
    });
    const synced = (
      await this.prisma.table.findMany({
        where: { datasource: { oid, type: 'excel' } },
        select: { tableName: true },
      })
    ).map((t) => t.tableName);
    return [...new Set([...configured, ...synced])];
  }

  // ─── uws pager ─────────────────────────────────────────────────────────

  /** GET /system/workspace/uws/pager/:n/:s?oid&keyword.
   *  - admin + oid → users bound to that workspace (weight from binding).
   *  - admin without oid → all users with ≥1 binding (system-wide list).
   *  - non-admin → ALWAYS the current workspace (oid is ignored/validated). */
  async uwsPager(
    pageNum: number,
    pageSize: number,
    user: CurrentUserInfo,
    oid?: number,
    keyword?: string,
  ): Promise<{ items: UwsItem[]; total: number }> {
    const targetOid = this.resolveTargetOid(user, oid);
    const skip = (pageNum - 1) * pageSize;
    const kw = keyword?.trim();
    // Case-insensitive substring match on PostgreSQL (ILIKE). Email is
    // included because the member-search placeholder advertises it and it is
    // often the only identifier an admin has at hand.
    const userFilter: Prisma.UserWhereInput = kw
      ? {
          OR: [
            { account: { contains: kw, mode: 'insensitive' } },
            { name: { contains: kw, mode: 'insensitive' } },
            { email: { contains: kw, mode: 'insensitive' } },
          ],
        }
      : {};

    if (targetOid !== undefined) {
      // WITH oid — users bound to this workspace, weight from binding.
      const where: Prisma.UserWsWhereInput = {
        oid: targetOid,
        user: userFilter,
      };
      const [total, rows] = await this.prisma.$transaction([
        this.prisma.userWs.count({ where }),
        this.prisma.userWs.findMany({
          where,
          include: {
            user: {
              select: {
                id: true,
                account: true,
                name: true,
                email: true,
                status: true,
                createdAt: true,
              },
            },
          },
          skip,
          take: pageSize,
          orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
        }),
      ]);
      return {
        items: rows.map((r) => ({
          id: r.user.id, // flatten: frontend uses row.id as uid (uwsDelete)
          name: r.user.name,
          account: r.user.account,
          status: r.user.status,
          email: r.user.email,
          weight: r.weight,
          createdAt: r.createdAt, // binding createdAt (when user joined)
        })),
        total,
      };
    }

    // WITHOUT oid — system-admin only (non-admins are forced to an oid above).
    // weight = max binding weight (1 if admin anywhere, else 0).
    const where: Prisma.UserWhereInput = {
      userWorkspaces: { some: {} },
      ...userFilter,
    };
    const [total, users] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          account: true,
          name: true,
          email: true,
          status: true,
          createdAt: true,
          userWorkspaces: { select: { weight: true } },
        },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      items: users.map((u) => ({
        id: u.id,
        name: u.name,
        account: u.account,
        status: u.status,
        email: u.email,
        weight: Math.max(0, ...u.userWorkspaces.map((uw) => uw.weight)),
        createdAt: u.createdAt,
      })),
      total,
    };
  }

  // ─── uws option ────────────────────────────────────────────────────────

  /** GET /system/workspace/uws/option/pager/:n/:s?oid&keyword — users NOT
   *  bound to the target workspace (selectable to add). Non-admins can only
   *  query their current workspace. */
  async uwsOptionPager(
    pageNum: number,
    pageSize: number,
    user: CurrentUserInfo,
    oid: number,
    keyword?: string,
  ): Promise<{ items: UserRow[]; total: number }> {
    const targetOid = this.resolveTargetOid(user, oid) ?? user.oid;
    const bound = await this.prisma.userWs.findMany({
      where: { oid: targetOid },
      select: { uid: true },
    });
    const boundUids = bound.map((b) => b.uid);
    const kw = keyword?.trim();
    const where: Prisma.UserWhereInput = {
      id: { notIn: boundUids },
      ...(kw
        ? {
            OR: [
              { account: { contains: kw, mode: 'insensitive' } },
              { name: { contains: kw, mode: 'insensitive' } },
              { email: { contains: kw, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const skip = (pageNum - 1) * pageSize;
    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          account: true,
          name: true,
          email: true,
          status: true,
          createdAt: true,
        },
        skip,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { items, total };
  }

  /** GET /system/workspace/uws/option?keyword — find a SINGLE user by
   *  keyword (id/account/name/email substring). Used by member/index.vue to
   *  resolve a typed-in identifier before binding via uwsCreate. Returns
   *  null when no match. */
  async uwsOption(keyword: string): Promise<UserRow | null> {
    const kw = keyword.trim();
    // P2-1: strict parse — a blank keyword used to coerce into {id: 0}
    // (Number('')===0 passed the isNaN guard) and match an arbitrary user.
    const keywordNum = parseStrictInt(kw);
    const numFilter = keywordNum === null ? [] : [{ id: keywordNum }];
    return this.prisma.user.findFirst({
      where: {
        OR: [
          { account: { contains: kw, mode: 'insensitive' } },
          { name: { contains: kw, mode: 'insensitive' } },
          { email: { contains: kw, mode: 'insensitive' } },
          ...numFilter,
        ],
      },
      select: {
        id: true,
        account: true,
        name: true,
        email: true,
        status: true,
        createdAt: true,
      },
    });
  }

  // ─── uws mutations ─────────────────────────────────────────────────────

  /** POST /system/workspace/uws — bulk-ADD bindings.
   *  - admin: may target any active workspace and set weight (0/1).
   *  - ws admin: target is forced to the current workspace and weight is
   *    forced to 0 (ordinary member). Existing admin bindings are never
   *    demoted by this path. */
  async uwsCreate(
    dto: { uid_list: number[]; oid?: number; weight?: number },
    user: CurrentUserInfo,
  ): Promise<{ success: true }> {
    if (dto.uid_list.length === 0) return { success: true };
    const isAdmin = user.id === ADMIN_UID;
    const oid = isAdmin
      ? (dto.oid ?? user.oid)
      : (this.resolveTargetOid(user, dto.oid) ?? user.oid);
    const weight = isAdmin ? (dto.weight ?? 0) : 0;
    this.assertWeight(weight);

    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findFirst({
        where: { id: oid, archivedAt: null },
        select: { id: true },
      });
      if (!workspace) {
        throw new NotFoundException(
          tr('workspace.not_found_or_archived', { oid }),
        );
      }
      const existing = await tx.userWs.findMany({
        where: { oid, uid: { in: dto.uid_list } },
        select: { uid: true },
      });
      const existingUids = new Set(existing.map((e) => e.uid));
      const toCreate = dto.uid_list.filter((uid) => !existingUids.has(uid));
      const toUpdate = isAdmin
        ? dto.uid_list.filter((uid) => existingUids.has(uid))
        : [];
      if (toCreate.length > 0) {
        await tx.userWs.createMany({
          data: toCreate.map((uid) => ({ uid, oid, weight })),
          skipDuplicates: true,
        });
      }
      if (toUpdate.length > 0) {
        await tx.userWs.updateMany({
          where: { oid, uid: { in: toUpdate } },
          data: { weight },
        });
      }
      // Re-adding a user whose current workspace was archived (oid reset to 0)
      // should also make this workspace their current one again, otherwise
      // they could never log in.
      await tx.user.updateMany({
        where: { id: { in: dto.uid_list }, oid: 0 },
        data: { oid },
      });
    });
    return { success: true };
  }

  /** PUT /system/workspace/uws — single-user weight update (system admin
   *  only; enforced at the controller). */
  async uwsUpdate(dto: {
    uid: number;
    oid: number;
    weight: number;
  }): Promise<{ success: true }> {
    this.assertWeight(dto.weight);
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({
        where: { id: dto.oid },
        select: { id: true },
      });
      if (!workspace) {
        throw new NotFoundException(tr('workspace.not_found', { id: dto.oid }));
      }
      await tx.userWs.upsert({
        where: { uid_oid: { uid: dto.uid, oid: dto.oid } },
        create: { uid: dto.uid, oid: dto.oid, weight: dto.weight },
        update: { weight: dto.weight },
      });
    });
    return { success: true };
  }

  /** DELETE /system/workspace/uws — bulk-REMOVE.
   *  - admin: with oid → that workspace's bindings; without oid → ALL
   *    bindings for these users (system-wide removal).
   *  - ws admin: forced to the current workspace, and only ordinary members
   *    may be removed (other workspace admins are protected). */
  async uwsDelete(
    dto: { uid_list: number[]; oid?: number },
    user: CurrentUserInfo,
  ): Promise<{ success: true }> {
    if (dto.uid_list.length === 0) return { success: true };
    const isAdmin = user.id === ADMIN_UID;
    const targetOid = isAdmin ? dto.oid : this.resolveTargetOid(user, dto.oid);

    await this.prisma.$transaction(async (tx) => {
      if (!isAdmin) {
        const protectedBindings = await tx.userWs.findMany({
          where: {
            oid: targetOid,
            uid: { in: dto.uid_list },
            weight: { not: 0 },
          },
          select: { uid: true },
        });
        if (protectedBindings.length > 0) {
          throw new ForbiddenException(tr('workspace.admin_not_removable'));
        }
      }
      await tx.userWs.deleteMany({
        where:
          targetOid !== undefined
            ? { oid: targetOid, uid: { in: dto.uid_list } }
            : { uid: { in: dto.uid_list } },
      });
      await this.reconcileRemovedUsers(tx, dto.uid_list);
    });
    return { success: true };
  }

  // ─── private helpers ───────────────────────────────────────────────────

  /** Non-admins can only address their current workspace. Admins may pass any
   *  oid (undefined = the system-wide "no oid" semantics). */
  private resolveTargetOid(
    user: CurrentUserInfo,
    requested?: number,
  ): number | undefined {
    if (user.id === ADMIN_UID) return requested;
    if (requested !== undefined && requested !== user.oid) {
      throw new ForbiddenException(tr('workspace.only_current_ws'));
    }
    return user.oid;
  }

  private assertWeight(weight: number): void {
    if (weight !== 0 && weight !== 1) {
      throw new BadRequestException(tr('workspace.role_invalid'));
    }
  }

  /** Move users whose current workspace is `oid` to another active workspace
   *  (default workspace for the system admin, 0 when no membership remains).
   *  Runs inside the caller's transaction. */
  private async resetUsersInWorkspace(
    tx: Prisma.TransactionClient,
    oid: number,
  ): Promise<void> {
    const users = await tx.user.findMany({
      where: { oid },
      select: { id: true },
    });
    for (const u of users) {
      const candidate = await tx.userWs.findFirst({
        where: {
          uid: u.id,
          oid: { not: oid },
          workspace: { archivedAt: null },
        },
        orderBy: { oid: 'asc' },
        select: { oid: true },
      });
      const fallback = u.id === ADMIN_UID ? 1 : (candidate?.oid ?? 0);
      await tx.user.update({
        where: { id: u.id },
        data: { oid: fallback },
      });
    }
  }

  /** After bindings were removed, users whose current workspace lost its
   *  membership move to another active workspace (or 0). System admin keeps
   *  its current workspace — it does not require a binding. */
  private async reconcileRemovedUsers(
    tx: Prisma.TransactionClient,
    uids: number[],
  ): Promise<void> {
    for (const uid of uids) {
      if (uid === ADMIN_UID) continue;
      const u = await tx.user.findUnique({
        where: { id: uid },
        select: { oid: true },
      });
      if (!u || u.oid === 0) continue;
      const stillBound = await tx.userWs.findUnique({
        where: { uid_oid: { uid, oid: u.oid } },
      });
      if (stillBound) continue;
      const candidate = await tx.userWs.findFirst({
        where: { uid, workspace: { archivedAt: null } },
        orderBy: { oid: 'asc' },
        select: { oid: true },
      });
      await tx.user.update({
        where: { id: uid },
        data: { oid: candidate?.oid ?? 0 },
      });
    }
  }

  private rethrowDuplicateName(e: unknown): never {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new BadRequestException(tr('workspace.name_exists'));
    }
    throw e;
  }
}
