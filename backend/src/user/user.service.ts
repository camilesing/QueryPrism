// User CRUD + Excel import/export + self-service (language/password/workspace).
// Phase 10 §85/§88: mgmt routes return Prisma rows WITH the userWorkspaces
// include so the controller's toUserSnake mapper can derive oid_list; the
// password column is never serialized (the mapper omits it). /user/info
// (the auth shape) returns the camelCase UserInfo separately.
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { type Prisma, type User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { tr } from '../common/i18n/translate';
import { ImportErrorFileService } from '../common/import-export/import-error-file.service';
import { jsonValueToString } from '../common/utils/json-value';
import { PWD_REGEX, initialPwdDisabled } from '../auth/password-policy';
import { ADMIN_UID } from '../auth/admin.guard';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import type { CurrentUserInfo } from '../common/context/request-context';
import type { UserWithWorkspaces } from './user-snake-mapper';

// exceljs's Xlsx.load() is typed against an older non-generic Buffer (from a
// different @types/node in its resolution graph). The project's Buffer is the
// Node 22+ generic Buffer<TArrayBuffer>; the two are not structurally
// assignable. Extract exceljs's exact expected input type and cast through it.
type XlsxLoadInput = Parameters<ExcelJS.Workbook['xlsx']['load']>[0];

// The UserInfo shape the frontend's user store reads.
// exp/time come from the JWT (iat→time, exp→exp); name reads the `name`
// column (null → fallback to account for legacy rows); weight=0 (admin
// detected via uid==='1' in the frontend); origin reads the Int column
// (0=local). All fields defined — undefined would break the store
// (uid='undefined', Number(undefined)=NaN).
export interface UserInfo {
  id: number;
  account: string;
  name: string;
  oid: number;
  language: string;
  exp: number;
  time: number;
  weight: number;
  origin: number;
}

/** Result of POST /user/batchImport — Phase 10 §86: {successCount, errorCount,
 *  dataKey}. dataKey is the handle for the error-record file (null when there
 *  are no error rows — the errorRecord route then 404s). */
export interface ImportResult {
  successCount: number;
  errorCount: number;
  dataKey: string | null;
}

/** The default password an admin reset (PATCH /user/pwd/:id) sets, and which
 *  GET /user/defaultPwd returns so the frontend can display it. Exported for
 *  AuthService's forced-change check (bcrypt.compare against this
 *  constant decides "is the initial password"). */
export const DEFAULT_PWD = '123456';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly importError: ImportErrorFileService,
  ) {}

  // GET /user/info — the shape the frontend's user store reads:
  // {id(→uid), account, name, oid, language, exp, time, weight, origin}.
  async getInfo(currentUser: CurrentUserInfo): Promise<UserInfo> {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
    });
    if (!user) {
      throw new NotFoundException(tr('user.not_found'));
    }
    return {
      id: user.id,
      account: user.account,
      name: user.name ?? user.account, // Phase 10 §85: name column now exists; fallback for legacy null rows
      oid: user.oid,
      language: user.language,
      exp: currentUser.exp ?? 0,
      time: currentUser.iat ?? 0,
      // Resolved by JwtAuthGuard from UserWs.weight for the current workspace
      // (0 for the hardcoded uid-1 system admin). Drives the frontend's
      // isSpaceAdmin gate for /set/* pages and workspace-scoped API calls.
      weight: currentUser.weight ?? 0,
      origin: user.origin,
    };
  }

  // GET /user/pager/:n/:s — Phase 10 §83: {items, total} envelope (assembled
  // in the controller); service returns raw rows WITH userWorkspaces so the
  // controller's toUserSnake can derive oid_list.
  async pager(opts: {
    page: number;
    pageSize: number;
    keyword?: string;
  }): Promise<{ total: number; list: UserWithWorkspaces[] }> {
    const page = opts.page > 0 ? Math.floor(opts.page) : 1;
    const pageSize = opts.pageSize > 0 ? Math.floor(opts.pageSize) : 20;
    if (!opts.keyword) {
      // P3-5: DB-side pagination — the old path materialized the ENTIRE
      // table (workspace include included) on every page load, then sliced.
      const [total, list] = await this.prisma.$transaction([
        this.prisma.user.count(),
        this.prisma.user.findMany({
          orderBy: { createdAt: 'desc' },
          include: { userWorkspaces: { select: { oid: true } } },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
      ]);
      return { total, list };
    }
    // b99f1403+a2d1a9d4+1fdc28b6: search across account/name/email and rank
    // by similarity — per field exact(0) > prefix(1) > contains(2) > none(3);
    // more matched fields first, then the lower total score wins. Literal
    // substring matching (indexOf) sidesteps SQL wildcard escaping entirely;
    // lowercasing normalises both sides of the in-memory ranking.
    // P3-5: the ranking stays in memory, but a case-insensitive SQL prefilter
    // (PostgreSQL ILIKE) now fetches ONLY matching rows instead of the whole
    // table.
    const kw = opts.keyword.toLowerCase();
    const matches = await this.prisma.user.findMany({
      where: {
        OR: [
          { account: { contains: opts.keyword, mode: 'insensitive' } },
          { name: { contains: opts.keyword, mode: 'insensitive' } },
          { email: { contains: opts.keyword, mode: 'insensitive' } },
        ],
      },
      include: { userWorkspaces: { select: { oid: true } } },
    });
    const score = (v: string | null): number => {
      const s = (v ?? '').toLowerCase();
      if (!s || !kw) return 3;
      if (s === kw) return 0;
      if (s.startsWith(kw)) return 1;
      if (s.includes(kw)) return 2;
      return 3;
    };
    const ranked = matches
      .map((u) => {
        const scores = [score(u.account), score(u.name), score(u.email)];
        return {
          u,
          matchCount: scores.filter((s) => s < 3).length,
          totalScore: scores[0] + scores[1] + scores[2],
        };
      })
      .filter((r) => r.matchCount > 0)
      .sort(
        (a, b) =>
          b.matchCount - a.matchCount ||
          a.totalScore - b.totalScore ||
          b.u.createdAt.getTime() - a.u.createdAt.getTime(),
      );
    return {
      total: ranked.length,
      list: ranked
        .slice((page - 1) * pageSize, page * pageSize)
        .map((r) => r.u),
    };
  }

  // GET /user/:key — public single-fetch (nullable; controller 404s on null).
  async findOne(id: number): Promise<UserWithWorkspaces | null> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { userWorkspaces: { select: { oid: true } } },
    });
    return user;
  }

  // POST /user — Phase 10 §85: status Int (1/0), origin 0 (local self-create),
  // name column, oid_list drives multi-workspace UserWs rows. Returns the row
  // WITH userWorkspaces so the controller can map oid_list.
  async create(dto: CreateUserDto): Promise<UserWithWorkspaces> {
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: dto.oid, archivedAt: null },
    });
    if (!workspace) {
      throw new NotFoundException(
        tr('workspace.not_found_or_archived', { oid: dto.oid }),
      );
    }
    // Validate every oid_list entry resolves to a real ACTIVE workspace.
    const oids = dto.oid_list?.length ? dto.oid_list : [];
    const oidSet = new Set<number>(oids);
    oidSet.add(dto.oid); // primary workspace always included
    if (oids.length) {
      const found = await this.prisma.workspace.count({
        where: { id: { in: oids }, archivedAt: null },
      });
      if (found !== oids.length) {
        throw new NotFoundException(tr('user.some_ws_not_found_or_archived'));
      }
    }
    const hashed = await bcrypt.hash(dto.password, 10);
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          account: dto.account,
          password: hashed,
          email: dto.email ?? null,
          name: dto.name ?? dto.account,
          oid: dto.oid,
          status: dto.status ?? 1,
          origin: 0,
          language: dto.language ?? 'en',
          ...(dto.system_variables !== undefined
            ? { systemVariables: dto.system_variables as Prisma.InputJsonValue }
            : {}),
        },
      });
      const wsRows: Prisma.UserWsCreateManyInput[] = [...oidSet].map((oid) => ({
        uid: user.id,
        oid,
      }));
      await tx.userWs.createMany({ data: wsRows });
      return user;
    });
    return this.findDetailed(created.id);
  }

  // PUT /user (body contains id) — Phase 10 §85: Int status/name, optional
  // oid_list reconciles UserWs rows (add new, drop removed), system_variables
  // is a Json blob passed through verbatim. Returns row WITH userWorkspaces.
  async update(id: number, dto: UpdateUserDto): Promise<UserWithWorkspaces> {
    if (dto.status !== undefined && dto.status !== 1) {
      this.assertSystemAdminIntact(id);
    }
    await this.findOneOrFail(id);
    const data: {
      account?: string;
      email?: string;
      name?: string;
      oid?: number;
      language?: string;
      status?: number;
      systemVariables?: Prisma.InputJsonValue;
    } = {};
    if (dto.account !== undefined) data.account = dto.account;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.oid !== undefined) {
      const workspace = await this.prisma.workspace.findFirst({
        where: { id: dto.oid, archivedAt: null },
        select: { id: true },
      });
      if (!workspace) {
        throw new BadRequestException(
          tr('workspace.not_found_or_archived', { oid: dto.oid }),
        );
      }
      data.oid = dto.oid;
    }
    if (dto.oid_list !== undefined && dto.oid_list.length > 0) {
      const found = await this.prisma.workspace.count({
        where: { id: { in: dto.oid_list }, archivedAt: null },
      });
      if (found !== dto.oid_list.length) {
        throw new BadRequestException(tr('user.some_ws_not_found_or_archived'));
      }
    }
    if (dto.language !== undefined) data.language = dto.language;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.system_variables !== undefined) {
      data.systemVariables = dto.system_variables as Prisma.InputJsonValue;
    }
    // Review P1-1: the row update + the UserWs reconciliation run in ONE
    // $transaction — the old two independent awaits could leave the user row
    // updated with a stale workspace set (or vice versa) on mid-failure.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data });
      // The primary workspace must always have a membership row, otherwise
      // JwtAuthGuard would lock the user out of their own current workspace.
      if (dto.oid !== undefined) {
        await tx.userWs.upsert({
          where: { uid_oid: { uid: id, oid: dto.oid } },
          create: { uid: id, oid: dto.oid },
          update: {},
        });
      }
      if (dto.oid_list !== undefined) {
        const target = new Set(dto.oid_list);
        if (dto.oid !== undefined) target.add(dto.oid);
        // Empty target = "remove every workspace". There is no valid oid to
        // fall back to, and oid 0 matches no Workspace — JwtAuthGuard would
        // reject every subsequent request (permanent lockout). Refuse.
        if (target.size === 0) {
          throw new BadRequestException(tr('user.must_belong_to_ws'));
        }
        await this.reconcileUserWorkspaces(tx, id, [...target]);
        const current = await tx.user.findUnique({
          where: { id },
          select: { oid: true },
        });
        if (current && !target.has(current.oid)) {
          await tx.user.update({
            where: { id },
            data: { oid: dto.oid ?? [...target][0] },
          });
        }
      }
    });
    return this.findDetailed(id);
  }

  /** Reconcile a user's UserWs rows against a target oid list — add new
   *  memberships, drop removed ones. The primary `oid` is always retained.
   *  Runs on the caller's client (the transactional client inside update(),
   *  P1-1 — or the plain PrismaService default). */
  private async reconcileUserWorkspaces(
    client: Prisma.TransactionClient,
    uid: number,
    oidList: number[],
  ): Promise<void> {
    const target = new Set(oidList);
    const existing = await client.userWs.findMany({
      where: { uid },
      select: { oid: true },
    });
    const existingOids = new Set(existing.map((u) => u.oid));
    const toAdd = [...target].filter((o) => !existingOids.has(o));
    const toRemove = [...existingOids].filter((o) => !target.has(o));
    if (toRemove.length) {
      await client.userWs.deleteMany({
        where: { uid, oid: { in: toRemove } },
      });
    }
    if (toAdd.length) {
      const wsRows: Prisma.UserWsCreateManyInput[] = toAdd.map((oid) => ({
        uid,
        oid,
      }));
      await client.userWs.createMany({ data: wsRows });
    }
  }

  // DELETE /user/:key — UserWs rows cascade via the relation onDelete: Cascade.
  async remove(id: number): Promise<{ success: true }> {
    this.assertSystemAdminIntact(id);
    await this.findOneOrFail(id);
    await this.prisma.user.delete({ where: { id } });
    return { success: true };
  }

  // DELETE /user (batch body {ids}) — Phase 10 §86: bulk delete; nonexistent
  // ids are skipped (deleteMany is idempotent).
  async removeBatch(ids: number[]): Promise<{ success: true }> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new BadRequestException(tr('user.ids_required'));
    }
    if (ids.includes(ADMIN_UID)) this.assertSystemAdminIntact(ADMIN_UID);
    await this.prisma.user.deleteMany({ where: { id: { in: ids } } });
    return { success: true };
  }

  // PATCH /user/status (body {id, status}) — Phase 10 §85: status is Int 1/0.
  // Returns row WITH userWorkspaces so the controller can map oid_list.
  async updateStatus(id: number, status: number): Promise<UserWithWorkspaces> {
    if (status !== 1) this.assertSystemAdminIntact(id);
    await this.findOneOrFail(id);
    await this.prisma.user.update({ where: { id }, data: { status } });
    return this.findDetailed(id);
  }

  // PATCH /user/pwd/:id (admin reset) — no body; reset to DEFAULT_PWD. The
  // GET /user/defaultPwd route returns the same constant so the frontend can
  // display what the password was reset to.
  async resetToDefaultPassword(id: number): Promise<{ success: true }> {
    this.assertSystemAdminIntact(id);
    await this.findOneOrFail(id);
    const hashed = await bcrypt.hash(DEFAULT_PWD, 10);
    await this.prisma.user.update({
      where: { id },
      data: { password: hashed },
    });
    return { success: true };
  }

  /** uid 1 is the only hard-coded system admin (AdminGuard). Deleting or
   *  disabling it, or putting it on the public default password, cannot be
   *  undone through the API — recovery needs manual SQL. */
  private assertSystemAdminIntact(id: number): void {
    if (id === ADMIN_UID) {
      throw new BadRequestException(tr('user.admin_protected'));
    }
  }

  /** Return the default password string (GET /user/defaultPwd). When
   *  login.initial_pwd_hidden=true the password is hidden — return ''.
   *  A missing parameter row means not hidden (the admin parameter page only
   *  upserts rows on save). Reads SystemVariable directly (type='parameter',
   *  name=pkey) per the appearance.service no-DI pattern — importing
   *  ParameterModule here would be circular (it imports AuthModule, and
   *  UserModule does too). */
  async getDefaultPwd(): Promise<string> {
    const row = await this.prisma.systemVariable.findFirst({
      where: { type: 'parameter', name: 'login.initial_pwd_hidden' },
    });
    if (row && jsonValueToString(row.value).trim().toLowerCase() === 'true') {
      return '';
    }
    return DEFAULT_PWD;
  }

  // PUT /user/language (self) — body {language}. Updates the current user's
  // language preference; the frontend reloads the page to re-localize.
  async updateOwnLanguage(
    user: CurrentUserInfo,
    language: string,
  ): Promise<{ success: true }> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { language },
    });
    return { success: true };
  }

  // PUT /user/pwd (self) — body {pwd, new_pwd} (snake, from PwdForm.vue).
  // Verifies the old password before accepting the new one. The self-service
  // path enforces the same rules as the pre-login /login/change-pwd —
  // PWD_REGEX format and, while login.initial_pwd_disabled is on, refusal
  // of the initial password.
  async changeOwnPassword(
    user: CurrentUserInfo,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ success: true }> {
    const u = await this.prisma.user.findUnique({ where: { id: user.id } });
    if (!u) {
      throw new NotFoundException(tr('user.not_found'));
    }
    const ok = await bcrypt.compare(oldPassword, u.password);
    if (!ok) {
      throw new BadRequestException(tr('user.wrong_original_password'));
    }
    if (!PWD_REGEX.test(newPassword)) {
      throw new BadRequestException(
        '密码格式错误（8-20位，需包含大写字母、小写字母、数字和特殊字符）',
      );
    }
    if (
      (await initialPwdDisabled(this.prisma)) &&
      newPassword === DEFAULT_PWD
    ) {
      throw new BadRequestException(tr('user.password_same_as_initial'));
    }
    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });
    return { success: true };
  }

  // GET /user/ws — workspace options for the current user. Returns [{id, name}]
  // where id is the workspace id (= UserWs.oid) — the same value PUT /user/ws/:oid
  // takes as its path param. The frontend Workspace.vue reads ele.id + ele.name.
  async getWorkspaceOptions(
    user: CurrentUserInfo,
  ): Promise<{ id: number; name: string; archived?: boolean }[]> {
    // The system admin sees every workspace; other users see only their
    // memberships. Archived workspaces are admin-only, which is why admins
    // receive them (flagged) and members do not.
    if (user.id === 1) {
      const workspaces = await this.prisma.workspace.findMany({
        orderBy: { id: 'asc' },
        select: { id: true, name: true, archivedAt: true },
      });
      return workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        archived: w.archivedAt != null,
      }));
    }
    const uws = await this.prisma.userWs.findMany({
      where: { uid: user.id, workspace: { archivedAt: null } },
      include: { workspace: { select: { name: true } } },
      orderBy: { oid: 'asc' },
    });
    return uws.map((uw) => ({ id: uw.oid, name: uw.workspace.name }));
  }

  // PUT /user/ws/:oid (switch) — sets User.oid (the server-side current
  // workspace). JwtAuthGuard reads it from the DB on every request, so the
  // switch takes effect immediately without re-login. The membership check and
  // the update run in one transaction (read informs write).
  async switchWorkspace(
    user: CurrentUserInfo,
    oid: number,
  ): Promise<{ success: true }> {
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.findUnique({
        where: { id: oid },
        select: { id: true, archivedAt: true },
      });
      if (!workspace) {
        throw new NotFoundException(tr('user.ws_not_found', { oid }));
      }
      // System admins may enter any existing workspace (including archived
      // ones for inspection/restore). Everyone else needs a membership and an
      // active workspace.
      if (user.id !== 1) {
        if (workspace.archivedAt != null) {
          throw new ForbiddenException(tr('workspace.ws_archived'));
        }
        const membership = await tx.userWs.findUnique({
          where: { uid_oid: { uid: user.id, oid } },
        });
        if (!membership) {
          throw new NotFoundException(tr('user.not_in_ws', { oid }));
        }
      }
      await tx.user.update({ where: { id: user.id }, data: { oid } });
    });
    return { success: true };
  }

  // POST /user/batchImport (multipart) — Excel upload. Columns: A account,
  // B password, C email, D language, E oid (default 1). Row 1 is the header.
  // Failed rows are written to an error workbook; dataKey is its filename
  // (null when every row imported).
  async importUsers(file: Buffer): Promise<ImportResult> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file as unknown as XlsxLoadInput);
    const ws = wb.worksheets[0];
    if (!ws) {
      throw new BadRequestException(tr('user.no_worksheet'));
    }

    let successCount = 0;
    const failedRows: unknown[][] = [];
    const failedMessages: string[] = [];
    const fail = (row: unknown[], message: string): void => {
      failedRows.push(row);
      failedMessages.push(message);
    };

    for (let rowNum = 2; rowNum <= ws.rowCount; rowNum++) {
      const row = ws.getRow(rowNum);
      const account = cellToString(row.getCell(1).value).trim();
      const password = cellToString(row.getCell(2).value);
      const email = cellToString(row.getCell(3).value).trim();
      const language = cellToString(row.getCell(4).value).trim() || 'en';
      const oidRaw = cellToString(row.getCell(5).value).trim();
      // Never write the uploaded plaintext password into a downloadable file.
      const errorRow = [
        account,
        password ? '***' : '',
        email,
        language,
        oidRaw,
      ];

      // Skip fully-empty trailing rows without counting them as errors.
      if (!account && !password && !email && !oidRaw) continue;

      if (!account) {
        fail(errorRow, '账号不能为空');
        continue;
      }
      if (!password) {
        fail(errorRow, '密码不能为空');
        continue;
      }
      if (
        email &&
        !/^[a-zA-Z0-9_._-]+@[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$/.test(email)
      ) {
        fail(errorRow, '邮箱格式不正确');
        continue;
      }
      const oid = oidRaw === '' ? 1 : Number(oidRaw);
      if (!Number.isInteger(oid) || oid <= 0) {
        fail(errorRow, `工作空间 id 无效: ${oidRaw}`);
        continue;
      }

      try {
        const exists = await this.prisma.user.findUnique({
          where: { account },
        });
        if (exists) {
          fail(errorRow, '账号已存在');
          continue;
        }
        const hashed = await bcrypt.hash(password, 10);
        await this.prisma.$transaction(async (tx) => {
          const created = await tx.user.create({
            data: {
              account,
              password: hashed,
              email: email || null,
              name: account,
              oid,
              status: 1,
              origin: 0,
              language,
            },
          });
          await tx.userWs.create({ data: { uid: created.id, oid } });
        });
        successCount++;
      } catch (e) {
        fail(errorRow, e instanceof Error ? e.message : String(e));
      }
    }

    const dataKey =
      failedRows.length > 0
        ? await this.importError.write({
            prefix: 'user',
            headers: ['account', 'password', 'email', 'language', 'oid'],
            rows: failedRows,
            messages: failedMessages,
          })
        : null;

    return {
      successCount,
      errorCount: failedRows.length,
      dataKey,
    };
  }

  /** Resolve a user-import error record for download. Only files created by
   *  this service (the `user_` prefix) are visible through the route. */
  async resolveErrorRecord(key: string): Promise<string> {
    if (!key.startsWith('user_')) {
      throw new NotFoundException(tr('user.no_error_record'));
    }
    return this.importError.resolveDownload(key);
  }

  /** Delete a user-import error record (idempotent). */
  async clearErrorRecord(key: string): Promise<{ success: true }> {
    if (key.startsWith('user_')) {
      await this.importError.delete(key);
    }
    return { success: true };
  }

  // GET /user/template — build a downloadable template workbook.
  async exportTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('users');
    ws.columns = [
      { header: 'account', key: 'account', width: 20 },
      { header: 'password', key: 'password', width: 20 },
      { header: 'email', key: 'email', width: 30 },
      { header: 'language', key: 'language', width: 12 },
      { header: 'oid', key: 'oid', width: 8 },
    ];
    ws.addRow({
      account: 'demo',
      password: '123456',
      email: 'demo@example.com',
      language: 'en',
      oid: 1,
    });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** Load a user or 404 — shared guard for all :id mutations. */
  private async findOneOrFail(id: number): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) {
      throw new NotFoundException(tr('user.user_id_not_found', { id }));
    }
    return user;
  }

  /** Re-fetch a user WITH userWorkspaces (for oid_list derivation) — used by
   *  create/update/updateStatus to return the post-mutation row. Throws if the
   *  row vanished between the mutation and the re-fetch (should not happen). */
  private async findDetailed(id: number): Promise<UserWithWorkspaces> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { userWorkspaces: { select: { oid: true } } },
    });
    if (!user) {
      throw new NotFoundException(tr('user.user_id_not_found', { id }));
    }
    return user;
  }
}

/** Coerce an ExcelJS cell value to a plain string for import parsing. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>)
        .map((r) => r.text ?? '')
        .join('');
    }
    if (typeof v.text === 'string') {
      return v.text;
    }
    const result = v.result;
    if (typeof result === 'string' || typeof result === 'number') {
      return String(result);
    }
  }
  return '';
}
