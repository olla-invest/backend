import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
    @ApiPropertyOptional( { example: '홍길동', description: '이름' } )
    @IsOptional()
    @IsString()
    @MaxLength( 100 )
    name?: string;

    @ApiPropertyOptional( { example: '01012345678', description: '휴대폰 번호 (숫자만)' } )
    @IsOptional()
    @Transform( ( { value } ) => typeof value === 'string' ? value.replace( /\D/g, '' ) : value )
    @IsString()
    @Matches( /^01[0-9]{8,9}$/, { message: '올바른 휴대폰 번호를 입력해주세요' } )
    phone?: string;

    @ApiPropertyOptional( { example: 'john@example.com', description: '이메일' } )
    @IsOptional()
    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요' } )
    @MaxLength( 100 )
    email?: string;
}
