// Table-relation controller. Aligned to the frontend's
// `frontend/src/api/datasource.ts` (relationGet/relationSave). The persisted
// shape is the raw X6 `graph.toJSON().cells` array (NOT structured FK edges);
// stored verbatim as the Datasource.tableRelation Json column. The
// get_table_schema step later interprets `shape=='edge'` cells' source.cell
// (table id) / source.port (field id) / target.* to emit FK lines.
import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
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
}
