// MetricImportService unit tests (MetaDataImprove): scope/enabled on the
// metric + standard ingestion paths, per-row authority, and the merged
// by_scope summary.
import { requestContextStorage } from '../common/context/request-context';
import { setI18n } from '../common/i18n/translate';
import { createTestI18n } from '../common/i18n/test-i18n';
import {
  MetricImportService,
  type MetricImportRow,
  type StandardImportRow,
} from './metric-import.service';

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

const ATOMIC_ROW: MetricImportRow = {
  kind: 'atomic',
  code: 'pay_amount',
  name: '支付金额',
  datasource_id: 1,
  table_name: 'sales_order',
  field_name: 'amount',
  aggregation: 'SUM',
};

const STANDARD_ROW: StandardImportRow = {
  kind: 'naming',
  code: 'gmv',
  term: 'GMV',
  name: '商品交易总额',
  category: 'business_noun',
};

function makeService() {
  const metricUpsert = jest.fn().mockResolvedValue({ applied: true, id: 11 });
  const standardUpsert = jest.fn().mockResolvedValue({ applied: true, id: 12 });
  const service = new MetricImportService(
    {} as never,
    { upsert: metricUpsert } as never,
    { upsert: standardUpsert } as never,
  );
  return { service, metricUpsert, standardUpsert };
}

describe('MetricImportService scope/enabled', () => {
  it('defaults old metric rows to WORKSPACE + enabled', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([ATOMIC_ROW]),
    );
    expect(out).toEqual({
      applied: 1,
      by_scope: { GLOBAL: 0, WORKSPACE: 1, PERSONAL: 0 },
      failed: [],
    });
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'WORKSPACE', enabled: true }),
    );
  });

  it('lets a member import PERSONAL metrics + standards', async () => {
    const { service, metricUpsert, standardUpsert } = makeService();
    const metrics = await withUser(MEMBER, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, scope: 'personal', enabled: '0' },
      ]),
    );
    const standards = await withUser(MEMBER, () =>
      service.importJsonStandards([{ ...STANDARD_ROW, scope: 'PERSONAL' }]),
    );
    expect(metrics.by_scope.PERSONAL).toBe(1);
    expect(standards.by_scope.PERSONAL).toBe(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL', enabled: false }),
    );
    expect(standardUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'PERSONAL' }),
    );
  });

  it('fails WORKSPACE/GLOBAL rows for a member but keeps PERSONAL rows', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(MEMBER, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'ws', scope: 'WORKSPACE' },
        { ...ATOMIC_ROW, code: 'global', scope: 'GLOBAL' },
        { ...ATOMIC_ROW, code: 'mine', scope: 'PERSONAL' },
      ]),
    );
    expect(out.applied).toBe(1);
    expect(out.by_scope).toEqual({
      GLOBAL: 0,
      WORKSPACE: 0,
      PERSONAL: 1,
    });
    expect(out.failed).toHaveLength(2);
    expect(metricUpsert).toHaveBeenCalledTimes(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'mine', scope: 'PERSONAL' }),
    );
  });

  it('accepts GLOBAL for the system admin', async () => {
    const { service, metricUpsert } = makeService();
    const out = await withUser(SYS_ADMIN, () =>
      service.importJsonMetrics([{ ...ATOMIC_ROW, scope: 'GLOBAL' }]),
    );
    expect(out.by_scope.GLOBAL).toBe(1);
    expect(metricUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'GLOBAL' }),
    );
  });

  it('reports invalid metric/standard scopes without aborting the batch', async () => {
    const { service, standardUpsert } = makeService();
    const metrics = await withUser(WS_ADMIN, () =>
      service.importJsonMetrics([
        { ...ATOMIC_ROW, code: 'bad', scope: 'team' },
        { ...ATOMIC_ROW, code: 'good' },
      ]),
    );
    expect(metrics.applied).toBe(1);
    expect(metrics.failed).toHaveLength(1);
    expect(metrics.failed[0].row).toBe('row1');

    const standards = await withUser(WS_ADMIN, () =>
      service.importJsonStandards([
        { ...STANDARD_ROW, code: 'bad', scope: 'team' },
        { ...STANDARD_ROW, code: 'good' },
      ]),
    );
    expect(standards.applied).toBe(1);
    expect(standards.failed).toHaveLength(1);
    expect(standardUpsert).toHaveBeenCalledTimes(1);
  });
});
