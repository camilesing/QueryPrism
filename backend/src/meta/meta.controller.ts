// MetaController — the authenticated external metadata ingestion API
// (MetaDataImprove M2 ingestion channel: "expose the API Post into data
// (with authentication)"). ApiKeyGuard authenticates the per-user key pair;
// each row carries its own scope (default WORKSPACE) and is written directly
// only when the key owner may edit that layer: PERSONAL (own rows), WORKSPACE
// (workspace admin), GLOBAL (system admin). Unauthorized rows fail and are
// reported — they never become pending proposals.
//
// Response protocol note: this controller RETURNS data (JSON envelope via
// TransformInterceptor), unlike the SSE chat routes.
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import {
  SemanticImportService,
  type SemanticImportRow,
} from '../semantic/semantic-import.service';
import {
  MetricImportService,
  type MetricImportRow,
  type StandardImportRow,
} from '../semantic/metric-import.service';
import { RegressionService } from '../regression/regression.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { CurrentUserInfo } from '../common/context/request-context';

@Controller('meta')
@UseGuards(ApiKeyGuard)
export class MetaController {
  constructor(
    private readonly importService: SemanticImportService,
    private readonly metricImportService: MetricImportService,
    private readonly regressionService: RegressionService,
  ) {}

  /** Batch semantic import: array of rows, per-row `scope` (default WORKSPACE).
   *  Returns {applied, by_scope, failed:[{row, reason}]} — one bad row never
   *  aborts. */
  @Post('semantic/import')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.SEMANTIC,
    type: OperationType.IMPORT,
    detail: 'API 导入语义',
  })
  importSemantics(@Body() rows: SemanticImportRow[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('body must be a non-empty row array');
    }
    if (rows.length > 5000) {
      throw new BadRequestException('batch limit is 5000 rows');
    }
    return this.importService.importJson(rows);
  }

  /** Batch metric import (MetaDataImprove M4): per-row `scope` (default
   *  WORKSPACE). */
  @Post('metric/import')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.IMPORT,
    detail: 'API 导入指标',
  })
  importMetrics(@Body() rows: MetricImportRow[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('body must be a non-empty row array');
    }
    if (rows.length > 5000) {
      throw new BadRequestException('batch limit is 5000 rows');
    }
    return this.metricImportService.importJsonMetrics(rows);
  }

  /** Batch data-standard import (MetaDataImprove M4): units + naming. */
  @Post('standard/import')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METRIC,
    type: OperationType.IMPORT,
    detail: 'API 导入数据标准',
  })
  importStandards(@Body() rows: StandardImportRow[]) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException('body must be a non-empty row array');
    }
    if (rows.length > 5000) {
      throw new BadRequestException('batch limit is 5000 rows');
    }
    return this.metricImportService.importJsonStandards(rows);
  }

  /** Trigger a regression run for the key owner's workspace (MetaDataImprove
   *  M6): the hook future CI pipelines call after applying metadata changes.
   *  Returns the run id immediately — poll GET /system/regression/runs for
   *  the outcome (admin JWT) or reuse the run id in later tooling. */
  @Post('regression/run')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.REGRESSION,
    type: OperationType.SYNC,
    detail: 'API 触发回归运行',
  })
  runRegression(@CurrentUser() user: CurrentUserInfo) {
    return this.regressionService.startApiRun(user);
  }
}
