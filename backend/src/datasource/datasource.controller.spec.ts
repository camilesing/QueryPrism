// DatasourceController spec — locks the route → service wiring and the
// in-controller contracts: list() masks `configuration` for non-admins
// (uid 1 / non-zero workspace weight see it), update() 400s on missing id,
// snake-mappers run in the controller (assert on mapped output), Excel
// endpoints delegate to ExcelStoreService, and exportDsSchema streams the
// xlsx blob through @Res. The service itself is covered by
// datasource.service.spec — here it is a jest.fn() stub.
import type { Response } from 'express';
import { BadRequestException } from '@nestjs/common';
import { DatasourceController } from './datasource.controller';
import { DatasourceService } from './datasource.service';
import { ExcelStoreService } from './excel-store.service';
import { SYSTEMLOG_KEY } from '../audit/system-log.decorator';
import type { LogConfig } from '../audit/log-config.interface';
import type {
  DatasourceRow,
  FieldRow,
  TableRow,
} from './datasource-snake-mapper';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';

const T0 = new Date('2026-01-02T03:04:05.678Z');

const dsRow = (over: Partial<DatasourceRow> = {}): DatasourceRow => ({
  id: 7,
  name: 'orders db',
  description: 'main warehouse',
  type: 'mysql',
  configuration: 'enc-secret',
  status: 'active',
  tableRelation: [{ shape: 'edge' }],
  recommendedConfig: { a: 1 },
  num: '3/10',
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const tableRow: TableRow = {
  id: 11,
  datasourceId: 3,
  tableName: 'users',
  tableComment: 'members',
  customComment: null,
  checked: true,
  createdAt: T0,
  updatedAt: T0,
};

const fieldRow: FieldRow = {
  id: 21,
  tableId: 11,
  fieldName: 'uid',
  fieldType: 'int',
  fieldComment: 'pk',
  customComment: 'user id',
  isPrimaryKey: true,
  fieldIndex: 0,
  checked: true,
  createdAt: T0,
  updatedAt: T0,
};

describe('DatasourceController', () => {
  let ds: Record<string, jest.Mock>;
  let excelStore: {
    receive: jest.Mock;
    importWholeFile: jest.Mock;
    importToDb: jest.Mock;
  };
  let controller: DatasourceController;

  beforeEach(() => {
    setI18n(createTestI18n());
    ds = {
      findAll: jest.fn(),
      findByOid: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      checkByConf: jest.fn(),
      checkById: jest.fn(),
      getTables: jest.fn(),
      getTablesByConf: jest.fn(),
      getFields: jest.fn(),
      getSchemaByConf: jest.fn(),
      tableList: jest.fn(),
      fieldList: jest.fn(),
      editTable: jest.fn(),
      editField: jest.fn(),
      chooseTables: jest.fn(),
      syncFieldsByTableId: jest.fn(),
      previewData: jest.fn(),
      execSql: jest.fn(),
      exportDsSchema: jest.fn(),
    };
    excelStore = {
      receive: jest.fn(),
      importWholeFile: jest.fn(),
      importToDb: jest.fn(),
    };
    controller = new DatasourceController(
      ds as unknown as DatasourceService,
      excelStore as unknown as ExcelStoreService,
    );
  });

  // ─── list / ws / get ────────────────────────────────────────────────────

  describe('list configuration masking', () => {
    const rows = [
      dsRow(),
      // no stored num + no includes → num falls back to String(selected=0)
      dsRow({ id: 8, num: undefined, type: 'excel', _count: undefined }),
    ];

    it('masks configuration for an ordinary member (weight 0)', async () => {
      ds.findAll.mockResolvedValue(rows);
      const out = await controller.list({
        id: 2,
        account: 'u2',
        oid: 1,
        language: 'en',
        weight: 0,
      });
      expect(out.map((d) => d.configuration)).toEqual([null, null]);
      expect(out[0].name).toBe('orders db');
      expect(out[0].type_name).toBe('MySQL');
      expect(out[0].num).toBe('3/10');
      expect(out[1].type_name).toBe('Excel/CSV');
      expect(out[1].num).toBe('0');
    });

    it('masks configuration when weight is absent (assistant-style user)', async () => {
      ds.findAll.mockResolvedValue(rows);
      const out = await controller.list({
        id: 5,
        account: 'u5',
        oid: 1,
        language: 'en',
      });
      expect(out[0].configuration).toBeNull();
    });

    it('keeps configuration for the system admin (uid 1)', async () => {
      ds.findAll.mockResolvedValue(rows);
      const out = await controller.list({
        id: 1,
        account: 'admin',
        oid: 1,
        language: 'en',
        weight: 0,
      });
      expect(out[0].configuration).toBe('enc-secret');
    });

    it('keeps configuration for a workspace admin (non-zero weight)', async () => {
      ds.findAll.mockResolvedValue(rows);
      const out = await controller.list({
        id: 2,
        account: 'u2',
        oid: 1,
        language: 'en',
        weight: 2,
      });
      expect(out[0].configuration).toBe('enc-secret');
      expect(out[0].create_time).toBe(T0.toISOString());
      expect(out[0].table_relation).toEqual([{ shape: 'edge' }]);
      expect(out[0].recommended_config).toEqual({ a: 1 });
    });
  });

  it('byWorkspace maps rows without masking configuration', async () => {
    const user = { id: 2, account: 'u2', oid: 1, language: 'en', weight: 2 };
    ds.findByOid.mockResolvedValue([dsRow()]);
    const out = await controller.byWorkspace('4', user);
    expect(ds.findByOid).toHaveBeenCalledWith(4, user);
    expect(out[0]).toMatchObject({
      id: 7,
      configuration: 'enc-secret',
      type_name: 'MySQL',
      status: 'active',
    });
  });

  it('get maps the row to snake_case', async () => {
    ds.findOne.mockResolvedValue(dsRow());
    const out = await controller.get('7');
    expect(ds.findOne).toHaveBeenCalledWith(7);
    expect(out).toMatchObject({ id: 7, name: 'orders db', type_name: 'MySQL' });
  });

  // ─── CRUD ───────────────────────────────────────────────────────────────

  it('add delegates the raw body and maps the created row', async () => {
    const dto = {
      name: 'orders db',
      description: null,
      type: 'mysql',
      configuration: 'enc-secret',
      tables: [{ table_name: 'users' }],
    };
    ds.create.mockResolvedValue(dsRow());
    const out = await controller.add(dto);
    expect(ds.create).toHaveBeenCalledWith(dto);
    expect(out).toMatchObject({ id: 7, type_name: 'MySQL' });
  });

  it('update 400s (translated) when dto.id is undefined', async () => {
    await expect(
      controller.update({ name: 'x' } as { id: number; name: string }),
    ).rejects.toMatchObject({
      constructor: BadRequestException,
      message: 'Missing datasource id',
    });
    expect(ds.update).not.toHaveBeenCalled();
  });

  it('update forwards id + body and maps the row', async () => {
    const dto = { id: 7, name: 'renamed' };
    ds.update.mockResolvedValue(dsRow({ name: 'renamed' }));
    const out = await controller.update(dto);
    expect(ds.update).toHaveBeenCalledWith(7, dto);
    expect(out).toMatchObject({ id: 7, name: 'renamed' });
  });

  it('remove deletes by numeric id and returns success', async () => {
    ds.remove.mockResolvedValue(undefined);
    await expect(controller.remove('7')).resolves.toEqual({ success: true });
    expect(ds.remove).toHaveBeenCalledWith(7);
  });

  // ─── check ──────────────────────────────────────────────────────────────

  it('check passes the conf body through', async () => {
    const dto = { type: 'mysql', configuration: 'enc-secret' };
    ds.checkByConf.mockResolvedValue({ success: true });
    await expect(controller.check(dto)).resolves.toEqual({ success: true });
    expect(ds.checkByConf).toHaveBeenCalledWith(dto);
  });

  it('checkById coerces the id', async () => {
    ds.checkById.mockResolvedValue({ success: true });
    await expect(controller.checkById('9')).resolves.toEqual({ success: true });
    expect(ds.checkById).toHaveBeenCalledWith(9);
  });

  // ─── live introspection (camelCase passthrough) ─────────────────────────

  it('getTables / getTablesByConf / getFields / getSchemaByConf delegate', async () => {
    const tables = [{ tableName: 'users' }];
    ds.getTables.mockResolvedValue(tables);
    await expect(controller.getTables('3')).resolves.toBe(tables);
    expect(ds.getTables).toHaveBeenCalledWith(3);

    const conf = { type: 'pg', configuration: null };
    ds.getTablesByConf.mockResolvedValue(tables);
    await expect(controller.getTablesByConf(conf)).resolves.toBe(tables);
    expect(ds.getTablesByConf).toHaveBeenCalledWith(conf);

    const fields = [{ fieldName: 'uid' }];
    ds.getFields.mockResolvedValue(fields);
    await expect(controller.getFields('3', 'users')).resolves.toBe(fields);
    expect(ds.getFields).toHaveBeenCalledWith(3, 'users');

    const schema = { hello: 'schema' };
    ds.getSchemaByConf.mockResolvedValue(schema);
    await expect(controller.getSchemaByConf(conf)).resolves.toBe(schema);
    expect(ds.getSchemaByConf).toHaveBeenCalledWith(conf);
  });

  // ─── persisted rows (snake) ─────────────────────────────────────────────

  it('tableList maps rows via toTableSnake', async () => {
    ds.tableList.mockResolvedValue([tableRow]);
    const out = await controller.tableList('3');
    expect(ds.tableList).toHaveBeenCalledWith(3);
    expect(out).toEqual([
      {
        id: 11,
        ds_id: 3,
        table_name: 'users',
        table_comment: 'members',
        custom_comment: null,
        checked: true,
        create_time: T0.toISOString(),
        update_time: T0.toISOString(),
      },
    ]);
  });

  it('fieldList forwards fieldName and maps rows via toFieldSnake', async () => {
    ds.fieldList.mockResolvedValue([fieldRow]);
    const out = await controller.fieldList('3', { fieldName: 'uid' });
    expect(ds.fieldList).toHaveBeenCalledWith(3, 'uid');
    expect(out).toEqual([
      {
        id: 21,
        table_id: 11,
        field_name: 'uid',
        field_type: 'int',
        field_comment: 'pk',
        custom_comment: 'user id',
        is_primary_key: true,
        field_index: 0,
        checked: true,
        create_time: T0.toISOString(),
        update_time: T0.toISOString(),
      },
    ]);
  });

  it('fieldList tolerates a missing body (fieldName undefined)', async () => {
    ds.fieldList.mockResolvedValue([]);
    await expect(controller.fieldList('3', undefined)).resolves.toEqual([]);
    expect(ds.fieldList).toHaveBeenCalledWith(3, undefined);
  });

  // ─── edit / legacy no-op ────────────────────────────────────────────────

  it('editTable / editField delegate and return success', async () => {
    ds.editTable.mockResolvedValue(undefined);
    const tableDto = { id: 11, custom_comment: 'c', checked: false };
    await expect(controller.editTable(tableDto)).resolves.toEqual({
      success: true,
    });
    expect(ds.editTable).toHaveBeenCalledWith(tableDto);

    ds.editField.mockResolvedValue(undefined);
    const fieldDto = { id: 21, checked: false };
    await expect(controller.editField(fieldDto)).resolves.toEqual({
      success: true,
    });
    expect(ds.editField).toHaveBeenCalledWith(fieldDto);
  });

  it('editLocalComment is a sync no-op success that touches no service', () => {
    expect(controller.editLocalComment()).toEqual({ success: true });
    expect(Object.values(ds).every((m) => m.mock.calls.length === 0)).toBe(
      true,
    );
  });

  // ─── chooseTables / syncFields ──────────────────────────────────────────

  it('chooseTables forwards the selection array', async () => {
    const selection = [{ table_name: 'users', table_comment: null }];
    ds.chooseTables.mockResolvedValue({ success: true });
    await expect(controller.chooseTables('5', selection)).resolves.toEqual({
      success: true,
    });
    expect(ds.chooseTables).toHaveBeenCalledWith(5, selection);
  });

  it('chooseTables normalizes a missing body to an empty selection', async () => {
    ds.chooseTables.mockResolvedValue({ success: true });
    await expect(
      controller.chooseTables(
        '5',
        undefined as unknown as { table_name: string }[],
      ),
    ).resolves.toEqual({ success: true });
    expect(ds.chooseTables).toHaveBeenCalledWith(5, []);
  });

  it('syncFields delegates and returns success', async () => {
    ds.syncFieldsByTableId.mockResolvedValue(undefined);
    await expect(controller.syncFields('11')).resolves.toEqual({
      success: true,
    });
    expect(ds.syncFieldsByTableId).toHaveBeenCalledWith(11);
  });

  // ─── previewData / execSql ──────────────────────────────────────────────

  it('previewData passes the body through with the numeric id', async () => {
    const dto = { table: { id: 11 }, fields: [{ fieldName: 'uid' }] };
    const rows = [{ uid: 1 }];
    ds.previewData.mockResolvedValue(rows);
    await expect(controller.previewData('7', dto)).resolves.toBe(rows);
    expect(ds.previewData).toHaveBeenCalledWith(7, dto);
  });

  it('execSql forwards only the sql string', async () => {
    const rows = [{ uid: 1 }];
    ds.execSql.mockResolvedValue(rows);
    await expect(
      controller.execSql('7', { sql: 'SELECT 1', limit: 10 }),
    ).resolves.toBe(rows);
    expect(ds.execSql).toHaveBeenCalledWith(7, 'SELECT 1');
  });

  // ─── Excel upload/parse/import ──────────────────────────────────────────

  it('parseExcel hands the uploaded file to ExcelStoreService', async () => {
    const file = { buffer: Buffer.from('xlsx'), originalname: 'f.xlsx' };
    excelStore.receive.mockResolvedValue({ filePath: '/tmp/f', data: [] });
    await expect(
      controller.parseExcel(file as Express.Multer.File),
    ).resolves.toEqual({ filePath: '/tmp/f', data: [] });
    expect(excelStore.receive).toHaveBeenCalledWith(file);
  });

  it('uploadExcel hands the uploaded file to ExcelStoreService', async () => {
    const file = { buffer: Buffer.from('xlsx'), originalname: 'all.xlsx' };
    excelStore.importWholeFile.mockResolvedValue({ success: true });
    await expect(
      controller.uploadExcel(file as Express.Multer.File),
    ).resolves.toEqual({ success: true });
    expect(excelStore.importWholeFile).toHaveBeenCalledWith(file);
  });

  it('importToDb defaults filePath/sheets when the body omits them', async () => {
    excelStore.importToDb.mockResolvedValue({ success: true });
    await expect(controller.importToDb({})).resolves.toEqual({ success: true });
    expect(excelStore.importToDb).toHaveBeenCalledWith('', []);
  });

  it('importToDb forwards filePath + sheets', async () => {
    const sheets = [{ sheetName: 'Sheet1', fields: [] }];
    excelStore.importToDb.mockResolvedValue({ success: true });
    await expect(
      controller.importToDb({ filePath: '/tmp/x.xlsx', sheets }),
    ).resolves.toEqual({ success: true });
    expect(excelStore.importToDb).toHaveBeenCalledWith('/tmp/x.xlsx', sheets);
  });

  // ─── exportDsSchema (xlsx blob via @Res) ────────────────────────────────

  it('exportDsSchema sets xlsx headers and sends the buffer', async () => {
    const buf = Buffer.from('xlsx-bytes');
    ds.exportDsSchema.mockResolvedValue(buf);
    const res = { set: jest.fn(), send: jest.fn() } as unknown as Response;
    await controller.exportDsSchema('4', res);
    expect(ds.exportDsSchema).toHaveBeenCalledWith(4);
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="datasource-schema.xlsx"',
    });
    expect(res.send).toHaveBeenCalledWith(buf);
  });

  // ─── @SystemLog audit metadata (normally invoked by the audit
  //     interceptor with the handler's return value) ──────────────────────

  it('add/update @SystemLog resources callbacks extract name+id from the snake result', () => {
    const addCfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      DatasourceController.prototype.add,
    ) as LogConfig;
    expect(addCfg.resources({ name: 'orders db', id: 7 })).toEqual([
      { name: 'orders db', originId: 7 },
    ]);

    const updateCfg = Reflect.getMetadata(
      SYSTEMLOG_KEY,
      DatasourceController.prototype.update,
    ) as LogConfig;
    expect(updateCfg.resources({ name: 'renamed', id: 7 })).toEqual([
      { name: 'renamed', originId: 7 },
    ]);
  });
});
