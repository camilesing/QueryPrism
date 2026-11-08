import { Prisma } from '@prisma/client';
import { IsDefined, IsNotEmpty, IsString } from 'class-validator';

export class UpdateParameterItemDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  // Prisma.InputJsonValue is a free-form JSON value, so no scalar validator
  // applies. @IsDefined() both guards against an omitted/null value and
  // keeps the property from being stripped by the global ValidationPipe
  // (whitelist: true), which drops properties lacking any decorator.
  @IsDefined()
  value!: Prisma.InputJsonValue;
}
