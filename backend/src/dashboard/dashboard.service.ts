// DashboardService.
//
// Route semantics:
// - list_resource: filter by oid + createBy + optional nodeType; build tree
// - load_resource: full row + create_name/update_name via User lookup;
//   403 ownership check (createBy !== current user id)
// - create_resource/create_canvas: NO backend name-uniqueness check (frontend
//   gates via check_name — the client-side check is trusted). Sets createBy = uid.
// - update_resource/update_canvas: NO uniqueness check. Sets updateBy = uid.
//   Ownership 403 like load/delete/move (a canvas is private to its creator).
// - check_name (validate_name): opt-based uniqueness, returns boolean
// - delete_resource: ownership 403 + folder-not-empty guard (safety: refuse
//   to delete a non-empty folder)
// - move_resource: pid+level update for frontend drag-drop parity
//
// Per plan: `tree()`/`saveCanvas(id, dto)` signatures preserved. `tree()` is a
// thin wrapper over listResource(). saveCanvas stays (version-bump path) even
// though the new controller routes through updateCanvas instead.
//
// Design notes:
// - id is a NUMBER (autoincrement integer)
// - pid is number|null; normalizePid maps 'root'/'0'→null
// - canvas fields are stored as Prisma Json objects; the service
//   JSON.parses frontend strings on write, the mapper JSON.stringifies on read
// - folder-not-empty guard on delete (refuse to delete non-empty folders)
// - canvas_view_info is refreshed on load: each chart component's stored
//   datasource + SQL is re-executed; failures are recorded on the component
//   instead of failing the whole dashboard.
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, type CoreDashboard, type User } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DatasourceService } from '../datasource/datasource.service';
import { toQueryPrismDataShape } from '../common/utils/queryprism-data-shape';
import { parseStrictInt } from '../common/utils/parse-int';
import { RequestContext } from '../common/context/request-context';
import { ADMIN_UID } from '../auth/admin.guard';
import { tr } from '../common/i18n/translate';

/** A dashboard node with its nested children (for the resource tree view). */
export type DashboardNode = CoreDashboard & { children: DashboardNode[] };

/** Full row + create_name/update_name (for load_resource). */
export type DashboardResourceRow = CoreDashboard & {
  createName: string | null;
  updateName: string | null;
};

// --- Plain typed body interfaces (§101 — ValidationPipe passthrough) ---

/** Body for create_resource/create_canvas/update_resource/update_canvas. */
export interface DashboardMutateBody {
  id?: string | number;
  name: string;
  pid?: string | number | null;
  node_type?: string;
  type?: string;
  level?: number;
  opt?: string;
  component_data?: string; // JSON string (frontend JSON.stringify)
  canvas_style_data?: string;
  canvas_view_info?: string;
  workspace_id?: string | number;
  org_id?: string | number;
}

/** Body for check_name (validate_name). */
export interface DashboardCheckNameBody {
  name: string;
  pid?: string | number | null;
  opt: string;
  id?: string | number;
}

/** Body for move_resource. */
export interface DashboardMoveBody {
  id?: string | number;
  pid?: string | number | null;
  name?: string;
  nodeType?: string;
  type?: string;
}

// --- Helpers ---

