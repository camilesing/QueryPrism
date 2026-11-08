import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/** Body for `POST /chat/question` (Phase 9c §65 snake_case). `chat_id`
 *  identifies the target chat (the route is chat_id-less); `question` is the
 *  user's text (also accepts quick commands `/regenerate|/analysis|/predict
 *  <rid>`); the optional `model_id` overrides the configured default LLM. */
export class QuestionDto {
  @IsInt()
  @Min(1)
  chat_id!: number;

  @IsString()
  @IsNotEmpty()
  question!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  model_id?: number;
}
