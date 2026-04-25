import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { mapUpNameToThemeCode } from '../../common/constants/theme-codes';

interface StockListCache {
  data: any[];
  timestamp: number;
}

@Injectable()
export class RealTimeChartService implements OnModuleInit {
  private readonly logger = new Logger(RealTimeChartService.name);
  private readonly stockListCache = new Map<string, StockListCache>();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1시간 (밀리초)
  private initializationComplete = false;
  private lastDataUpdate: Date | null = null;

  constructor(
    private readonly kiwoomRest: KiwoomRestService,
    @Inject(REALTIME_SOURCE_TOKEN)
    private readonly realtimeSource: IRealtimeSource,
    private readonly chartStorage: ChartStorageService,
    private readonly metricsService: StockMetricsService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 서버 시작 시 데이터 초기화
   * - 데이터 없음: 52주(365일)치 수집 (신고가 판단용)
   * - 데이터 있음: 마지막 데이터 ~ 오늘까지 공백만 수집
   */
  async onModuleInit() {
    this.logger.log('Starting data initialization on server startup...');

    // 백그라운드에서 비동기로 초기화 실행 (서버 시작을 블로킹하지 않음)
    this.initializeData().catch((error) => {
      this.logger.error(`Data initialization failed: ${error.message}`, error.stack);
    });
  }

  /**
   * 데이터 초기화 (일봉 수집 + 지표 계산)
   * - DB에 데이터가 없으면: 52주(365일)치 수집
   * - DB에 데이터가 있으면: 마지막 데이터 날짜 ~ 오늘까지 공백 기간만 수집
   */
  async initializeData(marketTypes: ('0' | '10')[] = ['0', '10']) {
    const startTime = Date.now();
    this.logger.log('=== Data Initialization Started ===');

    try {
      // 현재 시간 체크 (한국 시간 기준)
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const dayOfWeek = now.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // 월~금

      // DB에서 마지막 일봉 데이터 날짜 조회
      const lastCandleDate = await this.chartStorage.getLatestDayCandleDate();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let daysToFetch: number;
      let shouldSkipCollection = false;

      // 전 거래일 계산 (주말 역방향으로 건너뜀)
      const getPrevTradingDay = (): Date => {
        const d = new Date(today);
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) {
          d.setDate(d.getDate() - 1);
        }
        return d;
      };

      // 수집 기준일 결정:
      // - 장 마감 후(평일 15:30 초과): 오늘까지 수집 가능 (당일 일봉 완성)
      // - 그 외(장 중, 개장 전, 주말): 전 거래일까지만 수집 (당일 미완성 일봉 제외)
      const isAfterMarketClose = isWeekday && (currentHour > 15 || (currentHour === 15 && currentMinute > 30));
      const collectionTargetDate = isAfterMarketClose ? today : getPrevTradingDay();

      this.logger.log(
        `Collection mode: ${isAfterMarketClose ? '장 마감 후 (당일 포함)' : '장 중/전 (전일까지)'}, target: ${collectionTargetDate.toISOString().split('T')[0]}`,
      );

      if (!lastCandleDate) {
        // 데이터가 없으면 52주치 수집 (신고가 판단 필요)
        daysToFetch = 365;
        this.logger.log('No existing data found. Fetching 52 weeks (365 days)...');
      } else {
        const lastDate = new Date(lastCandleDate);
        lastDate.setHours(0, 0, 0, 0);
        const diffMs = collectionTargetDate.getTime() - lastDate.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          // 이미 기준일 데이터까지 보유 중
          shouldSkipCollection = true;
          this.logger.log(
            `Data is up to date (last: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}). Skipping collection.`,
          );
        } else {
          // 공백 일수만큼 수집 (API가 거래일만 반환하므로 주말/공휴일 자동 제외)
          daysToFetch = diffDays;
          this.logger.log(
            `Last data: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}, gap: ${diffDays} days. Fetching...`,
          );
        }
      }

      // 데이터 수집 (스킵하지 않는 경우만)
      if (!shouldSkipCollection) {
        // 0. 시장 지수 일봉 수집 (KOSPI + KOSDAQ) - RS 계산에 필요
        this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
        await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
        await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
        // ka20006은 당일 캔들 미포함 → 장 마감 후에는 ka20001로 오늘 종가 별도 수집
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
        this.logger.log('Market index day candles collected.');

        for (const marketType of marketTypes) {
          const marketName = marketType === '0' ? 'KOSPI' : 'KOSDAQ';
          this.logger.log(`[${marketName}] Collecting day candles (${daysToFetch} days)...`);

          // 1. 일봉 데이터 수집
          const collectResult = await this.collectAllDayCandles(marketType, daysToFetch);
          this.logger.log(`[${marketName}] Day candles collected: ${collectResult.success}/${collectResult.total}`);
        }
      } else {
        this.logger.log('Data collection skipped (already up to date). Recalculating metrics only...');
        // 일봉 수집은 스킵해도 오늘 지수 종가는 항상 갱신 (ka20006 당일 미포함)
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
      }

      // 2. 7개 필터 + RS(63) + 통합 랭킹 계산 (최근 4거래일 - 항상 실행)
      // KOSPI + KOSDAQ 합쳐서 하나의 풀로 순위 매기기 (RS는 각 시장 지수 사용)
      const [kospiStockList, kosdaqStockList] = await Promise.all([
        this.fetchStockList('0'),
        this.fetchStockList('10'),
      ]);
      const allStockCodes = [
        ...kospiStockList.map((s: any) => s.code),
        ...kosdaqStockList.map((s: any) => s.code),
      ];
      const stockIndexMap = new Map<string, string>();
      const stockNameMap = new Map<string, string>();
      for (const s of kospiStockList) { stockIndexMap.set(s.code, 'INDEX_KOSPI'); stockNameMap.set(s.code, s.name); }
      for (const s of kosdaqStockList) { stockIndexMap.set(s.code, 'INDEX_KOSDAQ'); stockNameMap.set(s.code, s.name); }

      const recentDates = await this.metricsService.getRecentTradingDates(4);
      this.logger.log(`Calculating unified metrics for ${recentDates.length} trading days (KOSPI: ${kospiStockList.length}, KOSDAQ: ${kosdaqStockList.length}, total: ${allStockCodes.length})...`);

      for (let i = 0; i < recentDates.length; i++) {
        const tradeDate = recentDates[i];
        const metricsResult = await this.metricsService.calculateAndSaveDailyMetrics('all', tradeDate, 'INDEX_KOSPI', allStockCodes, stockIndexMap, stockNameMap, i === 0);
        this.logger.log(`Metrics for ${tradeDate.toISOString().split('T')[0]}: ${metricsResult?.count || 0} stocks, filtered: ${metricsResult?.filtered || 0}`);
      }

      this.initializationComplete = true;
      this.lastDataUpdate = new Date();

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`=== Data Initialization Completed in ${duration}s ===`);

      // 필터 통과 종목 전체 WebSocket 구독 (백그라운드)
      this.subscribeFilteredStocks().catch((error) => {
        this.logger.warn(`Bulk subscription failed: ${(error as Error).message}`);
      });

