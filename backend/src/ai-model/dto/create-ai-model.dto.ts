import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateAiModelDto {
  @IsString()
  @IsNotEmpty()
  supplier!: string; // openai | tongyi | azure | vllm | ollama | deepseek | ...

  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  modelType!: string; // llm | embedding | rerank

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
  protocol?: string; // openai | azure | ...

  @IsOptional()
  @IsObject()
  config?: object;

  @IsOptional()
  @IsString()
  status?: string; // active | disabled
}
