// Regression suite admin API (MetaDataImprove M6). Workspace admins manage
// the standard-question cases, start runs, inspect the baseline diffs and
// promote a run's aggregates as the new baseline. Auto-triggering on
// governance approvals is wired in the semantic/metric services (via
// RegressionTriggerService), not here.
import {
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
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { RegressionService } from './regression.service';

export class RegressionCaseUpsertDto {
  @IsOptional()
  @IsInt()
  id?: number;

  @IsInt()
  datasource_id!: number;

  @IsString()
  @MaxLength(100)
  name!: string;

  @IsString()
  @MaxLength(500)
  question!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  metric_code?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  tolerance_pct?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

@Controller('system/regression')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class RegressionController {
  constructor(private readonly regression: RegressionService) {}

  /** Case list (optionally filtered by datasource). */
  @Get()
  listCases(
    @CurrentUser('oid') oid: number,
    @Query('datasource_id') datasourceId?: string,
    @Query('current_page') currentPage = '1',
    @Query('page_size') pageSize = '20',
  ) {
    return this.regression.pageCases(
      oid,
      datasourceId ? Number(datasourceId) : undefined,
      Math.max(1, Number(currentPage) || 1),
      Math.min(100, Math.max(1, Number(pageSize) || 20)),
    );
  }

  /** Create/update a case. */
  @Put()
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.UPDATE,
    detail: '保存回归用例',
  })
  upsert(
    @CurrentUser('oid') oid: number,
    @CurrentUser('id') uid: number,
    @Body() dto: RegressionCaseUpsertDto,
  ) {
    return this.regression.upsertCase(oid, uid, {
      id: dto.id,
      datasourceId: dto.datasource_id,
      name: dto.name,
      question: dto.question,
      metricCode: dto.metric_code,
      tolerancePct: dto.tolerance_pct,
      enabled: dto.enabled,
    });
  }

  /** Delete a case (its run history cascades). */
  @Delete(':id')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.DELETE,
    detail: '删除回归用例',
  })
  remove(
    @CurrentUser('oid') oid: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.regression.removeCase(oid, id);
  }

  /** Enable/disable a case without deleting it. */
  @Post(':id/enable/:enabled')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.ENABLE,
    detail: '切换回归用例状态',
  })
  setEnabled(
    @CurrentUser('oid') oid: number,
    @Param('id', ParseIntPipe) id: number,
    @Param('enabled') enabled: string,
  ) {
    return this.regression.setCaseEnabled(oid, id, enabled === 'true');
  }

  /** Start a manual run now (executes in the background; poll runs). */
  @Post('run')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.SYNC,
    detail: '手动触发回归运行',
  })
  run(@CurrentUser('oid') oid: number, @CurrentUser('id') uid: number) {
    return this.regression.startRun(oid, 'manual', { actor_uid: uid });
  }

  /** Run history (newest first). */
  @Get('runs')
  listRuns(
    @CurrentUser('oid') oid: number,
    @Query('current_page') currentPage = '1',
    @Query('page_size') pageSize = '20',
  ) {
    return this.regression.listRuns(
      oid,
      Math.max(1, Number(currentPage) || 1),
      Math.min(100, Math.max(1, Number(pageSize) || 20)),
    );
  }

  /** One run's per-case diff (baseline vs current aggregates). */
  @Get('run/:id')
  runDetail(
    @CurrentUser('oid') oid: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.regression.runDetail(oid, id);
  }

  /** Adopt a finished run's aggregates as the new baselines. */
  @Post('run/:id/promote')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.UPDATE,
    detail: '采纳回归结果为基准',
  })
  promote(
    @CurrentUser('oid') oid: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.regression.promote(oid, id);
  }
}
