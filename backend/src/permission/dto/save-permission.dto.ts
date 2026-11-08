// SavePermissionDto — runtime-validated body for POST /ds_permission/save
// (2026-09 review P2-2: the old plain-interface body hit the service with
// ZERO validation — a missing body.users was a TypeError 500, garbage shapes
// flowed straight into DsPermission rows). Wire shape is unchanged
// (snake_case, §101); the service keeps the PermissionSaveBody interface and
// its semantic expression-tree validation (P0-1) — this DTO only enforces
// the shape so bad payloads die as 400 before reaching Prisma.
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** One entry of `permissions` — the frontend spreads its in-memory item and
 *  JSON-stringifies `permissions` (column field list) + `expression_tree`
 *  (row tree). Nullable snake_case fields pass through as-is. */
export class SavePermissionItemDto {
  /** Client-side id (+new Date() for new items) — ignored on save. */
  @IsOptional()
  @IsInt()
  id?: number;

  @IsOptional()
  @IsString()
  name?: string;

  /** 'row' | 'column'. */
  @IsString()
  @IsNotEmpty()
  type!: string;

  @IsOptional()
  ds_id?: number | null;

  @IsOptional()
  ds_name?: string | null;

  @IsOptional()
  table_id?: number | null;

  @IsOptional()
  table_name?: string | null;

  /** JSON string (column field list) — semantically validated by the service. */
  @IsOptional()
  @IsString()
  permissions?: string;

  /** JSON string (row expression tree) — semantically validated by the service (P0-1). */
  @IsOptional()
  @IsString()
  expression_tree?: string;
}

export class SavePermissionDto {
  /** Absent = create, present = update. */
  @IsOptional()
  @IsInt()
  id?: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SavePermissionItemDto)
  permissions?: SavePermissionItemDto[];

  /** Missing is allowed (the service persists JsonNull); a wrong type is a
   *  clean 400 instead of the old TypeError 500. */
  @IsOptional()
  @IsArray()
  users?: number[];
}
