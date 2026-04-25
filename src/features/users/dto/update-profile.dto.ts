import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
    @ApiPropertyOptional( { example: '홍길동', description: '이름' } )
    @IsOptional()
    @IsString()
    @MaxLength( 100 )
    name?: string;

    @ApiPropertyOptional( { example: '01012345678', description: '휴대폰 번호 (숫자만)' } )
    @IsOptional()
    @IsString()
    @Matches( /^01[0-9]{8,9}$/, { message: '올바른 휴대폰 번호를 입력해주세요' } )
    phone?: string;
}
