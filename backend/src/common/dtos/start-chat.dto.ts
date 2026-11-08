import { IsInt, IsOptional, Min } from 'class-validator';

/** Body for `POST /chat/start` (Phase 9c §65 snake_case). `datasource`
 *  is optional — a chat without one triggers the select_datasource LLM step
 *  on its first question. `origin` 0 = page (default), 1 = mcp, 2 = embedded
 *  assistant. The controller translates to the service's camelCase opts. */
export class StartChatDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  datasource?: number;

  // 0 = page, 1 = mcp, 2 = embedded — small enum ints, not an id.
  @IsOptional()
  @IsInt()
  @Min(0)
  origin?: number;
}
