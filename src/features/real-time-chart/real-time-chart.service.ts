import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
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
      // 장 운영 시간 체크 (한국 시간 기준: 평일 09:00 ~ 15:30)
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const dayOfWeek = now.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // 월~금
      const isMarketHours = isWeekday && (currentHour === 9 || (currentHour >= 10 && currentHour < 15) || (currentHour === 15 && currentMinute <= 30));

      // DB에서 마지막 일봉 데이터 날짜 조회
      const lastCandleDate = await this.chartStorage.getLatestDayCandleDate();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let daysToFetch: number;
      let shouldSkipCollection = false;

      // 가장 최근 거래일 계산 (주말 제외, 공휴일은 API 레벨에서 처리)
      const getLastTradingDay = (): Date => {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        const day = d.getDay();
        if (day === 0) d.setDate(d.getDate() - 2); // 일요일 -> 금요일
        else if (day === 6) d.setDate(d.getDate() - 1); // 토요일 -> 금요일
        return d;
      };

      if (!lastCandleDate) {
        // 데이터가 없으면 52주치 수집 (신고가 판단 필요)
        daysToFetch = 365;
        this.logger.log('No existing data found. Fetching 52 weeks (365 days)...');
      } else {
        // 마지막 데이터 날짜 ~ 가장 최근 거래일까지 비교
        const lastDate = new Date(lastCandleDate);
        lastDate.setHours(0, 0, 0, 0);
        const lastTradingDay = getLastTradingDay();
        const diffMs = lastTradingDay.getTime() - lastDate.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          // 데이터가 최신 상태 (마지막 데이터 >= 가장 최근 거래일)
          if (!isMarketHours) {
            // 장 마감 후이고 데이터가 최신이면 수집 스킵
            this.logger.log(
              `Market is closed and data is up to date (last: ${lastDate.toISOString().split('T')[0]}, lastTradingDay: ${lastTradingDay.toISOString().split('T')[0]}). Skipping data collection.`,
            );
            shouldSkipCollection = true;
          } else {
            // 장 운영 중이면 최신 종가 업데이트를 위해 1일치 가져옴
            daysToFetch = 1;
            this.logger.log(
              `Market is open. Fetching 1 day for latest prices (last: ${lastDate.toISOString().split('T')[0]})...`,
            );
          }
        } else {
          // 공백이 있으면 정확히 그 일수만큼만 가져옴 (API는 거래일만 반환하므로 주말/공휴일 자동 제외)
          daysToFetch = diffDays;
          this.logger.log(
            `Last data date: ${lastDate.toISOString().split('T')[0]}, gap: ${diffDays} days to lastTradingDay: ${lastTradingDay.toISOString().split('T')[0]}. Fetching ${daysToFetch} days...`,
          );
        }
      }

      // 데이터 수집 (스킵하지 않는 경우만)
      if (!shouldSkipCollection) {
        // 0. 시장 지수 일봉 수집 (KOSPI + KOSDAQ) - RS 계산에 필요
        this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
        await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
        await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
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
      for (const s of kospiStockList) stockIndexMap.set(s.code, 'INDEX_KOSPI');
      for (const s of kosdaqStockList) stockIndexMap.set(s.code, 'INDEX_KOSDAQ');

      const recentDates = await this.metricsService.getRecentTradingDates(4);
      this.logger.log(`Calculating unified metrics for ${recentDates.length} trading days (KOSPI: ${kospiStockList.length}, KOSDAQ: ${kosdaqStockList.length}, total: ${allStockCodes.length})...`);

      for (const tradeDate of recentDates) {
        const metricsResult = await this.metricsService.calculateAndSaveDailyMetrics('all', tradeDate, 'INDEX_KOSPI', allStockCodes, stockIndexMap);
        this.logger.log(`Metrics for ${tradeDate.toISOString().split('T')[0]}: ${metricsResult?.count || 0} stocks, filtered: ${metricsResult?.filtered || 0}`);
      }

      this.initializationComplete = true;
      this.lastDataUpdate = new Date();

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`=== Data Initialization Completed in ${duration}s ===`);

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
   * 실시간 데이터 소스 연결 보장
   * (장시작 시간에 WebSocket 연결 확인 및 재연결)
   */
  async ensureRealtimeConnection(): Promise<void> {
    this.logger.log('Ensuring realtime data source connection...');

    try {
      const isConnected = this.realtimeSource.isConnected();

      if (isConnected) {
        this.logger.log('Realtime source already connected');
      } else {
        this.logger.log('Realtime source not connected, attempting to connect...');
        await this.realtimeSource.ensureConnection();
        this.logger.log('Realtime source connection established');
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

    // 1. 키움 API에서 데이터 조회
    const kiwoomData = await this.kiwoomRest.getMinuteCandles(stockCode, interval);

    // 2. DB에 저장
    const candles = kiwoomData.stk_min_pole_chart_qry.map((item) => ({
      stockCode,
      candleType: `${interval}min`,
      candleTime: this.parseCandleTime(item.cntr_tm),
      openPrice: this.parsePrice(item.open_pric),
      highPrice: this.parsePrice(item.high_pric),
      lowPrice: this.parsePrice(item.low_pric),
      closePrice: this.parsePrice(item.cur_prc),
      volume: BigInt(item.trde_qty),
    }));

    // 병렬로 저장
    await Promise.all(candles.map((candle) => this.chartStorage.saveCandle(candle)));

    return {
      stockCode,
      interval: `${interval}min`,
      candles: candles.map((c) => ({
        time: c.candleTime.toISOString(),
        open: c.openPrice.toString(),
        high: c.highPrice.toString(),
        low: c.lowPrice.toString(),
        close: c.closePrice.toString(),
        volume: c.volume.toString(),
      })),
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
    this.logger.log(`Getting day candles for ${stockCode} from ${baseDate}`);

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
        tradingValue: BigInt(item.trde_prica || '0'),
      }));

      await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
      this.logger.debug(`Saved ${candlesToSave.length} day candles for ${stockCode}`);
    }

    return {
      stockCode,
      candles,
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
        // 기본 필터: RS 점수 > 0
        if (item.rsScore <= 0) return false;

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
          // 테마명 부분 매칭 (키움 API의 upName과 비교)
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

    // 실시간 캐시에서 현재가 조회
    const realtimePrices = this.realtimeCache.getPrices(pageStockCodes);

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
      },
      stocks: paginatedData.map((item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = rankingMap.get(s.code) || [];

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: metrics?.rank || startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number((metrics?.relativeStrengthScore || 0).toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChange1d
            ? `${metrics.priceChange1d > 0 ? '+' : ''}${metrics.priceChangeRate1d?.toFixed(2)}%`
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

    // 기본 지표 데이터 조회 (필터링용: isNewHigh, tradingValue 등)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

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
        // 기본 필터: RS 점수 > 0
        if (item.rsScore <= 0) return false;

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

    // 실시간 캐시에서 현재가 조회
    const realtimePrices = this.realtimeCache.getPrices(pageStockCodes);

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
        customRS: { periods, weights },
      },
      stocks: paginatedData.map((item) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: item.rank,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChange1d
            ? `${metrics.priceChange1d > 0 ? '+' : ''}${metrics.priceChangeRate1d?.toFixed(2)}%`
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
    this.logger.log(`Getting stock list with range RS filters: ${JSON.stringify(rsFilters)}`);

    // rsFilters가 없으면 기본 로직 사용
    if (!rsFilters || rsFilters.length === 0) {
      return this.getStockList(marketType, page, pageSize, filters);
    }

    // 종목 리스트 가져오기
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);

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
      const kospiStocks = validStocks.filter((s) => s.marketName === '거래소').map((s) => s.code);
      const kosdaqStocks = validStocks.filter((s) => s.marketName === '코스닥').map((s) => s.code);

      this.logger.log(`Split stocks: KOSPI=${kospiStocks.length}, KOSDAQ=${kosdaqStocks.length}`);

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
        allStockCodes,
        rsFilters,
        indexCode,
        4,
      );
    }

    // 기본 지표 데이터 조회 (필터링용)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

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
        if (item.rsScore <= 0) return false;

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

    const realtimePrices = this.realtimeCache.getPrices(pageStockCodes);
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
        rangeRS: { filters: rsFilters, periods, weights },
      },
      stocks: paginatedData.map((item) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = realtimePrices.get(s.code);
        const dbPrice = closingPrices.get(s.code) || metrics?.closePrice || 0;

        return {
          id: s.code,
          rank: item.rank,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: realtimePrice
            ? `${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate.toFixed(2)}%`
            : metrics?.priceChange1d
            ? `${metrics.priceChange1d > 0 ? '+' : ''}${metrics.priceChangeRate1d?.toFixed(2)}%`
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
      for (const candle of candles) {
        await this.chartStorage.saveCandle({
          stockCode: indexStockCode,
          candleType: 'day',
          candleTime: this.parseDateOnly(candle.dt),
          openPrice: parseFloat(candle.open_pric),
          highPrice: parseFloat(candle.high_pric),
          lowPrice: parseFloat(candle.low_pric),
          closePrice: parseFloat(candle.cur_prc),
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
  async collectAllDayCandles(marketType: '0' | '10' = '0', days = 7) {
    const BATCH_SIZE = 5; // 동시 요청 수
    const BATCH_DELAY_MS = 600; // 배치 간 대기 (ms)

    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}, batchSize: ${BATCH_SIZE}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 해당 시장 종목 필터 (우선주 등 비정규 코드 포함)
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType,
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

    const candles = await this.chartStorage.getCandles(stockCode, candleType, startTime, endTime);

    return {
      stockCode,
      candleType,
      candles: candles.map((c) => ({
        time: c.candleTime.toISOString(),
        open: c.openPrice.toString(),
        high: c.highPrice.toString(),
        low: c.lowPrice.toString(),
        close: c.closePrice.toString(),
        volume: c.volume.toString(),
      })),
    };
  }

  /**
   * 실시간 구독 시작
   */
  async startRealtime(stockCode: string) {
    this.logger.log(`Starting realtime subscription for ${stockCode}`);

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
    this.logger.log(`Stopping realtime subscription for ${stockCode}`);

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
   * 종목 자동 구독 (아직 구독하지 않은 종목만)
   */
  private async autoSubscribeStocks(stockCodes: string[]) {
    const subscribedStocks = new Set(this.realtimeCache.getSubscribedStocks());
    const newStocks = stockCodes.filter((code) => !subscribedStocks.has(code));

    if (newStocks.length === 0) {
      return;
    }

    this.logger.log(`Auto-subscribing ${newStocks.length} new stocks`);

    // 배치로 구독 (너무 많으면 부하 발생 가능하므로 제한)
    const MAX_AUTO_SUBSCRIBE = 50;
    const stocksToSubscribe = newStocks.slice(0, MAX_AUTO_SUBSCRIBE);

    for (const code of stocksToSubscribe) {
      try {
        await this.startRealtime(code);
      } catch (error) {
        this.logger.warn(`Failed to auto-subscribe ${code}: ${(error as Error).message}`);
      }
    }
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
    return new Date(year, month, day);
  }

  /**
   * 일별 지표 계산 (배치 작업)
   */
  async calculateDailyMetrics(marketType: '0' | '10' | 'all' = 'all', tradeDate?: string) {
    this.logger.log(`Starting daily metrics calculation for market type: ${marketType}, date: ${tradeDate || 'today'}`);
    const date = tradeDate ? new Date(tradeDate) : undefined;

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
    for (const s of kospiStocks) stockIndexMap.set(s.code, 'INDEX_KOSPI');
    for (const s of kosdaqStocks) stockIndexMap.set(s.code, 'INDEX_KOSDAQ');

    return this.metricsService.calculateAndSaveDailyMetrics('all', date, 'INDEX_KOSPI', allCodes, stockIndexMap);
  }
}
