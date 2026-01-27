import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateUserDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength( 50 )
        username: string;

    @IsEmail()
    @IsNotEmpty()
    @MaxLength( 100 )
        email: string;
}
