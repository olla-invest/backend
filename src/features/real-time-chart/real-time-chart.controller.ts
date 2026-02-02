import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { RealTimeChartService } from './real-time-chart.service';

@Controller('chart')
export class RealTimeChartController {
  constructor(private readonly chartService: RealTimeChartService) {}

  /**
   * GET /chart/candles/minute/:stockCode
   * 분봉 차트 데이터 조회
   */
  @Get('candles/minute/:stockCode')
  async getMinuteCandles(
    @Param('stockCode') stockCode: string,
    @Query('interval') interval: '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60' = '1',
  ) {
    return await this.chartService.getMinuteCandles(stockCode, interval);
  }

  /**
   * GET /chart/candles/tick/:stockCode
   * 틱 차트 데이터 조회
   */
  @Get('candles/tick/:stockCode')
  async getTickCandles(
    @Param('stockCode') stockCode: string,
    @Query('interval') interval: '1' | '3' | '5' | '10' | '30' = '1',
  ) {
    return await this.chartService.getTickCandles(stockCode, interval);
  }

  /**
   * GET /chart/candles/day/:stockCode
   * 일봉 차트 데이터 조회
   */
  @Get('candles/day/:stockCode')
  async getDayCandles(
    @Param('stockCode') stockCode: string,
    @Query('baseDate') baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getDayCandles(stockCode, formattedDate);
  }

  /**
   * GET /chart/stored/:stockCode
   * DB에 저장된 캔들 데이터 조회
   */
  @Get('stored/:stockCode')
  async getStoredCandles(
    @Param('stockCode') stockCode: string,
    @Query('candleType') candleType: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    return await this.chartService.getStoredCandles(
      stockCode,
      candleType,
      startDate,
      endDate,
    );
  }

  /**
   * POST /chart/realtime/start
   * 실시간 구독 시작
   */
  @Post('realtime/start')
  async startRealtime(@Body('stockCode') stockCode: string) {
    return await this.chartService.startRealtime(stockCode);
  }

  /**
   * POST /chart/realtime/stop
   * 실시간 구독 중지
   */
  @Post('realtime/stop')
  async stopRealtime(@Body('stockCode') stockCode: string) {
    return await this.chartService.stopRealtime(stockCode);
  }
}
