// MetricController — the M4 metric-system admin surface (`system/metric`).
// JwtAuthGuard at class level (every route needs a user — PERSONAL rows are
// per-uid); scope authority is enforced INSIDE the services (canEditDirect /
// canReview) because the same route serves direct edits, proposals and
// reviews depending on the actor's layer — same rationale as the M2
// SemanticController. The approval inbox lives HERE for BOTH M4 dictionaries
// (metric + standard share one SemanticChangeRequest table); the data
// standards themselves are served by StandardController.
//
// Excel import/export + the ApiKey-guarded /meta ingestion land in the
// ingestion commit (metric-import.service).
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
import { MetricReviewDto, MetricUpsertDto } from '../common/dtos';
import { MetricService } from './metric.service';
import { MetricImportService } from './metric-import.service';

@Controller('system/metric')
@UseGuards(JwtAuthGuard)
export class MetricController {
  constructor(
    private readonly metricService: MetricService,
    private readonly importService: MetricImportService,
  ) {}

  /** Paginated metric list of one kind (visible layers only). */
  @Get('page/:kind/:current_page/:page_size')
  page(
    @Param('kind') kind: string,
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
    @Query('scope') scope?: string,
    @Query('datasource_id') datasourceId?: string,
    @Query('keyword') keyword?: string,
  ) {
    const dsId = datasourceId ? Number(datasourceId) : undefined;
    return this.metricService.page(kind as never, currentPage, pageSize, {
      scope,
      datasourceId: Number.isFinite(dsId) && dsId! > 0 ? dsId : undefined,
      keyword,
    });
  }

  /** Version history of one metric entry (newest first). */
  @Get('versions/:id')
  versions(@Param('id', ParseIntPipe) id: number) {
    return this.metricService.versions(id);
  }

  /** Approval inbox covering BOTH M4 dictionaries (metric + standard).
   *  `box=pending` = requests this actor may review; `box=mine` = this
   *  actor's own proposals (any status). */
  @Get('requests/:box/:current_page/:page_size')
  requests(
    @Param('box') box: 'pending' | 'mine',
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
  ) {
    return this.metricService.pageRequests(
      box === 'mine' ? 'mine' : 'pending',
      currentPage,
      pageSize,
      ['metric', 'standard'],
    );
  }

  /** Upsert a metric — direct edit on the actor's own authority, proposal
   *  otherwise. Returns {applied:true,id} or {applied:false,request_id}. */
  @Put()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.UPDATE,
    detail: '保存指标',
  })
  upsert(@Body() dto: MetricUpsertDto) {
    return this.metricService.upsert(dto);
  }

  /** Review a pending metric/standard proposal (approve applies + closes in
   *  one tx; dispatched by the request's entityType). */
  @Put('request/review')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.UPDATE,
    detail: '审批指标提案',
  })
  review(@Body() dto: MetricReviewDto) {
    return this.metricService.reviewShared(
      dto.id,
      dto.approve,
      dto.review_note,
    );
  }

  /** Delete metrics by ids — direct rows vanish, upper-layer rows become
   *  requests. */
  @Delete()
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.DELETE,
    detail: '删除指标',
  })
  remove(@Body() ids: number[]) {
    return this.metricService.remove(
      Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [],
    );
  }

  /** Enable/disable toggle. */
  @Get(':id/enable/:enabled')
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.ENABLE,
    detail: '切换指标启停',
  })
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.metricService.setEnabled(
      id,
      enabled === 'true' || enabled === '1',
    );
  }

  /** Export the actor-visible metric + standard rows to xlsx (six sheets). */
  @Get('export')
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.EXPORT,
    detail: '导出指标与数据标准',
  })
  async export(@Res() res: Response): Promise<void> {
    const buf = await this.importService.exportAll();
    res.set({
      'Content-Type': MetricImportService.XLSX_TYPE,
      'Content-Disposition': 'attachment; filename="metrics.xlsx"',
    });
    res.send(buf);
  }

  /** Excel import (ws admin) — per-row upsert at WORKSPACE across all six
   *  sheets; failures are reported in the response, one bad row never
   *  aborts the batch. */
  @Post('uploadExcel')
  @HttpCode(200)
  @UseInterceptors(FileInterceptor('file'))
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.IMPORT,
    detail: '导入指标与数据标准',
  })
  uploadExcel(@UploadedFile() file?: Express.Multer.File) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('file is required');
    }
    return this.importService.importExcel(file.buffer);
  }
}
