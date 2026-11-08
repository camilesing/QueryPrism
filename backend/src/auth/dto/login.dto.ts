import { IsNotEmpty, IsString } from 'class-validator';

// Phase 9b: the frontend posts {username, password} form-urlencoded.
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
