// Table-relation controller. Aligned to the frontend's
// `frontend/src/api/datasource.ts` (relationGet/relationSave). The persisted
// shape is the raw X6 `graph.toJSON().cells` array (NOT structured FK edges);
// stored verbatim as the Datasource.tableRelation Json column so the editor
// can re-render positions on load. The read side normalizes it:
// `normalizeTableRelation` (m-schema.builder.ts, M3.1) resolves `shape=='edge'`
// cells' source.cell (Table row id) / source.port (Field row id) into
// {fromTable,fromField,toTable,toField} FK edges for the SQL prompt.
import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { TableRelationCompareDto } from '../common/dtos';
import { DatasourceService } from './datasource.service';

@Controller('table_relation')
@UseGuards(JwtAuthGuard)
export class TableRelationController {
  constructor(private readonly ds: DatasourceService) {}

  @Post('get/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  get(@Param('id') id: string) {
    return this.ds.getTableRelation(+id);
  }

  @Post('save/:dsId')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '保存表关系',
  })
  save(@Param('dsId') dsId: string, @Body() cells: unknown[]) {
    // Body is a bare JSON array of X6 cells; stored verbatim.
    return this.ds.saveTableRelation(+dsId, cells ?? []);
  }

  /** Append-only history of saved relation graphs (MetaDataImprove M3). */
  @Post('versions/:dsId')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  versions(
    @Param('dsId') dsId: string,
    @Query('current_page') currentPage = '1',
    @Query('page_size') pageSize = '20',
  ) {
    return this.ds.getTableRelationVersions(
      +dsId,
      Number(currentPage) || 1,
      Number(pageSize) || 20,
    );
  }

  /** Restore one saved relation version. Appends a NEW version (history is
   *  never rewritten) — same authority as save, and audited. */
  @Post('restore/:dsId/:version')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '恢复表关系版本',
  })
  restore(
    @Param('dsId', ParseIntPipe) dsId: number,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.ds.restoreTableRelation(dsId, version);
  }

  /** Semantic diff between two saved versions (default: newest saved). */
  @Post('compare/:dsId')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  compare(
    @Param('dsId', ParseIntPipe) dsId: number,
    @Body() dto: TableRelationCompareDto,
  ) {
    return this.ds.compareTableRelation(dsId, dto.from_version, dto.to_version);
  }
}
