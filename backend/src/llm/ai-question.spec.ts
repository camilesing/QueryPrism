// Spec for the datasource-type → engine mapping helper.
import { engineFromDatasourceType } from './ai-question';

describe('engineFromDatasourceType', () => {
  it('maps the canonical lowercase types', () => {
    expect(engineFromDatasourceType('mysql')).toBe('MySQL');
    expect(engineFromDatasourceType('postgresql')).toBe('PostgreSQL');
    expect(engineFromDatasourceType('sqlite')).toBe('SQLite');
  });

  it('maps the postgres alias', () => {
    expect(engineFromDatasourceType('postgres')).toBe('PostgreSQL');
  });

  it('maps the frontend pg type', () => {
    expect(engineFromDatasourceType('pg')).toBe('PostgreSQL');
    expect(engineFromDatasourceType('PG')).toBe('PostgreSQL');
  });

  it('maps imported Excel sheets to the PostgreSQL engine', () => {
    expect(engineFromDatasourceType('excel')).toBe('PostgreSQL');
  });

  it('is case-insensitive', () => {
    expect(engineFromDatasourceType('MySQL')).toBe('MySQL');
    expect(engineFromDatasourceType('SQLITE')).toBe('SQLite');
  });

  it('returns null for unknown types', () => {
    expect(engineFromDatasourceType('oracle')).toBeNull();
  });
});
