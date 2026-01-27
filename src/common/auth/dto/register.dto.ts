import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength( 50 )
    username: string;

    @IsEmail()
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;

    @IsString()
    @IsNotEmpty()
    @MinLength( 6 )
    @MaxLength( 50 )
    password: string;
}
