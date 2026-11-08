// AuditService: the audit-log pipeline — WRITE side (record() + the
// SystemLogInterceptor) + READ side (page/getOptions/export). Phase 10c cycle 3
// §82/§83/§88/§104. Aligned to the `system/audit` contract (frontend
// views/system/audit/index.vue is the source of truth; the wire shape is
// reverse-engineered from the frontend).
//
// WRITE side (record): persists a SystemLog row + resource snapshots. Reads
// the operator from the ALS RequestContext (set by JwtAuthGuard). Cycle 3
// extends the row with oid/ipAddress/userAgent/executionTime/errorMessage/
// requestMethod/requestPath — the audit-read contract surface (§104).
//
// READ side:
//   - page(pageNum, pageSize, query)  → { data: [...], total_count }  (§83)
//   - getOptions()                     → [{id, name}]  operation-type options
//   - export(query)                    → xlsx Buffer (controller streams via @Res())
//
// Query filter (configParams() in audit/index.vue:100-119): `__`-joined
// multi-value strings for opt_type_list/uid_list/oid_list/log_status/time_range
// + a `name` keyword. Parsed in the service into a Prisma where.
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { RequestContext } from '../common/context/request-context';
import {
  toAuditLogSnake,
  type AuditLogRow,
  type AuditLogSnake,
} from './audit-snake-mapper';
import { OperationType } from './operation.enum';
import type { LogResource } from './log-config.interface';
import { tr } from '../common/i18n/translate';

/** WRITE-side entry — what SystemLogInterceptor passes to record(). */
export interface AuditEntry {
  module: string;
  type: string;
  status: 'success' | 'failed';
  detail?: string;
  resources?: LogResource[];
  // §104 audit-read contract fields (captured by the interceptor):
  oid?: number | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  executionTime?: number | null;
  errorMessage?: string | null;
  requestMethod?: string | null;
  requestPath?: string | null;
  remark?: string | null;
}

/** READ-side query — the parsed @Query() object from the page/export routes.
 *  Each multi-value field arrives as a `__`-joined string (e.g.
 *  'login__logout'); the service splits them. Plain interface (no DTO class) →
 *  ValidationPipe passthrough (§101). */
export interface AuditLogQuery {
  name?: string;
  opt_type_list?: string;
  uid_list?: string;
  oid_list?: string;
  log_status?: string;
  time_range?: string;
}

/** Parsed Prisma where built from an AuditLogQuery. */
interface AuditWhere {
  where: Prisma.SystemLogWhereInput;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── WRITE SIDE ─────────────────────────────

  /** Persist a SystemLog row + nested resource snapshots. Called by
   *  SystemLogInterceptor on every @SystemLog-decorated handler (success or
   *  fail). Audit must never break the request flow — log and swallow. */
  async record(entry: AuditEntry): Promise<void> {
    const user = RequestContext.getUser();
    try {
      await this.prisma.systemLog.create({
        data: {
          module: entry.module,
          type: entry.type,
          status: entry.status,
          operatorId: user?.id ?? null,
          operator: user?.account ?? null,
          detail: entry.detail ?? null,
          oid: entry.oid ?? user?.oid ?? null,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent ?? null,
          executionTime: entry.executionTime ?? null,
          errorMessage: entry.errorMessage ?? null,
          requestMethod: entry.requestMethod ?? null,
          requestPath: entry.requestPath ?? null,
          remark: entry.remark ?? null,
          resources: entry.resources?.length
            ? {
                create: entry.resources.map((r) => ({
                  name: r.name ?? null,
                  originId: r.originId != null ? String(r.originId) : null,
                  originStr: r.originStr ?? null,
                })),
              }
            : undefined,
        },
      });
    } catch (e) {
      this.logger.error(`Failed to record audit log: ${(e as Error).message}`);
    }
  }

  // ───────────────────────────── READ SIDE ─────────────────────────────

