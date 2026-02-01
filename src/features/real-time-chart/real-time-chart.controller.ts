import { Controller, Get, Query } from '@nestjs/common';
import { RealTimeChartService } from './real-time-chart.service';
import { RealTimeChartFilterDto } from './dto/real-time-chart-filter.dto';
import { RealTimeChartResultDto } from './dto/real-time-chart-result.dto';

@Controller( 'real-time-chart' )
export class RealTimeChartController {
    constructor( private readonly realTimeChartService: RealTimeChartService ) {}

    /**
     * GET /real-time-chart
     *
     * 실시간 차트 조회 - 필터 조건에 따라 종목 스크리닝 및 랭킹 결과 반환
     *
     * @query rsPeriods        RS 기간/비율 설정 JSON string (기본: 63영업일 / 100%)
     * @query minTradingValue  최소 거래대금 (기본: 1,000,000,000)
     * @query marketType       거래소 필터 (KOSPI / KOSDAQ / 미전송=전체)
     * @query newHighTypes     신고가 기준 (ALL_TIME,YEARLY)
     * @query includeNonNewHigh 신고가 미해당 포함 여부
     * @query theme            테마 필터 (미전송=전체)
     * @query queryStartDate   조회 시작일
     * @query queryEndDate     조회 종료일
     * @query page             페이지 (기본: 1)
     * @query limit            페이지당 개수 (기본: 10)
     *
     * @example GET /real-time-chart?marketType=KOSPI&minTradingValue=1000000000&newHighTypes=ALL_TIME,YEARLY&page=1&limit=10
     */
    @Get()
    async screen( @Query() filter: RealTimeChartFilterDto ): Promise<RealTimeChartResultDto> {
        return this.realTimeChartService.screen( filter );
    }
}
