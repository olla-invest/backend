import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
    @ApiProperty( { example: 'john123', description: '아이디' } )
    @IsString()
    @IsNotEmpty()
    username: string;

    @ApiProperty( { example: 'password123!', description: '비밀번호' } )
    @IsString()
    @IsNotEmpty()
    password: string;
}
