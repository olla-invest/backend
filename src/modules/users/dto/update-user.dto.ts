import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateUserDto {
    @IsString()
    @IsOptional()
    @MaxLength( 50 )
        username?: string;

    @IsEmail()
    @IsOptional()
    @MaxLength( 100 )
        email?: string;
}
