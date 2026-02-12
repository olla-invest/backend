import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { RealTimeChartService } from './real-time-chart.service';
import { InitialSetupService } from './initial-setup.service';
import { Public } from '../../common/auth/decorators/public.decorator';

@Controller('real-time-chart')
@Public()
export class RealTimeChartController {
  constructor(
    private readonly chartService: RealTimeChartService,
    private readonly setupService: InitialSetupService,
  ) {}

  /**
   * GET /real-time-chart/candles/minute/:stockCode
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
   * GET /real-time-chart/candles/tick/:stockCode
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
   * GET /real-time-chart/candles/day/:stockCode
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
   * GET /real-time-chart/stored/:stockCode
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
   * POST /real-time-chart/realtime/start
   * 실시간 구독 시작 (단일 종목)
   */
  @Post('realtime/start')
  async startRealtime(@Body('stockCode') stockCode: string) {
    return await this.chartService.startRealtime(stockCode);
  }

  /**
   * POST /real-time-chart/realtime/stop
   * 실시간 구독 중지 (단일 종목)
   */
  @Post('realtime/stop')
  async stopRealtime(@Body('stockCode') stockCode: string) {
    return await this.chartService.stopRealtime(stockCode);
  }

  /**
   * POST /real-time-chart/realtime/start-batch
   * 실시간 구독 시작 (여러 종목)
   */
  @Post('realtime/start-batch')
  async startRealtimeBatch(@Body('stockCodes') stockCodes: string[]) {
    return await this.chartService.startRealtimeBatch(stockCodes);
  }

  /**
   * POST /real-time-chart/realtime/stop-batch
   * 실시간 구독 중지 (여러 종목)
   */
  @Post('realtime/stop-batch')
  async stopRealtimeBatch(@Body('stockCodes') stockCodes: string[]) {
    return await this.chartService.stopRealtimeBatch(stockCodes);
  }

  /**
   * GET /real-time-chart/realtime/cache-stats
   * 실시간 캐시 상태 조회
   */
  @Get('realtime/cache-stats')
  async getCacheStats() {
    return await this.chartService.getRealtimeCacheStats();
  }

  /**
   * GET /real-time-chart/stocks
   * 종목 리스트 조회 (페이지네이션 + 필터 + 커스텀 RS)
   *
   * RS 커스터마이징 파라미터:
   * - rsPeriods: RS 계산 기간 (예: "63,126,252")
   * - rsWeights: RS 가중치 (예: "50,30,20")
   * - rsDates: RS 계산 날짜 (예: "2026-02-09,2026-01-15,2025-11-10" 또는 "20260209,20260115,20251110")
   *   * rsDates를 사용하면 오늘로부터 며칠 전인지 자동 계산됩니다
   *
   * 파라미터 없으면 디폴트 RS(63일) 사용
   */
  @Get('stocks')
  async getStockList(
    @Query('marketType') marketType: '0' | '10' | '8' = '0',
    @Query('page') page: string = '1',
    @Query('pageSize') pageSize: string = '50',
    @Query('isHighPrice') isHighPrice?: string,
    @Query('minTradingValue') minTradingValue?: string,
    @Query('rsPeriods') rsPeriods?: string,
    @Query('rsWeights') rsWeights?: string,
    @Query('rsDates') rsDates?: string,
  ) {
    return await this.chartService.getStockList(
      marketType,
      parseInt(page),
      parseInt(pageSize),
      {
        isHighPrice: isHighPrice === 'true' ? true : undefined,
        minTradingValue: minTradingValue ? parseFloat(minTradingValue) : undefined,
      },
      rsPeriods,
      rsWeights,
      rsDates,
    );
  }

