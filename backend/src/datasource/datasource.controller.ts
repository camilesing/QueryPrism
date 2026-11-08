// Datasource controller. Aligned to the
// frontend's `frontend/src/api/datasource.ts`. Bare controller name
// 'datasource'. Class-level @UseGuards(JwtAuthGuard) — closes the last
// CRUD-without-guard gap. POST routes use @HttpCode(200) (NestJS
// defaults to 201). Route ordering: the only GETs
// with a path param are `check/:id` and `exportDsSchema/:id` — both have
// literal first segments, so no single-param capture can shadow them.
//
// Casing:
//  - list/get/add/update → snake_case via toDatasourceSnake
//  - tableList/fieldList → snake_case via toTableSnake/toFieldSnake
//  - getTables/getTablesByConf/getFields → camelCase passthrough (the
//    connector's TableMeta/FieldMeta already have this shape)
//  - configuration/table_relation/recommended_config → Json blob passthrough
//
// No global ValidationPipe is configured (main.ts), so DTOs are loose typed
// @Body() params — class-validator decorators would be decorative. The
// @IsObject-rejects-arrays pitfall is avoided by not using @IsObject at all.
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { WsAdminGuard } from '../auth/ws-admin.guard';
import type { CurrentUserInfo } from '../common/context/request-context';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { SystemLog } from '../audit/system-log.decorator';
import { OperationModule, OperationType } from '../audit/operation.enum';
import { DatasourceService } from './datasource.service';
import {
  ExcelStoreService,
  type ImportSheetRequest,
} from './excel-store.service';
import {
  toDatasourceSnake,
  toFieldSnake,
  toTableSnake,
  type DatasourceSnake,
} from './datasource-snake-mapper';
import { ExecSqlDto } from './exec-sql.dto';
import { tr } from '../common/i18n/translate';

/** Body for POST /check + /getTablesByConf + /getSchemaByConf. */
interface ConfBody {
  type: string;
  configuration: string | null;
}

/** Body for POST /add (CreateDatasource). `configuration` is the frontend-
 *  encrypted string; `tables` is the optional selection persisted via syncTable. */
interface AddBody {
  name: string;
  description?: string | null;
  type: string;
  configuration?: string | null;
  tables?: { table_name: string; table_comment?: string | null }[];
}

/** Body for POST /update (CoreDatasource — carries id in the body). */
interface UpdateBody {
  id: number;
  name?: string;
  description?: string | null;
  type?: string;
  configuration?: string | null;
  status?: string;
}

interface EditTableBody {
  id: number;
  custom_comment?: string | null;
  checked?: boolean;
}

interface EditFieldBody {
  id: number;
  custom_comment?: string | null;
  checked?: boolean;
}

interface FieldListBody {
  fieldName?: string;
}

interface PreviewDataBody {
  table: { id: number };
  fields?: unknown[];
}

interface ImportToDbBody {
  filePath?: string;
  sheets?: ImportSheetRequest[];
}

@Controller('datasource')
@UseGuards(JwtAuthGuard)
export class DatasourceController {
  constructor(
    private readonly ds: DatasourceService,
    private readonly excelStore: ExcelStoreService,
  ) {}

  // ─── list / get (snake) ──────────────────────────────────────────────

  @Get('list')
  async list(@CurrentUser() user: CurrentUserInfo) {
    const rows = await this.ds.findAll();
    // Ordinary members need the list to start chats, but the encrypted
    // connection config is only meaningful to workspace admins (the frontend
    // holds the decryption key, so exposing it is equivalent to plaintext
    // credentials) — a deliberate hardening within the same workspace.
    const showConfig = user.id === 1 || (user.weight ?? 0) !== 0;
    return rows.map((r) => {
      const d = toDatasourceSnake(r);
      if (!showConfig) d.configuration = null;
      return d;
    });
  }

  /** GET /datasource/ws/:oid — datasources of a workspace the caller belongs to
   *  (embedded-app configuration: pick a workspace's datasources). */
  @Get('ws/:oid')
  @UseGuards(WsAdminGuard)
  async byWorkspace(
    @Param('oid') oid: string,
    @CurrentUser() user: CurrentUserInfo,
  ) {
    const rows = await this.ds.findByOid(+oid, user);
    return rows.map((r) => toDatasourceSnake(r));
  }

  @Post('get/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  async get(@Param('id') id: string) {
    const row = await this.ds.findOne(+id);
    return toDatasourceSnake(row);
  }

  // ─── CRUD (snake) ────────────────────────────────────────────────────

