import { IsEnum, IsNumber, IsOptional, IsArray, IsBoolean, IsString, ValidateNested, IsDate } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { MarketType } from '@generated/prisma';

/**
 * RS 기간 설정
 * - 시작일/종료일 날짜 범위 내 영업일만을 기준으로 RS 산출
 * - 기본값: 최근 63영업일 / 비율 100%
 * - 복수 기간 설정 가능, 비율 합계는 100%
 */
export class RsPeriodDto {
    @IsDate()
    @Type( () => Date )
        startDate: Date;

    @IsDate()
    @Type( () => Date )
        endDate: Date;

    @IsNumber()
        weight: number; // 비율 (%, 합계 100)
}

/**
 * 신고가 기준 타입
 * - ALL_TIME: 전체기간 신고가
 * - YEARLY: 연봉 (52주 신고가)
 */
export enum NewHighType {
    ALL_TIME = 'ALL_TIME',
    YEARLY = 'YEARLY',
}

/**
 * 실시간 차트 조회 필터
 */
export class RealTimeChartFilterDto {
    // ① RS 기준 (상세 설정) - JSON string으로 전달
    @IsOptional()
    @Transform( ( { value } ) => typeof value === 'string' ? JSON.parse( value ) : value )
    @IsArray()
    @ValidateNested( { each: true } )
    @Type( () => RsPeriodDto )
        rsPeriods?: RsPeriodDto[];

    // ② 거래대금 (기본: 1,000,000,000)
    @IsOptional()
    @Transform( ( { value } ) => value ? Number( value ) : undefined )
    @IsNumber()
        minTradingValue?: number;

    // ③ 거래소 (전체 / KOSPI / KOSDAQ)
    @IsOptional()
    @IsEnum( MarketType )
        marketType?: MarketType;

    // ④ 신고가 기준 - 선택된 타입 목록 (콤마 구분: ALL_TIME,YEARLY)
    @IsOptional()
    @Transform( ( { value } ) => typeof value === 'string' ? value.split( ',' ) : value )
    @IsArray()
    @IsEnum( NewHighType, { each: true } )
        newHighTypes?: NewHighType[];

    // ④ 신고가 미해당(-표시) 포함 여부
    @IsOptional()
    @Transform( ( { value } ) => value === 'true' ? true : value === 'false' ? false : value )
    @IsBoolean()
        includeNonNewHigh?: boolean;

    // ⑤ 테마 필터 (null이면 전체)
    @IsOptional()
    @IsString()
        theme?: string;

    // 조회기간
    @IsOptional()
    @IsDate()
    @Type( () => Date )
        queryStartDate?: Date;

    @IsOptional()
    @IsDate()
    @Type( () => Date )
        queryEndDate?: Date;

    // 페이지네이션
    @IsOptional()
    @Transform( ( { value } ) => value ? Number( value ) : undefined )
    @IsNumber()
        page?: number;

    @IsOptional()
    @Transform( ( { value } ) => value ? Number( value ) : undefined )
    @IsNumber()
        limit?: number;
}
