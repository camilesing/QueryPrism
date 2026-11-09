// StandardController — the M4 data-standards admin surface (`system/standard`,
// kinds: unit 度量单位 | naming 命名词典). Same guard/authority rationale as
// MetricController; the shared approval inbox + review route live on
// MetricController.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { StandardUpsertDto } from '../common/dtos';
import { DataStandardService } from './standard.service';

@Controller('system/standard')
@UseGuards(JwtAuthGuard)
export class StandardController {
  constructor(private readonly standardService: DataStandardService) {}

  /** Paginated data-standard list of one kind (visible layers only). */
  @Get('page/:kind/:current_page/:page_size')
  page(
    @Param('kind') kind: string,
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
    @Query('scope') scope?: string,
    @Query('category') category?: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.standardService.page(kind as never, currentPage, pageSize, {
      scope,
      category,
      keyword,
    });
  }

  /** Version history of one entry (newest first). */
  @Get('versions/:id')
  versions(@Param('id', ParseIntPipe) id: number) {
    return this.standardService.versions(id);
  }

  /** Upsert — direct edit on the actor's own authority, proposal otherwise. */
  @Put()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.UPDATE,
    detail: '保存数据标准',
  })
  upsert(@Body() dto: StandardUpsertDto) {
    return this.standardService.upsert(dto);
  }

  /** Delete by ids — direct rows vanish, upper-layer rows become requests. */
  @Delete()
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.DELETE,
    detail: '删除数据标准',
  })
  remove(@Body() ids: number[]) {
    return this.standardService.remove(
      Array.isArray(ids) ? ids.filter((n) => Number.isInteger(n)) : [],
    );
  }

  /** Enable/disable toggle. */
  @Get(':id/enable/:enabled')
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.ENABLE,
    detail: '切换数据标准启停',
  })
  setEnabled(
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.standardService.setEnabled(
      id,
      enabled === 'true' || enabled === '1',
    );
  }
}
