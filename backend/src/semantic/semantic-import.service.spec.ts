// SemanticImportService unit tests (MetaDataImprove): scope/enabled parsing,
// per-row direct-write authority (PERSONAL self / WORKSPACE admin / GLOBAL
// sysadmin) and the additive by_scope summary.
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  SemanticImportService,
  type SemanticImportRow,
} from './semantic-import.service';

setI18n(createTestI18n());

function withUser<T>(
  user: { id: number; oid: number; weight?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return requestContextStorage.run(
    {
      user: {
        id: user.id,
        account: `u${user.id}`,
        oid: user.oid,
        language: 'en',
        weight: user.weight ?? 0,
      },
    },
    fn,
  );
}

const MEMBER = { id: 7, oid: 1, weight: 0 };
const WS_ADMIN = { id: 5, oid: 1, weight: 1 };
const SYS_ADMIN = { id: 1, oid: 1, weight: 0 };

const ROW: SemanticImportRow = {
  entity_type: 'table',
  datasource_id: 1,
  table_name: 'sales_order',
  meaning: '销售订单主表',
};

function makeService() {
  const upsert = jest.fn().mockResolvedValue({ applied: true, id: 11 });
  const service = new SemanticImportService({} as never, { upsert } as never);
  return { service, upsert };
}

describe('SemanticImportService scope/enabled', () => {
  it('defaults old rows to WORKSPACE + enabled', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () => service.importJson([ROW]));
    expect(out).toEqual({
      applied: 1,
      by_scope: { GLOBAL: 0, WORKSPACE: 1, PERSONAL: 0 },
      failed: [],
    });
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'WORKSPACE', enabled: true }),
    );
  });

  it('passes explicit PERSONAL + enabled=false through to the service', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJson([{ ...ROW, scope: 'personal', enabled: 'false' }]),
    );
    expect(out.by_scope.PERSONAL).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL', enabled: false }),
    );
  });

  it('lets a member write only PERSONAL rows; WORKSPACE/GLOBAL rows fail', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJson([
        { ...ROW, table_name: 'ws_row', scope: 'WORKSPACE' },
        { ...ROW, table_name: 'global_row', scope: 'GLOBAL' },
        { ...ROW, table_name: 'personal_row', scope: 'PERSONAL' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.by_scope).toEqual({
      GLOBAL: 0,
      WORKSPACE: 0,
      PERSONAL: 1,
    });
    expect(out.failed).toHaveLength(2);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL' }),
    );
  });

  it('accepts GLOBAL only for the system admin', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(SYS_ADMIN, () =>
      service.importJson([{ ...ROW, scope: 'GLOBAL' }]),
    );
    expect(out.by_scope.GLOBAL).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'GLOBAL' }),
    );
  });

  it('reports an invalid scope row and keeps processing the batch', async () => {
    const { service, upsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJson([
        { ...ROW, table_name: 'bad', scope: 'team' },
        { ...ROW, table_name: 'good' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].row).toBe('row1');
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ table_name: 'good' }),
    );
  });

  it('treats a proposal result as a failed row (no bulk approval routing)', async () => {
    const upsert = jest
      .fn()
      .mockResolvedValue({ applied: false, request_id: 9 });
    const service = new SemanticImportService({} as never, { upsert } as never);
    const out = await withUser(SYS_ADMIN, () =>
      service.importJson([{ ...ROW, scope: 'GLOBAL' }]),
    );
    expect(out.applied).toBe(0);
    expect(out.failed).toHaveLength(1);
  });
});
