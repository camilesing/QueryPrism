import { BadRequestException } from '@nestjs/common';
import { DbConnectorFactory } from './db-connector.factory';
import { PostgresConnector } from './postgres.connector';
import { encryptFrontendConfig } from '../frontend-config-crypto';

describe('DbConnectorFactory', () => {
  const factory = new DbConnectorFactory({
    get: (key: string) =>
      key === 'DATABASE_URL'
        ? 'postgresql://u:p@localhost:5432/queryprism'
        : key === 'excel.storeSchema'
          ? 'excel_store'
          : undefined,
  } as never);

  it("accepts the frontend's `pg` alias and normalises form keys", async () => {
    const connector = factory.create({
      type: 'pg',
      configuration: encryptFrontendConfig({
        host: 'db.local',
        port: '5433',
        username: 'reader',
        password: 'secret',
        database: 'analytics',
        dbSchema: 'reporting',
      }),
    });

    expect(connector).toBeInstanceOf(PostgresConnector);
    const internals = connector as unknown as {
      pool: { options: Record<string, unknown> };
      schema: string;
    };
    expect(internals.pool.options).toMatchObject({
      host: 'db.local',
      port: 5433,
      user: 'reader',
      password: 'secret',
      database: 'analytics',
    });
    expect(internals.schema).toBe('reporting');
    await connector.close();
  });

  it('also accepts `postgres` as an alias', () => {
    const connector = factory.create({
      type: 'postgres',
      configuration: encryptFrontendConfig({ host: 'h', db: 'd' }),
    });
    expect(connector).toBeInstanceOf(PostgresConnector);
    void connector.close();
  });

  it('rejects unsupported types', () => {
    expect(() =>
      factory.create({ type: 'oracle', configuration: null }),
    ).toThrow(BadRequestException);
  });
});
