import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class AdminLoginDto {
    @ApiProperty( { example: 'admin', description: '관리자 로그인 ID' } )
    @IsString()
    @IsNotEmpty( { message: '로그인 ID를 입력해주세요.' } )
    loginId: string;

    @ApiProperty( { example: 'admin1234!', description: '관리자 비밀번호' } )
    @IsString()
    @IsNotEmpty( { message: '비밀번호를 입력해주세요.' } )
    password: string;
}
