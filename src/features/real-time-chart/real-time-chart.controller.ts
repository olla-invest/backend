import { Controller, Get, Post, Query, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { RealTimeChartService } from './real-time-chart.service';
import { InitialSetupService } from './initial-setup.service';
import { StockMetricsService } from './stock-metrics.service';
import { Public } from '../../common/auth/decorators/public.decorator';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { RealTimeChartResultDto } from './dto/real-time-chart-result.dto';
import {
  CsvDatePipe,
  CsvIntPipe,
  DateStringPipe,
  EnumPipe,
  EnumArrayPipe,
  IntRangePipe,
  NumberRangePipe,
  RegexPipe,
  RsFiltersPipe,
  StockCodeArrayPipe,
  StockListFiltersPipe,
  StockCodePipe,
} from '../../common/pipes/input-validation.pipes';

@ApiTags( '실시간 차트 (Real-time Chart)' )
@Controller('real-time-chart')
@Public()
export class RealTimeChartController {
  constructor(
    private readonly chartService: RealTimeChartService,
    private readonly setupService: InitialSetupService,
    private readonly metricsService: StockMetricsService,
  ) {}

  @Get('candles/minute/:stockCode')
  @ApiOperation( { summary: '분봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'interval', required: false, enum: ['1','3','5','10','15','30','45','60'], description: '봉 간격(분)' } )
  async getMinuteCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('interval', new EnumPipe(['1','3','5','10','15','30','45','60'] as const, 'interval', true)) interval: '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60' = '1',
  ) {
    return await this.chartService.getMinuteCandles(stockCode, interval);
  }

  @Get('candles/tick/:stockCode')
  @ApiOperation( { summary: '틱봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'interval', required: false, enum: ['1','3','5','10','30'], description: '틱 간격' } )
  async getTickCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('interval', new EnumPipe(['1','3','5','10','30'] as const, 'interval', true)) interval: '1' | '3' | '5' | '10' | '30' = '1',
  ) {
    return await this.chartService.getTickCandles(stockCode, interval);
  }

  @Get('candles/day/:stockCode')
  @ApiOperation( { summary: '일봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'baseDate', required: false, example: '20260404', description: '기준일자 (YYYYMMDD, 생략 시 오늘)' } )
  async getDayCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('baseDate', new RegexPipe(/^\d{8}$/, 'baseDate', true)) baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getDayCandles(stockCode, formattedDate);
  }

  @Get('candles/day-detail/:stockCode')
  @ApiOperation( { summary: '일봉 차트 조회 (종목상세용, ~3년치)' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'baseDate', required: false, example: '20260404', description: '기준일자 (YYYYMMDD, 생략 시 오늘)' } )
  @ApiQuery( { name: 'adjustedPrice', required: false, example: '1', description: '수정주가구분 (0: 비조정, 1: 수정주가, 기본값 1)' } )
  async getDayCandlesDetail(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('baseDate', new RegexPipe(/^\d{8}$/, 'baseDate', true)) baseDate: string,
    @Query('adjustedPrice', new EnumPipe(['0', '1'] as const, 'adjustedPrice', true)) adjustedPrice: '0' | '1',
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getDayCandlesDetail(stockCode, formattedDate, adjustedPrice === '0' ? '0' : '1');
  }

  @Get('candles/week/:stockCode')
  @ApiOperation( { summary: '주봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'baseDate', required: false, example: '20260404', description: '기준일자 (YYYYMMDD)' } )
  async getWeekCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('baseDate', new RegexPipe(/^\d{8}$/, 'baseDate', true)) baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getWeekCandles(stockCode, formattedDate);
  }

  @Get('candles/month/:stockCode')
  @ApiOperation( { summary: '월봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'baseDate', required: false, example: '20260404', description: '기준일자 (YYYYMMDD)' } )
  async getMonthCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('baseDate', new RegexPipe(/^\d{8}$/, 'baseDate', true)) baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getMonthCandles(stockCode, formattedDate);
  }

  @Get('candles/year/:stockCode')
  @ApiOperation( { summary: '연봉 차트 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'baseDate', required: false, example: '20260404', description: '기준일자 (YYYYMMDD)' } )
  async getYearCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('baseDate', new RegexPipe(/^\d{8}$/, 'baseDate', true)) baseDate: string,
  ) {
    const formattedDate = baseDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
    return await this.chartService.getYearCandles(stockCode, formattedDate);
  }

  @Get('summary/:stockCode')
  @ApiOperation( { summary: '종목 상세 요약', description: '현재가, 전일대비, 거래량, 거래대금, 1일 고저, 52주 고저' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  async getStockSummary(@Param('stockCode', new StockCodePipe()) stockCode: string) {
    return await this.chartService.getStockSummary(stockCode);
  }

  @Get('stored/:stockCode')
  @ApiOperation( { summary: 'DB 저장 캔들 데이터 조회', description: '분봉/틱봉은 키움 API 실시간 조회, 일/주/월봉은 DB 조회' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiQuery( { name: 'chartType', required: false, enum: ['minute','tick','day','week','month','year'] } )
  @ApiQuery( { name: 'interval', required: false, example: '1' } )
  @ApiQuery( { name: 'startDate', required: false, example: '20260101' } )
  @ApiQuery( { name: 'endDate', required: false, example: '20260404' } )
  async getStoredCandles(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Query('chartType', new EnumPipe(['minute','tick','day','week','month','year'] as const, 'chartType', true)) chartType: string,
    @Query('interval', new EnumPipe(['1','3','5','10','15','30','45','60'] as const, 'interval', true)) interval: string,
    @Query('startDate', new DateStringPipe('startDate', true)) startDate: string,
    @Query('endDate', new DateStringPipe('endDate', true)) endDate: string,
  ) {
    if (chartType === 'minute') {
      const intervalVal = (interval || '1') as '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60';
      return await this.chartService.getMinuteCandles(stockCode, intervalVal);
    }
    if (chartType === 'tick') {
      const intervalVal = (interval || '1') as '1' | '3' | '5' | '10' | '30';
      return await this.chartService.getTickCandles(stockCode, intervalVal);
    }

    const candleTypeMap: Record<string, string> = {
      day: 'day',
      week: 'week',
      month: 'month',
      year: 'year',
    };
    const candleType = candleTypeMap[chartType] ?? 'day';
    return await this.chartService.getStoredCandles(
      stockCode,
      candleType,
      startDate,
      endDate,
    );
  }

  @Post('realtime/start')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 실시간 구독 시작 (단일 종목)' } )
  @ApiBody( { schema: { example: { stockCode: '005930' } } } )
  async startRealtime(@Body('stockCode', new StockCodePipe()) stockCode: string) {
    return await this.chartService.startRealtime(stockCode);
  }

  @Post('realtime/stop')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 실시간 구독 중지 (단일 종목)' } )
  @ApiBody( { schema: { example: { stockCode: '005930' } } } )
  async stopRealtime(@Body('stockCode', new StockCodePipe()) stockCode: string) {
    return await this.chartService.stopRealtime(stockCode);
  }

  @Post('realtime/start-batch')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 실시간 구독 시작 (여러 종목)' } )
  @ApiBody( { schema: { example: { stockCodes: ['005930', '000660'] } } } )
  async startRealtimeBatch(@Body('stockCodes', new StockCodeArrayPipe(false, 200)) stockCodes: string[]) {
    return await this.chartService.startRealtimeBatch(stockCodes);
  }

  @Post('realtime/stop-batch')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 실시간 구독 중지 (여러 종목)' } )
  @ApiBody( { schema: { example: { stockCodes: ['005930', '000660'] } } } )
  async stopRealtimeBatch(@Body('stockCodes', new StockCodeArrayPipe(false, 200)) stockCodes: string[]) {
    return await this.chartService.stopRealtimeBatch(stockCodes);
  }

  @Get('realtime/cache-stats')
  @ApiOperation( { summary: '실시간 캐시 상태 조회' } )
  async getCacheStats() {
    return await this.chartService.getRealtimeCacheStats();
  }

  @Get('realtime/status')
  @ApiOperation( { summary: '실시간 WebSocket 연결 상태 조회' } )
  getRealtimeStatus() {
    return this.chartService.getRealtimeStatus();
  }

  @Get('admin/metrics')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 일자별 메트릭 조회' } )
  async getAdminDailyMetrics(
    @Query('tradeDate') tradeDate?: string,
    @Query('marketType') marketType: '0' | '10' | 'all' = 'all',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('passedStaticFilters') passedStaticFilters?: string,
    @Query('mode') mode?: 'aggregated' | 'raw',
  ) {
    return this.chartService.getAdminDailyMetrics({
      tradeDate,
      marketType,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      passedStaticFilters: passedStaticFilters === undefined ? undefined : passedStaticFilters === 'true',
      mode: mode === 'raw' ? 'raw' : 'aggregated',
    });
  }

  @Post('realtime/ensure-connection')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 실시간 연결 확인 및 재연결' } )
  async ensureRealtimeConnection() {
    await this.chartService.ensureRealtimeConnection();
    return { success: true, message: 'Connection ensured' };
  }

  @Get('stocks')
  @ApiOperation( { summary: '종목 리스트 조회 (GET)', description: '페이지네이션 + 필터 + 커스텀 RS. 파라미터 없으면 디폴트 RS(63일) 사용.' } )
  @ApiQuery( { name: 'marketType', required: false, enum: ['0','10','all'], description: '0: KOSPI, 10: KOSDAQ, all: 전체' } )
  @ApiQuery( { name: 'page', required: false, example: '1' } )
  @ApiQuery( { name: 'pageSize', required: false, example: '50' } )
  @ApiQuery( { name: 'isHighPrice', required: false, example: 'true', description: '신고가 필터' } )
  @ApiQuery( { name: 'minTradingValue', required: false, example: '100000000', description: '최소 거래대금 (원)' } )
  @ApiQuery( { name: 'theme', required: false, example: '101,102,302', description: '테마코드 (쉼표 구분)' } )
  @ApiQuery( { name: 'rsPeriods', required: false, example: '63,126,252', description: 'RS 계산 기간' } )
  @ApiQuery( { name: 'rsWeights', required: false, example: '50,30,20', description: 'RS 가중치' } )
  @ApiQuery( { name: 'rsDates', required: false, example: '2026-02-09,2026-01-15,2025-11-10', description: 'RS 계산 날짜' } )
  @ApiOkResponse( { type: RealTimeChartResultDto } )
  async getStockList(
    @Query('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Query('page', new IntRangePipe('page', 1, 10000, true)) page: number = 1,
    @Query('pageSize', new IntRangePipe('pageSize', 1, 500, true)) pageSize: number = 50,
    @Query('isHighPrice', new EnumPipe(['true', 'false'] as const, 'isHighPrice', true)) isHighPrice?: string,
    @Query('minTradingValue', new NumberRangePipe('minTradingValue', 0, 1_000_000_000_000_000, true)) minTradingValue?: number,
    @Query('theme', new CsvIntPipe('theme', 1, 999999, true, 50)) theme?: string,
    @Query('rsPeriods', new CsvIntPipe('rsPeriods', 1, 1000, true, 10)) rsPeriods?: string,
    @Query('rsWeights', new CsvIntPipe('rsWeights', 0, 100, true, 10)) rsWeights?: string,
    @Query('rsDates', new CsvDatePipe('rsDates', true, 10)) rsDates?: string,
  ) {
    return await this.chartService.getStockList(
      marketType,
      page,
      pageSize,
      {
        isHighPrice: isHighPrice === 'true' ? true : undefined,
        minTradingValue,
        theme: theme ? theme.split(',').map(t => parseInt(t.trim())) : undefined,
      },
      rsPeriods,
      rsWeights,
      rsDates,
    );
  }

  @Post('stocks')
  @ApiOperation( { summary: '종목 리스트 조회 (POST)', description: '기간 기반 RS 필터 적용' } )
  @ApiBody( {
    schema: {
      example: {
        marketType: '0',
        page: 1,
        pageSize: 50,
        filters: { isHighPrice: true, minTradingValue: 100000000, theme: [101, 102] },
        rsFilters: [
          { rsStartDate: '2026-02-09', rsEndDate: '2026-01-15', strength: 50 },
          { rsStartDate: '2026-01-15', rsEndDate: '2025-12-01', strength: 50 },
        ],
      },
    },
  } )
  @ApiOkResponse( { type: RealTimeChartResultDto } )
  async getStockListWithRangeRS(
    @Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Body('page', new IntRangePipe('page', 1, 10000, true)) page: number = 1,
    @Body('pageSize', new IntRangePipe('pageSize', 1, 500, true)) pageSize: number = 50,
    @Body('filters', new StockListFiltersPipe()) filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
      theme?: number[];
    },
    @Body('rsFilters', new RsFiltersPipe(true)) rsFilters?: Array<{
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

  @Post('collect/day')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 전체 종목 일봉 수집 (1주일치)' } )
  @ApiBody( { schema: { example: { marketType: '0', days: 7 } } } )
  async collectAllDayCandles(
    @Body('marketType', new EnumPipe(['0','10'] as const, 'marketType', true)) marketType: '0' | '10' = '0',
    @Body('days', new IntRangePipe('days', 1, 30, true)) days = 7,
  ) {
    return await this.chartService.collectAllDayCandles(marketType, days);
  }

  @Post('backfill/day')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 전체 종목 일봉 백필', description: 'Fire-and-forget. 최대 750일.' } )
  @ApiBody( { schema: { example: { marketType: 'all', days: 330 } } } )
  async backfillDayCandles(
    @Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Body('days', new IntRangePipe('days', 1, 1000, true)) days: number = 330,
  ) {
    const markets: ('0' | '10')[] = marketType === 'all' ? ['0', '10'] : [marketType];

    this.chartService.collectIndexCandles()
      .then((indexResult) => {
        console.log('Index candle backfill done:', indexResult);
        for (const market of markets) {
          this.chartService.backfillDayCandles(market, days)
            .then((result) => console.log(`Backfill done: market=${market}`, result))
            .catch((err) => console.error(`Backfill failed: market=${market}`, err));
        }
      })
      .catch((err) => console.error('Index candle backfill failed:', err));

    return {
      success: true,
      message: `Index + day candle backfill started (markets: ${markets.join(',')}, days: ${days}). Check server logs for progress.`,
    };
  }

  @Post('backfill/higher-timeframes')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 전체/선택 종목 주봉·월봉·연봉 백필', description: 'Fire-and-forget. stock_candles에 candle_type week/month/year로 저장.' } )
  @ApiBody( { schema: { example: { marketType: 'all', candleTypes: ['week', 'month', 'year'], stockCodes: ['327260'] } } } )
  async backfillHigherTimeframeCandles(
    @Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Body('candleTypes') candleTypes: Array<'week' | 'month' | 'year'> = ['week', 'month', 'year'],
    @Body('stockCodes', new StockCodeArrayPipe(true, 2000)) stockCodes?: string[],
  ) {
    const markets: ('0' | '10')[] = stockCodes?.length
      ? [marketType === '10' ? '10' : '0']
      : marketType === 'all'
        ? ['0', '10']
        : [marketType];

    for (const market of markets) {
      this.chartService.backfillHigherTimeframeCandles(market, candleTypes, stockCodes)
        .then((result) => console.log(`Higher timeframe backfill done: market=${market}`, result))
        .catch((err) => console.error(`Higher timeframe backfill failed: market=${market}`, err));
    }

    return {
      success: true,
      message: `Higher timeframe backfill started (markets: ${markets.join(',')}, types: ${candleTypes.join(',')}). Check server logs for progress.`,
    };
  }

  @Post('fill-trading-value')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 누락 거래대금 채우기', description: 'Fire-and-forget. tradingValue null인 일봉을 키움 데이터로 채움.' } )
  async fillMissingTradingValue() {
    this.chartService.fillMissingTradingValue()
      .then((result) => console.log('fillMissingTradingValue done:', result))
      .catch((err) => console.error('fillMissingTradingValue failed:', err));

    return { success: true, message: 'tradingValue 채우기 시작. 서버 로그에서 진행상황 확인하세요.' };
  }

  @Post('collect/index')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 시장 지수 일봉 수집', description: 'KOSPI + KOSDAQ. 장 마감 후 사용.' } )
  async collectIndexCandles() {
    return await this.chartService.collectIndexCandles();
  }

  @Post('collect/index-close')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 오늘 지수 종가만 수집', description: '장 마감 후 가볍게 호출' } )
  async collectTodayIndexClose() {
    return await this.chartService.collectTodayIndexClose();
  }

  @Post('metrics/calculate')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 일별 지표 계산 (수동)' } )
  @ApiBody( { schema: { example: { marketType: 'all', tradeDate: '20260404', writeLogFile: false } } } )
  async calculateMetrics(
    @Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Body('tradeDate', new RegexPipe(/^\d{8}$/, 'tradeDate', true)) tradeDate?: string,
    @Body('writeLogFile') writeLogFile: boolean = false,
  ) {
    return await this.chartService.calculateDailyMetrics(marketType, tradeDate, writeLogFile);
  }

  @Get('status')
  @ApiOperation( { summary: '데이터 초기화 상태 조회' } )
  getInitializationStatus() {
    return this.chartService.getInitializationStatus();
  }

  @Get('debug/stocks')
  @ApiOperation( { summary: '[디버그] 필터 없이 종목 리스트 Raw 조회' } )
  @ApiQuery( { name: 'marketType', required: false, enum: ['0','10','all'] } )
  async debugGetStockList(@Query('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all') {
    return await this.chartService.debugGetStockList(marketType);
  }

  @Post('initialize')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 데이터 수동 초기화', description: '일봉 수집 + 지표 계산' } )
  @ApiBody( { schema: { example: { marketTypes: ['0', '10'] } } } )
  async initializeData(
    @Body('marketTypes', new EnumArrayPipe(['0', '10'] as const, 'marketTypes', true)) marketTypes: ('0' | '10')[] = ['0', '10'],
  ) {
    return await this.chartService.initializeData(marketTypes);
  }

  @Post('setup/initial')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 초기 데이터 설정 (기본)' } )
  @ApiBody( { schema: { example: { marketType: 'all' } } } )
  async runInitialSetup(@Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all') {
    return await this.setupService.runInitialSetup(marketType);
  }

  @Post('setup/quick')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 빠른 초기 설정', description: '홈 화면 즉시 사용 가능' } )
  @ApiBody( { schema: { example: { marketType: 'all' } } } )
  async runQuickSetup(@Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all') {
    return await this.setupService.runQuickSetup(marketType);
  }

  @Post('setup/full')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 전체 데이터 설정', description: '백그라운드 배치용' } )
  @ApiBody( { schema: { example: { marketType: 'all' } } } )
  async runFullSetup(@Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all') {
    return await this.setupService.runFullSetup(marketType);
  }

  @Post('setup/extended')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[관리자] 확장 데이터 수집', description: '10년치 등 장기 데이터. Fire-and-forget.' } )
  @ApiBody( { schema: { example: { marketType: '0', days: 3650 } } } )
  async runExtendedDataCollection(
    @Body('marketType', new EnumPipe(['0','10','all'] as const, 'marketType', true)) marketType: '0' | '10' | 'all' = 'all',
    @Body('days', new IntRangePipe('days', 1, 3650, true)) days: number = 3650,
  ) {
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

  @Post('rs-history/:stockCode')
  @ApiOperation( { summary: '단일 종목 RS 추이 조회 (그래프용)', description: '날짜는 모두 YYYYMMDD 형식' } )
  @ApiParam( { name: 'stockCode', example: '005930' } )
  @ApiBody( {
    schema: {
      example: {
        startDate: '20250304',
        endDate: '20260304',
        rsFilters: [
          { rsStartDate: '20260209', rsEndDate: '20260115', strength: 50 },
          { rsStartDate: '20260115', rsEndDate: '20251110', strength: 50 },
        ],
      },
    },
  } )
  async getRsHistory(
    @Param('stockCode', new StockCodePipe()) stockCode: string,
    @Body('startDate', new DateStringPipe('startDate')) startDate: string,
    @Body('endDate', new DateStringPipe('endDate', true)) endDate: string,
    @Body('rsFilters', new RsFiltersPipe(true)) rsFilters?: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
  ) {
    const today = new Date();
    const end = endDate || `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
    return await this.chartService.getRsHistory(stockCode, startDate, end, rsFilters);
  }

  @Post('debug/filter-check')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[디버그] 특정 종목들의 5개 필터 통과/실패 상세 조회' } )
  @ApiBody( { schema: { example: { stockCodes: ['043260', '347700', '041920'] } } } )
  async debugFilterCheck(
    @Body('stockCodes', new StockCodeArrayPipe(false, 100)) stockCodes: string[],
  ) {
    return await this.metricsService.debugFilterCheck(stockCodes);
  }

  @Post('metrics/custom-rs')
  @UseGuards(AdminApiKeyGuard)
  @ApiOperation( { summary: '[디버그] 특정 종목 RS 상세 로그 생성', description: '필터 통과 여부 관계없이 모든 종목 값을 log 파일로 저장' } )
  @ApiBody( {
    schema: {
      example: {
        stockCodes: ['043260', '272210', '006800'],
        tradeDate: '20260303',
      },
    },
  } )
  async calculateCustomRsLog(
    @Body('stockCodes', new StockCodeArrayPipe(false, 100)) stockCodes: string[],
    @Body('tradeDate', new RegexPipe(/^\d{8}$/, 'tradeDate', true)) tradeDate?: string,
  ) {
    return await this.metricsService.calculateCustomRsLog(stockCodes, tradeDate);
  }
}
