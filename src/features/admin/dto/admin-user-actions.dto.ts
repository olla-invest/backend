import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEmail, IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PlanType, UserStatus } from '../../../../generated/prisma';

/** 마스킹 해제: 사유는 필수값이며 감사 로그에 그대로 기록된다. */
export class UnmaskUserDto {
    @ApiProperty( { example: 'CS 문의 대응', description: '마스킹 해제 사유 (필수)' } )
    @IsString()
    @IsNotEmpty( { message: '마스킹 해제 사유를 입력해주세요.' } )
    @MaxLength( 500 )
    reason: string;
}

export class ChangeUserPlanDto {
    @ApiProperty( { enum: PlanType, description: '변경할 플랜' } )
    @IsEnum( PlanType )
    planType: PlanType;

    @ApiProperty( { example: '2026-09-28', description: '적용 시작일. 미지정 시 회원의 다음 결제일, 없으면 즉시' } )
    @IsOptional()
    @IsISO8601()
    effectiveAt?: string;

    @ApiPropertyOptional( { example: '2026-12-31', description: '만료일' } )
    @IsOptional()
    @IsISO8601()
    expiresAt?: string;

    @ApiProperty( { example: 'CS 문의 대응', description: '플랜 변경 사유 (필수)' } )
    @IsString()
    @IsNotEmpty( { message: '플랜 변경 사유를 입력해주세요.' } )
    @MaxLength( 500 )
    reason: string;
}

export class ChangeUserStatusDto {
    @ApiProperty( { enum: UserStatus, description: '변경할 상태' } )
    @IsEnum( UserStatus )
    status: UserStatus;

    @ApiProperty( { example: '장기 미접속', description: '상태 변경 사유 (필수)' } )
    @IsString()
    @IsNotEmpty( { message: '상태 변경 사유를 입력해주세요.' } )
    @MaxLength( 500 )
    reason: string;
}

/** 목록에서 선택한 회원의 상태를 한 번에 변경한다. */
export class BulkChangeUserStatusDto {
    @ApiProperty( { type: [ String ], description: '대상 회원 ID 목록' } )
    @IsArray()
    @ArrayNotEmpty( { message: '대상 회원을 선택해주세요.' } )
    @ArrayMaxSize( 500 )
    @IsUUID( '4', { each: true } )
    userIds: string[];

    @ApiProperty( { enum: UserStatus } )
    @IsEnum( UserStatus )
    status: UserStatus;

    @ApiProperty( { example: '휴면 전환 일괄 처리' } )
    @IsString()
    @IsNotEmpty( { message: '상태 변경 사유를 입력해주세요.' } )
    @MaxLength( 500 )
    reason: string;
}

export class ResetUserPasswordDto {
    @ApiPropertyOptional( { example: 'CS 문의 대응', description: '비밀번호 초기화 사유' } )
    @IsOptional()
    @IsString()
    @MaxLength( 500 )
    reason?: string;
}

/** 회원정보 수정. ID 는 수정할 수 없고, 마스킹된 값은 저장을 거부한다. */
export class UpdateUserProfileDto {
    @ApiProperty( { example: '이태린' } )
    @IsString()
    @IsNotEmpty( { message: '이름을 입력해주세요.' } )
    @MaxLength( 100 )
    name: string;

    @ApiProperty( { example: 'ollauser@gmail.com' } )
    @IsEmail( {}, { message: '올바른 이메일 형식을 입력해주세요.' } )
    @MaxLength( 100 )
    email: string;

    @ApiPropertyOptional( { example: '010-1234-5678' } )
    @IsOptional()
    @IsString()
    @MaxLength( 20 )
    phone?: string;
}
