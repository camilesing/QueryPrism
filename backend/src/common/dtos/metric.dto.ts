import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';
import {
  METRIC_KINDS,
  NAMING_CATEGORIES,
  STANDARD_KINDS,
  UNIT_CATEGORIES,
} from '../../semantic/metric-policy';

/** Body for `PUT /system/metric` (MetaDataImprove M4). Per-kind definition
 *  presence (aggregation for atomics, expression for composites, ...) is
 *  cross-validated in MetricService.validateInfo — the DTO pins the wire
 *  shape common to every kind. */
export class MetricUpsertDto {
  @IsIn(METRIC_KINDS)
  kind!: (typeof METRIC_KINDS)[number];

  @IsIn(['GLOBAL', 'WORKSPACE', 'PERSONAL'])
  scope!: 'GLOBAL' | 'WORKSPACE' | 'PERSONAL';

  /** Identifier token — codes must survive the composite-expression
   *  tokenizer (metric-policy CODE_TOKEN). */
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z][A-Za-z0-9_]*$/, {
    message: 'code must be an identifier (letter first, then letters/digits/_)',
  })
  code!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsObject()
  definition!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Body for `PUT /system/standard` (MetaDataImprove M4 data standards). */
export class StandardUpsertDto {
  @IsIn(STANDARD_KINDS)
  kind!: (typeof STANDARD_KINDS)[number];

  @IsIn(['GLOBAL', 'WORKSPACE', 'PERSONAL'])
  scope!: 'GLOBAL' | 'WORKSPACE' | 'PERSONAL';

  @IsString()
  @IsNotEmpty()
  code!: string;

  /** The matched word (unit name / business term or word root). */
  @IsString()
  @IsNotEmpty()
  term!: string;

  /** The standard translation / standard symbol. */
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsIn([...UNIT_CATEGORIES, ...NAMING_CATEGORIES])
  category?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

/** Body for `PUT /system/metric/request/review` — same shape as the semantic
 *  review but a separate route (M4 requests live in the same table). */
export class MetricReviewDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  review_note?: string;
}
