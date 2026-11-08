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
import { USER_STATUS } from './create-user.dto';

// The frontend (User.vue) sends a PUT /user with the full form
// (id in body, not path). All fields optional for partial update.
export class UpdateUserDto {
  @IsOptional()
  @IsNumber()
  id?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  account?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsNumber()
  oid?: number;

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

  @IsOptional()
  system_variables?: unknown;
}
