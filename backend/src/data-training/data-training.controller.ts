// DataTraining HTTP routes — implements the `system/data-training` API
// contract. @Controller('system/data-training') (kebab-case). 7 routes,
// static-before-dynamic (page/export/template before :id/enable/:enabled;
// no @Get(':id') — the frontend's getOne is dead code, dropped).
//
// recall() + getDataTrainingTemplate() are NOT exposed as HTTP routes: the
// chat pipeline (ai-question.service) injects DataTrainingService + calls
// getDataTrainingTemplate() directly (non-HTTP DI). The pre-parity
// @Get('recall')/@Get('template') XML-string HTTP routes were dead code and
// are dropped (the /template URL is repurposed for the Excel template blob).
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
  DataTrainingService,
  type DataTrainingInfo,
} from './data-training.service';
import { tr } from '../common/i18n/translate';

const XLSX_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Normalize a repeated query param (`?ds_list=1&ds_list=2`) — Express collects
 *  same-name params into an array; single values arrive as a string — into a
 *  de-duplicated number[] (same pattern as terminology's ds_list/adv_list). */
function toIdList(value?: string | string[]): number[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value])
    .map((v) => Number(v))
    .filter((n) => !Number.isNaN(n));
}

@Controller('system/data-training')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class DataTrainingController {
  constructor(private readonly dataTrainingService: DataTrainingService) {}

  /** GET /system/data-training/page/:current_page/:page_size?question=&ds_list=&adv_list=
   *  Single keyword `question` query param; `ds_list`/`adv_list` are REPEATED
   *  query params (datasource in / advancedApplication in,
   *  AND-combined with the keyword). Returns the pager shape {current_page,
   *  page_size, total_count, total_pages, data}. */
  @Get('page/:current_page/:page_size')
  page(
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
    @Query('question') question?: string,
    @Query('ds_list') dsList?: string | string[],
    @Query('adv_list') advList?: string | string[],
  ) {
    return this.dataTrainingService.page(
      currentPage,
      pageSize,
      question,
      toIdList(dsList),
      toIdList(advList),
    );
  }

  /** GET /system/data-training/export?question=&ds_list=&adv_list= → xlsx blob
   *  (export honors the same filters as the page). @Res() (no
   *  passthrough) bypasses the envelope interceptor — correct for a binary
   *  download (same as chat/audit/terminology export routes). */
  @Get('export')
  @SystemLog({
    module: OperationModule.DATA_TRAINING,
    type: OperationType.EXPORT,
    detail: '导出 SQL 样例',
  })
  async exportExcel(
    @Query('question') question: string | undefined,
    @Query('ds_list') dsList: string | string[] | undefined,
    @Query('adv_list') advList: string | string[] | undefined,
    @Res() res: Response,
  ) {
    const buffer = await this.dataTrainingService.exportAll(
      question,
      toIdList(dsList),
      toIdList(advList),
    );
    res.set('Content-Type', XLSX_TYPE);
    res.set('Content-Disposition', 'attachment; filename="data-training.xlsx"');
    res.send(buffer);
  }

  /** GET /system/data-training/template → xlsx blob (1 sample row). Same
   *  @Res() bypass as export. */
  @Get('template')
  async template(@Res() res: Response) {
    const buffer = await this.dataTrainingService.getTemplate();
    res.set('Content-Type', XLSX_TYPE);
    res.set(
      'Content-Disposition',
      'attachment; filename="data-training-template.xlsx"',
    );
    res.send(buffer);
  }

  /** GET /system/data-training/:id/enable/:enabled (path string 'true'/
   *  'false', NOT PATCH body — mirrors terminology's enable route). */
  @Get(':id/enable/:enabled')
  @SystemLog({
    module: OperationModule.DATA_TRAINING,
    type: OperationType.ENABLE,
    detail: '切换 SQL 样例启用状态',
  })
  enable(
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.dataTrainingService.setEnabled(id, enabled === 'true');
  }

  /** Create (no id) or update (with id) a SQL sample. Body is the snake_case
   *  DataTrainingInfo (plain interface, no DTO class → ValidationPipe
   *  passthrough, §101). Returns the row (the @SystemLog resources callback
   *  reads question+id). */
  @Put('')
  @SystemLog({
    module: OperationModule.DATA_TRAINING,
    type: OperationType.CREATE,
    detail: '新建/更新 SQL 样例',
    resources: (r) => {
      const t = r as { id: number; question: string };
      return [{ name: t.question, originId: t.id }];
    },
  })
  upsert(@Body() info: DataTrainingInfo) {
    return this.dataTrainingService.upsert(info);
  }

  /** Batch-delete SQL samples by id. Body is a BARE ARRAY `[id1, id2, ...]`
   *  (the frontend sends `multipleSelectionAll.map(e => e.id)`). Returns
   *  `[{id}]` for the @SystemLog DELETE callback (mirrors terminology). */
  @Delete('')
  @SystemLog({
    module: OperationModule.DATA_TRAINING,
    type: OperationType.DELETE,
    detail: '删除 SQL 样例',
    resources: (r) => {
      const arr = (r ?? []) as { id: number }[];
      return arr.map((x) => ({ name: String(x.id), originId: x.id }));
    },
  })
  remove(@Body() ids: number[]) {
    return this.dataTrainingService.remove(ids);
  }

  /** Bulk import SQL samples from an xlsx file. Multipart field name `file`
   *  (el-upload default). Returns the
   *  summary the el-upload `onSuccess(response)` reads as `response.data.*`
   *  — the global TransformInterceptor envelope wraps it (el-upload does its
   *  own XHR, so the envelope is what the Uploader unpacks). */
  @Post('uploadExcel')
  @HttpCode(200) // §91: POST routes return 200, not NestJS's default 201.
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.DATA_TRAINING,
    type: OperationType.IMPORT,
    detail: '批量导入 SQL 样例',
  })
  uploadExcel(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException(tr('common.file_required'));
    }
    return this.dataTrainingService.importExcel(file.buffer);
  }
}
