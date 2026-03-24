import { Controller, Get, Post, Query, Param, Body } from '@nestjs/common';
import { RealTimeChartService } from './real-time-chart.service';
import { InitialSetupService } from './initial-setup.service';
import { StockMetricsService } from './stock-metrics.service';
import { Public } from '../../common/auth/decorators/public.decorator';

@Controller('real-time-chart')
@Public()
export class RealTimeChartController {
  constructor(
    private readonly chartService: RealTimeChartService,
    private readonly setupService: InitialSetupService,
    private readonly metricsService: StockMetricsService,
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
   * GET /real-time-chart/candles/day-detail/:stockCode
   * 일봉 차트 데이터 조회 (종목상세용, 연속조회 ~3년치)
   */
  @Get('candles/day-detail/:stockCode')
  async getDayCandlesDetail(
    @Param('stockCode') stockCode: string,
    @Query('baseDate') baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getDayCandlesDetail(stockCode, formattedDate);
  }

  /**
   * GET /real-time-chart/candles/week/:stockCode
   * 주봉 차트 데이터 조회
   */
  @Get('candles/week/:stockCode')
  async getWeekCandles(
    @Param('stockCode') stockCode: string,
    @Query('baseDate') baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getWeekCandles(stockCode, formattedDate);
  }

  /**
   * GET /real-time-chart/candles/month/:stockCode
   * 월봉 차트 데이터 조회
   */
  @Get('candles/month/:stockCode')
  async getMonthCandles(
    @Param('stockCode') stockCode: string,
    @Query('baseDate') baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getMonthCandles(stockCode, formattedDate);
  }

  /**
   * GET /real-time-chart/summary/:stockCode
   * 종목 상세 요약 (현재가, 전일대비, 거래량, 거래대금, 1일 고저, 52주 고저)
   */
  @Get('summary/:stockCode')
  async getStockSummary(@Param('stockCode') stockCode: string) {
    return await this.chartService.getStockSummary(stockCode);
  }

  /**
   * GET /real-time-chart/stored/:stockCode
   * DB에 저장된 캔들 데이터 조회
   */
  @Get('stored/:stockCode')
  async getStoredCandles(
    @Param('stockCode') stockCode: string,
    @Query('chartType') chartType: string,
    @Query('interval') interval: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    // 분봉/틱봉은 키움 API에서 실시간 조회
    if (chartType === 'minute') {
      const intervalVal = (interval || '1') as '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60';
      return await this.chartService.getMinuteCandles(stockCode, intervalVal);
    }
    if (chartType === 'tick') {
      const intervalVal = (interval || '1') as '1' | '3' | '5' | '10' | '30';
      return await this.chartService.getTickCandles(stockCode, intervalVal);
    }

    // 일/주/월봉은 DB에서 조회
    const candleTypeMap: Record<string, string> = {
      day: 'day',
      week: 'week',
      month: 'month',
    };
    const candleType = candleTypeMap[chartType] ?? chartType;
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
   * GET /real-time-chart/realtime/status
   * 실시간 WebSocket 연결 상태 조회
   */
  @Get('realtime/status')
  getRealtimeStatus() {
    return this.chartService.getRealtimeStatus();
  }

  /**
   * POST /real-time-chart/realtime/ensure-connection
   * 실시간 연결 확인 및 재연결
   */
  @Post('realtime/ensure-connection')
  async ensureRealtimeConnection() {
    await this.chartService.ensureRealtimeConnection();
    return { success: true, message: 'Connection ensured' };
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
   *
   * 테마 필터:
   * - theme: 테마 코드 (숫자, 쉼표로 구분, 예: "101,102,302" = 제약,금속,반도체)
   */
  @Get('stocks')
  async getStockList(
    @Query('marketType') marketType: '0' | '10' | 'all' = 'all',
    @Query('page') page: string = '1',
    @Query('pageSize') pageSize: string = '50',
    @Query('isHighPrice') isHighPrice?: string,
    @Query('minTradingValue') minTradingValue?: string,
    @Query('theme') theme?: string,
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
        theme: theme ? theme.split(',').map(t => parseInt(t.trim())) : undefined,
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
   *     "minTradingValue": 100000000,
   *     "theme": [101, 102, 302]
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
    @Body('marketType') marketType: '0' | '10' | 'all' = 'all',
    @Body('page') page: number = 1,
    @Body('pageSize') pageSize: number = 50,
    @Body('filters') filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
      theme?: number[];
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
   * POST /real-time-chart/backfill/day
   * 전체 종목 일봉 + 거래대금 백필 (페이지네이션, 최대 750일)
   * Fire-and-forget: 즉시 응답, 백그라운드 처리
   */
  @Post('backfill/day')
  async backfillDayCandles(
    @Body('marketType') marketType: '0' | '10' | 'all' = 'all',
    @Body('days') days: number = 130,
  ) {
    const markets: ('0' | '10')[] = marketType === 'all' ? ['0', '10'] : [marketType];

    for (const market of markets) {
      this.chartService.backfillDayCandles(market, days)
        .then((result) => console.log(`Backfill done: market=${market}`, result))
        .catch((err) => console.error(`Backfill failed: market=${market}`, err));
    }

    return {
      success: true,
      message: `Day candle backfill started (markets: ${markets.join(',')}, days: ${days}). Check server logs for progress.`,
    };
  }

  /**
   * POST /real-time-chart/collect/index
   * 시장 지수 일봉 수집 (KOSPI + KOSDAQ)
   * 장 마감 후 지수 종가 갱신 시 사용
   */
  @Post('collect/index')
  async collectIndexCandles() {
    return await this.chartService.collectIndexCandles();
  }

  /**
   * POST /real-time-chart/collect/index-close
   * 오늘 지수 종가만 수집 (ka20001 업종현재가)
   * 장 마감 후 가볍게 호출 — ka20006 일봉 API는 당일 포함 안 함
   */
  @Post('collect/index-close')
  async collectTodayIndexClose() {
    return await this.chartService.collectTodayIndexClose();
  }

  /**
   * POST /real-time-chart/metrics/calculate
   * 일별 지표 계산 (수동 실행)
   */
  @Post('metrics/calculate')
  async calculateMetrics(
    @Body('marketType') marketType: '0' | '10' | 'all' = 'all',
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
   * GET /real-time-chart/debug/stocks
   * 디버그: 필터 없이 종목 리스트 Raw 조회
   */
  @Get('debug/stocks')
  async debugGetStockList(@Query('marketType') marketType: '0' | '10' | 'all' = 'all') {
    return await this.chartService.debugGetStockList(marketType);
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
  async runInitialSetup(@Body('marketType') marketType: '0' | '10' | 'all' = 'all') {
    return await this.setupService.runInitialSetup(marketType);
  }

  /**
   * POST /real-time-chart/setup/quick
   * 빠른 초기 설정 (홈 화면 즉시 사용 가능)
   */
  @Post('setup/quick')
  async runQuickSetup(@Body('marketType') marketType: '0' | '10' | 'all' = 'all') {
    return await this.setupService.runQuickSetup(marketType);
  }

  /**
   * POST /real-time-chart/setup/full
   * 전체 데이터 설정 (백그라운드 배치용)
   */
  @Post('setup/full')
  async runFullSetup(@Body('marketType') marketType: '0' | '10' | 'all' = 'all') {
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
    @Body('marketType') marketType: '0' | '10' | 'all' = 'all',
    @Body('days') days: number = 3650,
  ) {
    // Fire-and-forget: 즉시 응답 후 백그라운드에서 처리
    this.setupService.runExtendedDataCollection(marketType, days)
      .then(result => {
        console.log('Extended data collection completed:', result);
      })
      .catch(error => {
        console.error('Extended data collection failed:', error);
      });

    return {
      success: true,
      message: `Extended data collection started (${days} days, market: ${marketType}). Check server logs for progress.`,
    };
  }

  /**
   * POST /real-time-chart/rs-history/:stockCode
   * 단일 종목 RS 추이 조회 (그래프용), 날짜는 모두 YYYYMMDD
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
   * POST /real-time-chart/debug/filter-check
   * 디버그: 특정 종목들의 5개 필터 통과/실패 상세 조회
   *
   * Body: { "stockCodes": ["043260", "347700", "041920", ...] }
   */
  @Post('debug/filter-check')
  async debugFilterCheck(
    @Body('stockCodes') stockCodes: string[],
  ) {
    return await this.metricsService.debugFilterCheck(stockCodes);
  }

  /**
   * POST /real-time-chart/metrics/custom-rs
   * 특정 종목코드 리스트의 RS 상세 로그 생성
   * 필터 통과 여부와 관계없이 모든 종목의 값을 custom-rs-scores-*.log 로 저장
   *
   * Body:
   * {
   *   "stockCodes": ["043260", "272210", "006800"],
   *   "tradeDate": "20260303"  // 생략 시 오늘
   * }
   */
  @Post('metrics/custom-rs')
  async calculateCustomRsLog(
    @Body('stockCodes') stockCodes: string[],
    @Body('tradeDate') tradeDate?: string,
  ) {
    return await this.metricsService.calculateCustomRsLog(stockCodes, tradeDate);
  }
}
