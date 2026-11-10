// Pure policy tests for external metadata sync (MetaDataImprove M5).
import {
  authHeaders,
  extractSyncRows,
  isValidAuth,
  isValidCron,
  isValidEndpoint,
  syncErrorText,
} from './metadata-sync-policy';

describe('metadata-sync policy', () => {
  it('accepts only http(s) endpoints', () => {
    expect(isValidEndpoint('https://meta.example.com/rows')).toBe(true);
    expect(isValidEndpoint('http://127.0.0.1:9000/rows')).toBe(true);
    expect(isValidEndpoint('ftp://meta.example.com/rows')).toBe(false);
    expect(isValidEndpoint('file:///etc/passwd')).toBe(false);
    expect(isValidEndpoint('not a url')).toBe(false);
  });

  it('validates cron expressions', () => {
    expect(isValidCron('0 3 * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('not-a-cron')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });

  it('validates the auth shape', () => {
    expect(isValidAuth(null)).toBe(true);
    expect(isValidAuth(undefined)).toBe(true);
    expect(isValidAuth({})).toBe(true);
    expect(isValidAuth({ token: 'abc' })).toBe(true);
    expect(isValidAuth({ headers: { 'X-Key': 'v' } })).toBe(true);
    expect(isValidAuth({ token: 1 })).toBe(false);
    expect(isValidAuth({ headers: { 'X-Key': 1 } })).toBe(false);
    expect(isValidAuth({ headers: 'nope' })).toBe(false);
    expect(isValidAuth([])).toBe(false);
  });

  it('merges headers and a bearer token', () => {
    expect(
      authHeaders({
        token: ' abc ',
        headers: { 'X-API-Key': 'k', '': 'drop' },
      }),
    ).toEqual({ Authorization: 'Bearer abc', 'X-API-Key': 'k' });
    expect(authHeaders(null)).toEqual({});
  });

  it('unwraps arrays, {data} and {rows}, rejecting other payloads', () => {
    expect(extractSyncRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(extractSyncRows({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractSyncRows({ rows: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(extractSyncRows({ data: 'no' })).toBeNull();
    expect(extractSyncRows({ nope: [] })).toBeNull();
    expect(extractSyncRows(null)).toBeNull();
    expect(extractSyncRows('[]')).toBeNull();
  });

  it('truncates long error text', () => {
    const text = syncErrorText(new Error('x'.repeat(2000)));
    expect(text.length).toBe(1000);
    expect(text.endsWith('...')).toBe(true);
    expect(syncErrorText('short')).toBe('short');
  });
});
