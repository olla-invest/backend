import {
    IsBoolean,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CompleteSocialProfileDto {
    @ApiProperty( { example: '홍길동', description: '이름' } )
    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요' } )
    @MaxLength( 100 )
    name: string;

    @ApiProperty( { example: '01012345678', description: '휴대폰번호' } )
    @IsString()
    @IsNotEmpty( { message: '휴대폰번호를 입력해주세요' } )
    @Matches( /^01[0-9]{8,9}$/, { message: '올바른 휴대폰 번호를 입력해주세요' } )
    @MaxLength( 20 )
    phone: string;

    @ApiProperty( { example: true, description: '서비스 이용약관 동의' } )
    @IsBoolean()
    agreeService: boolean;

    @ApiProperty( { example: true, description: '개인정보 처리방침 동의' } )
    @IsBoolean()
    agreePrivacy: boolean;

    @ApiPropertyOptional( { example: false, description: '마케팅 수신 동의' } )
    @IsOptional()
    @IsBoolean()
    agreeMarketing?: boolean;
}
