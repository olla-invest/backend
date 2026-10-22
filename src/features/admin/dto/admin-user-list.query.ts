import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { AuthProvider, PlanType, UserStatus } from '../../../../generated/prisma';

const toBoolean = ( { value }: { value: unknown } ) => value === true || value === 'true';
const toStringArray = ( { value }: { value: unknown } ) =>
    typeof value === 'string' ? value.split( ',' ).map( ( item ) => item.trim() ).filter( Boolean ) : value;

export class AdminUserListQuery {
    @ApiPropertyOptional( { description: '가입기간 시작일 (yyyy-mm-dd)', example: '2026-03-17' } )
    @IsOptional()
    @IsISO8601()
    joinedFrom?: string;

    @ApiPropertyOptional( { description: '가입기간 종료일 (yyyy-mm-dd, 해당일 포함)', example: '2026-06-18' } )
    @IsOptional()
    @IsISO8601()
    joinedTo?: string;

    @ApiPropertyOptional( { description: '가입경로', enum: AuthProvider } )
    @IsOptional()
    @IsEnum( AuthProvider )
    provider?: AuthProvider;

    @ApiPropertyOptional( { description: '플랜', enum: PlanType } )
    @IsOptional()
    @IsEnum( PlanType )
    planType?: PlanType;

    @ApiPropertyOptional( { description: '계정 상태', enum: UserStatus } )
    @IsOptional()
    @IsEnum( UserStatus )
    status?: UserStatus;

    @ApiPropertyOptional( { description: 'ID · 이메일 · 이름 · 전화번호 부분 일치 (원문 기준)' } )
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional( { description: '선택한 회원만 조회·내보내기 (쉼표로 구분한 회원 ID)', type: String } )
    @IsOptional()
    @Transform( toStringArray )
    @IsArray()
    @ArrayMaxSize( 500 )
    @IsUUID( '4', { each: true } )
    userIds?: string[];

    @ApiPropertyOptional( { description: '삭제 계정 포함 여부', default: false } )
    @IsOptional()
    @Transform( toBoolean )
    @IsBoolean()
    includeDeleted?: boolean;

    @ApiPropertyOptional( { default: 1 } )
    @IsOptional()
    @Type( () => Number )
    @IsInt()
    @Min( 1 )
    page?: number;

    @ApiPropertyOptional( { default: 10, maximum: 200 } )
    @IsOptional()
    @Type( () => Number )
    @IsInt()
    @Min( 1 )
    @Max( 200 )
    pageSize?: number;

    @ApiPropertyOptional( { description: '정렬 기준', enum: [ 'createdAt', 'username', 'planType', 'status' ], default: 'createdAt' } )
    @IsOptional()
    @IsIn( [ 'createdAt', 'username', 'planType', 'status' ] )
    sortBy?: 'createdAt' | 'username' | 'planType' | 'status';

    @ApiPropertyOptional( { enum: [ 'asc', 'desc' ], default: 'desc' } )
    @IsOptional()
    @IsIn( [ 'asc', 'desc' ] )
    sortOrder?: 'asc' | 'desc';
}
