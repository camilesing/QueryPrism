// Spec for the shared datasource-type normaliser.
import { normalizeDatasourceType } from './datasource-type';

describe('normalizeDatasourceType', () => {
  it('maps the PostgreSQL aliases the frontend and legacy callers send', () => {
    expect(normalizeDatasourceType('pg')).toBe('postgresql');
    expect(normalizeDatasourceType('postgres')).toBe('postgresql');
  });

  it('passes canonical types through', () => {
    expect(normalizeDatasourceType('mysql')).toBe('mysql');
    expect(normalizeDatasourceType('postgresql')).toBe('postgresql');
    expect(normalizeDatasourceType('sqlite')).toBe('sqlite');
    expect(normalizeDatasourceType('excel')).toBe('excel');
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeDatasourceType('PG')).toBe('postgresql');
    expect(normalizeDatasourceType(' MySQL ')).toBe('mysql');
  });

  it('returns an empty string for missing values', () => {
    expect(normalizeDatasourceType(null)).toBe('');
    expect(normalizeDatasourceType(undefined)).toBe('');
  });

  it('leaves unknown types untouched', () => {
    expect(normalizeDatasourceType('oracle')).toBe('oracle');
  });
});
