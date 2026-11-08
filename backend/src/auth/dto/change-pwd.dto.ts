import { IsNotEmpty, IsString } from 'class-validator';

// POST /login/change-pwd body — pre-login
// forced initial-password change. Snake_case field names to match the
// frontend's AuthApi.changePwd payload. Credentials arrive in
// plaintext (the QueryPrism backend verifies plaintext — same as
// /login/access-token).
export class ChangePwdDto {
  @IsString()
  @IsNotEmpty()
  account!: string;

  @IsString()
  @IsNotEmpty()
  pwd!: string;

  @IsString()
  @IsNotEmpty()
  new_pwd!: string;
}
