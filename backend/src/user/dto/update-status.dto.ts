import { IsIn, IsInt } from 'class-validator';
import { USER_STATUS } from './create-user.dto';

// Phase 10 §85: PATCH /user/status body {id, status} — both Int. id is the
// target user (no path param); status is 1 (active) or 0 (disabled).
export class UpdateStatusDto {
  @IsInt()
  id!: number;

  @IsInt()
  @IsIn(USER_STATUS)
  status!: number;
}
