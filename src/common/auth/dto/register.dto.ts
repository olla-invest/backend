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

export class RegisterDto {
    @IsString()
    @IsNotEmpty()
    @Matches( /^[a-zA-Z0-9]{4,20}$/, {
        message: '4-20자, 영문/숫자로 입력해주세요',
    } )
    username: string;

    @IsString()
    @IsNotEmpty()
    @MinLength( 8, { message: '8자 이상 입력해주세요' } )
    @MaxLength( 50 )
    password: string;

    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @IsNotEmpty()
    @MaxLength( 100 )
    email: string;

    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요' } )
    @MaxLength( 100 )
    name: string;

    @IsString()
    @IsNotEmpty( { message: '휴대폰번호를 입력해주세요' } )
    @MaxLength( 20 )
    phone: string;

    @IsBoolean()
    agreeService: boolean;

    @IsBoolean()
    agreePrivacy: boolean;

    @IsOptional()
    @IsBoolean()
    agreeMarketing?: boolean;
}
