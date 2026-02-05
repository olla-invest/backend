import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { KiwoomWebSocketService } from '../../integrations/kiwoom/websocket/kiwoom-websocket.service';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';

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
    private readonly kiwoomWebSocket: KiwoomWebSocketService,
    private readonly chartStorage: ChartStorageService,
    private readonly metricsService: StockMetricsService,
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
      // DB에서 마지막 일봉 데이터 날짜 조회
      const lastCandleDate = await this.chartStorage.getLatestDayCandleDate();
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let daysToFetch: number;

      if (!lastCandleDate) {
        // 데이터가 없으면 52주치 수집 (신고가 판단 필요)
        daysToFetch = 365;
        this.logger.log('No existing data found. Fetching 52 weeks (365 days)...');
      } else {
        // 마지막 데이터 날짜 ~ 오늘까지의 일수 계산
        const lastDate = new Date(lastCandleDate);
        lastDate.setHours(0, 0, 0, 0);
        const diffMs = today.getTime() - lastDate.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          this.logger.log('Data is already up to date. Skipping candle collection.');
          this.initializationComplete = true;
          this.lastDataUpdate = new Date();
          return {
            success: true,
            duration: '0s',
            updatedAt: this.lastDataUpdate,
            skipped: true,
            message: 'Data already up to date',
          };
        }

        // 주말/공휴일 고려하여 여유분 +2일 추가
        daysToFetch = diffDays + 2;
        this.logger.log(
          `Last data date: ${lastDate.toISOString().split('T')[0]}, gap: ${diffDays} days. Fetching ${daysToFetch} days...`,
        );
      }

      for (const marketType of marketTypes) {
        const marketName = marketType === '0' ? 'KOSPI' : 'KOSDAQ';
        this.logger.log(`[${marketName}] Collecting day candles (${daysToFetch} days)...`);

        // 1. 일봉 데이터 수집
        const collectResult = await this.collectAllDayCandles(marketType, daysToFetch);
        this.logger.log(`[${marketName}] Day candles collected: ${collectResult.success}/${collectResult.total}`);

        // 2. 일별 지표 계산
        this.logger.log(`[${marketName}] Calculating daily metrics...`);
        const metricsResult = await this.calculateDailyMetrics(marketType);
        this.logger.log(`[${marketName}] Daily metrics calculated: ${metricsResult?.count || 0} stocks`);
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
   * 종목 리스트 조회 (프론트엔드 인터페이스에 맞춰서, 페이지네이션 지원, 캐싱)
   */
  async getStockList(marketType: '0' | '10' | '8' = '0', page: number = 1, pageSize: number = 50) {
    this.logger.log(`Getting stock list for market type: ${marketType}, page: ${page}, pageSize: ${pageSize}`);

    // 캐시 확인
    const cached = this.stockListCache.get(marketType);
    const now = Date.now();
    let validStocks: any[];

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      // 캐시 히트
      this.logger.debug(`Cache hit for market type: ${marketType}`);
      validStocks = cached.data;
    } else {
      // 캐시 미스 - API 호출
      this.logger.log(`Cache miss for market type: ${marketType}, fetching from API`);
      const result = await this.kiwoomRest.getStockList(marketType);

      // 6자리 숫자 종목코드만 필터
      validStocks = result.list.filter((s) => s.code.match(/^\d{6}$/));

      // 캐시 저장
      this.stockListCache.set(marketType, {
        data: validStocks,
        timestamp: now,
      });
      this.logger.log(`Cached ${validStocks.length} stocks for market type: ${marketType}`);
    }

    // 모든 종목 코드 수집
    const allStockCodes = validStocks.map((s) => s.code);

    // 최신 지표 데이터 조회 (모든 종목)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 종목 리스트와 지표 병합 및 RS 점수 기준 내림차순 정렬
    const stocksWithMetrics = validStocks
      .map((s) => {
        const metrics = metricsMap.get(s.code);
        return {
          stock: s,
          metrics,
          rsScore: metrics?.relativeStrengthScore || 0,
        };
      })
      .sort((a, b) => b.rsScore - a.rsScore); // RS 점수 내림차순

    // 정렬 후 페이지네이션
    const totalCount = stocksWithMetrics.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithMetrics.slice(startIndex, endIndex);

    // 페이지네이션된 종목들의 종가 및 순위 변동 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);

    const rankingHistories = await Promise.all(
      pageStockCodes.map(async (code) => ({
        code,
        history: await this.metricsService.getRankingHistory(code, 3),
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

        return {
          id: s.code,
          rank: metrics?.rank || startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: closingPrices.get(s.code) || metrics?.closePrice || 0,
          exchange: s.marketName === '거래소' ? 'KOSPI' : s.marketName === '코스닥' ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: metrics?.relativeStrengthScore || 0,
          isHighPrice: metrics?.isNewHigh || false,
          investmentIndicators: metrics?.priceChange1d
            ? `${metrics.priceChange1d > 0 ? '+' : ''}${metrics.priceChangeRate1d?.toFixed(2)}%`
            : '-',
          investmentIndicatorsDtl: '-',
          theme: s.upName || '-',
          upName: s.upName || '-',
          rankChange3Days: rankHistory.slice(0, 3),
        };
      }),
    };
  }

  /**
   * 종목 리스트 캐시 무효화
   */
  clearStockListCache(marketType?: '0' | '10' | '8') {
    if (marketType) {
      this.stockListCache.delete(marketType);
      this.logger.log(`Cleared cache for market type: ${marketType}`);
    } else {
      this.stockListCache.clear();
      this.logger.log('Cleared all stock list cache');
    }
  }

  /**
   * 전체 종목 일봉 수집
   */
  async collectAllDayCandles(marketType: '0' | '10' = '0', days = 7) {
    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 일반 주식만 필터 (6자리 숫자 종목코드, 거래소 종목)
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && s.code.match(/^\d{6}$/),
    );

    this.logger.log(`Found ${stocks.length} stocks to process`);

    let success = 0;
    let failed = 0;
    let currentDelay = 500; // 기본 딜레이 500ms
    const errors: { code: string; error: string }[] = [];

    for (const stock of stocks) {
      try {
        await this.getDayCandles(stock.code, today, true, days);
        success++;
        currentDelay = 500; // 성공 시 딜레이 복구

        if (success % 50 === 0) {
          this.logger.log(`Progress: ${success}/${stocks.length} stocks processed`);
        }
      } catch (error) {
        const axiosError = error as any;

        // 429 (Too Many Requests) → 백오프 후 재시도
        if (axiosError?.status === 429 || axiosError?.response?.status === 429) {
          currentDelay = Math.min(currentDelay * 2, 10000); // 최대 10초까지 백오프
          this.logger.warn(`Rate limited (429). Backing off ${currentDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, currentDelay));

          // 1회 재시도
          try {
            await this.getDayCandles(stock.code, today, true, days);
            success++;
          } catch (retryError) {
            failed++;
            errors.push({ code: stock.code, error: (retryError as Error).message });
          }
        } else {
          failed++;
          errors.push({ code: stock.code, error: (error as Error).message });
          this.logger.warn(`Failed to fetch day candles for ${stock.code}: ${(error as Error).message}`);
        }
      }

      // API 호출 간 딜레이
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }

    this.logger.log(`Bulk collection completed: ${success} success, ${failed} failed`);

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
    await this.kiwoomWebSocket.subscribe(stockCode, ['0B', '0D']);
    return { success: true, stockCode };
  }

  /**
   * 실시간 구독 중지
   */
  async stopRealtime(stockCode: string) {
    this.logger.log(`Stopping realtime subscription for ${stockCode}`);
    await this.kiwoomWebSocket.unsubscribe(stockCode);
    return { success: true, stockCode };
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
  async calculateDailyMetrics(marketType: '0' | '10' | '8' = '0', tradeDate?: string) {
    this.logger.log(`Starting daily metrics calculation for market type: ${marketType}, date: ${tradeDate || 'today'}`);
    const date = tradeDate ? new Date(tradeDate) : undefined;
    return await this.metricsService.calculateAndSaveDailyMetrics(marketType, date);
  }
}
