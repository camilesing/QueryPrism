import { IsInt, IsOptional, Min } from 'class-validator';

/** Body for `POST /chat/record/:rid/analysis|predict` (Phase 9c §65
 *  snake_case). Only the optional `model_id` override — the question is
 *  reused from the source record. The body is optional (the frontend posts
 *  `{}`), so every field is @IsOptional. */
export class RegenerateChatDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  model_id?: number;
}
