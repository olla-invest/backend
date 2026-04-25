import {
    IsBoolean,
    IsEmail,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
    MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
    @ApiProperty( { example: 'john123', description: '아이디 (4-20자, 영문/숫자)' } )
    @IsString()
    @IsNotEmpty()
    @Matches( /^[a-zA-Z0-9]{4,20}$/, {
        message: '4-20자, 영문/숫자로 입력해주세요',
    } )
    username: string;

    @ApiProperty( { example: 'password123!', description: '비밀번호 (8자 이상)' } )
    @IsString()
    @IsNotEmpty()
    @MinLength( 8, { message: '8자 이상 입력해주세요' } )
    @MaxLength( 50 )
    password: string;

    @ApiProperty( { example: 'john@example.com', description: '이메일' } )
    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;

    @ApiProperty( { example: '홍길동', description: '이름' } )
    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요' } )
    @MaxLength( 100 )
    name: string;

    @ApiProperty( { example: '01012345678', description: '휴대폰번호' } )
    @IsString()
    @IsNotEmpty( { message: '휴대폰번호를 입력해주세요' } )
    @MaxLength( 20 )
    phone: string;

    @ApiProperty( { example: true, description: '서비스 이용약관 동의' } )
    @IsBoolean()
    agreeService: boolean;

    @ApiProperty( { example: true, description: '개인정보 처리방침 동의' } )
    @IsBoolean()
    agreePrivacy: boolean;

    @ApiPropertyOptional( { example: false, description: '마케팅 수신 동의 (선택)' } )
    @IsOptional()
    @IsBoolean()
    agreeMarketing?: boolean;
}
