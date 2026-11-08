import { IsNotEmpty, IsString } from 'class-validator';

// PUT /user/pwd (self change) body — snake_case field names
// from the frontend PwdForm.vue: {pwd (old), new_pwd (new)}.
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  pwd!: string;

  @IsString()
  @IsNotEmpty()
  new_pwd!: string;
}
