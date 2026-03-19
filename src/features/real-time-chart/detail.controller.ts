import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { RealTimeChartService } from './real-time-chart.service';
import { StockInfoService } from '../stock-info/stock-info.service';
import { Public } from '../../common/auth/decorators/public.decorator';

@Controller('real-time-chart/detail')
@Public()
export class DetailController {
  constructor(
    private readonly chartService: RealTimeChartService,
    private readonly stockInfoService: StockInfoService,
  ) {}

  /**
   * GET /real-time-chart/detail/chart/:stockCode
   * 종목 상세 차트/시세 탭 — 종목 요약 + 캔들 + 시세변동현황 통합 조회
   *
   * Query params (차트):
   *   chartType:  'minute' | 'tick' | 'day' | 'week' | 'month' (default: 'day')
   *   interval:   분/틱 단위 (minute: 1|3|5|10|15|30|45|60, tick: 1|3|5|10|30)
   *   startDate:  YYYYMMDD — day/week/month 차트 시작일
   *   endDate:    YYYYMMDD — day/week/month 차트 종료일 (생략 시 오늘)
   *
   * Query params (시세변동현황 테이블 — 항상 DB 저장 일봉):
   *   historyStartDate: YYYYMMDD — 시세변동현황 시작일
   *   historyEndDate:   YYYYMMDD — 시세변동현황 종료일 (생략 시 오늘)
   */
  @Get('chart/:stockCode')
  async getDetailChart(
    @Param('stockCode') stockCode: string,
    @Query('chartType') chartType: 'minute' | 'tick' | 'day' | 'week' | 'month' = 'day',
    @Query('interval') interval: string = '1',
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('historyStartDate') historyStartDate?: string,
    @Query('historyEndDate') historyEndDate?: string,
  ) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;

    const toIso = (yyyymmdd: string) =>
      `${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-${yyyymmdd.substring(6, 8)}`;

    const histStart = historyStartDate
      ? toIso(historyStartDate)
      : `${today.getFullYear() - 1}-01-01`;
    const histEnd = historyEndDate
      ? toIso(historyEndDate)
      : today.toISOString().split('T')[0];

    const [summary, candles, priceHistory] = await Promise.allSettled([
      this.chartService.getStockSummary(stockCode),
      this.getCandles(stockCode, chartType, interval, startDate, endDate ?? todayStr),
      this.chartService.getStoredCandles(stockCode, 'day', histStart, histEnd),
    ]);

    return {
      stockCode,
      summary: summary.status === 'fulfilled' ? summary.value : null,
      candles: candles.status === 'fulfilled' ? candles.value : null,
      priceHistory: priceHistory.status === 'fulfilled' ? priceHistory.value : null,
    };
  }

  private async getCandles(
    stockCode: string,
    chartType: 'minute' | 'tick' | 'day' | 'week' | 'month',
    interval: string,
    startDate?: string,
    endDate?: string,
  ) {
    switch (chartType) {
      case 'minute':
        return await this.chartService.getMinuteCandles(stockCode, interval as any);
      case 'tick':
        return await this.chartService.getTickCandles(stockCode, interval as any);
      case 'day':
      case 'week':
      case 'month': {
        const start = startDate
          ? `${startDate.substring(0, 4)}-${startDate.substring(4, 6)}-${startDate.substring(6, 8)}`
          : `${new Date().getFullYear() - 1}-01-01`;
        const end = endDate
          ? `${endDate.substring(0, 4)}-${endDate.substring(4, 6)}-${endDate.substring(6, 8)}`
          : new Date().toISOString().split('T')[0];
        return await this.chartService.getStoredCandles(stockCode, chartType, start, end);
      }
    }
  }

  /**
   * POST /real-time-chart/detail/rs-history/:stockCode
   * 시장강도분석 탭 — 단일 종목 RS 추이 조회 (그래프용)
   *
   * Body:
   * {
   *   "startDate": "20250304",
   *   "endDate": "20260304",            // 생략 시 오늘
   *   "rsFilters": [                    // 생략 시 디폴트 RS(63일)
   *     { "rsStartDate": "20260209", "rsEndDate": "20260115", "strength": 50 },
   *     { "rsStartDate": "20260115", "rsEndDate": "20251110", "strength": 50 }
   *   ]
   * }
   */
  @Post('rs-history/:stockCode')
  async getRsHistory(
    @Param('stockCode') stockCode: string,
    @Body('startDate') startDate: string,
    @Body('endDate') endDate: string,
    @Body('rsFilters') rsFilters?: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
  ) {
    const today = new Date();
    const end = endDate || `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    return await this.chartService.getRsHistory(stockCode, startDate, end, rsFilters);
  }

  /**
   * GET /real-time-chart/detail/stock-info/:stockCode
   * 종목정보 탭 — DART 재무 데이터 통합 조회 (기업개황 + 손익 + 현금흐름 + 재무지표)
   *
   * Query params:
   *   year: 사업연도 (YYYY, 생략 시 자동 계산)
   */
  @Get('stock-info/:stockCode')
  async getStockInfo(
    @Param('stockCode') stockCode: string,
    @Query('year') year?: string,
  ) {
    return await this.stockInfoService.getStockInfoSummary(stockCode, year);
  }
}
