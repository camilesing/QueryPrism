// Query budget admin API (MetaDataImprove M7). Workspace admins configure
// per-subject daily LLM character limits (workspace default / user / MCP
// integration / embedded assistant) and watch today's usage. Enforcement
// itself lives in ChatService's generator wrapper via
// QuotaService.reserveChars/chargeChars.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsInt, IsIn, IsOptional, IsPositive, Max, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { BUDGET_SUBJECT_TYPES } from './quota-policy';
import { QuotaService } from './quota.service';

export class QueryBudgetUpsertDto {
  @IsIn([...BUDGET_SUBJECT_TYPES])
  subject_type!: string;

  /** null/omitted only valid for subject_type 'default'. */
  @IsOptional()
  @IsInt()
  @Min(1)
  subject_id?: number | null;

  @IsInt()
  @IsPositive()
  @Max(100_000_000)
  daily_limit!: number;
}

@Controller('system/quota')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  /** Budget rows + today's usage for the workspace. */
  @Get()
  overview(@CurrentUser('oid') oid: number) {
    return this.quota.overview(oid);
  }

  /** Upsert one budget row. */
  @Put()
  @SystemLog({
    module: OperationModule.QUOTA,
    type: OperationType.UPDATE,
    detail: '更新 LLM 字数预算',
  })
  upsert(
    @CurrentUser('oid') oid: number,
    @CurrentUser('id') uid: number,
    @Body() dto: QueryBudgetUpsertDto,
  ) {
    return this.quota.upsertBudget(oid, uid, {
      subject_type: dto.subject_type,
      subject_id: dto.subject_id ?? null,
      daily_limit: dto.daily_limit,
    });
  }

  /** Remove one budget row (subject falls back to default / unlimited). */
  @Delete(':id')
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.QUOTA,
    type: OperationType.DELETE,
    detail: '删除 LLM 字数预算',
  })
  remove(
    @CurrentUser('oid') oid: number,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.quota.removeBudget(oid, id);
  }
}
