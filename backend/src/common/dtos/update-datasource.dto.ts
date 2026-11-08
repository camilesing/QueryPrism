import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ConnectionConfigDto, DatasourceType } from './create-datasource.dto';

export class UpdateDatasourceDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(DatasourceType)
  type?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ConnectionConfigDto)
  configuration?: ConnectionConfigDto;

  // NOTE: tableRelation is edited through the dedicated
  // POST /:id/table-relation endpoint, not here, so it stays a single source of truth.

  @IsOptional()
  @IsString()
  status?: string;
}
