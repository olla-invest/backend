import { IsString, IsNotEmpty } from 'class-validator';

export class TokenRequestDto {
  @IsString()
  @IsNotEmpty()
  grant_type: string = 'client_credentials';

  @IsString()
  @IsNotEmpty()
  appkey: string;

  @IsString()
  @IsNotEmpty()
  secretkey: string;
}

export class TokenResponseDto {
  expires_dt: string;
  token_type: string;
  token: string;
  return_code: number;
  return_msg: string;
}
