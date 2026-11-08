import { IsInt, IsNotEmpty, IsOptional, IsString, Max } from 'class-validator';

/** Body for POST /:id/exec — runs a read-only SQL statement. */
export class ExecSqlDto {
  @IsString()
  @IsNotEmpty()
  sql!: string;

  @IsOptional()
  @IsInt()
  @Max(10000)
  limit?: number;
}
