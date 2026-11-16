import { ExcelConnector } from './excel.connector';
import { PostgresConnector } from './postgres.connector';
import { setI18n } from '../../common/i18n/translate';
import { createTestI18n } from '../../common/i18n/test-i18n';

/** Stub the inner PostgresConnector so no real connection is opened. */
function makeConnector(tableNames: string[]) {
  const connector = new ExcelConnector(
    { host: 'db.local', db: 'app', schema: 'excel_store' },
    tableNames,
  );
  const inner = (connector as unknown as { inner: PostgresConnector }).inner;
  const execSql = jest.spyOn(inner, 'execSql').mockResolvedValue({
    fields: [],
    rows: [],
  });
  const getFields = jest.spyOn(inner, 'getFields').mockResolvedValue([]);
  const getTables = jest
    .spyOn(inner, 'getTables')
    .mockResolvedValue([
      { tableName: 'someone_elses_sheet', tableComment: null },
    ]);
  return { connector, execSql, getFields, getTables };
}

describe('ExcelConnector table scoping', () => {
  beforeEach(() => setI18n(createTestI18n()));
  describe('getTables', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('returns [] when the configuration has no sheets (never the whole shared schema)', async () => {
      const { connector, getTables } = makeConnector([]);
      await expect(connector.getTables()).resolves.toEqual([]);
      expect(getTables).not.toHaveBeenCalled();
    });

    it('lists only the configured sheet tables', async () => {
      const { connector } = makeConnector(['sheet1', 'sheet2']);
      await expect(connector.getTables()).resolves.toEqual([
        { tableName: 'sheet1', tableComment: null },
        { tableName: 'sheet2', tableComment: null },
      ]);
    });
  });

  describe('getFields', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('rejects a table outside this datasource', async () => {
      const { connector, getFields } = makeConnector(['sheet1']);
      await expect(connector.getFields('User')).rejects.toThrow(
        'does not belong to this Excel datasource',
      );
      expect(getFields).not.toHaveBeenCalled();
    });

    it('passes member tables through', async () => {
      const { connector, getFields } = makeConnector(['sheet1']);
      await expect(connector.getFields('sheet1')).resolves.toEqual([]);
      expect(getFields).toHaveBeenCalledWith('sheet1');
    });
  });

  describe('execSql', () => {
    beforeEach(() => setI18n(createTestI18n()));
    it('rejects SQL referencing an app table outside excel_store', async () => {
      const { connector, execSql } = makeConnector(['sheet1']);
      await expect(
        connector.execSql('SELECT * FROM public."User"'),
      ).rejects.toThrow('does not belong to this Excel datasource');
      expect(execSql).not.toHaveBeenCalled();
    });

    it('rejects SQL referencing another datasource sheet', async () => {
      const { connector, execSql } = makeConnector(['sheet1']);
      await expect(
        connector.execSql('SELECT * FROM other_sheet LIMIT 1'),
      ).rejects.toThrow('does not belong to this Excel datasource');
      expect(execSql).not.toHaveBeenCalled();
    });

    it('allows plain, quoted, unicode and excel_store-qualified member tables', async () => {
      const { connector, execSql } = makeConnector([
        'sheet1',
        '订单表',
        'sheet_2',
      ]);
      await expect(connector.execSql('SELECT * FROM sheet1')).resolves.toEqual({
        fields: [],
        rows: [],
      });
      await expect(
        connector.execSql('SELECT * FROM "sheet_2" WHERE x = 1'),
      ).resolves.toEqual({ fields: [], rows: [] });
      await expect(connector.execSql('SELECT * FROM 订单表')).resolves.toEqual({
        fields: [],
        rows: [],
      });
      await expect(
        connector.execSql(
          'SELECT a.* FROM excel_store.sheet1 a JOIN sheet1 b ON a.id = b.id',
        ),
      ).resolves.toEqual({ fields: [], rows: [] });
      expect(execSql).toHaveBeenCalledTimes(4);
    });

    it('rejects a unicode-named sheet outside this datasource', async () => {
      const { connector, execSql } = makeConnector(['sheet1']);
      await expect(connector.execSql('SELECT * FROM 别人的表')).rejects.toThrow(
        'does not belong to this Excel datasource',
      );
      expect(execSql).not.toHaveBeenCalled();
    });

    it('allows CTE names, subqueries and set-returning functions', async () => {
      const { connector, execSql } = makeConnector(['sheet1']);
      await expect(
        connector.execSql(
          'WITH recent AS (SELECT * FROM sheet1) SELECT * FROM recent',
        ),
      ).resolves.toEqual({ fields: [], rows: [] });
      await expect(
        connector.execSql('SELECT * FROM (SELECT 1 AS x) sub'),
      ).resolves.toEqual({ fields: [], rows: [] });
      await expect(
        connector.execSql('SELECT * FROM generate_series(1, 3) AS g'),
      ).resolves.toEqual({ fields: [], rows: [] });
      expect(execSql).toHaveBeenCalledTimes(3);
    });

    it('allows FROM-less SELECT', async () => {
      const { connector, execSql } = makeConnector(['sheet1']);
      await expect(connector.execSql('SELECT 1')).resolves.toEqual({
        fields: [],
        rows: [],
      });
      expect(execSql).toHaveBeenCalledWith('SELECT 1', undefined);
    });
  });
});

