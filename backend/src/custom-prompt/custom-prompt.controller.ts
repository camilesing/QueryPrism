// custom-prompt.controller — implements the `system/custom_prompt` API,
// from the frontend contract (api/prompt.ts promptApi +
// views/system/prompt/index.vue).
//
// 6 routes (system/* prefix; static segments before dynamic):
//   - GET    /system/custom_prompt/template              → xlsx blob
//   - PUT    /system/custom_prompt       (body CustomPromptInfo; id? → create|update)
//   - DELETE /system/custom_prompt       (body bare array [ids])
//   - POST   /system/custom_prompt/:type/page/:pageNum/:pageSize
//        (body { name?, ds_list?, adv_list? })
//        → { current_page, page_size, total_count, total_pages, data: CustomPromptSnake[] }
//   - POST   /system/custom_prompt/:type/export (body { name?, ds_list?, adv_list? })
//        → xlsx blob
//   - POST   /system/custom_prompt/:type/uploadExcel     (multipart field `file`)
//
// DROPPED: GET /system/custom_prompt/:id (frontend `getOne` is dead code —
// frontend never calls it). The
// pre-upgrade non-standard `?name=foo_5_12&dslist=5_12` GET contract
// (parseQueryFilters) is REPLACED by the POST-body contract
// (getList/export2Excel post { name, ds_list, adv_list } via
// request.post(url, params)).
//
// `@Res()` (non-passthrough) + `res.send(buf)` sets headersSent so the global
// TransformInterceptor bypasses the success envelope (§18; mirrors terminology
// §105 export/template). The upload handler returns the summary dict directly —
// the envelope wraps it, and el-upload (which does its own XHR) reads
// `response.data.*`.
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
  CustomPromptService,
  type CustomPromptInfo,
  type CustomPromptQueryFilters,
} from './custom-prompt.service';
import { tr } from '../common/i18n/translate';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@UseGuards(JwtAuthGuard, WsAdminGuard)
@Controller('system/custom_prompt')
export class CustomPromptController {
  constructor(private readonly customPromptService: CustomPromptService) {}

  /** Download the xlsx template (1 example row + 5 column headers). Same
   *  blob-via-@Res() pattern as terminology §105. The frontend's Uploader calls
   *  this via `settingsApi.downloadTemplate('/system/custom_prompt/template')`
   *  with `responseType: 'blob'`. Declared before the dynamic `:type/...`
   *  routes so the static `template` segment isn't shadowed (§92). */
  @Get('template')
  async template(@Res() res: Response): Promise<void> {
    const buf = await this.customPromptService.getTemplate();
    res.set({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="custom_prompt_template.xlsx"`,
    });
    res.send(buf);
  }

  /** Create (no id) or update (with id) a custom prompt. Body is the
   *  snake_case CustomPromptInfo (plain interface, no DTO class → ValidationPipe
   *  passthrough, §101). Returns the raw row (the @SystemLog resources callback
   *  reads name+id; the frontend doesn't read the response body — it re-fetches
   *  the page). */
  @Put()
  @SystemLog({
    module: OperationModule.CUSTOM_PROMPT,
    type: OperationType.CREATE,
    detail: '新建/更新自定义提示词',
    resources: (r) => {
      const c = r as { id: number; name: string };
      return [{ name: c.name, originId: c.id }];
    },
  })
  upsert(@Body() info: CustomPromptInfo) {
    return this.customPromptService.upsert(info);
  }

  /** Batch-delete custom prompts by id. Body is a BARE ARRAY `[id1, id2, ...]`
   *  (the frontend sends `multipleSelectionAll.map(e => e.id)` as
   *  `{ data: params }`). Returns the ids for the @SystemLog callback. */
  @Delete()
  @SystemLog({
    module: OperationModule.CUSTOM_PROMPT,
    type: OperationType.DELETE,
    detail: '删除自定义提示词',
    resources: (r) => {
      const arr = (r ?? []) as { id: number }[];
      return arr.map((x) => ({ name: String(x.id), originId: x.id }));
    },
  })
  remove(@Body() ids: number[]) {
    return this.customPromptService.remove(ids);
  }

  /** Paginated per-type custom-prompt list.
   *  POST with a JSON body `{ name?, ds_list?, adv_list? }` (the
   *  frontend's configParams() now returns an object, posted via request.post).
   *  Body is a plain interface → ValidationPipe passthrough. Returns
   *  the full pager shape. */
  @Post(':type/page/:pageNum/:pageSize')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  page(
    @Param('type') type: string,
    @Param('pageNum', ParseIntPipe) pageNum: number,
    @Param('pageSize', ParseIntPipe) pageSize: number,
    @Body() filters: CustomPromptQueryFilters,
  ) {
    return this.customPromptService.page(type, pageNum, pageSize, filters);
  }

  /** Export the filtered per-type list to xlsx.
   *  POST with the same `{ name?, ds_list?, adv_list? }` body.
   *  `@Res()` (non-passthrough) + `res.send(buf)` — sets headersSent before
   *  TransformInterceptor's map runs, so the success envelope is bypassed.
   *  The frontend requests with `responseType: 'blob'` +
   *  `customError: true`. */
  @Post(':type/export')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @SystemLog({
    module: OperationModule.CUSTOM_PROMPT,
    type: OperationType.EXPORT,
    detail: '导出自定义提示词',
  })
  async export(
    @Param('type') type: string,
    @Body() filters: CustomPromptQueryFilters,
    @Res() res: Response,
  ): Promise<void> {
    const buf = await this.customPromptService.exportAll(type, filters);
    res.set({
      'Content-Type': XLSX_TYPE,
      'Content-Disposition': `attachment; filename="custom_prompt_${type}.xlsx"`,
    });
    res.send(buf);
  }

  /** Bulk import custom prompts from an xlsx file. Multipart field name `file`
   *  (el-upload default); auth via the
   *  `X-QUERYPRISM-TOKEN` header (JwtAuthGuard handles it). `type` comes from the
   *  path segment (each imported row gets this type). Returns the summary the
   *  el-upload `onSuccess(response)` reads as `response.data.*` — the global
   *  TransformInterceptor envelope wraps it (el-upload does its own XHR). */
  @Post(':type/uploadExcel')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.CUSTOM_PROMPT,
    type: OperationType.IMPORT,
    detail: '批量导入自定义提示词',
  })
  uploadExcel(
    @Param('type') type: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException(tr('common.file_required'));
    }
    return this.customPromptService.importExcel(type, file.buffer);
  }
}
