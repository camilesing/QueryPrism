// Import-row value parsing (MetaDataImprove): scope defaults + enabled text.
import {
  emptyScopeCounts,
  mergeImportSummaries,
  parseImportEnabled,
  parseImportScope,
} from './import-values';

describe('parseImportScope', () => {
  it('defaults missing/empty values to WORKSPACE', () => {
    expect(parseImportScope(undefined)).toBe('WORKSPACE');
    expect(parseImportScope(null)).toBe('WORKSPACE');
    expect(parseImportScope('')).toBe('WORKSPACE');
    expect(parseImportScope('   ')).toBe('WORKSPACE');
  });

  it('accepts case-insensitive layer names', () => {
    expect(parseImportScope('personal')).toBe('PERSONAL');
    expect(parseImportScope(' Global ')).toBe('GLOBAL');
    expect(parseImportScope('WORKSPACE')).toBe('WORKSPACE');
  });

  it('returns null for unknown or non-string values', () => {
    expect(parseImportScope('team')).toBeNull();
    expect(parseImportScope(1)).toBeNull();
  });
});

describe('parseImportEnabled', () => {
  it('treats absent values as enabled', () => {
    expect(parseImportEnabled(undefined)).toBe(true);
    expect(parseImportEnabled('true')).toBe(true);
    expect(parseImportEnabled('yes')).toBe(true);
    expect(parseImportEnabled(1)).toBe(true);
  });

  it('accepts boolean/string/numeric disable markers', () => {
    expect(parseImportEnabled(false)).toBe(false);
    expect(parseImportEnabled(0)).toBe(false);
    expect(parseImportEnabled('false')).toBe(false);
    expect(parseImportEnabled(' FALSE ')).toBe(false);
    expect(parseImportEnabled('0')).toBe(false);
  });
});

describe('import summary helpers', () => {
  it('starts with zero counts per scope', () => {
    expect(emptyScopeCounts()).toEqual({
      GLOBAL: 0,
      WORKSPACE: 0,
      PERSONAL: 0,
    });
  });

  it('sums applied/by_scope and concatenates failures', () => {
    expect(
      mergeImportSummaries(
        {
          applied: 2,
          by_scope: { GLOBAL: 1, WORKSPACE: 1, PERSONAL: 0 },
          failed: [{ row: 'a', reason: 'x' }],
        },
        {
          applied: 1,
          by_scope: { GLOBAL: 0, WORKSPACE: 0, PERSONAL: 1 },
          failed: [{ row: 'b', reason: 'y' }],
        },
      ),
    ).toEqual({
      applied: 3,
      by_scope: { GLOBAL: 1, WORKSPACE: 1, PERSONAL: 1 },
      failed: [
        { row: 'a', reason: 'x' },
        { row: 'b', reason: 'y' },
      ],
    });
  });
});