describe('ExcelConnector passthrough + sample guards', () => {
  beforeEach(() => setI18n(createTestI18n()));

  function makeFull(tableNames: string[]) {
    const { connector, execSql, getFields } = makeConnector(tableNames);
    const inner = (connector as unknown as { inner: PostgresConnector }).inner;
    const getVersion = jest
      .spyOn(inner, 'getVersion')
      .mockResolvedValue('PostgreSQL 18.1');
    const testConnection = jest
      .spyOn(inner, 'testConnection')
      .mockResolvedValue({ success: true, message: 'ok' });
    const sampleDistinct = jest
      .spyOn(inner, 'sampleDistinct')
      .mockResolvedValue(['a', 'b']);
    const close = jest.spyOn(inner, 'close').mockResolvedValue(undefined);
    return {
      connector,
      execSql,
      getFields,
      getVersion,
      testConnection,
      sampleDistinct,
      close,
    };
  }

  it('delegates getVersion to the inner postgres connector', async () => {
    const m = makeFull(['sheet1']);
    await expect(m.connector.getVersion()).resolves.toBe('PostgreSQL 18.1');
    expect(m.getVersion).toHaveBeenCalledTimes(1);
  });

  it('testConnection reports the Excel success message on success', async () => {
    const m = makeFull(['sheet1']);
    await expect(m.connector.testConnection()).resolves.toEqual({
      success: true,
      message: 'Excel 数据源连接成功',
    });
  });

  it('testConnection keeps the inner failure message on failure', async () => {
    const m = makeFull(['sheet1']);
    m.testConnection.mockResolvedValue({
      success: false,
      message: 'connection refused',
    });
    await expect(m.connector.testConnection()).resolves.toEqual({
      success: false,
      message: 'connection refused',
    });
  });

  it('getSchemas is always empty (no user-selectable schema)', async () => {
    const m = makeFull(['sheet1']);
    await expect(m.connector.getSchemas()).resolves.toEqual([]);
  });

  it('getTableSampleData quotes the identifier and clamps the limit', async () => {
    const m = makeFull(['sheet1']);
    m.execSql.mockResolvedValue({ fields: [], rows: [['r1'], ['r2']] });
    await expect(
      m.connector.getTableSampleData('sheet1', 2.9),
    ).resolves.toEqual([['r1'], ['r2']]);
    expect(m.execSql).toHaveBeenCalledWith('SELECT * FROM "sheet1"', 2);
    // default limit is 3; negative limits clamp to 0
    await m.connector.getTableSampleData('sheet1');
    expect(m.execSql).toHaveBeenLastCalledWith('SELECT * FROM "sheet1"', 3);
    await m.connector.getTableSampleData('sheet1', -1);
    expect(m.execSql).toHaveBeenLastCalledWith('SELECT * FROM "sheet1"', 0);
  });

  it('getTableSampleData escapes embedded double quotes in the table name', async () => {
    const m = makeFull(['we"ird']);
    m.execSql.mockResolvedValue({ fields: [], rows: [] });
    await m.connector.getTableSampleData('we"ird');
    expect(m.execSql).toHaveBeenCalledWith('SELECT * FROM "we""ird"', 3);
  });

  it('getTableSampleData rejects a non-member table', async () => {
    const m = makeFull(['sheet1']);
    await expect(m.connector.getTableSampleData('User')).rejects.toThrow(
      'does not belong to this Excel datasource',
    );
    expect(m.execSql).not.toHaveBeenCalled();
  });

  it('getTableSampleData passes any table through when none are configured', async () => {
    const m = makeFull([]);
    m.execSql.mockResolvedValue({ fields: [], rows: [] });
    await expect(m.connector.getTableSampleData('anything')).resolves.toEqual(
      [],
    );
  });

  it('sampleDistinct delegates for a member table', async () => {
    const m = makeFull(['sheet1']);
    await expect(
      m.connector.sampleDistinct('sheet1', 'col', 100),
    ).resolves.toEqual(['a', 'b']);
    expect(m.sampleDistinct).toHaveBeenCalledWith('sheet1', 'col', 100);
  });

  it('sampleDistinct rejects a non-member table', async () => {
    const m = makeFull(['sheet1']);
    await expect(
      m.connector.sampleDistinct('other', 'col', 100),
    ).rejects.toThrow('does not belong to this Excel datasource');
    expect(m.sampleDistinct).not.toHaveBeenCalled();
  });

  it('sampleDistinct passes any table through when none are configured', async () => {
    const m = makeFull([]);
    await expect(m.connector.sampleDistinct('any', 'col', 5)).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  it('close closes the inner connector', async () => {
    const m = makeFull(['sheet1']);
    await expect(m.connector.close()).resolves.toBeUndefined();
    expect(m.close).toHaveBeenCalledTimes(1);
  });
});
