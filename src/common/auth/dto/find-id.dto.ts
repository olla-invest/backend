import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class FindIdDto {
    @ApiProperty( { example: '홍길동', description: '이름' } )
    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요' } )
    @MaxLength( 100 )
    name: string;

    @ApiProperty( { example: 'john@example.com', description: '가입 시 등록한 이메일' } )
    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;
}
