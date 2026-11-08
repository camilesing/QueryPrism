import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/** Legacy chat-creation DTO (datasourceId now optional to match the nullable
 *  Chat.datasourceId). Prefer StartChatDto for the v2 chat routes. */
export class CreateChatDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  datasourceId?: number;

  @IsOptional()
  @IsString()
  title?: string;
}
