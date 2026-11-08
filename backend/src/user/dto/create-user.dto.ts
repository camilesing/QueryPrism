import {
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

// The frontend (User.vue) sends {account, password, email, name, oid,
// status, oid_list, system_variables}. status is Int (1/0 from el-switch);
// origin is set by backend (0=local for self-created); name is the display
// name (null → frontend fallback to account).
export const USER_STATUS = [0, 1] as const;

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  account!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsNumber()
  @IsNotEmpty()
  oid!: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  oid_list?: number[];

  @IsOptional()
  @IsIn(USER_STATUS)
  status?: number;

  @IsOptional()
  @IsString()
  language?: string;

  // Json blob (variable overrides) — permissive, deep structure not validated
  // (§38: @IsObject rejects arrays; this field is an array of
  // {variableId, variableValues, variableValue}, so just @IsOptional).
  @IsOptional()
  system_variables?: unknown;
}
