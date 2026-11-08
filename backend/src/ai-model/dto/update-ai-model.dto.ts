import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateAiModelDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  supplier?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  modelType?: string;

  @IsOptional()
  @IsString()
  baseModel?: string;

  /** Plaintext API key — AES-encrypted before persistence. */
  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  apiDomain?: string;

  @IsOptional()
  @IsString()
  protocol?: string;

  @IsOptional()
  @IsObject()
  config?: object;

  @IsOptional()
  @IsString()
  status?: string;
}
