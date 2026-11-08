// terminology.controller — implements the `system/terminology` API (the
// frontend views/system/professional/index.vue is the source of truth for the
// wire contract). The controller assembles the snake_case wire shape via
// terminology-snake-mapper + delegates Prisma to the service.
//
// 7 routes (system/* prefix; route ordering: static segments before the
// dynamic `:id/enable/:enabled` so the latter doesn't shadow them):
//   - GET  /system/terminology/page/:current_page/:page_size
//        ?word=&ds_list=&ds_list=&adv_list=  → { current_page, page_size,
//                                   total_count, total_pages, data: TerminologySnake[] }
//   - GET  /system/terminology/export?word=&ds_list=&adv_list=   → xlsx blob (bypass envelope)
//   - GET  /system/terminology/template        → xlsx blob (bypass envelope)
//   - GET  /system/terminology/:id/enable/:enabled  (path-param string)
//   - PUT  /system/terminology      (body TerminologyInfo; id? → create|update)
//   - DELETE /system/terminology     (body bare array [ids])
//   - POST /system/terminology/uploadExcel  (multipart field `file`)
//
// `@Res()` (non-passthrough) + `res.send(buf)` sets headersSent so the global
// TransformInterceptor bypasses the success envelope (§18; mirrors cycle 3
// audit export + chat.controller.exportRecord). The upload handler returns the
// summary dict directly — the envelope wraps it, and el-upload (which does its
// own XHR, NOT through the axios instance) reads `response.data.*`.
//
// The pre-parity `@Get('recall')` + `@Get('template')` (XML string) HTTP routes
// are dropped: the chat pipeline calls TerminologyService.recall() +
// getTerminologyTemplate() via DI (not HTTP). The HTTP `template`
// route is repurposed for the Excel template blob. `@Get(':id')` (frontend
// `getOne`) is dead code (frontend never calls it) — dropped.
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SystemLog } from '../audit/system-log.decorator';
import {
  TerminologyService,
  type TerminologyInfo,
  type TerminologyPage,
} from './terminology.service';
import { tr } from '../common/i18n/translate';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Normalize a repeated query param (`?ds_list=1&ds_list=2`) — Express collects
 *  same-name params into an array; single values arrive as a string — into a
 *  de-duplicated number[]. */
function toIdList(value?: string | string[]): number[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n));
}

@UseGuards(JwtAuthGuard, WsAdminGuard)
@Controller('system/terminology')
export class TerminologyController {
  constructor(private readonly terminologyService: TerminologyService) {}

  /** Paginated terminology list. `word` is a single keyword (ILIKE on parent
   *  word/description); `ds_list`/`adv_list` are REPEATED query params
   *  `?ds_list=1&ds_list=2` (Express collects same-name params into an array —
   *  normalized here). Returns the full pager shape; the frontend reads
   *  `res.data` + `res.total_count`. */
  @Get('page/:current_page/:page_size')
  page(
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
    @Query('word') word?: string,
    @Query('ds_list') dsList?: string | string[],
    @Query('adv_list') advList?: string | string[],
  ): Promise<TerminologyPage> {
    return this.terminologyService.page(
      currentPage,
      pageSize,
      word,
      toIdList(dsList),
      toIdList(advList),
    );
  }

  /** Export the FILTERED terminology list to xlsx (honors the same
   *  word/ds_list/adv_list filters as page). `@Res()` (non-
   *  passthrough) + `res.send(buf)` — sets headersSent before
   *  TransformInterceptor's map runs, so the success envelope is bypassed.
   *  The frontend requests with `responseType: 'blob'` + `customError: true`. */
  @Get('export')
  @SystemLog({
    module: OperationModule.TERMINOLOGY,
    type: OperationType.EXPORT,
    detail: '导出术语',
  })
  async export(
    @Query('word') word: string | undefined,
    @Query('ds_list') dsList: string | string[] | undefined,
    @Query('adv_list') advList: string | string[] | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const buf = await this.terminologyService.exportAll(
      word,
      toIdList(dsList),
      toIdList(advList),
    );
    res.set({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="terminology.xlsx"`,
    });
    res.send(buf);
  }

  /** Download the xlsx template (2 example rows + 6 column headers). Same
   *  blob-via-@Res() pattern as export. The frontend's Uploader calls this via
   *  `settingsApi.downloadTemplate('/system/terminology/template')` with
   *  `responseType: 'blob'`. */
  @Get('template')
  async template(@Res() res: Response): Promise<void> {
    const buf = await this.terminologyService.getTemplate();
    res.set({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="terminology_template.xlsx"`,
    });
    res.send(buf);
  }

  /** Toggle enabled on a parent + its children (a state change performed via
   *  GET); `enabled` is a path-param string `'true'`/`'false'` (the
   *  frontend sends `val + ''`). Declared AFTER the static `export`/`template`
   *  routes so its dynamic `:id` first segment doesn't shadow them. */
  @Get(':id/enable/:enabled')
  @SystemLog({
    module: OperationModule.TERMINOLOGY,
    type: OperationType.ENABLE,
    detail: '切换术语启用状态',
  })
  enable(
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.terminologyService.setEnabled(id, enabled === 'true');
  }

  /** Create (no id) or update (with id) a terminology + reconcile synonym
   *  children. Body is the snake_case TerminologyInfo (plain interface, no DTO
   *  class → ValidationPipe passthrough, §101). Returns the parent row (the
   *  @SystemLog resources callback reads word+id). */
  @Put('')
  @SystemLog({
    module: OperationModule.TERMINOLOGY,
    type: OperationType.CREATE,
    detail: '新建/更新术语',
    resources: (r) => {
      const t = r as { id: number; word: string };
      return [{ name: t.word, originId: t.id }];
    },
  })
  upsert(@Body() info: TerminologyInfo) {
    return this.terminologyService.upsert(info);
  }

  /** Batch-delete terminologies by id. Body is a BARE ARRAY `[id1, id2, ...]`
   *  (the frontend sends `multipleSelectionAll.map(e => e.id)` as
   *  `{ data: params }`). Returns the ids for the @SystemLog callback. */
  @Delete('')
  @SystemLog({
    module: OperationModule.TERMINOLOGY,
    type: OperationType.DELETE,
    detail: '删除术语',
    resources: (r) => {
      const arr = (r ?? []) as { id: number }[];
      return arr.map((x) => ({ name: String(x.id), originId: x.id }));
    },
  })
  remove(@Body() ids: number[]) {
    return this.terminologyService.remove(ids);
  }

  /** Bulk import terminologies from an xlsx file. Multipart field name `file`
   *  (el-upload default); auth via the
   *  `X-QUERYPRISM-TOKEN` header (JwtAuthGuard handles it). Returns the summary
   *  the el-upload `onSuccess(response)` reads as `response.data.*` — the
   *  global TransformInterceptor envelope wraps it (el-upload does its own XHR,
   *  so the envelope is what the Uploader unpacks). */
  @Post('uploadExcel')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.TERMINOLOGY,
    type: OperationType.IMPORT,
    detail: '批量导入术语',
  })
  uploadExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(tr('common.file_required'));
    }
    return this.terminologyService.importExcel(file.buffer);
  }
}
