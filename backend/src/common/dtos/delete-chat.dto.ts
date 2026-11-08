import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/** Body for `DELETE /chat/:id` (Phase 9c, snake_case). `id` mirrors the path
 *  param; `brief` is an optional audit hint. The controller deletes by `id`. */
export class DeleteChatDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsOptional()
  @IsString()
  brief?: string;
}
