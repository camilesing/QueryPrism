import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

/** Body for `POST /chat/rename` (Phase 9c, snake_case). `id` is the chat id;
 *  `brief` is the new display name. The controller updates both the chat's
 *  `brief` + internal `title`. */
export class RenameChatDto {
  @IsInt()
  @Min(1)
  id!: number;

  @IsString()
  @IsNotEmpty()
  brief!: string;
}
