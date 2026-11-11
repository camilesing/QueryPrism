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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { MetadataSyncUpsertDto } from '../common/dtos/metadata-sync.dto';
import { MetadataSyncService } from './metadata-sync.service';
import { MetadataSyncRunnerService } from './metadata-sync-runner.service';

/** External metadata sync admin API (MetaDataImprove M5). Workspace admins
 *  only; secrets are write-only (`has_auth` in responses). */
@Controller('system/metadata-sync')
@UseGuards(JwtAuthGuard, WsAdminGuard)
export class MetadataSyncController {
  constructor(
    private readonly sync: MetadataSyncService,
    private readonly runner: MetadataSyncRunnerService,
  ) {}

  @Get()
  list() {
    return this.sync.list();
  }

  @Get(':id/runs/:current_page/:page_size')
  runs(
    @Param('id', ParseIntPipe) id: number,
    @Param('current_page', ParseIntPipe) currentPage: number,
    @Param('page_size', ParseIntPipe) pageSize: number,
  ) {
    return this.sync.listRuns(id, currentPage, pageSize);
  }

  @Post()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METADATA_SYNC,
    type: OperationType.CREATE,
    detail: '新增元数据同步源',
    resources: (r) => {
      const item = r as { id: number; name: string };
      return [{ name: item.name, originId: item.id }];
    },
  })
  create(@Body() dto: MetadataSyncUpsertDto) {
    return this.sync.create(dto);
  }

  @Put()
  @HttpCode(200)
  @SystemLog({
    module: OperationModule.METADATA_SYNC,
    type: OperationType.UPDATE,
    detail: '修改元数据同步源',
    resources: (r) => {
      const item = r as { id: number; name: string };
      return [{ name: item.name, originId: item.id }];
    },
  })
  update(@Body() dto: MetadataSyncUpsertDto) {
    return this.sync.update(dto);
  }

  @Delete(':id')
  @SystemLog({
    module: OperationModule.METADATA_SYNC,
    type: OperationType.DELETE,
    detail: '删除元数据同步源',
    resources: (r) => {
      const item = r as { id: number; name: string };
      return [{ name: item.name, originId: item.id }];
    },
  })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.sync.remove(id);
  }

  /** Manual trigger. The runner writes its own audit row (manual + cron).
   *  `oid` is the caller's current workspace: the runner rejects a source id
   *  from another tenant (a workspace admin must not run foreign sources). */
  @Post(':id/run')
  @HttpCode(200)
  run(@Param('id', ParseIntPipe) id: number, @CurrentUser('oid') oid: number) {
    return this.runner.run(id, 'manual', oid);
  }
}
