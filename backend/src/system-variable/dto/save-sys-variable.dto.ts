// SaveSysVariableDto — runtime-validated body for POST /system/variable/save
// (2026-09 review P2-2: the old plain-interface body was ValidationPipe
// passthrough — `value: "oops"` was blind-cast `as Prisma.InputJsonValue`
// into the Json column even though the wire contract says value is ALWAYS an
// array, and an unparseable id fell into the CREATE branch).
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class SaveSysVariableDto {
  /** Absent = create, present = update. Non-integer strings are rejected
   *  here (defense in depth — the service also strict-parses, P2-1). */
  @IsOptional()
  @IsInt()
  id?: number;

  @IsString()
  @IsNotEmpty()
  name!: string;

  /** 'text' | 'number' | 'datetime'. */
  @IsString()
  @IsNotEmpty()
  var_type!: string;

  /** ALWAYS a Json array on the wire — the mapper reads it as a list; a bare
   *  string/object is a client error. */
  @IsArray()
  value!: unknown[];
}