      return {
        success: true,
        duration: `${duration}s`,
        updatedAt: this.lastDataUpdate,
      };
    } catch (error) {
      this.logger.error(`Data initialization failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 초기화 상태 조회
   */
  getInitializationStatus() {
    return {
      initialized: this.initializationComplete,
      lastDataUpdate: this.lastDataUpdate,
    };
  }

  /**
   * 실시간 WebSocket 연결 상태 조회
   */
  getRealtimeStatus() {
    const isConnected = this.realtimeSource.isConnected();
    const cacheStats = this.realtimeCache.getCacheStats();
    const subscribedStocks = this.realtimeCache.getSubscribedStocks();

    return {
      websocket: {
        connected: isConnected,
        status: isConnected ? 'CONNECTED' : 'DISCONNECTED',
      },
      subscriptions: {
        total: subscribedStocks.length,
        stockCodes: subscribedStocks.slice(0, 20), // 최대 20개만 표시
      },
      cache: cacheStats,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 실시간 데이터 소스 연결 보장
   * (장시작 시간에 WebSocket 연결 확인 및 재연결)
   */
  async ensureRealtimeConnection(): Promise<void> {
    try {
      const isConnected = this.realtimeSource.isConnected();

      if (!isConnected) {
        await this.realtimeSource.ensureConnection();
        this.logger.log('Realtime source reconnected');
      }
    } catch (error) {
      this.logger.error(`Failed to ensure realtime connection: ${(error as Error).message}`, (error as Error).stack);
      throw error;
    }
  }

  /**
   * 분봉 차트 데이터 조회 (과거 데이터)
   */
  async getMinuteCandles(stockCode: string, interval: '1' | '3' | '5' | '10' | '15' | '30' | '45' | '60') {
    this.logger.log(`Getting ${interval}min candles for ${stockCode}`);

    const kiwoomData = await this.kiwoomRest.getMinuteCandles(stockCode, interval);

    const candles = kiwoomData.stk_min_pole_chart_qry.map((item) => ({
      time: this.parseCandleTime(item.cntr_tm).toISOString(),
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
    }));

    return {
      stockCode,
      interval: `${interval}min`,
      candles,
    };
  }

  /**
   * 틱 차트 데이터 조회
   */
  async getTickCandles(stockCode: string, interval: '1' | '3' | '5' | '10' | '30') {
    this.logger.log(`Getting ${interval}tick candles for ${stockCode}`);

    const kiwoomData = await this.kiwoomRest.getTickCandles(stockCode, interval);

    const candles = kiwoomData.stk_tic_chart_qry.map((item) => ({
      time: this.parseCandleTime(item.cntr_tm).toISOString(),
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
    }));

    return {
      stockCode,
      interval: `${interval}tick`,
      candles,
    };
  }

  /**
   * 일봉 차트 데이터 조회 및 저장
   */
  async getDayCandles(stockCode: string, baseDate: string, saveToDb = false, days = 7) {
    // this.logger.log(`Getting day candles for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getDayCandles(stockCode, baseDate);

    // 최근 N일만 필터링
    const recentCandles = kiwoomData.stk_dt_pole_chart_qry.slice(0, days);

    const candles = recentCandles.map((item) => ({
      date: item.dt,
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
      tradingValue: item.trde_prica,
    }));

    // DB에 저장
    if (saveToDb) {
      const candlesToSave = recentCandles.map((item) => ({
        stockCode,
        candleType: 'day',
        candleTime: this.parseDateOnly(item.dt),
        openPrice: this.parsePrice(item.open_pric),
        highPrice: this.parsePrice(item.high_pric),
        lowPrice: this.parsePrice(item.low_pric),
        closePrice: this.parsePrice(item.cur_prc),
        volume: BigInt(item.trde_qty),
        tradingValue: item.trde_prica ? BigInt(item.trde_prica) * 1_000_000n : null,
      }));

      await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
      this.logger.debug(`Saved ${candlesToSave.length} day candles for ${stockCode}`);
    }

    return {
      stockCode,
      candles,
    };
  }

  async getDayCandlesDetail(stockCode: string, baseDate: string) {
    this.logger.log(`Getting day candles (detail) for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getDayCandlesWithHistory(stockCode, baseDate);

    const candles = kiwoomData.stk_dt_pole_chart_qry.map((item) => ({
      date: item.dt,
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
      tradingValue: item.trde_prica,
    }));

    return { stockCode, candles };
  }

  async getWeekCandles(stockCode: string, baseDate: string) {
    this.logger.log(`Getting week candles for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getWeekCandles(stockCode, baseDate);

    const candles = kiwoomData.stk_stk_pole_chart_qry.map((item) => ({
      date: item.dt,
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
      tradingValue: item.trde_prica,
    }));

    return { stockCode, candles };
  }

  async getMonthCandles(stockCode: string, baseDate: string) {
    this.logger.log(`Getting month candles for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);

    const candles = kiwoomData.stk_mth_pole_chart_qry.map((item) => ({
      date: item.dt,
      open: this.parsePrice(item.open_pric).toString(),
      high: this.parsePrice(item.high_pric).toString(),
      low: this.parsePrice(item.low_pric).toString(),
      close: this.parsePrice(item.cur_prc).toString(),
      volume: item.trde_qty,
      tradingValue: item.trde_prica,
    }));

    return { stockCode, candles };
  }

  /**
   * 종목 상세 요약 (현재가, 전일대비, 거래량, 거래대금, 1일 고저, 52주 고저)
   */
  async getStockSummary(stockCode: string) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

    // 1. 키움 일봉 API → 오늘 현재가/거래량/고저/전일대비
    const kiwoomData = await this.kiwoomRest.getDayCandles(stockCode, today);
    const latest = kiwoomData.stk_dt_pole_chart_qry[0];

    if (!latest) {
      throw new Error(`No candle data for ${stockCode}`);
    }

    const currentPrice = this.parsePrice(latest.cur_prc);
    const prevDayCompare = this.parsePrice(latest.pred_pre);
    const changeRate = currentPrice !== 0
      ? ((prevDayCompare / (currentPrice - prevDayCompare)) * 100).toFixed(2)
      : '0.00';

    // 2. DB 저장 일봉 → 52주 고저 계산
    const now = new Date();
    const yearAgo = new Date(now);
    yearAgo.setFullYear(now.getFullYear() - 1);

    const yearCandles = await this.chartStorage.getCandles(stockCode, 'day', yearAgo, now);

    let week52High = currentPrice;
    let week52Low = currentPrice;

    if (yearCandles.length > 0) {
      week52High = Math.max(...yearCandles.map((c) => Number(c.highPrice)));
      week52Low = Math.min(...yearCandles.map((c) => Number(c.lowPrice)));
    }

    return {
      stockCode,
      currentPrice,
      prevDayCompare,
      prevDayCompareSign: latest.pred_pre_sig,
      changeRate,
      volume: latest.trde_qty,
      tradingValue: latest.trde_prica,
      dayHigh: this.parsePrice(latest.high_pric),
      dayLow: this.parsePrice(latest.low_pric),
      week52High,
      week52Low,
    };
  }

  /**
   * 종목 리스트 조회 (프론트엔드 인터페이스에 맞춰서, 페이지네이션 지원, 캐싱, 필터링)
   *
   * @param rsPeriods - RS 계산 기간 (예: "63,126,252"), 없으면 디폴트 RS(63일) 사용
   * @param rsWeights - RS 가중치 (예: "50,30,20"), rsPeriods와 함께 사용
   */
  async getStockList(
    marketType: '0' | '10' | 'all' = 'all',
    page: number = 1,
    pageSize: number = 50,
    filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
      theme?: number[];
    },
    rsPeriods?: string,
    rsWeights?: string,
    rsDates?: string,
  ) {
    this.logger.log(
      `Getting stock list for market type: ${marketType}, page: ${page}, pageSize: ${pageSize}, filters: ${JSON.stringify(filters)}, rsPeriods: ${rsPeriods}, rsWeights: ${rsWeights}, rsDates: ${rsDates}`,
    );

    // rsDates가 있으면 날짜를 일수로 변환
    let calculatedPeriods = rsPeriods;
    if (rsDates && rsWeights) {
      calculatedPeriods = this.convertDatesToPeriods(rsDates);
      this.logger.log(`Converted dates ${rsDates} to periods: ${calculatedPeriods}`);
    }

    // 커스텀 RS 요청인 경우 런타임 계산
    if (calculatedPeriods && rsWeights) {
      return this.getStockListWithCustomRS(
        marketType,
        page,
        pageSize,
        filters,
        calculatedPeriods,
        rsWeights,
      );
    }

    // 디폴트 RS(63일) - 기존 로직

    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);

    // 최신 지표 데이터 조회 (모든 종목)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (인메모리, 빠름)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트와 지표 병합 및 필터링
    const stocksWithMetrics = validStocks
      .map((s) => {
        const metrics = metricsMap.get(s.code);
        return {
          stock: s,
          metrics,
          rsScore: metrics?.relativeStrengthScore || 0,
        };
      })
      .filter((item) => {
        // 정적 필터 통과 여부 (장마감 후 계산, DB 저장)
        if (!item.metrics?.passedStaticFilters) return false;

        // 동적 필터: 현재가 기준 실시간 적용 (실시간 가격 우선, 없으면 종가)
        const realtimePrice = allRealtimePrices.get(item.stock.code);
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics.lowPrice52w;
        const high52w = item.metrics.highPrice52w;
        const ma50 = item.metrics.ma50;

        // DF1: 현재가 >= 52주저 × 1.3
        if (low52w != null && currentPrice < low52w * 1.3) return false;
        // DF2: 현재가 >= 52주고 × 0.75
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        // DF3: 현재가 > MA50
        if (ma50 != null && currentPrice <= ma50) return false;

        // 신고가 필터
        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        // 최소 거래대금 필터
        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // 테마 필터
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(stockTheme, filters.theme)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // 1차: rank 오름차순 (낮은 순위가 먼저)
        const rankDiff = (a.metrics?.rank || 999999) - (b.metrics?.rank || 999999);
        if (rankDiff !== 0) return rankDiff;
        // 2차: rsScore 내림차순 (동일 순위는 점수 높은게 먼저)
        return b.rsScore - a.rsScore;
      });

    // 정렬 후 페이지네이션
    const totalCount = stocksWithMetrics.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithMetrics.slice(startIndex, endIndex);

    // 페이지네이션된 종목들의 종가 및 순위 변동 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);

    // 자동 실시간 구독 (백그라운드에서 비동기 실행)
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // 실시간 현재가 (이미 allRealtimePrices에 있음)
    const realtimePrices = allRealtimePrices;

    const rankingHistories = await Promise.all(
      pageStockCodes.map(async (code) => ({
        code,
        history: await this.metricsService.getRankingHistory(code, 4), // 오늘 + D-1 + D-2 + D-3
      })),
    );
    const rankingMap = new Map(rankingHistories.map((r) => [r.code, r.history]));

    // 최신 거래일 조회 (메타데이터용)
    const latestTradeDate = await this.metricsService.getLatestTradeDate();

    return {
      marketType,
      page,
      pageSize,
      totalCount,
      totalPages,
      count: paginatedData.length,
      // 메타데이터: 데이터 기준일 및 갱신 정보
      meta: {
        dataDate: latestTradeDate?.toISOString().split('T')[0] || null, // 데이터 기준 거래일
        lastUpdatedAt: this.lastDataUpdate?.toISOString() || null, // 마지막 데이터 갱신 시간
        isInitialized: this.initializationComplete, // 초기화 완료 여부
        queryStartDate: latestTradeDate ? (() => { const d = new Date(latestTradeDate); d.setDate(d.getDate() - Math.round(63 * 1.5)); return d.toISOString().split('T')[0]; })() : null,
        queryEndDate: latestTradeDate?.toISOString().split('T')[0] || null,
      },
      stocks: paginatedData.map((item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = rankingMap.get(s.code) || [];

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number((metrics?.relativeStrengthScore || 0).toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChangeRate1d != null
            ? `${Number(metrics.priceChangeRate1d) > 0 ? '+' : ''}${Number(metrics.priceChangeRate1d).toFixed(2)}%`
            : '-',
          investmentIndicatorsDtl: '-',
          theme: s.upName || '-',
          upName: s.upName || '-',
          rankHistory: {
            today: rankHistory[0] || null,
            oneDayAgo: rankHistory[1] || null,
            twoDaysAgo: rankHistory[2] || null,
            threeDaysAgo: rankHistory[3] || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
        };
      }),
    };
  }

  /**
   * 커스텀 RS 설정으로 종목 리스트 조회 (런타임 계산)
   */
  async getStockListWithCustomRS(
    marketType: '0' | '10' | 'all' = 'all',
    page: number = 1,
    pageSize: number = 50,
    filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
      theme?: number[];
    },
    rsPeriods?: string,
    rsWeights?: string,
  ) {
    this.logger.log(`Getting stock list with custom RS: periods=${rsPeriods}, weights=${rsWeights}`);

    // RS 파라미터 파싱
    const periods = rsPeriods?.split(',').map((p) => parseInt(p.trim())) || [63];
    const weights = rsWeights?.split(',').map((w) => parseFloat(w.trim())) || [100];

    if (periods.length !== weights.length) {
      throw new Error('RS periods and weights must have the same length');
    }

    // 종목 리스트 가져오기 (캐시 or API)
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);

    // 런타임 RS 계산 (최근 4개 거래일: 당일, D-1, D-2, D-3)
    let rsHistoryMap: Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>;

    if (marketType === 'all') {
      // 전체 조회: KOSPI/KOSDAQ 각각 해당 지수로 RS 계산 후 합치기
      const kospiStocks = validStocks.filter((s) => s.marketName === '거래소').map((s) => s.code);
      const kosdaqStocks = validStocks.filter((s) => s.marketName === '코스닥').map((s) => s.code);

      this.logger.log(`Split stocks for custom RS: KOSPI=${kospiStocks.length}, KOSDAQ=${kosdaqStocks.length}`);

      const [kospiRS, kosdaqRS] = await Promise.all([
        kospiStocks.length > 0
          ? this.metricsService.calculateRuntimeRS(kospiStocks, periods, weights, 'INDEX_KOSPI', 4)
          : new Map(),
        kosdaqStocks.length > 0
          ? this.metricsService.calculateRuntimeRS(kosdaqStocks, periods, weights, 'INDEX_KOSDAQ', 4)
          : new Map(),
      ]);

      // 두 결과 합치기
      rsHistoryMap = new Map([...kospiRS, ...kosdaqRS]);
    } else {
      // 단일 시장 조회
      const indexCode = marketType === '0' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
      rsHistoryMap = await this.metricsService.calculateRuntimeRS(
        allStockCodes,
        periods,
        weights,
        indexCode,
        4,
      );
    }

    // 기본 지표 데이터 조회 (ma50, 52w 고저, isNewHigh, tradingValue 등)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (인메모리, 빠름)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트와 RS 병합 및 필터링
    const stocksWithRS = validStocks
      .map((s) => {
        const rsHistory = rsHistoryMap.get(s.code);
        const metrics = metricsMap.get(s.code);

        // 당일 (첫 번째) RS와 랭크
        const todayRS = rsHistory && rsHistory.length > 0 ? rsHistory[0] : null;

        return {
          stock: s,
          metrics,
          rsScore: todayRS?.rsScore || 0,
          rank: todayRS?.rank || 0,
          rankHistory: rsHistory || [],
        };
      })
      .filter((item) => {
        // 기본 필터: 정적 필터 통과 종목 (calculateRuntimeRS에서 이미 SF1~SF5 적용)
        if (item.rsScore <= 0) return false;

        // 동적 필터: 현재가 기준 실시간 적용
        const realtimePrice = allRealtimePrices.get(item.stock.code);
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics?.lowPrice52w;
        const high52w = item.metrics?.highPrice52w;
        const ma50 = item.metrics?.ma50;

        if (low52w != null && currentPrice < low52w * 1.3) return false;
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        if (ma50 != null && currentPrice <= ma50) return false;

        // 신고가 필터
        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        // 최소 거래대금 필터
        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // 테마 필터
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(stockTheme, filters.theme)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank); // 랭크 오름차순 (이미 계산됨)

    // 페이지네이션
    const totalCount = stocksWithRS.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithRS.slice(startIndex, endIndex);

    // 페이지네이션된 종목들의 종가 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);

    // 자동 실시간 구독
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // 실시간 현재가 (이미 allRealtimePrices에 있음)
    const realtimePrices = allRealtimePrices;

    // 최신 거래일 조회
    const latestTradeDate = await this.metricsService.getLatestTradeDate();

    return {
      marketType,
      page,
      pageSize,
      totalCount,
      totalPages,
      count: paginatedData.length,
      meta: {
        dataDate: latestTradeDate?.toISOString().split('T')[0] || null,
        lastUpdatedAt: this.lastDataUpdate?.toISOString() || null,
        isInitialized: this.initializationComplete,
        queryStartDate: latestTradeDate ? (() => { const maxPeriod = periods.length > 0 ? Math.max(...periods) : 63; const d = new Date(latestTradeDate); d.setDate(d.getDate() - Math.round(maxPeriod * 1.5)); return d.toISOString().split('T')[0]; })() : null,
        queryEndDate: latestTradeDate?.toISOString().split('T')[0] || null,
        customRS: { periods, weights },
      },
      stocks: paginatedData.map((item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChangeRate1d != null
            ? `${Number(metrics.priceChangeRate1d) > 0 ? '+' : ''}${Number(metrics.priceChangeRate1d).toFixed(2)}%`
            : '-',
          investmentIndicatorsDtl: '-',
          theme: s.upName || '-',
          upName: s.upName || '-',
          rankHistory: {
            today: rankHistory[0]?.rank || null,
            oneDayAgo: rankHistory[1]?.rank || null,
            twoDaysAgo: rankHistory[2]?.rank || null,
            threeDaysAgo: rankHistory[3]?.rank || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
        };
      }),
    };
  }

  /**
   * 종목 리스트 조회 (기간 기반 RS 필터)
   * rsFilters 배열을 받아서 각 기간의 RS를 계산하고 가중치를 적용
   */
  async getStockListWithRangeRS(
    marketType: '0' | '10' | 'all' = 'all',
    page: number = 1,
    pageSize: number = 50,
    filters?: {
      isHighPrice?: boolean;
      minTradingValue?: number;
      theme?: number[];
    },
    rsFilters?: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
  ) {
    const _mem0 = process.memoryUsage();
    this.logger.log(
      `[getStockListWithRangeRS] START filters=${JSON.stringify(rsFilters)} ` +
      `heap=${Math.round(_mem0.heapUsed/1024/1024)}MB/${Math.round(_mem0.heapTotal/1024/1024)}MB rss=${Math.round(_mem0.rss/1024/1024)}MB`,
    );

    // rsFilters가 없으면 기본 로직 사용
    if (!rsFilters || rsFilters.length === 0) {
      return this.getStockList(marketType, page, pageSize, filters);
    }

    // 종목 리스트 가져오기
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);

    // StockDailyMetrics.passedStaticFilters 기준으로 사전 필터링
    // → SF1~SF5를 통과한 종목만 calculateRangeRS에 넘겨 연산량 대폭 감소
    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    let rsStockCodes = allStockCodes;
    if (latestTradeDate) {
      const passedCodes = await this.metricsService.getPassedStaticFilterCodes(allStockCodes, latestTradeDate);
      if (passedCodes.length > 0) {
        rsStockCodes = passedCodes;
        this.logger.log(`Static filter pre-filter: ${allStockCodes.length} → ${rsStockCodes.length} stocks`);
      }
    }

    // rsFilters를 periods와 weights로 변환
    const periods: number[] = [];
    const weights: number[] = [];

    for (const filter of rsFilters) {
      // endDate를 일수로 변환 (endDate 종가 기준으로 계산)
      const endDays = this.convertSingleDateToDays(filter.rsEndDate);
      periods.push(endDays);
      weights.push(filter.strength);
    }

    this.logger.log(`Converted range filters to periods: ${periods}, weights: ${weights}`);

    // 기간 기반 RS 계산 (최근 4개 거래일)
    let rsHistoryMap: Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>;

    if (marketType === 'all') {
      // 전체 조회: KOSPI/KOSDAQ 각각 해당 지수로 RS 계산 후 합치기
      const rsCodesSet = new Set(rsStockCodes);
      const kospiStocks = validStocks.filter((s) => s.marketName === '거래소' && rsCodesSet.has(s.code)).map((s) => s.code);
      const kosdaqStocks = validStocks.filter((s) => s.marketName === '코스닥' && rsCodesSet.has(s.code)).map((s) => s.code);

      this.logger.log(`Split stocks (pre-filtered): KOSPI=${kospiStocks.length}, KOSDAQ=${kosdaqStocks.length}`);

      const [kospiRS, kosdaqRS] = await Promise.all([
        kospiStocks.length > 0
          ? this.metricsService.calculateRangeRS(kospiStocks, rsFilters, 'INDEX_KOSPI', 4)
          : new Map(),
        kosdaqStocks.length > 0
          ? this.metricsService.calculateRangeRS(kosdaqStocks, rsFilters, 'INDEX_KOSDAQ', 4)
          : new Map(),
      ]);

      // 두 결과 합치기
      rsHistoryMap = new Map([...kospiRS, ...kosdaqRS]);
    } else {
      // 단일 시장 조회
      const indexCode = marketType === '0' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
      rsHistoryMap = await this.metricsService.calculateRangeRS(
        rsStockCodes,
        rsFilters,
        indexCode,
        4,
      );
    }

    // 기본 지표 데이터 조회 (ma50, 52w 고저, isNewHigh, tradingValue 등)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (인메모리, 빠름)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트와 RS 병합 및 필터링
    const stocksWithRS = validStocks
      .map((s) => {
        const rsHistory = rsHistoryMap.get(s.code);
        const metrics = metricsMap.get(s.code);

        const todayRS = rsHistory && rsHistory.length > 0 ? rsHistory[0] : null;

        return {
          stock: s,
          metrics,
          rsScore: todayRS?.rsScore || 0,
          rank: todayRS?.rank || 0,
          rankHistory: rsHistory || [],
        };
      })
      .filter((item) => {
        // 기본 필터: 정적 필터 통과 종목 (calculateRangeRS에서 이미 SF1~SF5 적용)
        if (item.rsScore <= 0) return false;

        // 동적 필터: 현재가 기준 실시간 적용
        const realtimePrice = allRealtimePrices.get(item.stock.code);
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics?.lowPrice52w;
        const high52w = item.metrics?.highPrice52w;
        const ma50 = item.metrics?.ma50;

        if (low52w != null && currentPrice < low52w * 1.3) return false;
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        if (ma50 != null && currentPrice <= ma50) return false;

        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // 테마 필터
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(stockTheme, filters.theme)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank);

    // 페이지네이션
    const totalCount = stocksWithRS.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithRS.slice(startIndex, endIndex);

    // 종가 및 실시간 가격 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);

    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    const realtimePrices = allRealtimePrices;

    return {
      marketType,
      page,
      pageSize,
      totalCount,
      totalPages,
      count: paginatedData.length,
      meta: {
        dataDate: latestTradeDate?.toISOString().split('T')[0] || null,
        lastUpdatedAt: this.lastDataUpdate?.toISOString() || null,
        isInitialized: this.initializationComplete,
        queryStartDate: (() => { const toMs = (s: string) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`).getTime(); const longest = rsFilters.reduce((max, f) => (toMs(f.rsEndDate) - toMs(f.rsStartDate)) > (toMs(max.rsEndDate) - toMs(max.rsStartDate)) ? f : max); return `${longest.rsStartDate.slice(0,4)}-${longest.rsStartDate.slice(4,6)}-${longest.rsStartDate.slice(6,8)}`; })(),
        queryEndDate: (() => { const toMs = (s: string) => new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`).getTime(); const longest = rsFilters.reduce((max, f) => (toMs(f.rsEndDate) - toMs(f.rsStartDate)) > (toMs(max.rsEndDate) - toMs(max.rsStartDate)) ? f : max); return `${longest.rsEndDate.slice(0,4)}-${longest.rsEndDate.slice(4,6)}-${longest.rsEndDate.slice(6,8)}`; })(),
        rangeRS: { filters: rsFilters, periods, weights },
      },
      stocks: paginatedData.map((item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChangeRate1d != null
            ? `${Number(metrics.priceChangeRate1d) > 0 ? '+' : ''}${Number(metrics.priceChangeRate1d).toFixed(2)}%`
            : '-',
          investmentIndicatorsDtl: '-',
          theme: s.upName || '-',
          upName: s.upName || '-',
          rankHistory: {
            today: rankHistory[0]?.rank || null,
            oneDayAgo: rankHistory[1]?.rank || null,
            twoDaysAgo: rankHistory[2]?.rank || null,
            threeDaysAgo: rankHistory[3]?.rank || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
        };
      }),
    };
  }

  /**
   * 종목 리스트 가져오기 (캐시 사용)
   * 'all'인 경우 KOSPI + KOSDAQ 모두 가져와서 병합
   *
   * marketType 정의:
   *   '0'   = KOSPI (키움 API 그대로)
   *   '10'  = KOSDAQ (키움 API 그대로)
   *   'all' = 전체 (KOSPI + KOSDAQ 병합)
   */
  private async fetchStockList(marketType: '0' | '10' | 'all'): Promise<any[]> {
    const cached = this.stockListCache.get(marketType);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }

    let validStocks: any[];

    if (marketType === 'all') {
      const [kospiResult, kosdaqResult] = await Promise.all([
        this.kiwoomRest.getStockList('0'),
        this.kiwoomRest.getStockList('10'),
      ]);
      validStocks = [
        ...kospiResult.list.filter((s: any) => s.code.match(/^\d{6}$/)),
        ...kosdaqResult.list.filter((s: any) => s.code.match(/^\d{6}$/)),
      ];
    } else {
      const result = await this.kiwoomRest.getStockList(marketType);
      validStocks = result.list.filter((s: any) => s.code.match(/^\d{6}$/));
    }

    this.stockListCache.set(marketType, { data: validStocks, timestamp: now });
    return validStocks;
  }

  /**
   * 종목 리스트 캐시 무효화
   */
  clearStockListCache(marketType?: '0' | '10' | 'all') {
    if (marketType) {
      this.stockListCache.delete(marketType);
      this.logger.log(`Cleared cache for market type: ${marketType}`);
    } else {
      this.stockListCache.clear();
      this.logger.log('Cleared all stock list cache');
    }
  }

  /**
   * 날짜 문자열을 오늘로부터 며칠 전인지 계산하여 일수로 변환
   * @param rsDates 쉼표로 구분된 날짜 문자열 (예: "2026-02-09,2026-01-15" 또는 "20260209,20260115")
   * @returns 쉼표로 구분된 일수 문자열 (예: "1,26")
   */
  private convertDatesToPeriods(rsDates: string): string {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const dates = rsDates.split(',').map((d) => d.trim());
    const periods = dates.map((dateStr) => {
      return this.convertSingleDateToDays(dateStr);
    });

    return periods.join(',');
  }

  /**
   * 단일 날짜 문자열을 오늘로부터 며칠 전인지 계산
   * @param dateStr 날짜 문자열 (예: "2026-02-09" 또는 "20260209")
   * @returns 오늘로부터 며칠 전인지 (예: 1)
   */
  private convertSingleDateToDays(dateStr: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 날짜 형식 파싱: "2026-02-09" 또는 "20260209"
    let date: Date;
    if (dateStr.includes('-')) {
      // "2026-02-09" 형식
      date = new Date(dateStr);
    } else if (dateStr.length === 8) {
      // "20260209" 형식
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      date = new Date(`${year}-${month}-${day}`);
    } else {
      this.logger.warn(`Invalid date format: ${dateStr}, using 63 as default`);
      return 63;
    }

    // 날짜 유효성 검사
    if (isNaN(date.getTime())) {
      this.logger.warn(`Invalid date: ${dateStr}, using 63 as default`);
      return 63;
    }

    date.setHours(0, 0, 0, 0);

    // 오늘로부터 며칠 전인지 계산
    const diffMs = today.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    this.logger.log(`Date ${dateStr} is ${diffDays} days ago from today`);

    // 음수이거나 0이면 기본값 사용
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * 디버그: 종목 리스트 Raw 조회 (필터 없음)
   */
  async debugGetStockList(marketType: '0' | '10' | 'all' = 'all') {
    const validStocks = await this.fetchStockList(marketType);

    return {
      marketType,
      totalStocks: validStocks.length,
      sampleStocks: validStocks.slice(0, 5).map(s => ({
        code: s.code,
        name: s.name,
        marketName: s.marketName,
      })),
    };
  }

  /**
   * 테마 매칭 함수
   * @param stockUpName 종목의 업종명 (키움 API upName)
   * @param themeFilters 필터링할 테마 코드 배열 (숫자 배열, 예: [101, 102, 302] = 제약, 금속, 반도체)
   * @returns 매칭 여부
   */
  private matchesTheme(stockUpName: string, themeFilters: number[]): boolean {
    if (!stockUpName || stockUpName === '-') {
      return false;
    }

    // 0(전체) 테마가 포함되어 있으면 모든 종목 허용
    if (themeFilters.includes(0)) {
      return true;
    }

    // upName을 테마 코드로 변환
    const stockThemeCode = mapUpNameToThemeCode(stockUpName);

    // 변환된 테마 코드가 필터 배열에 포함되어 있는지 확인
    return stockThemeCode !== null && themeFilters.includes(stockThemeCode);
  }

  /**
   * 시장 지수 일봉 수집 (KOSPI/KOSDAQ)
   * @param sectorCode 업종코드 (001: KOSPI, 101: KOSDAQ)
   * @param indexStockCode DB 저장용 코드 (INDEX_KOSPI, INDEX_KOSDAQ)
   */
  async collectSectorDayCandles(sectorCode: string, indexStockCode: string) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    try {
      const data = await this.kiwoomRest.getSectorDayCandles(sectorCode, today);
      const candles = data.inds_dt_pole_qry;

      if (!candles || !Array.isArray(candles)) {
        this.logger.warn(
          `No candles data received for sector ${sectorCode}. Response: ${JSON.stringify(data)}`,
        );
        return { success: false, count: 0 };
      }

      this.logger.log(`Fetched ${candles.length} sector day candles for ${sectorCode}`);

      // DB에 저장 (지수값은 ×100 정수로 옴 → 그대로 저장, 계산 시 /100)
      // parsePrice로 부호 제거 (Kiwoom API가 '+'/'-' 부호를 붙여서 반환하는 경우 대응)
      for (const candle of candles) {
        await this.chartStorage.saveCandle({
          stockCode: indexStockCode,
          candleType: 'day',
          candleTime: this.parseDateOnly(candle.dt),
          openPrice: this.parsePrice(candle.open_pric),
          highPrice: this.parsePrice(candle.high_pric),
          lowPrice: this.parsePrice(candle.low_pric),
          closePrice: this.parsePrice(candle.cur_prc),
          volume: BigInt(candle.trde_qty || '0'),
        });
      }

      return { success: true, count: candles.length };
    } catch (error) {
      this.logger.error(`Failed to collect sector day candles for ${sectorCode}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * 전체 종목 일봉 수집 (배치 병렬 처리)
   * - BATCH_SIZE개씩 동시 요청, 배치 간 BATCH_DELAY_MS 대기
   * - 429 발생 시 백오프 후 재시도
   */
  async collectIndexCandles() {
    this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
    await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
    await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
    this.logger.log('Market index day candles collected.');
    // ka20006 doesn't include today's candle → also fetch today's close via ka20001
    const todayClose = await this.collectTodayIndexClose();
    return { success: true, message: 'KOSPI + KOSDAQ index candles collected.', todayClose };
  }

  /**
   * 오늘 지수 종가 수집 (ka20001 업종현재가)
   * ka20006 일봉 API는 당일 캔들을 포함하지 않으므로, 장 마감 후 별도로 호출
   */
  async collectTodayIndexClose() {
    const now = new Date();
    // KST 날짜 기준으로 오늘 자정 계산 (서버 타임존 무관)
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const todayDate = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - 9 * 60 * 60 * 1000);

    this.logger.log('Fetching today\'s index close via ka20001...');

    const [kospiData, kosdaqData] = await Promise.all([
      this.kiwoomRest.getSectorCurrentPrice('0', '001'),
      this.kiwoomRest.getSectorCurrentPrice('1', '101'),
    ]);

    // ka20001은 실제 지수값(×1)을 반환하고, ka20006은 ×100 정수를 반환하므로
    // DB 일관성 유지를 위해 ×100 곱하여 저장 (parsePrice로 부호도 제거)
    await Promise.all([
      this.chartStorage.saveCandle({
        stockCode: 'INDEX_KOSPI',
        candleType: 'day',
        candleTime: todayDate,
        openPrice: this.parsePrice(kospiData.open_pric) * 100,
        highPrice: this.parsePrice(kospiData.high_pric) * 100,
        lowPrice: this.parsePrice(kospiData.low_pric) * 100,
        closePrice: this.parsePrice(kospiData.cur_prc) * 100,
        volume: BigInt(kospiData.trde_qty || '0'),
      }),
      this.chartStorage.saveCandle({
        stockCode: 'INDEX_KOSDAQ',
        candleType: 'day',
        candleTime: todayDate,
        openPrice: this.parsePrice(kosdaqData.open_pric) * 100,
        highPrice: this.parsePrice(kosdaqData.high_pric) * 100,
        lowPrice: this.parsePrice(kosdaqData.low_pric) * 100,
        closePrice: this.parsePrice(kosdaqData.cur_prc) * 100,
        volume: BigInt(kosdaqData.trde_qty || '0'),
      }),
    ]);

    this.logger.log(`Today's index close saved — KOSPI: ${kospiData.cur_prc}, KOSDAQ: ${kosdaqData.cur_prc}`);

    return {
      date: `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`,
      kospi: kospiData.cur_prc,
      kosdaq: kosdaqData.cur_prc,
    };
  }

  async collectAllDayCandles(marketType: '0' | '10' = '0', days = 7) {
    const BATCH_SIZE = 5; // 동시 요청 수
    const BATCH_DELAY_MS = 600; // 배치 간 대기 (ms)

    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}, batchSize: ${BATCH_SIZE}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 해당 시장 종목 필터 (ETF/ETN 제외)
    // - ETF: marketCode='8'이라 이미 제외됨
    // - ETN: 코드가 5/6/7로 시작 (marketCode='0'이지만 ETN)
    // - 알파벳 포함 코드: ETF/ETN 변형
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && /^\d+$/.test(s.code) && !/^[567]/.test(s.code),
    );

    this.logger.log(`Found ${stocks.length} stocks to process in batches of ${BATCH_SIZE}`);

    let success = 0;
    let failed = 0;
    let currentDelay = BATCH_DELAY_MS;
    const errors: { code: string; error: string }[] = [];

    // 배치 단위로 분할
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);

      // 배치 내 종목들을 병렬로 처리
      const results = await Promise.allSettled(
        batch.map((stock) => this.getDayCandles(stock.code, today, true, days)),
      );

      // 결과 처리
      let batchHas429 = false;
      const retryStocks: typeof batch = [];

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          success++;
        } else {
          const axiosError = result.reason as any;
          if (axiosError?.status === 429 || axiosError?.response?.status === 429) {
            batchHas429 = true;
            retryStocks.push(batch[j]);
          } else {
            failed++;
            errors.push({ code: batch[j].code, error: result.reason?.message || 'Unknown error' });
            this.logger.warn(`Failed: ${batch[j].code} - ${result.reason?.message}`);
          }
        }
      }

      // 429 발생 시 백오프 후 재시도 (순차)
      if (batchHas429) {
        currentDelay = Math.min(currentDelay * 2, 10000);
        this.logger.warn(`Rate limited (429) on ${retryStocks.length} stocks. Backing off ${currentDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, currentDelay));

        for (const stock of retryStocks) {
          try {
            await this.getDayCandles(stock.code, today, true, days);
            success++;
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (retryError) {
            failed++;
            errors.push({ code: stock.code, error: (retryError as Error).message });
          }
        }
      } else {
        // 성공 시 딜레이 점진적 복구
        currentDelay = Math.max(BATCH_DELAY_MS, currentDelay - 200);
      }

      // 진행 상황 로깅
      const processed = Math.min(i + BATCH_SIZE, stocks.length);
      if (processed % 50 === 0 || processed === stocks.length) {
        const elapsed = ((processed / stocks.length) * 100).toFixed(1);
        this.logger.log(`Progress: ${processed}/${stocks.length} (${elapsed}%) - success: ${success}, failed: ${failed}`);
      }

      // 배치 간 딜레이
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }

    this.logger.log(`Bulk collection completed: ${success} success, ${failed} failed out of ${stocks.length}`);

    return {
      marketType,
      days,
      total: stocks.length,
      success,
      failed,
      errors: errors.slice(0, 10),
    };
  }

  /**
   * 전체 종목 일봉 + 거래대금 백필 (getDayCandlesWithHistory 사용, 페이지네이션 지원)
   */
  async backfillDayCandles(marketType: '0' | '10' = '0', days = 130) {
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1000;

    this.logger.log(`Starting day candle backfill: market=${marketType}, days=${days}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && /^\d+$/.test(s.code) && !/^[567]/.test(s.code),
    );
    this.logger.log(`Backfilling ${stocks.length} stocks (${days} days each)`);

    let success = 0;
    let failed = 0;
    const errors: { code: string; error: string }[] = [];

    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (stock) => {
          const kiwoomData = await this.kiwoomRest.getDayCandlesWithHistory(stock.code, today, days);
          const candlesToSave = kiwoomData.stk_dt_pole_chart_qry.map((item) => ({
            stockCode: stock.code,
            candleType: 'day',
            candleTime: this.parseDateOnly(item.dt),
            openPrice: this.parsePrice(item.open_pric),
            highPrice: this.parsePrice(item.high_pric),
            lowPrice: this.parsePrice(item.low_pric),
            closePrice: this.parsePrice(item.cur_prc),
            volume: BigInt(item.trde_qty || '0'),
            tradingValue: item.trde_prica ? BigInt(item.trde_prica) * 1_000_000n : null,
          }));
          await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
          return candlesToSave.length;
        }),
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          success++;
        } else {
          failed++;
          const err = (results[j] as PromiseRejectedResult).reason;
          errors.push({ code: batch[j].code, error: err?.message || 'Unknown' });
          this.logger.warn(`Backfill failed: ${batch[j].code} - ${err?.message}`);
        }
      }

      const processed = Math.min(i + BATCH_SIZE, stocks.length);
      if (processed % 100 === 0 || processed === stocks.length) {
        this.logger.log(`Backfill progress: ${processed}/${stocks.length} - success: ${success}, failed: ${failed}`);
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    this.logger.log(`Backfill completed: ${success} success, ${failed} failed out of ${stocks.length}`);
    return { marketType, days, total: stocks.length, success, failed, errors: errors.slice(0, 20) };
  }

  /**
   * tradingValue가 null인 일봉을 찾아 키움 데이터로 채워넣기
   */
  async fillMissingTradingValue() {
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1000;

    // tradingValue가 null인 종목 코드 목록 조회
    const nullCandleStocks = await this.prisma.stockCandle.findMany({
      where: { candleType: 'day', tradingValue: null },
      select: { stockCode: true },
      distinct: ['stockCode'],
    });

    const stockCodes = nullCandleStocks.map((r) => r.stockCode);
    this.logger.log(`fillMissingTradingValue: ${stockCodes.length}개 종목에 tradingValue 누락 일봉 존재`);

    if (stockCodes.length === 0) return { total: 0, success: 0, failed: 0, updated: 0, errors: [] };

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let success = 0;
    let failed = 0;
    let totalUpdated = 0;
    const errors: { code: string; error: string }[] = [];

    for (let i = 0; i < stockCodes.length; i += BATCH_SIZE) {
      const batch = stockCodes.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (stockCode) => {
          // 해당 종목에서 tradingValue가 null인 일자 목록
          const nullDates = await this.prisma.stockCandle.findMany({
            where: { stockCode, candleType: 'day', tradingValue: null },
            select: { candleTime: true },
          });
          const nullDateSet = new Set(nullDates.map((r) => r.candleTime.toISOString()));

          // 키움에서 해당 종목 일봉 데이터 조회 (최대 750일)
          const kiwoomData = await this.kiwoomRest.getDayCandlesWithHistory(stockCode, today, 750);

          let updatedCount = 0;
          for (const item of kiwoomData.stk_dt_pole_chart_qry) {
            if (!item.trde_prica) continue;
            const candleTime = this.parseDateOnly(item.dt);
            if (!nullDateSet.has(candleTime.toISOString())) continue;

            const tradingValue = BigInt(item.trde_prica) * 1_000_000n;
            await this.prisma.stockCandle.updateMany({
              where: { stockCode, candleType: 'day', candleTime, tradingValue: null },
              data: { tradingValue },
            });
            updatedCount++;
          }
          return updatedCount;
        }),
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          success++;
          totalUpdated += (results[j] as PromiseFulfilledResult<number>).value;
        } else {
          failed++;
          const err = (results[j] as PromiseRejectedResult).reason;
          errors.push({ code: batch[j], error: err?.message || 'Unknown' });
          this.logger.warn(`fillMissingTradingValue failed: ${batch[j]} - ${err?.message}`);
        }
      }

      const processed = Math.min(i + BATCH_SIZE, stockCodes.length);
      if (processed % 50 === 0 || processed === stockCodes.length) {
        this.logger.log(`진행: ${processed}/${stockCodes.length} - 업데이트: ${totalUpdated}건, 실패: ${failed}`);
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    this.logger.log(`fillMissingTradingValue 완료: ${success}종목 처리, ${totalUpdated}건 업데이트, ${failed}종목 실패`);
    return { total: stockCodes.length, success, failed, updated: totalUpdated, errors: errors.slice(0, 20) };
  }

  /**
   * DB에서 저장된 캔들 데이터 조회
   */
  async getStoredCandles(
    stockCode: string,
    candleType: string,
    startDate: string,
    endDate: string,
  ) {
    const startTime = new Date(startDate);
    const endTime = new Date(endDate);
    endTime.setUTCHours(23, 59, 59, 999);

    // 일봉/주봉/월봉은 오늘 미완성 캔들 제외 → 전 거래일까지만
    // KST 오늘(YYYY-MM-DD)의 일봉은 parseDateOnly 기준으로 (todayKST 00:00 UTC - 9h) 에 저장됨
    // 따라서 cutoff = todayKST 00:00 UTC - 9h - 1ms 로 잘라야 오늘 봉이 제외됨
    if (candleType === 'day' || candleType === 'week' || candleType === 'month') {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const todayKstMidnightUtc = new Date(kstNow.toISOString().split('T')[0]); // 오늘 KST 00:00 = UTC 당일 00:00
      const todayCandleStoredAt = new Date(todayKstMidnightUtc.getTime() - 9 * 60 * 60 * 1000); // 전날 15:00 UTC
      if (endTime >= todayCandleStoredAt) {
        endTime.setTime(todayCandleStoredAt.getTime() - 1); // 전날 14:59:59.999 UTC = 전날 23:59:59 KST
      }
    }

    const candles = await this.chartStorage.getCandles(stockCode, candleType, startTime, endTime);

    // candles는 candleTime DESC (최신 먼저) 순서로 반환됨
    // index+1이 전일 캔들 → 등락률 계산 가능
    return {
      stockCode,
      candleType,
      candles: candles.map((c, index) => {
        const prevCandle = candles[index + 1]; // 전일 (없으면 undefined)
        const closePrice = c.closePrice.toNumber();
        const prevClose = prevCandle?.closePrice.toNumber();
        const changeRate =
          prevClose && prevClose > 0
            ? ((closePrice - prevClose) / prevClose) * 100
            : null;

        return {
          time: c.candleTime.toISOString(),
          open: c.openPrice.toString(),
          high: c.highPrice.toString(),
          low: c.lowPrice.toString(),
          close: c.closePrice.toString(),
          volume: c.volume.toString(),
          tradingValue: c.tradingValue?.toString() || null,
          changeRate: changeRate !== null ? changeRate.toFixed(2) : null,
        };
      }),
    };
  }

  /**
   * YYYYMMDD 문자열 → Date 변환
   */
  private parseYYYYMMDD(dateStr: string): Date {
    const y = dateStr.substring(0, 4);
    const m = dateStr.substring(4, 6);
    const d = dateStr.substring(6, 8);
    return new Date(`${y}-${m}-${d}`);
  }

  /**
   * 단일 종목 RS 추이 계산 (그래프용)
   * rsFilters → POST /stocks와 동일한 형식, 날짜는 YYYYMMDD
   */
  async getRsHistory(
    stockCode: string,
    startDate: string,
    endDate: string,
    rsFilters?: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>,
  ) {
    // rsFilters → 기간(달력일 수)과 가중치로 변환
    let periods: number[];
    let weights: number[];

    if (rsFilters && rsFilters.length > 0) {
      periods = rsFilters.map((f) => {
        const from = this.parseYYYYMMDD(f.rsStartDate); // 이전 날짜 (earlier)
        const to = this.parseYYYYMMDD(f.rsEndDate);     // 이후 날짜 (later)
        const diffDays = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 ? diffDays : 63;
      });
      weights = rsFilters.map((f) => f.strength);
    } else {
      periods = [63];
      weights = [100];
    }

    // 종목 시장 조회 → 지수 코드 결정
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
    });
    const indexCode = company?.marketType === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI';

    // 룩백 버퍼 (영업일 → 달력일: 최대 기간 × 1.5)
    const maxPeriod = Math.max(...periods);
    const bufferDays = Math.ceil(maxPeriod * 1.5);
    const fetchStart = this.parseYYYYMMDD(startDate);
    fetchStart.setDate(fetchStart.getDate() - bufferDays);
    const fetchEnd = this.parseYYYYMMDD(endDate);

    // 종목 + 지수 일봉 조회
    const [stockCandles, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: { stockCode, candleType: 'day', candleTime: { gte: fetchStart, lte: fetchEnd } },
        orderBy: { candleTime: 'asc' },
      }),
      this.prisma.stockCandle.findMany({
        where: { stockCode: indexCode, candleType: 'day', candleTime: { gte: fetchStart, lte: fetchEnd } },
        orderBy: { candleTime: 'asc' },
      }),
    ]);

    // startDate 이후 거래일만 결과로 반환 (버퍼 기간 제외)
    const rangeStart = this.parseYYYYMMDD(startDate);
    const tradeDatesInRange = stockCandles.filter((c) => c.candleTime >= rangeStart);

    const data: Array<{ date: string; rsRaw: number }> = [];

    for (const candle of tradeDatesInRange) {
      const tradeDate = candle.candleTime;
      const stockUpTo = stockCandles.filter((c) => c.candleTime <= tradeDate);
      const indexUpTo = indexCandles.filter((c) => c.candleTime <= tradeDate);

      if (stockUpTo.length === 0 || indexUpTo.length === 0) continue;

      const closeNow = stockUpTo[stockUpTo.length - 1].closePrice.toNumber();
      const indexNow = indexUpTo[indexUpTo.length - 1].closePrice.toNumber();

      const rsValues: number[] = [];
      for (const period of periods) {
        if (stockUpTo.length <= period || indexUpTo.length <= period) {
          rsValues.push(0);
          continue;
        }
        const pastPrice = stockUpTo[stockUpTo.length - 1 - period].closePrice.toNumber();
        const indexPast = indexUpTo[indexUpTo.length - 1 - period].closePrice.toNumber();
        if (pastPrice > 0 && indexPast > 0) {
          rsValues.push((closeNow / pastPrice) / (indexNow / indexPast));
        } else {
          rsValues.push(0);
        }
      }

      // 가중 평균
      let weightedRS = 0;
      let totalWeight = 0;
      for (let i = 0; i < rsValues.length; i++) {
        if (rsValues[i] > 0) {
          weightedRS += rsValues[i] * weights[i];
          totalWeight += weights[i];
        }
      }
      if (totalWeight === 0) continue;
      weightedRS /= totalWeight;

      const dateStr = tradeDate.toISOString().split('T')[0].replace(/-/g, '');
      data.push({ date: dateStr, rsRaw: parseFloat(weightedRS.toFixed(6)) });
    }

    return { stockCode, indexCode, periods, weights, count: data.length, data };
  }

  /**
   * 실시간 구독 시작
   */
  async startRealtime(stockCode: string) {

    // 캐시에 구독 추가
    this.realtimeCache.addSubscription(stockCode);

    // 실시간 소스 구독 시작 (0B: 체결, 0D: 호가)
    await this.realtimeSource.subscribe(stockCode, ['0B', '0D']);

    return { success: true, stockCode };
  }

  /**
   * 실시간 구독 중지
   */
  async stopRealtime(stockCode: string) {

    // 실시간 소스 구독 해제
    await this.realtimeSource.unsubscribe(stockCode);

    // 캐시에서 제거
    this.realtimeCache.removeSubscription(stockCode);

    return { success: true, stockCode };
  }

  /**
   * 실시간 구독 시작 (여러 종목)
   */
  async startRealtimeBatch(stockCodes: string[]) {
    this.logger.log(`Starting realtime subscription for ${stockCodes.length} stocks`);

    const results = await Promise.allSettled(
      stockCodes.map((code) => this.startRealtime(code)),
    );

    const success = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    return {
      success: true,
      total: stockCodes.length,
      succeeded: success,
      failed,
    };
  }

  /**
   * 실시간 구독 중지 (여러 종목)
   */
  async stopRealtimeBatch(stockCodes: string[]) {
    this.logger.log(`Stopping realtime subscription for ${stockCodes.length} stocks`);

    const results = await Promise.allSettled(
      stockCodes.map((code) => this.stopRealtime(code)),
    );

    const success = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    return {
      success: true,
      total: stockCodes.length,
      succeeded: success,
      failed,
    };
  }

  /**
   * 실시간 캐시 상태 조회
   */
  async getRealtimeCacheStats() {
    const stats = this.realtimeCache.getCacheStats();
    const subscribedStocks = this.realtimeCache.getSubscribedStocks();

    return {
      ...stats,
      subscribedStockCodes: subscribedStocks.slice(0, 10), // 처음 10개만
      totalSubscribed: subscribedStocks.length,
    };
  }

  /**
   * 종목 자동 구독 (아직 구독하지 않은 종목만, 페이지 조회 시 사용)
   */
  private async autoSubscribeStocks(stockCodes: string[]) {
    const subscribedStocks = new Set(this.realtimeCache.getSubscribedStocks());
    const newStocks = stockCodes.filter((code) => !subscribedStocks.has(code));

    if (newStocks.length === 0) {
      return;
    }

    this.logger.log(`Auto-subscribing ${newStocks.length} new stocks`);

    for (const code of newStocks) {
      try {
        await this.startRealtime(code);
      } catch (error) {
        this.logger.warn(`Failed to auto-subscribe ${code}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * 필터 통과 종목 전체 일괄 구독 (서버 시작 시 / 재계산 완료 후)
   * - DB StockDailyMetrics에서 rank > 0인 종목 전체를 구독
   * - 이미 구독된 종목은 스킵
   */
  async subscribeFilteredStocks(): Promise<void> {
    if (!this.realtimeSource.isConnected()) {
      this.logger.warn('WebSocket not connected, skipping bulk subscription');
      return;
    }

    // 최신 거래일의 필터 통과 종목 조회 (rank > 0)
    const filteredCodes = await this.metricsService.getFilteredStockCodes();

    if (filteredCodes.length === 0) {
      this.logger.warn('No filtered stocks found for subscription');
      return;
    }

    const subscribedStocks = new Set(this.realtimeCache.getSubscribedStocks());
    const newCodes = filteredCodes.filter((code) => !subscribedStocks.has(code));

    if (newCodes.length === 0) {
      this.logger.log(`All ${filteredCodes.length} filtered stocks already subscribed`);
      return;
    }

    this.logger.log(`Bulk subscribing ${newCodes.length} filtered stocks via batch REG (total filtered: ${filteredCodes.length})`);

    // subscribeBatch: 100종목씩 단일 REG 요청으로 전송 (개별 요청 건수 초과 방지)
    await this.realtimeSource.subscribeBatch(newCodes, ['0B', '0D']);

    // 캐시에도 구독 등록 (status API 조회 시 정확히 반영되도록)
    newCodes.forEach((code) => this.realtimeCache.addSubscription(code));

    this.logger.log(`Bulk subscription completed: ${newCodes.length} stocks submitted`);
  }

  /**
   * 캔들 시간 파싱 (YYYYMMDDHHmmss)
   */
  private parseCandleTime(timeStr: string): Date {
    const year = parseInt(timeStr.substring(0, 4));
    const month = parseInt(timeStr.substring(4, 6)) - 1;
    const day = parseInt(timeStr.substring(6, 8));
    const hour = parseInt(timeStr.substring(8, 10));
    const minute = parseInt(timeStr.substring(10, 12));
    const second = parseInt(timeStr.substring(12, 14));

    return new Date(year, month, day, hour, minute, second);
  }

  /**
   * 가격 파싱 (부호 제거)
   */
  private parsePrice(priceStr: string): number {
    return parseFloat(priceStr.replace(/[+\-]/g, ''));
  }

  /**
   * 날짜만 파싱 (YYYYMMDD)
   */
  private parseDateOnly(dateStr: string): Date {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    // KST 자정 = UTC 15:00 전날 (서버 로컬 타임존 무관하게 고정)
    return new Date(Date.UTC(year, month, day) - 9 * 60 * 60 * 1000);
  }

  /**
   * 일별 지표 계산 (배치 작업)
   */
  async calculateDailyMetrics(marketType: '0' | '10' | 'all' = 'all', tradeDate?: string, writeLogFile: boolean = false) {
    this.logger.log(`Starting daily metrics calculation for market type: ${marketType}, date: ${tradeDate || 'today'}`);
    const parsedTradeDate = tradeDate
      ? /^\d{8}$/.test(tradeDate)
        ? `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
        : tradeDate
      : undefined;
    const date = parsedTradeDate ? new Date(parsedTradeDate) : undefined;

    // 항상 KOSPI + KOSDAQ 통합 랭킹 (순위는 전체 풀에서 매기고, 시장별 조회 시 필터링)
    const [kospiStocks, kosdaqStocks] = await Promise.all([
      this.fetchStockList('0'),
      this.fetchStockList('10'),
    ]);
    const allCodes = [
      ...kospiStocks.map((s: any) => s.code),
      ...kosdaqStocks.map((s: any) => s.code),
    ];
    const stockIndexMap = new Map<string, string>();
    const stockNameMap = new Map<string, string>();
    for (const s of kospiStocks) { stockIndexMap.set(s.code, 'INDEX_KOSPI'); stockNameMap.set(s.code, s.name); }
    for (const s of kosdaqStocks) { stockIndexMap.set(s.code, 'INDEX_KOSDAQ'); stockNameMap.set(s.code, s.name); }

    const result = await this.metricsService.calculateAndSaveDailyMetrics('all', date, 'INDEX_KOSPI', allCodes, stockIndexMap, stockNameMap, writeLogFile);

    // 수동 재계산 후 초기화 상태 갱신
    this.initializationComplete = true;
    this.lastDataUpdate = new Date();

    // 재계산 후 새로 필터 통과된 종목 구독 갱신 (백그라운드)
    this.subscribeFilteredStocks().catch((error) => {
      this.logger.warn(`Post-metrics bulk subscription failed: ${(error as Error).message}`);
    });

    return result;
  }
}
