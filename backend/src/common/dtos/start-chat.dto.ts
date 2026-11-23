import { IsInt, IsOptional, Min } from 'class-validator';

/** Body for `POST /chat/start` (Phase 9c §65 snake_case). `datasource`
 *  is optional — a chat without one triggers the select_datasource LLM step
 *  on its first question. The chat origin (0 page / 1 mcp / 2 embedded
 *  assistant) is NOT part of the body: the page route always creates a page
 *  chat, and the other origins are set by the server-side callers. */
export class StartChatDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  datasource?: number;
}
