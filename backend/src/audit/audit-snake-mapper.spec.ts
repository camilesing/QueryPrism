// audit-snake-mapper spec — Phase 10c cycle 3 §88. Jest hoists
// describe/it/expect globally (cycles 1/2 convention); only the mapper import
// is needed.
import { toAuditLogSnake, type AuditLogRow } from './audit-snake-mapper';

const baseRow: AuditLogRow = {
  id: 1,
  module: 'api_key',
  type: 'create',
  status: 'success',
  operatorId: 1,
  operator: 'admin',
  detail: '新建API密钥',
  createdAt: new Date('2026-07-26T01:00:00.000Z'),
  oid: 1,
  ipAddress: '127.0.0.1',
  userAgent: 'curl/8',
  executionTime: 42,
  errorMessage: null,
  requestMethod: 'POST',
  requestPath: '/api/v1/system/apikey',
  remark: null,
  resources: [{ name: 'test-key' }],
};

describe('toAuditLogSnake', () => {
  it('maps all 12 fields to the snake_case contract shape', () => {
    const out = toAuditLogSnake(baseRow, new Map([[1, 'default']]));
    expect(out).toEqual({
      id: '1',
      operation_type_name: 'Create',
      operation_detail_info: '新建API密钥',
      user_name: 'admin',
      resource_name: 'test-key',
      operation_status: 'success',
      operation_status_name: 'Success',
      ip_address: '127.0.0.1',
      create_time: baseRow.createdAt.getTime(),
      oid_name: 'default',
      oid: '1',
      error_message: '',
      remark: '',
    });
  });

  it('create_time is the epoch-ms number from createdAt.getTime()', () => {
    const out = toAuditLogSnake(baseRow, new Map());
    expect(typeof out.create_time).toBe('number');
    expect(out.create_time).toBe(baseRow.createdAt.getTime());
  });

  it('resource_name empty when there are no resource snapshots', () => {
    const row: AuditLogRow = { ...baseRow, resources: [] };
    expect(toAuditLogSnake(row, new Map()).resource_name).toBe('');
  });

  it('normalizes status: legacy "fail"→"failed", keeps success/failed', () => {
    expect(
      toAuditLogSnake({ ...baseRow, status: 'fail' }, new Map())
        .operation_status,
    ).toBe('failed');
    expect(
      toAuditLogSnake({ ...baseRow, status: 'failed' }, new Map())
        .operation_status,
    ).toBe('failed');
    expect(
      toAuditLogSnake({ ...baseRow, status: 'success' }, new Map())
        .operation_status,
    ).toBe('success');
  });

  it('oid_name from the workspace map; "-1" when oid null or unknown; oid "" when null', () => {
    expect(toAuditLogSnake(baseRow, new Map([[1, 'default']])).oid_name).toBe(
      'default',
    );
    expect(
      toAuditLogSnake({ ...baseRow, oid: 99 }, new Map([[1, 'default']]))
        .oid_name,
    ).toBe('-1');
    expect(
      toAuditLogSnake({ ...baseRow, oid: null }, new Map([[1, 'default']]))
        .oid_name,
    ).toBe('-1');
    expect(toAuditLogSnake({ ...baseRow, oid: null }, new Map()).oid).toBe('');
  });

  it('null/empty row fields become contract defaults ("" or null)', () => {
    const row: AuditLogRow = {
      ...baseRow,
      ipAddress: null,
      errorMessage: null,
      remark: null,
      detail: null,
      operator: null,
      resources: undefined,
    };
    const out = toAuditLogSnake(row, new Map());
    expect(out.ip_address).toBe(null);
    expect(out.error_message).toBe('');
    expect(out.remark).toBe('');
    expect(out.operation_detail_info).toBe('');
    expect(out.user_name).toBe('');
    expect(out.resource_name).toBe('');
  });
});