  @Post('add')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.CREATE,
    detail: '新建数据源',
    resources: (r) => {
      const d = r as DatasourceSnake;
      return [{ name: d.name, originId: d.id }];
    },
  })
  async add(@Body() dto: AddBody) {
    const row = await this.ds.create(dto);
    return toDatasourceSnake(row);
  }

  @Post('update')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '更新数据源',
    resources: (r) => {
      const d = r as DatasourceSnake;
      return [{ name: d.name, originId: d.id }];
    },
  })
  async update(@Body() dto: UpdateBody) {
    if (dto.id === undefined) {
      throw new BadRequestException(tr('datasource.ds_id_missing'));
    }
    const row = await this.ds.update(dto.id, dto);
    return toDatasourceSnake(row);
  }

  @Post('delete/:id/:name')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.DELETE,
    detail: '删除数据源',
  })
  async remove(@Param('id') id: string) {
    // `name` is ignored; kept in the path
    // only for contract parity with the frontend route signature.
    await this.ds.remove(+id);
    return { success: true };
  }

  // ─── check ───────────────────────────────────────────────────────────

  @Post('check')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.TEST,
    detail: '测试数据源连接',
  })
  check(@Body() dto: ConfBody) {
    return this.ds.checkByConf(dto);
  }

  @Get('check/:id')
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.TEST,
    detail: '测试数据源连接',
  })
  checkById(@Param('id') id: string) {
    return this.ds.checkById(+id);
  }

  // ─── live introspection (camelCase passthrough) ──────────────────────

  @Post('getTables/:id')
  @HttpCode(200)
  getTables(@Param('id') id: string) {
    return this.ds.getTables(+id);
  }

  @Post('getTablesByConf')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  getTablesByConf(@Body() dto: ConfBody) {
    return this.ds.getTablesByConf(dto);
  }

  @Post('getFields/:id/:table_name')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  getFields(@Param('id') id: string, @Param('table_name') tableName: string) {
    return this.ds.getFields(+id, tableName);
  }

  @Post('getSchemaByConf')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  getSchemaByConf(@Body() dto: ConfBody) {
    return this.ds.getSchemaByConf(dto);
  }

  // ─── persisted rows (snake) ──────────────────────────────────────────

  @Post('tableList/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  async tableList(@Param('id') id: string) {
    const rows = await this.ds.tableList(+id);
    return rows.map((r) => toTableSnake(r));
  }

  @Post('fieldList/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  async fieldList(@Param('id') id: string, @Body() dto: FieldListBody) {
    const rows = await this.ds.fieldList(+id, dto?.fieldName);
    return rows.map((r) => toFieldSnake(r));
  }

  // ─── edit (persist checked + custom_comment only) ─────────────────────

  @Post('editTable')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '编辑表',
  })
  async editTable(@Body() dto: EditTableBody) {
    await this.ds.editTable(dto);
    return { success: true };
  }

  @Post('editField')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.UPDATE,
    detail: '编辑字段',
  })
  async editField(@Body() dto: EditFieldBody) {
    await this.ds.editField(dto);
    return { success: true };
  }

  @Post('editLocalComment')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  editLocalComment() {
    // UNUSED (frontend TableList.vue:179 comments it out). Legacy batch-save
    // superseded by editTable/editField. No-op success.
    return { success: true };
  }

  // ─── chooseTables / syncFields (reconcile) ───────────────────────────

  @Post('chooseTables/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.SYNC,
    detail: '选择表',
  })
  chooseTables(
    @Param('id') id: string,
    @Body() dto: { table_name: string; table_comment?: string | null }[],
  ) {
    // Body is a bare JSON array (the user's selection); stored/reconciled
    // verbatim by syncTable.
    return this.ds.chooseTables(+id, dto ?? []);
  }

  @Post('syncFields/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.SYNC,
    detail: '同步字段',
  })
  async syncFields(@Param('id') id: string) {
    await this.ds.syncFieldsByTableId(+id);
    return { success: true };
  }

  // ─── previewData ─────────────────────────────────────────────────────

  @Post('previewData/:id')
  @HttpCode(200)
  previewData(@Param('id') id: string, @Body() dto: PreviewDataBody) {
    return this.ds.previewData(+id, dto);
  }

  // ─── execSql ─────────────────────────────────────────────────────────

  @Post('execSql/:id')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  execSql(@Param('id') id: string, @Body() dto: ExecSqlDto) {
    return this.ds.execSql(+id, dto.sql);
  }

  // ─── Excel upload/parse/import (local file datasource) ───────────────

  @Post('parseExcel')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  parseExcel(@UploadedFile() file: Express.Multer.File) {
    return this.excelStore.receive(file);
  }

  @Post('uploadExcel')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  uploadExcel(@UploadedFile() file: Express.Multer.File) {
    return this.excelStore.importWholeFile(file);
  }

  @Post('importToDb')
  @HttpCode(200)
  @UseGuards(WsAdminGuard)
  importToDb(@Body() dto: ImportToDbBody) {
    return this.excelStore.importToDb(dto.filePath ?? '', dto.sheets ?? []);
  }

  // ─── exportDsSchema (xlsx blob, non-passthrough @Res) ─────────

  @Get('exportDsSchema/:id')
  @UseGuards(WsAdminGuard)
  @SystemLog({
    module: OperationModule.DATASOURCE,
    type: OperationType.EXPORT,
    detail: '导出表结构',
  })
  async exportDsSchema(@Param('id') id: string, @Res() res: Response) {
    const buf = await this.ds.exportDsSchema(+id);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="datasource-schema.xlsx"',
    });
    res.send(buf);
  }
}
