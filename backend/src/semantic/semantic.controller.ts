// SemanticController — the M2 effective-semantics admin surface
// (`system/semantic`). JwtAuthGuard at class level (every route needs a user —
// PERSONAL rows are per-uid); scope authority is enforced INSIDE the service
// (canEditDirect / canReview) because the same route serves direct edits,
// proposals and reviews depending on the actor's layer. Route permission is
// therefore deliberately NOT WsAdminGuard — members must reach their own
// PERSONAL layer and the proposal/review queue.
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
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { SemanticReviewDto, SemanticUpsertDto } from '../common/dtos';
import { SemanticService } from './semantic.service';
import { SemanticImportService } from './semantic-import.service';

@Controller('system/semantic')
@UseGuards(JwtAuthGuard)
export class SemanticController {
  constructor(
    private readonly semanticService: SemanticService,
    private readonly importService: SemanticImportService,
  ) {}

  /** Paginated entity list (visible layers only). */
  @Get('page/:entity_type/:current_page/:page_size')
  page(
    @Param('entity_type') entityType: 'table' | 'field',
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
    @Query('scope') scope?: string,
    @Query('datasource_id') datasourceId?: string,
    @Query('keyword') keyword?: string,
  ) {
    const dsId = datasourceId ? Number(datasourceId) : undefined;
    return this.semanticService.page(
      entityType === 'field' ? 'field' : 'table',
      currentPage,
      pageSize,
      {
        scope,
        datasourceId: Number.isFinite(dsId) && dsId! > 0 ? dsId : undefined,
        keyword,
      },
    );
  }

  /** Approval inbox. `box=pending` = requests this actor may review;
   *  `box=mine` = this actor's own proposals (any status). */
  @Get('requests/:box/:current_page/:page_size')
  requests(
    @Param('box') box: 'pending' | 'mine',
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
  ) {
    return this.semanticService.pageRequests(
      box === 'mine' ? 'mine' : 'pending',
      currentPage,
      pageSize,
    );
  }

  /** Version history of one entity (newest first). */
  @Get('versions/:entity_type/:id')
  versions(
    @Param('entity_type') entityType: 'table' | 'field',
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.semanticService.versions(
      entityType === 'field' ? 'field' : 'table',
      id,
    );
  }

  /** Upsert — direct edit on the actor's own authority, proposal otherwise.
   *  Returns {applied:true,id} or {applied:false,request_id}. */
  @Put()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.UPDATE,
    detail: '保存语义',
  })
  upsert(@Body() dto: SemanticUpsertDto) {
    return this.semanticService.upsert(dto);
  }

  /** Review a pending proposal (approve applies + closes in one tx). */
  @Put('request/review')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.UPDATE,
    detail: '审批语义提案',
  })
  review(@Body() dto: SemanticReviewDto) {
    return this.semanticService.review(dto.id, dto.approve, dto.review_note);
  }

  /** Delete by ids — direct rows vanish, upper-layer rows become requests. */
  @Delete()
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.DELETE,
    detail: '删除语义',
  })
  remove(
    @Query('entity_type') entityType: 'table' | 'field',
    @Body() ids: number[],
  ) {
    return this.semanticService.remove(
      entityType === 'field' ? 'field' : 'table',
      Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [],
    );
  }

  /** Enable/disable toggle. */
  @Get(':entity_type/:id/enable/:enabled')
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.ENABLE,
    detail: '切换语义启停',
  })
  setEnabled(
    @Param('entity_type') entityType: 'table' | 'field',
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.semanticService.setEnabled(
      entityType === 'field' ? 'field' : 'table',
      id,
      enabled === 'true' || enabled === '1',
    );
  }

  /** Export the actor-visible rows to xlsx (two sheets, scope column). */
  @Get('export')
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.EXPORT,
    detail: '导出语义',
  })
  async export(@Res() res: Response): Promise<void> {
    const buf = await this.importService.exportAll();
    res.set({
      'Content-Type': SemanticImportService.XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="semantics.xlsx"',
    });
    res.send(buf);
  }

  /** Excel import — per-row `scope` (default WORKSPACE) + `enabled`; each row
   *  is written only when the actor may edit that layer. Failures are reported
   *  in the response, one bad row never aborts the batch. */
  @Post('uploadExcel')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.IMPORT,
    detail: '导入语义',
  })
  uploadExcel(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('file is required');
    }
    return this.importService.importExcel(file.buffer);
  }

  /** Dimension-enum collection (MetaDataImprove M3.3): one bounded DISTINCT
   *  probe per visible dimension field of the datasource, backfilling
   *  enumValues on the rows the actor may edit directly. Rate-limited per
   *  datasource (semantic.enum_cooldown); the response reports per-field
   *  collected/skipped outcomes. */
  @Post('collect_enum/:datasource_id')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.IMPORT,
    detail: '采集维度枚举',
  })
  collectEnum(@Param('datasource_id', ParseIntPipe) datasourceId: number) {
    return this.semanticService.collectEnums(datasourceId);
  }
}
