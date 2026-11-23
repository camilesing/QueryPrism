import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsNotEmpty,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class SemanticEnumValueDto {
  @IsString()
  @IsNotEmpty()
  value!: string;

  @IsOptional()
  @IsString()
  label?: string;
}

/** Body for `PUT /system/semantic` (MetaDataImprove M2). The scope decides
 *  the write path: the actor's own layer (PERSONAL / admin on WORKSPACE /
 *  uid 1 on GLOBAL) applies directly with a new version; anything else
 *  becomes a pending SemanticChangeRequest for that layer's admin. */
export class SemanticUpsertDto {
  @IsIn(['table', 'field'])
  entity_type!: 'table' | 'field';

  @IsIn(['GLOBAL', 'WORKSPACE', 'PERSONAL'])
  scope!: 'GLOBAL' | 'WORKSPACE' | 'PERSONAL';

  @IsInt()
  @Min(1)
  datasource_id!: number;

  @IsString()
  @IsNotEmpty()
  table_name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  field_name?: string;

  @IsOptional()
  @IsIn(['metric', 'dimension', 'time', 'other'])
  role?: 'metric' | 'dimension' | 'time' | 'other';

  @IsString()
  @IsNotEmpty()
  meaning!: string;

  /** Business synonyms used by table-recall keyword expansion only. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SemanticEnumValueDto)
  enum_values?: SemanticEnumValueDto[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Body for `PUT /system/semantic/request/review`. */
export class SemanticReviewDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  review_note?: string;
}
