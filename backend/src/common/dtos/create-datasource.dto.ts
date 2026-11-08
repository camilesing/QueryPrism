import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export enum DatasourceType {
  MYSQL = 'mysql',
  POSTGRESQL = 'postgresql',
  SQLITE = 'sqlite',
}

/**
 * Plaintext connection parameters received from the client. The service
 * AES-encrypts this whole object into Datasource.configuration before it
 * ever touches the database (see common/utils/aes). Field names mirror the
 * internal ConnectionConfig (host/port/user/pwd/db/schema) on purpose, so
 * `pwd` is used instead of `password` to match the encryption contract.
 */
export class ConnectionConfigDto {
  @IsOptional()
  @IsString()
  host?: string;

  @IsOptional()
  @IsNumber()
  port?: number;

  @IsOptional()
  @IsString()
  user?: string;

  @IsOptional()
  @IsString()
  pwd?: string;

  @IsOptional()
  @IsString()
  db?: string;

  @IsOptional()
  @IsString()
  schema?: string;

  @IsOptional()
  @IsBoolean()
  ssl?: boolean;
}

export class CreateDatasourceDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  @IsNotEmpty()
  @IsEnum(DatasourceType)
  type!: string; // mysql | postgresql | sqlite

  @IsOptional()
  @ValidateNested()
  @Type(() => ConnectionConfigDto)
  configuration?: ConnectionConfigDto;
}