  /**
   * POST /real-time-chart/stocks
   * 종목 리스트 조회 (기간 기반 RS 필터)
   *
   * Body:
   * {
   *   "marketType": "0",
   *   "page": 1,
   *   "pageSize": 50,
   *   "filters": {
   *     "isHighPrice": true,
   *     "minTradingValue": 100000000
   *   },
   *   "rsFilters": [
   *     { "rsStartDate": "2026-02-09", "rsEndDate": "2026-01-15", "strength": 50 },
   *     { "rsStartDate": "2026-01-15", "rsEndDate": "2025-12-01", "strength": 30 },
   *     { "rsStartDate": "2025-12-01", "rsEndDate": "2025-11-10", "strength": 20 }
   *   ]
   * }
   */
  @Post('stocks')
  async getStockListWithRangeRS(
    @Body('marketType') marketType: '0' | '10' | '8' = '0',
    @Body('page') page: number = 1,
    @Body('pageSize') pageSize: number = 50,
    @Body('filters') filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
    },
    @Body('rsFilters') rsFilters?: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
  ) {
    return await this.chartService.getStockListWithRangeRS(
      marketType,
      page,
      pageSize,
      filters,
      rsFilters,
    );
  }

  /**
   * POST /real-time-chart/collect/day
   * 전체 종목 일봉 수집 (1주일치)
   */
  @Post('collect/day')
  async collectAllDayCandles(
    @Body('marketType') marketType: '0' | '10' = '0',
    @Body('days') days = 7,
  ) {
    return await this.chartService.collectAllDayCandles(marketType, days);
  }

  /**
   * POST /real-time-chart/metrics/calculate
   * 일별 지표 계산 (수동 실행)
   */
  @Post('metrics/calculate')
  async calculateMetrics(
    @Body('marketType') marketType: '0' | '10' | '8' = '0',
    @Body('tradeDate') tradeDate?: string,
  ) {
    return await this.chartService.calculateDailyMetrics(marketType, tradeDate);
  }

  /**
   * GET /real-time-chart/status
   * 데이터 초기화 상태 조회
   */
  @Get('status')
  getInitializationStatus() {
    return this.chartService.getInitializationStatus();
  }

  /**
   * POST /real-time-chart/initialize
   * 데이터 수동 초기화 (일봉 수집 + 지표 계산)
   */
  @Post('initialize')
  async initializeData(
    @Body('marketTypes') marketTypes: ('0' | '10')[] = ['0', '10'],
  ) {
    return await this.chartService.initializeData(marketTypes);
  }

  /**
   * POST /real-time-chart/setup/initial
   * 초기 데이터 설정 (기본 = 빠른 설정)
   */
  @Post('setup/initial')
  async runInitialSetup(@Body('marketType') marketType: '0' | '10' | '8' = '0') {
    return await this.setupService.runInitialSetup(marketType);
  }

  /**
   * POST /real-time-chart/setup/quick
   * 빠른 초기 설정 (홈 화면 즉시 사용 가능)
   */
  @Post('setup/quick')
  async runQuickSetup(@Body('marketType') marketType: '0' | '10' | '8' = '0') {
    return await this.setupService.runQuickSetup(marketType);
  }

  /**
   * POST /real-time-chart/setup/full
   * 전체 데이터 설정 (백그라운드 배치용)
   */
  @Post('setup/full')
  async runFullSetup(@Body('marketType') marketType: '0' | '10' | '8' = '0') {
    return await this.setupService.runFullSetup(marketType);
  }

  /**
   * POST /real-time-chart/setup/extended
   * 확장 데이터 수집 (10년치 등 장기 데이터)
   *
   * @param marketType - 시장 타입 ('0': KOSPI, '10': KOSDAQ, '8': ETF)
   * @param days - 수집할 일수 (기본: 3650일 = 약 10년)
   *
   * @example
   * curl -X POST http://localhost:3000/real-time-chart/setup/extended \
   *   -H "Content-Type: application/json" \
   *   -d '{"marketType":"0","days":3650}'
   */
  @Post('setup/extended')
  async runExtendedDataCollection(
    @Body('marketType') marketType: '0' | '10' | '8' = '0',
    @Body('days') days: number = 3650,
  ) {
    return await this.setupService.runExtendedDataCollection(marketType, days);
  }
}