  /** Paginated audit log list. Returns `{ data, total_count }` (§83
   *  data/total_count family — NOT items/total). Filters via `__`-joined
   *  multi-value query fields. */
  async page(
    pageNum: number,
    pageSize: number,
    query: AuditLogQuery,
  ): Promise<{ data: AuditLogSnake[]; total_count: number }> {
    const { where } = this.buildWhere(query);
    const [total, rows] = await this.prisma.$transaction(
      [
        this.prisma.systemLog.count({ where }),
        this.prisma.systemLog.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (pageNum - 1) * pageSize,
          take: pageSize,
          include: { resources: { select: { name: true } } },
        }),
      ],
      // Count + page must come from one snapshot: under READ COMMITTED a
      // concurrent audit write can land between the two statements and make
      // total_count disagree with the returned rows.
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const oidNameMap = await this.buildOidNameMap(rows);
    return {
      data: rows.map((r) => toAuditLogSnake(r as AuditLogRow, oidNameMap)),
      total_count: total,
    };
  }

  /** Operation-type options for the audit page's tree-select filter
   *  (filterOption[0] = opt_type_list). Returns a flat `[{id, name}]` array —
   *  the frontend spreads `[...res]` into the tree-select's option list.
   *  The options are derived from the OperationType enum. `id` is the
   *  lowercase type string (matches what's
   *  stored in SystemLog.type + what the filter sends); `name` is the
   *  capitalized display (no backend i18n — §104 deviation). */
  getOptions(): { id: string; name: string }[] {
    return Object.values(OperationType).map((type) => ({
      id: type,
      name: type.charAt(0).toUpperCase() + type.slice(1),
    }));
  }

  /** Build an xlsx buffer of all rows matching the filter (no pagination —
   *  the full filtered set). Mirrors chat.service's
   *  exportRecordExcel pattern. The controller streams the buffer via @Res()
   *  with the xlsx content-type + disposition (bypasses TransformInterceptor
   *  via headersSent, §18/§104). */
  async export(query: AuditLogQuery): Promise<Buffer> {
    const { where } = this.buildWhere(query);
    const rows = await this.prisma.systemLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: { resources: { select: { name: true } } },
    });
    const oidNameMap = await this.buildOidNameMap(rows);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('SystemLog');
    ws.columns = [
      {
        header: tr('audit.col_operation_type'),
        key: 'operation_type_name',
        width: 14,
      },
      {
        header: tr('audit.col_operation_detail'),
        key: 'operation_detail_info',
        width: 40,
      },
      { header: tr('audit.col_operation_user'), key: 'user_name', width: 16 },
      { header: tr('audit.col_workspace'), key: 'oid_name', width: 16 },
      {
        header: tr('audit.col_status'),
        key: 'operation_status_name',
        width: 10,
      },
      { header: 'IP地址', key: 'ip_address', width: 16 },
      { header: tr('audit.col_operation_time'), key: 'create_time', width: 22 },
    ];
    for (const row of rows) {
      const snake = toAuditLogSnake(row, oidNameMap);
      ws.addRow({
        ...snake,
        // Format epoch-ms as a readable ISO string for the spreadsheet.
        create_time: new Date(snake.create_time).toISOString(),
      });
    }
    const buffer = await wb.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  /** Parse the `__`-joined multi-value AuditLogQuery into a Prisma where.
   *  Filter fields (per audit/index.vue:157-204 filterOption):
   *    - name (keyword)  → OR across detail/operator/resources[].name
   *    - opt_type_list   → type IN
   *    - uid_list        → operatorId IN
   *    - oid_list        → oid IN
   *    - log_status      → status IN
   *    - time_range      → createdAt BETWEEN (two unix-ms values)
   *  name filters use PostgreSQL ILIKE (case-insensitive). */
  private buildWhere(query: AuditLogQuery): AuditWhere {
    const where: Prisma.SystemLogWhereInput = {};
    if (query.name) {
      const kw = query.name;
      where.OR = [
        { detail: { contains: kw, mode: 'insensitive' } },
        { operator: { contains: kw, mode: 'insensitive' } },
        {
          resources: {
            some: { name: { contains: kw, mode: 'insensitive' } },
          },
        },
      ];
    }
    if (query.opt_type_list) {
      where.type = { in: query.opt_type_list.split('__') };
    }
    if (query.uid_list) {
      where.operatorId = {
        in: query.uid_list.split('__').map((n) => Number(n)),
      };
    }
    if (query.oid_list) {
      where.oid = { in: query.oid_list.split('__').map((n) => Number(n)) };
    }
    if (query.log_status) {
      where.status = { in: query.log_status.split('__') };
    }
    if (query.time_range) {
      const parts = query.time_range.split('__').map((n) => Number(n));
      if (parts.length === 2 && parts.every((n) => !Number.isNaN(n))) {
        where.createdAt = {
          gte: new Date(parts[0]),
          lte: new Date(parts[1]),
        };
      }
    }
    return { where };
  }

  /** Build a workspace id → name map for the distinct non-null oids in the
   *  page. Used by the mapper to resolve `oid_name` without an N+1 per row. */
  private async buildOidNameMap(
    rows: { oid?: number | null }[],
  ): Promise<Map<number, string>> {
    const oids = Array.from(
      new Set(rows.map((r) => r.oid).filter((o): o is number => o != null)),
    );
    if (oids.length === 0) return new Map();
    const workspaces = await this.prisma.workspace.findMany({
      where: { id: { in: oids } },
      select: { id: true, name: true },
    });
    return new Map(workspaces.map((w) => [w.id, w.name]));
  }
}
