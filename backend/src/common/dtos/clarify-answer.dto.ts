import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

/** Body for `POST /chat/record/:rid/clarify` (MetaDataImprove M1) — the
 *  user's answer to a clarify-paused record. At least one of table_ids /
 *  text / skip must be present (enforced by ChatService.resumeClarified so
 *  the error is localized); table_ids must come from the offered candidates.
 *  The optional model_id overrides the configured default LLM (mirrors
 *  RegenerateChatDto on the other SSE record routes). */
export class ClarifyAnswerDto {
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  table_ids?: number[];

  @IsOptional()
  @IsString()
  text?: string;

  @IsOptional()
  @IsBoolean()
  skip?: boolean;

  /** Round token echoed from the clarify frame / stored clarify payload.
   *  Optional: pre-token clients omit it and fall back to the legacy
   *  status-only claim; when present the answer is pinned to that pause. */
  @IsOptional()
  @IsInt()
  @Min(1)
  round?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  model_id?: number;
}
