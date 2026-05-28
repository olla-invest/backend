import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
    @ApiProperty( { example: 'john123', description: '아이디' } )
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    username: string;

    @ApiProperty( { example: 'password123!', description: '비밀번호' } )
    @IsString()
    @IsNotEmpty()
    @MaxLength(50)
    password: string;
}
