import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FindPasswordDto {
    @ApiProperty( { example: 'john123', description: '아이디' } )
    @IsString()
    @IsNotEmpty( { message: 'ID를 입력해주세요' } )
    @MaxLength( 50 )
    username: string;

    @ApiProperty( { example: 'john@example.com', description: '가입 시 등록한 이메일' } )
    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;
}
