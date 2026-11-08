// audit.controller — Phase 10c cycle 3 §82/§83/§88/§91/§104. Aligned to the
// `system/audit` contract (frontend views/system/audit/index.vue is source
// of truth). The controller assembles the snake_case wire shape via the
// mapper (§77/§88) + delegates Prisma to the service.
//
// 3 read-only GET routes (NO create/update/delete — audit logs are appended
// only by the SystemLogInterceptor as a side-effect of other modules' @SystemLog
// operations; the audit module exposes no mutation routes):
//   - GET /system/audit/page/:pageNum/:pageSize  → { data:[...], total_count }
//   - GET /system/audit/get_options               → [{id, name}]  (tree-select)
//   - GET /system/audit/export                    → xlsx blob (bypass envelope)
//
// `@Controller('system/audit')` (§82 — system/* prefix). Export uses `@Res()`
// (non-passthrough) + `res.send(buf)` — sets headersSent so the global
// TransformInterceptor bypasses the success envelope (§18 SSE pattern; chat.
// controller.exportRecord mirrors the same xlsx-streaming approach).
import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { AuditService, type AuditLogQuery } from './audit.service';
import type { AuditLogSnake } from './audit-snake-mapper';

@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('system/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** Paginated audit log list. `@Query()` is a plain object (no DTO class —
   *  ValidationPipe passthrough, §101). Multi-value filters arrive as
   *  `__`-joined strings, parsed in the service. Returns `{data, total_count}`
   *  (§83 data/total_count family — NOT items/total). */
  @Get('page/:pageNum/:pageSize')
  page(
    @Param('pageNum', ParseIntPipe) pageNum: number,
    @Param('pageSize', ParseIntPipe) pageSize: number,
    @Query() query: AuditLogQuery = {},
  ): Promise<{ data: AuditLogSnake[]; total_count: number }> {
    return this.audit.page(pageNum, pageSize, query);
  }

  /** Operation-type options for the audit page's tree-select filter
   *  (audit/index.vue:249-253 `filterOption[0].option = [...res]`). Returns a
   *  bare array `[{id, name}]`. The success envelope wraps it; the frontend's
   *  axios interceptor unwraps `data` when `code === 0`, yielding the array. */
  @Get('get_options')
  getOptions(): { id: string; name: string }[] {
    return this.audit.getOptions();
  }

  /** Export the filtered audit log to xlsx. `@Res()` (non-passthrough) +
   *  `res.send(buf)` — sets headersSent before TransformInterceptor's map
   *  runs, so the success envelope is bypassed (§18). The frontend requests
   *  with `responseType: 'blob'` + `customError: true`; on success it wraps the
   *  raw blob and downloads as `system_log.xlsx`. */
  @Get('export')
  async export(
    @Query() query: AuditLogQuery = {},
    @Res() res: Response,
  ): Promise<void> {
    const buf = await this.audit.export(query);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="system_log.xlsx"`,
    });
    res.send(buf);
  }
}