/** Map frontend pid ('root'/'0'/number/null) to QueryPrism Int? (null=root). */
function normalizePid(pid: unknown): number | null {
  if (pid == null || pid === '' || pid === 'root' || pid === '0') return null;
  const n = Number(pid);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse a frontend canvas JSON string to a Prisma.Json value.
 *  Returns undefined for null/empty (Prisma treats undefined as "don't set")
 *  so absent canvas fields don't overwrite existing ones on update. */
function parseCanvasJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Prisma.InputJsonValue;
    } catch {
      return undefined;
    }
  }
  // already an object/array (legacy Phase 6 callers)
  return value;
}

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly datasourceService: DatasourceService,
  ) {}

  // --- list / tree (list_resource) ---------------------------------------

  /** list_resource: filter by oid + createBy + optional nodeType, build tree. */
  async listResource(nodeType?: string): Promise<DashboardNode[]> {
    const { oid, uid } = this.currentUser();
    // Review P1-3: rows created before the createBy column existed
    // (migration 20260726100000 added it nullable with no backfill) matched
    // NO uid — invisible to everyone, forever. Legacy NULL-createBy rows are
    // now visible to the workspace admin (uid 1); owned rows as before.
    const where: Prisma.CoreDashboardWhereInput = {
      oid,
      ...(uid === 1
        ? { OR: [{ createBy: uid }, { createBy: null }] }
        : { createBy: uid }),
    };
    if (nodeType) where.nodeType = nodeType;
    const rows = await this.prisma.coreDashboard.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return this.buildTree(rows);
  }

  /** tree() signature preserved per plan — thin wrapper over listResource(). */
  async tree(): Promise<DashboardNode[]> {
    return this.listResource();
  }

  // --- load (load_resource) ----------------------------------------------

  /** load_resource: full row + create_name/update_name via User lookup.
   *  403 when createBy !== current user id (ownership check). */
  async loadResource(id: number): Promise<DashboardResourceRow> {
    const { oid, uid } = this.currentUser();
    const row = await this.prisma.coreDashboard.findFirst({
      where: { id, oid },
    });
    if (!row)
      throw new NotFoundException(tr('dashboard.dashboard_not_found', { id }));
    if (!this.isOwned(row, uid)) {
      throw new ForbiddenException(
        'You do not have permission to access this resource',
      );
    }
    const [creator, updater] = await Promise.all([
      row.createBy != null
        ? this.prisma.user.findUnique({
            where: { id: row.createBy },
            select: { name: true, account: true },
          })
        : Promise.resolve(null),
      row.updateBy != null
        ? this.prisma.user.findUnique({
            where: { id: row.updateBy },
            select: { name: true, account: true },
          })
        : Promise.resolve(null),
    ]);
    const canvasViewInfo = await this.injectCanvasData(row.canvasViewInfo);
    return {
      ...row,
      canvasViewInfo,
      createName: creator?.name ?? creator?.account ?? null,
      updateName: updater?.name ?? updater?.account ?? null,
    };
  }

  /** load_resource refresh: re-execute each chart component's stored SQL and
   *  inline the fresh rows into canvas_view_info. Failures are recorded on the
   *  component (status/message) instead of failing the whole dashboard load. */
  private async injectCanvasData(
    viewInfo: Prisma.JsonValue,
  ): Promise<Prisma.JsonValue> {
    if (
      viewInfo == null ||
      typeof viewInfo !== 'object' ||
      Array.isArray(viewInfo)
    ) {
      return viewInfo;
    }
    const view = viewInfo as Record<string, unknown>;
    for (const item of Object.values(view)) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) {
        continue;
      }
      const chart = item as Record<string, unknown>;
      const datasourceId = Number(chart.datasource);
      const sql = chart.sql;
      if (
        !Number.isInteger(datasourceId) ||
        typeof sql !== 'string' ||
        sql.trim() === ''
      ) {
        continue;
      }
      try {
        const result = await this.datasourceService.execSql(datasourceId, sql);
        const data =
          chart.data != null &&
          typeof chart.data === 'object' &&
          !Array.isArray(chart.data)
            ? (chart.data as Record<string, unknown>)
            : {};
        data.data = toQueryPrismDataShape(result).data;
        chart.data = data;
        chart.status = 'success';
        chart.message = '';
      } catch (e) {
        chart.status = 'failed';
        chart.message = e instanceof Error ? e.message : String(e);
      }
    }
    return view as unknown as Prisma.JsonValue;
  }

  // --- create (create_resource + create_canvas) --------------------------

  /** create_resource: create folder (no canvas). Sets createBy = uid.
   *  No name uniqueness check (the frontend check_name gate is trusted). */
  async createResource(dto: DashboardMutateBody): Promise<CoreDashboard> {
    const { oid, uid } = this.currentUser();
    const pid = normalizePid(dto.pid);
    const level = await this.deriveLevel(pid, oid);
    return this.prisma.coreDashboard.create({
      data: {
        oid,
        name: dto.name,
        pid,
        nodeType: dto.node_type ?? 'leaf',
        type: dto.type ?? null,
        level,
        createBy: uid,
      },
    });
  }

  /** create_canvas: create leaf with canvas (JSON.parse strings). */
  async createCanvas(dto: DashboardMutateBody): Promise<CoreDashboard> {
    const { oid, uid } = this.currentUser();
    const pid = normalizePid(dto.pid);
    const level = await this.deriveLevel(pid, oid);
    const data: Prisma.CoreDashboardCreateInput = {
      oid,
      name: dto.name,
      pid,
      nodeType: dto.node_type ?? 'leaf',
      type: dto.type ?? null,
      level,
      createBy: uid,
    };
    const componentData = parseCanvasJson(dto.component_data);
    if (componentData !== undefined) data.componentData = componentData;
    const canvasStyleData = parseCanvasJson(dto.canvas_style_data);
    if (canvasStyleData !== undefined) data.canvasStyleData = canvasStyleData;
    const canvasViewInfo = parseCanvasJson(dto.canvas_view_info);
    if (canvasViewInfo !== undefined) data.canvasViewInfo = canvasViewInfo;
    return this.prisma.coreDashboard.create({ data });
  }

  // --- update (update_resource + update_canvas) --------------------------

  /** update_resource: rename only. Sets updateBy = uid. No uniqueness check.
   *  Creator-only (403), like every other route that reads or writes a row. */
  async updateResource(
    id: number,
    dto: DashboardMutateBody,
  ): Promise<CoreDashboard> {
    const { oid, uid } = this.currentUser();
    const existing = await this.findOneOrFail(id, oid);
    this.assertOwned(existing, uid);
    return this.prisma.coreDashboard.update({
      where: { id },
      data: {
        name: dto.name,
        updateBy: uid,
      },
    });
  }

  /** update_canvas: update name + canvas fields + updateBy. No version bump
   *  (distinct from saveCanvas, which bumps version). Creator-only (403). */
  async updateCanvas(
    id: number,
    dto: DashboardMutateBody,
  ): Promise<CoreDashboard> {
    const { oid, uid } = this.currentUser();
    const existing = await this.findOneOrFail(id, oid);
    this.assertOwned(existing, uid);
    const data: Prisma.CoreDashboardUpdateInput = {
      name: dto.name,
      updateBy: uid,
    };
    const componentData = parseCanvasJson(dto.component_data);
    if (componentData !== undefined) data.componentData = componentData;
    const canvasStyleData = parseCanvasJson(dto.canvas_style_data);
    if (canvasStyleData !== undefined) data.canvasStyleData = canvasStyleData;
    const canvasViewInfo = parseCanvasJson(dto.canvas_view_info);
    if (canvasViewInfo !== undefined) data.canvasViewInfo = canvasViewInfo;
    return this.prisma.coreDashboard.update({ where: { id }, data });
  }

  // --- check_name (validate_name) ----------------------------------------

  /** validate_name: opt-based uniqueness, returns boolean (truthy=available).
   *  Logic: newLeaf/newFolder check (oid, createBy, name);
   *  updateLeaf/updateFolder/rename exclude self id. */
  async validateName(dto: DashboardCheckNameBody): Promise<boolean> {
    const { oid, uid } = this.currentUser();
    const opt = dto.opt;
    if (!opt) throw new BadRequestException('opt is required');
    const updateOpts = ['updateLeaf', 'updateFolder', 'rename'];
    const createOpts = ['newLeaf', 'newFolder'];
    if (!updateOpts.includes(opt) && !createOpts.includes(opt)) {
      throw new BadRequestException(`Invalid opt value: ${opt}`);
    }
    const where: Prisma.CoreDashboardWhereInput = {
      oid,
      createBy: uid,
      name: dto.name,
    };
    if (updateOpts.includes(opt)) {
      if (dto.id == null || dto.id === '') {
        throw new BadRequestException('id is required for update operation');
      }
      // P2-1: strict parse — Number('abc') is NaN, which Prisma rejects
      // with an opaque validation 500.
      const selfId = parseStrictInt(dto.id);
      if (selfId === null) {
        throw new BadRequestException(tr('common.id_must_be_int'));
      }
      where.id = { not: selfId };
    }
    const count = await this.prisma.coreDashboard.count({ where });
    return count === 0;
  }

  // --- delete (delete_resource) ------------------------------------------

  /** delete_resource: ownership 403 + folder-not-empty guard — non-empty
   *  folders are refused (safer than cascading the delete). */
  async remove(id: number): Promise<{ success: true }> {
    const { oid, uid } = this.currentUser();
    const existing = await this.findOneOrFail(id, oid);
    this.assertOwned(existing, uid);
    if (existing.nodeType === 'folder') {
      const childCount = await this.prisma.coreDashboard.count({
        where: { pid: id, oid },
      });
      if (childCount > 0) {
        throw new BadRequestException(tr('dashboard.delete_children_first'));
      }
    }
    await this.prisma.coreDashboard.delete({ where: { id } });
    return { success: true };
  }

  // --- move (move_resource) ----------------------------------------------

  /** move_resource: update pid + level + updateBy for frontend drag-drop.
   *  Ownership 403. */
  async moveResource(
    id: number,
    pid: number | null,
  ): Promise<{ success: true }> {
    const { oid, uid } = this.currentUser();
    const existing = await this.findOneOrFail(id, oid);
    this.assertOwned(existing, uid);
    const level = await this.deriveLevel(pid, oid);
    await this.prisma.coreDashboard.update({
      where: { id },
      data: { pid, level, updateBy: uid },
    });
    return { success: true };
  }

  // --- saveCanvas (signature preserved per plan; version-bump path) -----

  /** saveCanvas: 4 canvas fields + version bump. Preserved per plan even
   *  though new controller routes through updateCanvas instead. */
  async saveCanvas(
    id: number,
    dto: {
      canvasStyleData?: unknown;
      componentData?: unknown;
      canvasViewInfo?: unknown;
      mobileLayout?: unknown;
    },
  ): Promise<CoreDashboard> {
    const { oid, uid } = this.currentUser();
    const existing = await this.findOneOrFail(id, oid);
    this.assertOwned(existing, uid);
    return this.prisma.coreDashboard.update({
      where: { id },
      data: {
        canvasStyleData: dto.canvasStyleData as Prisma.InputJsonValue,
        componentData: dto.componentData as Prisma.InputJsonValue,
        canvasViewInfo: dto.canvasViewInfo as Prisma.InputJsonValue,
        mobileLayout: dto.mobileLayout as Prisma.InputJsonValue,
        version: { increment: 1 },
      },
    });
  }

  // --- helpers -----------------------------------------------------------

  /** A dashboard row is private to the user who created it. Legacy rows that
   *  predate `createBy` (NULL) belong to the system admin — the only user
   *  listResource shows them to (P1-3). */
  private isOwned(row: Pick<CoreDashboard, 'createBy'>, uid: number): boolean {
    return row.createBy === uid || (row.createBy == null && uid === ADMIN_UID);
  }

  private assertOwned(
    row: Pick<CoreDashboard, 'id' | 'createBy'>,
    uid: number,
  ): void {
    if (!this.isOwned(row, uid)) {
      throw new ForbiddenException(
        `Resource with id ${row.id} not owned by the current user`,
      );
    }
  }

  private currentUser(): { oid: number; uid: number } {
    const user = RequestContext.getUser();
    if (!user) throw new UnauthorizedException(tr('common.user_unresolved'));
    if (user.oid === undefined) {
      throw new UnauthorizedException(tr('common.ws_unresolved'));
    }
    return { oid: user.oid, uid: user.id };
  }

  private async findOneOrFail(id: number, oid: number): Promise<CoreDashboard> {
    const row = await this.prisma.coreDashboard.findFirst({
      where: { id, oid },
    });
    if (!row)
      throw new NotFoundException(tr('dashboard.dashboard_not_found', { id }));
    return row;
  }

  private async deriveLevel(pid: number | null, oid: number): Promise<number> {
    if (pid === null) return 0;
    const parent = await this.prisma.coreDashboard.findFirst({
      where: { id: pid, oid },
    });
    if (!parent)
      throw new NotFoundException(
        tr('dashboard.parent_not_found', { id: pid }),
      );
    return parent.level + 1;
  }

  private buildTree(rows: CoreDashboard[]): DashboardNode[] {
    const byId = new Map<number, DashboardNode>();
    rows.forEach((r) => byId.set(r.id, { ...r, children: [] }));
    const roots: DashboardNode[] = [];
    for (const node of byId.values()) {
      if (node.pid == null) {
        roots.push(node);
      } else {
        const parent = byId.get(node.pid);
        if (parent) parent.children.push(node);
        else roots.push(node); // orphan (parent deleted) → surface as root
      }
    }
    return roots;
  }
}

// Re-export User type for spec imports (avoid `@prisma/client` default import).
export type { User };
