import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { mapUpNameToThemeCode } from '../../common/constants/theme-codes';
import { isKrxTradingDay } from '../../common/utils/market-calendar.util';

interface StockListCache {
  data: any[];
  timestamp: number;
}

type HigherTimeframeCandleType = 'week' | 'month' | 'year';
export type InvestmentIndicatorType =
  | 'VOLATILITY_CONTRACTION'
  | 'PRICE_COMPRESSION'
  | 'STRENGTH_CONTINUATION'
  | 'TREND_TEMPLATE';

export interface InvestmentIndicator {
  type: InvestmentIndicatorType;
  label: string;
  value?: string;
}

export interface StockDetailSnapshot {
  currentPrice: number;
  prevDayCompare?: number;
  changeRate?: string | number | null;
  volume?: string | number | bigint | null;
  tradingValue?: string | number | bigint | null;
  dayHigh?: number | null;
  dayLow?: number | null;
}

@Injectable()
export class RealTimeChartService implements OnModuleInit {
  private readonly logger = new Logger(RealTimeChartService.name);
  private readonly stockListCache = new Map<string, StockListCache>();
  private readonly trendTemplateFinancialCache = new Map<string, { value: boolean; expiresAt: number }>();
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1?쒓컙 (諛由ъ큹)
  private readonly FINANCIAL_CACHE_TTL = 24 * 60 * 60 * 1000;
  private readonly REALTIME_CANDLE_SAVE_THROTTLE_MS = 30 * 1000;
  private readonly realtimeCandleSavedAt = new Map<string, number>();
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
   * ?쒕쾭 ?쒖옉 ???곗씠??珥덇린??
   * - ?곗씠???놁쓬: 52二?365??移??섏쭛 (?좉퀬媛 ?먮떒??
   * - ?곗씠???덉쓬: 留덉?留??곗씠??~ ?ㅻ뒛源뚯? 怨듬갚留??섏쭛
   */
  async onModuleInit() {
    this.logger.log('Starting data initialization on server startup...');

    // 諛깃렇?쇱슫?쒖뿉??鍮꾨룞湲곕줈 珥덇린???ㅽ뻾 (?쒕쾭 ?쒖옉??釉붾줈?뱁븯吏 ?딆쓬)
    this.initializeData().catch((error) => {
      this.logger.error(`Data initialization failed: ${error.message}`, error.stack);
    });
  }

  @OnEvent('kiwoom.realtime.0B')
  async handleRealtimeCandlePersistence(payload: {
    stockCode: string;
    type: string;
    values: Record<string, string>;
  }): Promise<void> {
    const { stockCode, values } = payload;
    const nowMs = Date.now();
    const lastSavedAt = this.realtimeCandleSavedAt.get(stockCode) ?? 0;
    if (nowMs - lastSavedAt < this.REALTIME_CANDLE_SAVE_THROTTLE_MS) return;
    this.realtimeCandleSavedAt.set(stockCode, nowMs);

    try {
      await this.upsertRealtimeCandles(stockCode, values);
    } catch (error) {
      this.logger.warn(`Realtime candle upsert failed: ${stockCode} - ${(error as Error).message}`);
    }
  }

  private async upsertRealtimeCandles(stockCode: string, values: Record<string, string>): Promise<void> {
    const currentPrice = this.parsePrice(values['10'] || '0');
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

    const openPrice = this.parsePrice(values['16'] || values['10'] || '0') || currentPrice;
    const highPrice = Math.max(this.parsePrice(values['17'] || values['10'] || '0') || currentPrice, currentPrice);
    const lowPrice = Math.min(this.parsePrice(values['18'] || values['10'] || '0') || currentPrice, currentPrice);
    const volume = this.toNonNegativeBigInt(values['13']);
    const tradingValue = this.normalizeTradingValueToWon(values['14']);
    const today = this.todayKstDateOnly();

    await this.chartStorage.saveCandle({
      stockCode,
      candleType: 'day',
      candleTime: today,
      openPrice,
      highPrice,
      lowPrice,
      closePrice: currentPrice,
      volume,
      tradingValue,
      adjOpenPrice: openPrice,
      adjHighPrice: highPrice,
      adjLowPrice: lowPrice,
      adjClosePrice: currentPrice,
    });

    await Promise.all(
      (['week', 'month', 'year'] as const).map((candleType) =>
        this.upsertRealtimeAggregateCandle(stockCode, candleType, today),
      ),
    );
  }

  private async upsertRealtimeAggregateCandle(
    stockCode: string,
    candleType: HigherTimeframeCandleType,
    today: Date,
  ): Promise<void> {
    const periodStart = this.getCurrentStoredPeriodStart(candleType, today);
    const periodEnd = new Date(today);
    periodEnd.setUTCHours(23, 59, 59, 999);

    const dayCandles = await this.chartStorage.getCandles(stockCode, 'day', periodStart, periodEnd);
    if (dayCandles.length === 0) return;

    const oldest = dayCandles[dayCandles.length - 1];
    const latest = dayCandles[0];
    const highPrice = Math.max(...dayCandles.map((c) => Number(c.highPrice)));
    const lowPrice = Math.min(...dayCandles.map((c) => Number(c.lowPrice)));
    const volume = dayCandles.reduce((sum, c) => sum + (c.volume ?? 0n), 0n);
    const tradingValue = dayCandles.reduce(
      (sum, c) => sum + (c.tradingValue ?? 0n),
      0n,
    );
    const openPrice = Number(oldest.openPrice);
    const closePrice = Number(latest.closePrice);

    await this.chartStorage.saveCandle({
      stockCode,
      candleType,
      candleTime: periodStart,
      openPrice,
      highPrice,
      lowPrice,
      closePrice,
      volume,
      tradingValue: tradingValue > 0n ? tradingValue : null,
      adjOpenPrice: openPrice,
      adjHighPrice: highPrice,
      adjLowPrice: lowPrice,
      adjClosePrice: closePrice,
    });
  }

  /**
   * ?곗씠??珥덇린??(?쇰큺 ?섏쭛 + 吏??怨꾩궛)
   * - DB???곗씠?곌? ?놁쑝硫? 52二?365??移??섏쭛
   * - DB???곗씠?곌? ?덉쑝硫? 留덉?留??곗씠???좎쭨 ~ ?ㅻ뒛源뚯? 怨듬갚 湲곌컙留??섏쭛
   */
  async initializeData(marketTypes: ('0' | '10')[] = ['0', '10']) {
    const startTime = Date.now();
    this.logger.log('=== Data Initialization Started ===');

    try {
      // ?꾩옱 ?쒓컙 泥댄겕 (?쒓뎅 ?쒓컙 湲곗?)
      const now = new Date();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      const dayOfWeek = now.getDay();
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // ??湲?

      // DB?먯꽌 留덉?留??쇰큺 ?곗씠???좎쭨 議고쉶
      const lastCandleDate = await this.chartStorage.getLatestDayCandleDate();
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      let daysToFetch: number;
      let shouldSkipCollection = false;

      // ??嫄곕옒??怨꾩궛 (二쇰쭚 ??갑?μ쑝濡?嫄대꼫?)
      const getPrevTradingDay = (): Date => {
        const d = new Date(today);
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) {
          d.setDate(d.getDate() - 1);
        }
        return d;
      };

      // ?섏쭛 湲곗???寃곗젙:
      // - ??留덇컧 ???됱씪 15:30 珥덇낵): ?ㅻ뒛源뚯? ?섏쭛 媛??(?뱀씪 ?쇰큺 ?꾩꽦)
      // - 洹?????以? 媛쒖옣 ?? 二쇰쭚): ??嫄곕옒?쇨퉴吏留??섏쭛 (?뱀씪 誘몄셿???쇰큺 ?쒖쇅)
      const isAfterMarketClose = isWeekday && (currentHour > 15 || (currentHour === 15 && currentMinute > 30));
      const collectionTargetDate = isAfterMarketClose ? today : getPrevTradingDay();

      this.logger.log(
        `Collection mode: ${isAfterMarketClose ? '??留덇컧 ??(?뱀씪 ?ы븿)' : '??以???(?꾩씪源뚯?)'}, target: ${collectionTargetDate.toISOString().split('T')[0]}`,
      );

      if (!lastCandleDate) {
        // ?곗씠?곌? ?놁쑝硫?52二쇱튂 ?섏쭛 (?좉퀬媛 ?먮떒 ?꾩슂)
        daysToFetch = 365;
        this.logger.log('No existing data found. Fetching 52 weeks (365 days)...');
      } else {
        const lastDate = new Date(lastCandleDate);
        lastDate.setUTCHours(0, 0, 0, 0);
        const diffMs = collectionTargetDate.getTime() - lastDate.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          // ?대? 湲곗????곗씠?곌퉴吏 蹂댁쑀 以?
          shouldSkipCollection = true;
          this.logger.log(
            `Data is up to date (last: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}). Skipping collection.`,
          );
        } else {
          // 怨듬갚 ?쇱닔留뚰겮 ?섏쭛 (API媛 嫄곕옒?쇰쭔 諛섑솚?섎?濡?二쇰쭚/怨듯쑕???먮룞 ?쒖쇅)
          daysToFetch = diffDays;
          this.logger.log(
            `Last data: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}, gap: ${diffDays} days. Fetching...`,
          );
        }
      }

      // ?곗씠???섏쭛 (?ㅽ궢?섏? ?딅뒗 寃쎌슦留?
      if (!shouldSkipCollection) {
        // 0. ?쒖옣 吏???쇰큺 ?섏쭛 (KOSPI + KOSDAQ) - RS 怨꾩궛???꾩슂
        this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
        await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
        await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
        // ka20006? ?뱀씪 罹붾뱾 誘명룷??????留덇컧 ?꾩뿉??ka20001濡??ㅻ뒛 醫낃? 蹂꾨룄 ?섏쭛
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
        this.logger.log('Market index day candles collected.');

        for (const marketType of marketTypes) {
          const marketName = marketType === '0' ? 'KOSPI' : 'KOSDAQ';
          this.logger.log(`[${marketName}] Collecting day candles (${daysToFetch} days)...`);

          // 1. ?쇰큺 ?곗씠???섏쭛
          const collectResult = await this.collectAllDayCandles(marketType, daysToFetch);
          this.logger.log(`[${marketName}] Day candles collected: ${collectResult.success}/${collectResult.total}`);
        }
      } else {
        this.logger.log('Data collection skipped (already up to date). Recalculating metrics only...');
        // ?쇰큺 ?섏쭛? ?ㅽ궢?대룄 ?ㅻ뒛 吏??醫낃?????긽 媛깆떊 (ka20006 ?뱀씪 誘명룷??
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
      }

      // metrics 怨꾩궛? ?먯젙 00:05 cron?먯꽌留??ㅽ뻾 (initializeData?먯꽌???쇰큺 ?섏쭛留?
      this.initializationComplete = true;
      this.lastDataUpdate = new Date();

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`=== Data Initialization Completed in ${duration}s ===`);

      // ?꾪꽣 ?듦낵 醫낅ぉ ?꾩껜 WebSocket 援щ룆 (諛깃렇?쇱슫??
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
   * 珥덇린???곹깭 議고쉶
   */
  getInitializationStatus() {
    return {
      initialized: this.initializationComplete,
      lastDataUpdate: this.lastDataUpdate,
    };
  }

  async getAdminDailyMetrics(params: {
    tradeDate?: string;
    marketType?: string;
    page?: number;
    pageSize?: number;
    search?: string;
    passedStaticFilters?: boolean;
    mode?: 'aggregated' | 'raw';
  }) {
    const page = Math.max(1, Number(params.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(params.pageSize) || 50));
    const mode = params.mode || 'aggregated';
    const dateText = params.tradeDate?.replace(/-/g, '');
    const latest = dateText
      ? new Date(`${dateText.slice(0, 4)}-${dateText.slice(4, 6)}-${dateText.slice(6, 8)}T00:00:00.000Z`)
      : await this.metricsService.getLatestTradeDate(params.marketType);

    if (!latest) {
      return { page, pageSize, totalCount: 0, totalPages: 0, tradeDate: null, rows: [], dates: [] };
    }

    const where: any = { tradeDate: latest };
    if (mode === 'aggregated') {
      where.passedStaticFilters = true;
      where.rank = { gt: 0 };
    } else if (params.passedStaticFilters !== undefined) {
      where.passedStaticFilters = params.passedStaticFilters;
    }
    if (params.search?.trim()) where.stockCode = { contains: params.search.trim() };

    const [allRows, dates] = await Promise.all([
      this.prisma.stockDailyMetrics.findMany({
        where,
        orderBy: [{ rank: 'asc' }, { stockCode: 'asc' }],
      }),
      this.prisma.stockDailyMetrics.findMany({
        distinct: ['tradeDate'],
        orderBy: { tradeDate: 'desc' },
        take: 30,
        select: { tradeDate: true },
      }),
    ]);

    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: allRows.map((row) => row.stockCode) } },
      select: { stockCode: true, companyName: true, marketType: true },
    });
    const companyMap = new Map(companies.map((company) => [company.stockCode, company]));
    const marketMatches = (row: typeof allRows[number]) => {
      if (!params.marketType || params.marketType === 'all') return true;
      const company = companyMap.get(row.stockCode);
      return company?.marketType === (params.marketType === '0' ? 'KOSPI' : 'KOSDAQ');
    };
    const passesDynamicFilters = (row: typeof allRows[number]) => {
      if (mode !== 'aggregated') return true;
      if (row.lowPrice52w == null || row.highPrice52w == null || row.ma50 == null) return false;
      const close = Number(row.closePrice);
      return (
        close >= Number(row.lowPrice52w) * 1.3 &&
        close >= Number(row.highPrice52w) * 0.75 &&
        close > Number(row.ma50)
      );
    };
    const filteredRows = allRows
      .filter((row) => marketMatches(row))
      .filter((row) => passesDynamicFilters(row));
    const totalCount = filteredRows.length;
    const rows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
    const movingAverageMap = await this.getAdminMovingAverageMap(
      rows.map((row) => row.stockCode),
      latest,
    );

    return {
      page,
      pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      tradeDate: latest.toISOString().split('T')[0],
      mode,
      dates: dates.map((date) => date.tradeDate.toISOString().split('T')[0]),
      rows: rows.map((row, index) => {
        const company = companyMap.get(row.stockCode);
        const movingAverages = movingAverageMap.get(row.stockCode);
        return {
          metricId: row.metricId,
          stockCode: row.stockCode,
          companyName: company?.companyName || '-',
          marketType: company?.marketType || row.marketType,
          rank: mode === 'aggregated' ? (page - 1) * pageSize + index + 1 : row.rank,
          storedRank: row.rank,
          closePrice: Number(row.closePrice),
          relativeStrengthScore: Number(row.relativeStrengthScore),
          isNewHigh: row.isNewHigh,
          highPrice52w: row.highPrice52w ? Number(row.highPrice52w) : null,
          lowPrice52w: row.lowPrice52w ? Number(row.lowPrice52w) : null,
          priceChange1d: row.priceChange1d ? Number(row.priceChange1d) : null,
          priceChangeRate1d: row.priceChangeRate1d ? Number(row.priceChangeRate1d) : null,
          volume1d: row.volume1d?.toString() || null,
          tradingValue: row.tradingValue?.toString() || null,
          ma50: row.ma50 ? Number(row.ma50) : null,
          ma150: movingAverages?.ma150 ?? null,
          ma200: movingAverages?.ma200 ?? null,
          ma200Uptrend: movingAverages?.ma200Uptrend ?? null,
          passedStaticFilters: row.passedStaticFilters,
          isVolatilityContraction: row.isVolatilityContraction,
          isPriceCompression: row.isPriceCompression,
          isTrendTemplate: row.isTrendTemplate,
          strengthContinuationDays: row.strengthContinuationDays,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };
      }),
    };
  }

  private async getAdminMovingAverageMap(stockCodes: string[], tradeDate: Date): Promise<Map<string, {
    ma150: number | null;
    ma200: number | null;
    ma200Uptrend: boolean | null;
  }>> {
    const result = new Map<string, { ma150: number | null; ma200: number | null; ma200Uptrend: boolean | null }>();
    if (stockCodes.length === 0) return result;

    const from = new Date(tradeDate);
    from.setUTCDate(from.getUTCDate() - 420);

    const candles = await this.prisma.stockCandle.findMany({
      where: {
        stockCode: { in: stockCodes },
        candleType: 'day',
        candleTime: { gte: from, lte: tradeDate },
      },
      orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      select: {
        stockCode: true,
        candleTime: true,
        closePrice: true,
        adjClosePrice: true,
        volume: true,
      },
    });

    const candlesByStock = new Map<string, typeof candles>();
    for (const candle of candles) {
      if (!isKrxTradingDay(candle.candleTime) || candle.volume <= 0n) continue;
      if (!candlesByStock.has(candle.stockCode)) candlesByStock.set(candle.stockCode, []);
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    const average = (items: typeof candles) =>
      items.reduce((sum, candle) => {
        const price = (candle.adjClosePrice ?? candle.closePrice).toNumber();
        return sum + price;
      }, 0) / items.length;

    for (const stockCode of stockCodes) {
      const stockCandles = candlesByStock.get(stockCode) ?? [];
      const ma150Slice = stockCandles.slice(-150);
      const ma200Slice = stockCandles.slice(-200);
      const ma150 = ma150Slice.length >= 150 ? average(ma150Slice) : null;
      const ma200 = ma200Slice.length >= 200 ? average(ma200Slice) : null;
      const ma200Uptrend = (() => {
        if (stockCandles.length < 220) return null;
        let prev = -Infinity;
        for (let i = 20; i >= 0; i--) {
          const slice = stockCandles.slice(-200 - i, i === 0 ? undefined : -i);
          const ma = average(slice);
          if (ma <= prev) return false;
          prev = ma;
        }
        return true;
      })();
      result.set(stockCode, { ma150, ma200, ma200Uptrend });
    }

    return result;
  }

  /**
   * ?ㅼ떆媛?WebSocket ?곌껐 ?곹깭 議고쉶
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
        stockCodes: subscribedStocks.slice(0, 20), // 理쒕? 20媛쒕쭔 ?쒖떆
      },
      cache: cacheStats,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * ?ㅼ떆媛??곗씠???뚯뒪 ?곌껐 蹂댁옣
   * (?μ떆???쒓컙??WebSocket ?곌껐 ?뺤씤 諛??ъ뿰寃?
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
   * 遺꾨큺 李⑦듃 ?곗씠??議고쉶 (怨쇨굅 ?곗씠??
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
   * ??李⑦듃 ?곗씠??議고쉶
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
   * ?쇰큺 李⑦듃 ?곗씠??議고쉶 諛????
   */
  async getDayCandles(stockCode: string, baseDate: string, saveToDb = false, days = 7) {
    // this.logger.log(`Getting day candles for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getDayCandles(stockCode, baseDate);

    // 理쒓렐 N?쇰쭔 ?꾪꽣留?
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

    // DB?????
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
        // kiwoom getDayCandles??upd_stkpc_tp='1'(?섏젙二쇨?)濡??붿껌?섎?濡?adj 而щ읆?먮룄 ?숈씪媛????
        adjOpenPrice: this.parsePrice(item.open_pric),
        adjHighPrice: this.parsePrice(item.high_pric),
        adjLowPrice: this.parsePrice(item.low_pric),
        adjClosePrice: this.parsePrice(item.cur_prc),
      }));

      await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
      this.logger.debug(`Saved ${candlesToSave.length} day candles for ${stockCode}`);
    }

    return {
      stockCode,
      candles,
    };
  }

  async getDayCandlesDetail(stockCode: string, baseDate: string, adjustedPrice: '0' | '1' = '1') {
    this.logger.log(`Getting day candles (detail) for ${stockCode} from ${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getDayCandlesWithHistory(stockCode, baseDate, 750, adjustedPrice);

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

  async saveWeekCandles(stockCode: string, baseDate: string) {
    const kiwoomData = await this.kiwoomRest.getWeekCandles(stockCode, baseDate);
    return await this.saveHigherTimeframeCandles(stockCode, 'week', kiwoomData.stk_stk_pole_chart_qry);
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

  async saveMonthCandles(stockCode: string, baseDate: string) {
    const kiwoomData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);
    return await this.saveHigherTimeframeCandles(stockCode, 'month', kiwoomData.stk_mth_pole_chart_qry);
  }

  async getYearCandles(stockCode: string, baseDate: string) {
    this.logger.log(`Getting year candles for ${stockCode} from monthly candles, baseDate=${baseDate}`);

    const kiwoomData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);
    const yearCandles = this.aggregateYearCandlesFromItems(kiwoomData.stk_mth_pole_chart_qry);

    const candles = yearCandles.map((item) => ({
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

  async saveYearCandles(stockCode: string, baseDate: string) {
    const kiwoomData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);
    const yearCandles = this.aggregateYearCandlesFromItems(kiwoomData.stk_mth_pole_chart_qry);
    return await this.saveHigherTimeframeCandles(stockCode, 'year', yearCandles);
  }

  /**
   * 醫낅ぉ ?곸꽭 ?붿빟 (?꾩옱媛, ?꾩씪?鍮? 嫄곕옒?? 嫄곕옒?湲? 1??怨좎?, 52二?怨좎?)
   */
  async getStockSummary(stockCode: string) {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

    // 1. ?ㅼ? ?쇰큺 API ???ㅻ뒛 ?꾩옱媛/嫄곕옒??怨좎?/?꾩씪?鍮?
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

    const [company, basicInfo] = await Promise.all([
      this.prisma.company.findFirst({
        where: { stockCode, deletedAt: null },
        select: { listedShares: true },
      }),
      this.kiwoomRest.getStockBasicInfo(stockCode).catch((error) => {
        this.logger.warn(`Kiwoom market cap unavailable for ${stockCode}: ${error.message}`);
        return null;
      }),
    ]);
    const listedShares = company?.listedShares ?? null;
    const kiwoomMarketCap = this.extractKiwoomMarketCap(basicInfo);
    const marketCap = kiwoomMarketCap;

    // 2. DB ????쇰큺 ??52二?怨좎? 怨꾩궛
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
      listedShares: listedShares ? Number(listedShares) : null,
      marketCap,
      marketCapSource: marketCap != null ? 'kiwoom' : null,
      dayHigh: this.parsePrice(latest.high_pric),
      dayLow: this.parsePrice(latest.low_pric),
      week52High,
      week52Low,
    };
  }

  /**
   * 醫낅ぉ 由ъ뒪??議고쉶 (?꾨줎?몄뿏???명꽣?섏씠?ㅼ뿉 留욎떠?? ?섏씠吏?ㅼ씠??吏?? 罹먯떛, ?꾪꽣留?
   *
   * @param rsPeriods - RS 怨꾩궛 湲곌컙 (?? "63,126,252"), ?놁쑝硫??뷀뤃??RS(63?? ?ъ슜
   * @param rsWeights - RS 媛以묒튂 (?? "50,30,20"), rsPeriods? ?④퍡 ?ъ슜
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

    // rsDates媛 ?덉쑝硫??좎쭨瑜??쇱닔濡?蹂??
    let calculatedPeriods = rsPeriods;
    if (rsDates && rsWeights) {
      calculatedPeriods = this.convertDatesToPeriods(rsDates);
      this.logger.log(`Converted dates ${rsDates} to periods: ${calculatedPeriods}`);
    }

    // 而ㅼ뒪? RS ?붿껌??寃쎌슦 ?고???怨꾩궛
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

    // ?뷀뤃??RS(63?? - 湲곗〈 濡쒖쭅

    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    // 理쒖떊 吏???곗씠??議고쉶 (紐⑤뱺 醫낅ぉ)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // ?ㅼ떆媛?罹먯떆?먯꽌 ?꾩껜 醫낅ぉ ?꾩옱媛 議고쉶 (?몃찓紐⑤━, 鍮좊쫫)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 醫낅ぉ 由ъ뒪?몄? 吏??蹂묓빀 諛??꾪꽣留?
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
        // ?뺤쟻 ?꾪꽣 ?듦낵 ?щ? (?λ쭏媛???怨꾩궛, DB ???
        if (!item.metrics?.passedStaticFilters) return false;

        // ?숈쟻 ?꾪꽣: ?꾩옱媛 湲곗? ?ㅼ떆媛??곸슜 (?ㅼ떆媛?媛寃??곗꽑, ?놁쑝硫?醫낃?)
        const realtimePrice = this.getUsableRealtimePrice(allRealtimePrices.get(item.stock.code));
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics.lowPrice52w;
        const high52w = item.metrics.highPrice52w;
        const ma50 = item.metrics.ma50;

        // DF1: ?꾩옱媛 >= 52二쇱? 횞 1.3
        if (low52w != null && currentPrice < low52w * 1.3) return false;
        // DF2: ?꾩옱媛 >= 52二쇨퀬 횞 0.75
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        // DF3: ?꾩옱媛 > MA50
        if (ma50 != null && currentPrice <= ma50) return false;

        // ?좉퀬媛 ?꾪꽣
        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        // 理쒖냼 嫄곕옒?湲??꾪꽣
        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // ?뚮쭏 ?꾪꽣
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // 1李? rank ?ㅻ쫫李⑥닚 (??? ?쒖쐞媛 癒쇱?)
        const rankDiff = (a.metrics?.rank || 999999) - (b.metrics?.rank || 999999);
        if (rankDiff !== 0) return rankDiff;
        // 2李? rsScore ?대┝李⑥닚 (?숈씪 ?쒖쐞???먯닔 ?믪?寃?癒쇱?)
        return b.rsScore - a.rsScore;
      });

    // ?뺣젹 ???섏씠吏?ㅼ씠??
    const totalCount = stocksWithMetrics.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithMetrics.slice(startIndex, endIndex);

    // ?섏씠吏?ㅼ씠?섎맂 醫낅ぉ?ㅼ쓽 醫낃? 諛??쒖쐞 蹂??議고쉶
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    // ?먮룞 ?ㅼ떆媛?援щ룆 (諛깃렇?쇱슫?쒖뿉??鍮꾨룞湲??ㅽ뻾)
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // ?ㅼ떆媛??꾩옱媛 (?대? allRealtimePrices???덉쓬)
    const realtimePrices = allRealtimePrices;

    const rankingHistories = await Promise.all(
      pageStockCodes.map(async (code) => ({
        code,
        history: await this.metricsService.getRankingHistory(code, 4), // ?ㅻ뒛 + D-1 + D-2 + D-3
      })),
    );
    const rankingMap = new Map(rankingHistories.map((r) => [r.code, r.history]));

    // 理쒖떊 嫄곕옒??議고쉶 (硫뷀??곗씠?곗슜)
    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const themeList = await this.getNaverThemeList();
    return {
      marketType,
      page,
      pageSize,
      totalCount,
      totalPages,
      count: paginatedData.length,
      // 硫뷀??곗씠?? ?곗씠??湲곗???諛?媛깆떊 ?뺣낫
      meta: {
        dataDate: latestTradeDate?.toISOString().split('T')[0] || null, // ?곗씠??湲곗? 嫄곕옒??
        lastUpdatedAt: this.lastDataUpdate?.toISOString() || null, // 留덉?留??곗씠??媛깆떊 ?쒓컙
        isInitialized: this.initializationComplete, // 珥덇린???꾨즺 ?щ?
        queryStartDate: latestTradeDate ? (() => { const d = new Date(latestTradeDate); d.setDate(d.getDate() - Math.round(63 * 1.5)); return d.toISOString().split('T')[0]; })() : null,
        queryEndDate: latestTradeDate?.toISOString().split('T')[0] || null,
      },
      themeList,
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = rankingMap.get(s.code) || [];

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = await this.buildInvestmentIndicators(s.code, metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? 'KOSPI' : this.isKosdaqStock(s) ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number((metrics?.relativeStrengthScore || 0).toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          priceChangeRateText,
          investmentIndicators: priceChangeRateText,
          investmentIndicatorItems: investmentIndicators,
          investmentIndicatorsDtl: investmentIndicatorsText,
          theme: displayTheme,
          upName: displayTheme,
          themeFull: naverThemeText || s.upName || '-',
          themes: naverThemes,
          rankHistory: {
            today: rankHistory[0] || null,
            oneDayAgo: rankHistory[1] || null,
            twoDaysAgo: rankHistory[2] || null,
            threeDaysAgo: rankHistory[3] || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 而ㅼ뒪? RS ?ㅼ젙?쇰줈 醫낅ぉ 由ъ뒪??議고쉶 (?고???怨꾩궛)
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

    // RS ?뚮씪誘명꽣 ?뚯떛
    const periods = rsPeriods?.split(',').map((p) => parseInt(p.trim())) || [63];
    const weights = rsWeights?.split(',').map((w) => parseFloat(w.trim())) || [100];

    if (periods.length !== weights.length) {
      throw new Error('RS periods and weights must have the same length');
    }

    // 醫낅ぉ 由ъ뒪??媛?몄삤湲?(罹먯떆 or API)
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    // ?고???RS 怨꾩궛 (理쒓렐 4媛?嫄곕옒?? ?뱀씪, D-1, D-2, D-3)
    let rsHistoryMap: Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>;

    if (marketType === 'all') {
      // ?꾩껜 議고쉶: KOSPI/KOSDAQ 媛곴컖 ?대떦 吏?섎줈 RS 怨꾩궛 ???⑹튂湲?
      const kospiStocks = validStocks.filter((s) => this.isKospiStock(s)).map((s) => s.code);
      const kosdaqStocks = validStocks.filter((s) => this.isKosdaqStock(s)).map((s) => s.code);

      this.logger.log(`Split stocks for custom RS: KOSPI=${kospiStocks.length}, KOSDAQ=${kosdaqStocks.length}`);

      const [kospiRS, kosdaqRS] = await Promise.all([
        kospiStocks.length > 0
          ? this.metricsService.calculateRuntimeRS(kospiStocks, periods, weights, 'INDEX_KOSPI', 4)
          : new Map(),
        kosdaqStocks.length > 0
          ? this.metricsService.calculateRuntimeRS(kosdaqStocks, periods, weights, 'INDEX_KOSDAQ', 4)
          : new Map(),
      ]);

      // ??寃곌낵 ?⑹튂湲?
      rsHistoryMap = new Map([...kospiRS, ...kosdaqRS]);
    } else {
      // ?⑥씪 ?쒖옣 議고쉶
      const indexCode = marketType === '0' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
      rsHistoryMap = await this.metricsService.calculateRuntimeRS(
        allStockCodes,
        periods,
        weights,
        indexCode,
        4,
      );
    }

    // 湲곕낯 吏???곗씠??議고쉶 (ma50, 52w 怨좎?, isNewHigh, tradingValue ??
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // ?ㅼ떆媛?罹먯떆?먯꽌 ?꾩껜 醫낅ぉ ?꾩옱媛 議고쉶 (?몃찓紐⑤━, 鍮좊쫫)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 醫낅ぉ 由ъ뒪?몄? RS 蹂묓빀 諛??꾪꽣留?
    const stocksWithRS = validStocks
      .map((s) => {
        const rsHistory = rsHistoryMap.get(s.code);
        const metrics = metricsMap.get(s.code);

        // ?뱀씪 (泥?踰덉㎏) RS? ??겕
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
        // 湲곕낯 ?꾪꽣: ?뺤쟻 ?꾪꽣 ?듦낵 醫낅ぉ (calculateRuntimeRS?먯꽌 ?대? SF1~SF5 ?곸슜)
        if (item.rsScore <= 0) return false;

        // ?숈쟻 ?꾪꽣: ?꾩옱媛 湲곗? ?ㅼ떆媛??곸슜
        const realtimePrice = this.getUsableRealtimePrice(allRealtimePrices.get(item.stock.code));
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics?.lowPrice52w;
        const high52w = item.metrics?.highPrice52w;
        const ma50 = item.metrics?.ma50;

        if (low52w != null && currentPrice < low52w * 1.3) return false;
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        if (ma50 != null && currentPrice <= ma50) return false;

        // ?좉퀬媛 ?꾪꽣
        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        // 理쒖냼 嫄곕옒?湲??꾪꽣
        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // ?뚮쭏 ?꾪꽣
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank); // ??겕 ?ㅻ쫫李⑥닚 (?대? 怨꾩궛??

    // ?섏씠吏?ㅼ씠??
    const totalCount = stocksWithRS.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithRS.slice(startIndex, endIndex);

    // ?섏씠吏?ㅼ씠?섎맂 醫낅ぉ?ㅼ쓽 醫낃? 議고쉶
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    // ?먮룞 ?ㅼ떆媛?援щ룆
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // ?ㅼ떆媛??꾩옱媛 (?대? allRealtimePrices???덉쓬)
    const realtimePrices = allRealtimePrices;

    // 理쒖떊 嫄곕옒??議고쉶
    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const shouldWriteCustomRsLog =
      !(periods.length === 1 && periods[0] === 63 && weights.length === 1 && weights[0] === 100);
    if (shouldWriteCustomRsLog) {
      const tradeDateForLog = latestTradeDate
        ? latestTradeDate.toISOString().split('T')[0].replace(/-/g, '')
        : undefined;
      this.metricsService
        .calculateRsFilterLog(allStockCodes, tradeDateForLog, periods.join(','), weights.join(','))
        .then((result) => {
          this.logger.log(`Custom RS filter log created: ${result.logFile} (passed=${result.passed})`);
        })
        .catch((error) => {
          this.logger.warn(`Custom RS filter log failed: ${(error as Error).message}`);
        });
    }

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
      themeList: await this.getNaverThemeList(),
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = await this.buildInvestmentIndicators(s.code, metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? 'KOSPI' : this.isKosdaqStock(s) ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          priceChangeRateText,
          investmentIndicators: priceChangeRateText,
          investmentIndicatorItems: investmentIndicators,
          investmentIndicatorsDtl: investmentIndicatorsText,
          theme: displayTheme,
          upName: displayTheme,
          themeFull: naverThemeText || s.upName || '-',
          themes: naverThemes,
          rankHistory: {
            today: rankHistory[0]?.rank || null,
            oneDayAgo: rankHistory[1]?.rank || null,
            twoDaysAgo: rankHistory[2]?.rank || null,
            threeDaysAgo: rankHistory[3]?.rank || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 醫낅ぉ 由ъ뒪??議고쉶 (湲곌컙 湲곕컲 RS ?꾪꽣)
   * rsFilters 諛곗뿴??諛쏆븘??媛?湲곌컙??RS瑜?怨꾩궛?섍퀬 媛以묒튂瑜??곸슜
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

    // rsFilters媛 ?놁쑝硫?湲곕낯 濡쒖쭅 ?ъ슜
    if (!rsFilters || rsFilters.length === 0) {
      return this.getStockList(marketType, page, pageSize, filters);
    }

    // 醫낅ぉ 由ъ뒪??媛?몄삤湲?
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const periods = await this.metricsService.resolveTradingPeriodsFromRanges(rsFilters, 'INDEX_KOSPI');
    const weights = rsFilters.map((filter) => filter.strength);
    const tradeDateForLog = latestTradeDate
      ? latestTradeDate.toISOString().split('T')[0].replace(/-/g, '')
      : undefined;
    const rsFilterResult = await this.metricsService.calculateRsFilterLog(
      allStockCodes,
      tradeDateForLog,
      periods.join(','),
      weights.join(','),
    );

    this.logger.log(`Converted range filters to periods: ${periods}, weights: ${weights}`);

    const rsHistoryMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();
    for (const row of rsFilterResult.rows) {
      rsHistoryMap.set(row.stockCode, [{
        tradeDate: latestTradeDate ?? new Date(),
        rank: row.rank,
        rsScore: row.rsScore,
      }]);
    }

    // 湲곕낯 吏???곗씠??議고쉶 (ma50, 52w 怨좎?, isNewHigh, tradingValue ??
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // ?ㅼ떆媛?罹먯떆?먯꽌 ?꾩껜 醫낅ぉ ?꾩옱媛 議고쉶 (?몃찓紐⑤━, 鍮좊쫫)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 醫낅ぉ 由ъ뒪?몄? RS 蹂묓빀 諛??꾪꽣留?
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
        // 湲곕낯 ?꾪꽣: ?뺤쟻 ?꾪꽣 ?듦낵 醫낅ぉ (calculateRangeRS?먯꽌 ?대? SF1~SF5 ?곸슜)
        if (item.rsScore <= 0) return false;

        if (filters?.isHighPrice !== undefined) {
          if (item.metrics?.isNewHigh !== filters.isHighPrice) return false;
        }

        if (filters?.minTradingValue !== undefined) {
          const tradingValue = item.metrics?.tradingValue || 0;
          if (tradingValue < filters.minTradingValue) return false;
        }

        // ?뚮쭏 ?꾪꽣
        if (filters?.theme) {
          const stockTheme = item.stock.upName || '';
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank);

    // ?섏씠吏?ㅼ씠??
    const totalCount = stocksWithRS.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = stocksWithRS.slice(startIndex, endIndex);

    // 醫낃? 諛??ㅼ떆媛?媛寃?議고쉶
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    const realtimePrices = allRealtimePrices;
    const themeList = await this.getNaverThemeList();

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
        rangeRS: { filters: rsFilters, periods, weights, logFile: rsFilterResult.logFile },
      },
      themeList,
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const rankHistory = item.rankHistory;

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = await this.buildInvestmentIndicators(s.code, metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: startIndex + index + 1,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? 'KOSPI' : this.isKosdaqStock(s) ? 'KOSDAQ' : s.marketName,
          relativeStrengthScore: Number(item.rsScore.toFixed(4)),
          isHighPrice: metrics?.isNewHigh || false,
          priceChangeRateText,
          investmentIndicators: priceChangeRateText,
          investmentIndicatorItems: investmentIndicators,
          investmentIndicatorsDtl: investmentIndicatorsText,
          theme: displayTheme,
          upName: displayTheme,
          themeFull: naverThemeText || s.upName || '-',
          themes: naverThemes,
          rankHistory: {
            today: rankHistory[0]?.rank || null,
            oneDayAgo: rankHistory[1]?.rank || null,
            twoDaysAgo: rankHistory[2]?.rank || null,
            threeDaysAgo: rankHistory[3]?.rank || null,
          },
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 醫낅ぉ 由ъ뒪??媛?몄삤湲?(罹먯떆 ?ъ슜)
   * 'all'??寃쎌슦 KOSPI + KOSDAQ 紐⑤몢 媛?몄???蹂묓빀
   *
   * marketType ?뺤쓽:
   *   '0'   = KOSPI (?ㅼ? API 洹몃?濡?
   *   '10'  = KOSDAQ (?ㅼ? API 洹몃?濡?
   *   'all' = ?꾩껜 (KOSPI + KOSDAQ 蹂묓빀)
   */
  private getUsableRealtimePrice(realtimePrice: any): any | undefined {
    if (!realtimePrice) return undefined;

    const now = new Date();
    const nowKst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const day = nowKst.getUTCDay();
    const minutes = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    const isWeekday = day >= 1 && day <= 5;
    const isMarketSession = isWeekday && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
    if (!isMarketSession) return undefined;

    const timestamp = new Date(realtimePrice.timestamp);
    if (Number.isNaN(timestamp.getTime())) return undefined;

    const timestampKst = new Date(timestamp.getTime() + 9 * 60 * 60 * 1000);
    const sameKstDate = nowKst.toISOString().slice(0, 10) === timestampKst.toISOString().slice(0, 10);
    const isFresh = now.getTime() - timestamp.getTime() <= 10 * 60 * 1000;
    return sameKstDate && isFresh ? realtimePrice : undefined;
  }

  private formatPriceChangeRateText(realtimePrice: any, metrics: any): string {
    if (realtimePrice) {
      const rate = realtimePrice.openPrice > 0
        ? ((realtimePrice.currentPrice - realtimePrice.openPrice) / realtimePrice.openPrice) * 100
        : realtimePrice.changeRate;
      return `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`;
    }
    if (metrics?.priceChangeRate1d != null) {
      const rate = Number(metrics.priceChangeRate1d);
      return `${rate > 0 ? '+' : ''}${rate.toFixed(2)}%`;
    }
    return '-';
  }

  private formatInvestmentIndicators(indicators: InvestmentIndicator[]): string {
    return indicators
      .map((indicator) => (indicator.value ? `${indicator.label} ${indicator.value}` : indicator.label))
      .join(', ') || '-';
  }

  private async buildInvestmentIndicators(stockCode: string, metrics: any): Promise<InvestmentIndicator[]> {
    const indicators: InvestmentIndicator[] = [];
    if (!metrics) return indicators;

    if (metrics.isVolatilityContraction) {
      indicators.push({ type: 'VOLATILITY_CONTRACTION', label: '蹂?숈꽦 異뺤냼' });
    }
    if (metrics.isPriceCompression) {
      indicators.push({ type: 'PRICE_COMPRESSION', label: '媛寃??뺤텞' });
    }
    if (metrics.strengthContinuationDays != null && metrics.strengthContinuationDays > 0) {
      indicators.push({
        type: 'STRENGTH_CONTINUATION',
        label: '강도 지속',
        value: `${metrics.strengthContinuationDays}/10`,
      });
    }
    if (metrics.isTrendTemplate && await this.hasTrendTemplateFundamentals(stockCode)) {
      indicators.push({ type: 'TREND_TEMPLATE', label: '트렌드 템플릿' });
    }

    return indicators;
  }

  private async hasTrendTemplateFundamentals(stockCode: string): Promise<boolean> {
    const cached = this.trendTemplateFinancialCache.get(stockCode);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;

    let value = false;
    try {
      const basicInfo = await this.kiwoomRest.getStockBasicInfo(stockCode);
      const eps = this.parseNullableNumber(basicInfo.eps);
      const roe = this.parseNullableNumber(basicInfo.roe);

      // ka10001 provides vendor EPS/ROE snapshots, not historical EPS growth or quarterly YoY.
      // Use it as the realtime-list financial gate: positive EPS and ROE >= 15%.
      value = eps != null && eps > 0 && roe != null && roe >= 15;
    } catch (error) {
      this.logger.debug(`Trend template fundamentals unavailable for ${stockCode}: ${(error as Error).message}`);
    }

    this.trendTemplateFinancialCache.set(stockCode, { value, expiresAt: now + this.FINANCIAL_CACHE_TTL });
    return value;
  }

  private parseNullableNumber(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    const normalized = String(value).replace(/,/g, '').replace(/%/g, '').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private extractKiwoomMarketCap(data: any): number | null {
    if (!data) return null;

    const raw =
      data.mac ??
      data.marketCap ??
      data.market_cap ??
      data.mkt_cap ??
      data.mrkt_cap ??
      data.stk_mkt_cap;

    const parsed = this.parseMarketCapNumber(raw);
    if (parsed == null) return null;

    // Kiwoom ka10001 usually returns market cap in eok-won units.
    return parsed * 100_000_000;
  }

  private parseMarketCapNumber(value?: string | number | null): number | null {
    if (value == null || value === '') return null;
    const parsed = Number(String(value).replace(/[,+\s]/g, ''));
    if (!Number.isFinite(parsed)) return null;
    return Math.abs(parsed);
  }

  private async fetchStockList(marketType: '0' | '10' | 'all'): Promise<any[]> {
    const cached = this.stockListCache.get(marketType);
    const now = Date.now();

    if (cached && (now - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }

    let validStocks: any[];

    try {
      if (marketType === 'all') {
        const [kospiResult, kosdaqResult] = await Promise.all([
          this.kiwoomRest.getStockList('0'),
          this.kiwoomRest.getStockList('10'),
        ]);
        const allList = [...kospiResult.list, ...kosdaqResult.list];
        validStocks = allList.filter(
          (s: any) => s.code.match(/^\d{6}$/) && !s.code.endsWith('5') && !this.isHaltedState(s.state),
        );
      } else {
        const result = await this.kiwoomRest.getStockList(marketType);
        validStocks = result.list.filter(
          (s: any) => s.code.match(/^\d{6}$/) && !s.code.endsWith('5') && !this.isHaltedState(s.state),
        );
      }
    } catch (error) {
      this.logger.warn(
        `Kiwoom stock list unavailable for marketType=${marketType}. Falling back to DB metrics/company data: ${(error as Error).message}`,
      );
      validStocks = await this.fetchStockListFromDatabase(marketType);
    }

    this.stockListCache.set(marketType, { data: validStocks, timestamp: now });
    return validStocks;
  }

  private async fetchStockListFromDatabase(marketType: '0' | '10' | 'all'): Promise<any[]> {
    const latestTradeDate = await this.metricsService.getLatestTradeDate(
      marketType === 'all' ? undefined : marketType,
    );

    if (!latestTradeDate) {
      this.logger.warn(`No latest metrics date found for DB stock list fallback. marketType=${marketType}`);
      return [];
    }

    const where: any = { tradeDate: latestTradeDate };
    if (marketType !== 'all') where.marketType = marketType;

    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where,
      orderBy: [{ marketType: 'asc' }, { rank: 'asc' }],
      select: { stockCode: true, marketType: true },
    });

    const stockCodes = metrics.map((m) => m.stockCode);
    if (stockCodes.length === 0) return [];

    const companies = await this.prisma.company.findMany({
      where: {
        stockCode: { in: stockCodes },
        deletedAt: null,
        NOT: { tradingState: { contains: '?뺤?' } },
      },
      select: {
        stockCode: true,
        companyName: true,
        marketType: true,
        tradingState: true,
        theme: { select: { themeName: true } },
      },
    });
    const companyMap = new Map(companies.map((c) => [c.stockCode, c]));

    return metrics
      .filter((m) => m.stockCode.match(/^\d{6}$/) && !m.stockCode.endsWith('5') && companyMap.has(m.stockCode))
      .map((m) => {
        const company = companyMap.get(m.stockCode);
        const normalizedMarketType = this.normalizeDbMarketType(String(company?.marketType ?? m.marketType));
        return {
          code: m.stockCode,
          name: company?.companyName ?? m.stockCode,
          marketType: normalizedMarketType,
          marketName: normalizedMarketType,
          upName: company?.theme?.themeName ?? '',
        };
      });
  }

  private isHaltedState(state?: string): boolean {
    if (!state) return false;
    return state.includes('?뺤?');
  }

  private normalizeTradingState(state?: string | null): string | null {
    if (!state) return null;

    const normalized = state.trim();
    if (!normalized) return null;

    if (this.isHaltedState(normalized)) {
      return '嫄곕옒?뺤?';
    }

    return normalized.slice(0, 20);
  }

  async syncTradingStates(stocks?: any[]): Promise<void> {
    if (!stocks) {
      const [kospi, kosdaq] = await Promise.all([
        this.kiwoomRest.getStockList('0'),
        this.kiwoomRest.getStockList('10'),
      ]);
      stocks = [...kospi.list, ...kosdaq.list];
    }

    const haltedStocks = stocks.filter((s) => this.isHaltedState(s.state));
    if (haltedStocks.length > 0) {
      this.logger.log(
        `[syncTradingStates] 嫄곕옒?뺤? 醫낅ぉ ${haltedStocks.length}媛? ${haltedStocks.map((s) => `${s.code}(${s.state})`).join(', ')}`,
      );
    }

    const uniqueStocks = stocks.filter((s) => s.code?.match(/^\d{6}$/));
    await Promise.all(
      uniqueStocks.map((s) =>
        this.prisma.company.updateMany({
          where: { stockCode: s.code, deletedAt: null },
          data: { tradingState: this.normalizeTradingState(s.state) },
        }),
      ),
    );

    this.clearStockListCache();
    this.logger.log(`[syncTradingStates] ${uniqueStocks.length}媛?醫낅ぉ tradingState ?낅뜲?댄듃 ?꾨즺`);
  }

  private normalizeDbMarketType(marketType?: string): 'KOSPI' | 'KOSDAQ' | string {
    if (marketType === '0' || marketType === 'KOSPI') return 'KOSPI';
    if (marketType === '10' || marketType === 'KOSDAQ') return 'KOSDAQ';
    return marketType ?? '';
  }

  private isKospiStock(stock: any): boolean {
    return stock?.marketType === 'KOSPI' || stock?.marketType === '0' || stock?.marketName === 'KOSPI';
  }

  private isKosdaqStock(stock: any): boolean {
    return stock?.marketType === 'KOSDAQ' || stock?.marketType === '10' || stock?.marketName === 'KOSDAQ';
  }

  /**
   * 醫낅ぉ 由ъ뒪??罹먯떆 臾댄슚??
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
   * ?좎쭨 臾몄옄?댁쓣 ?ㅻ뒛濡쒕???硫곗튌 ?꾩씤吏 怨꾩궛?섏뿬 ?쇱닔濡?蹂??
   * @param rsDates ?쇳몴濡?援щ텇???좎쭨 臾몄옄??(?? "2026-02-09,2026-01-15" ?먮뒗 "20260209,20260115")
   * @returns ?쇳몴濡?援щ텇???쇱닔 臾몄옄??(?? "1,26")
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

  private parseRsDate(dateStr: string): Date | null {
    const trimmed = dateStr.trim();
    const date = trimmed.includes('-')
      ? new Date(trimmed)
      : trimmed.length === 8
        ? new Date(`${trimmed.substring(0, 4)}-${trimmed.substring(4, 6)}-${trimmed.substring(6, 8)}`)
        : null;
    if (!date || Number.isNaN(date.getTime())) return null;
    date.setHours(0, 0, 0, 0);
    return date;
  }

  private getDateRangeDays(startDateStr: string, endDateStr: string): number {
    const startDate = this.parseRsDate(startDateStr);
    const endDate = this.parseRsDate(endDateStr);
    if (!startDate || !endDate) return 63;
    const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * ?⑥씪 ?좎쭨 臾몄옄?댁쓣 ?ㅻ뒛濡쒕???硫곗튌 ?꾩씤吏 怨꾩궛
   * @param dateStr ?좎쭨 臾몄옄??(?? "2026-02-09" ?먮뒗 "20260209")
   * @returns ?ㅻ뒛濡쒕???硫곗튌 ?꾩씤吏 (?? 1)
   */
  private convertSingleDateToDays(dateStr: string): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // ?좎쭨 ?뺤떇 ?뚯떛: "2026-02-09" ?먮뒗 "20260209"
    let date: Date;
    if (dateStr.includes('-')) {
      // "2026-02-09" ?뺤떇
      date = new Date(dateStr);
    } else if (dateStr.length === 8) {
      // "20260209" ?뺤떇
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      date = new Date(`${year}-${month}-${day}`);
    } else {
      this.logger.warn(`Invalid date format: ${dateStr}, using 63 as default`);
      return 63;
    }

    // ?좎쭨 ?좏슚??寃??
    if (isNaN(date.getTime())) {
      this.logger.warn(`Invalid date: ${dateStr}, using 63 as default`);
      return 63;
    }

    date.setHours(0, 0, 0, 0);

    // ?ㅻ뒛濡쒕???硫곗튌 ?꾩씤吏 怨꾩궛
    const diffMs = today.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    this.logger.log(`Date ${dateStr} is ${diffDays} days ago from today`);

    // ?뚯닔?닿굅??0?대㈃ 湲곕낯媛??ъ슜
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * ?붾쾭洹? 醫낅ぉ 由ъ뒪??Raw 議고쉶 (?꾪꽣 ?놁쓬)
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
   * ?뚮쭏 留ㅼ묶 ?⑥닔
   * @param stockUpName 醫낅ぉ???낆쥌紐?(?ㅼ? API upName)
   * @param themeFilters ?꾪꽣留곹븷 ?뚮쭏 肄붾뱶 諛곗뿴 (?レ옄 諛곗뿴, ?? [101, 102, 302] = ?쒖빟, 湲덉냽, 諛섎룄泥?
   * @returns 留ㅼ묶 ?щ?
   */
  private async getThemeFilteredStockCodes(themeFilters?: number[]): Promise<Set<string> | null> {
    // 0(?꾩껜) ?뚮쭏媛 ?ы븿?섏뼱 ?덉쑝硫?紐⑤뱺 醫낅ぉ ?덉슜
    if (!themeFilters?.length || themeFilters.includes(0)) {
      return null;
    }

    const stockThemes = await this.prisma.stockTheme.findMany({
      where: {
        source: 'NAVER',
        themeCode: { in: themeFilters },
        theme: { deletedAt: null },
      },
      select: { stockCode: true },
    });

    return new Set(stockThemes.map((row) => row.stockCode));
  }

  private async getNaverThemesByStockCodes(
    stockCodes: string[],
  ): Promise<Map<string, Array<{ themeCode: number; themeName: string }>>> {
    const result = new Map<string, Array<{ themeCode: number; themeName: string }>>();
    if (stockCodes.length === 0) return result;

    const stockThemes = await this.prisma.stockTheme.findMany({
      where: {
        source: 'NAVER',
        stockCode: { in: stockCodes },
        theme: { deletedAt: null },
      },
      select: {
        stockCode: true,
        themeCode: true,
        theme: { select: { themeName: true } },
      },
      orderBy: { themeCode: 'asc' },
    });

    for (const row of stockThemes) {
      const themes = result.get(row.stockCode) ?? [];
      themes.push({ themeCode: row.themeCode, themeName: row.theme.themeName });
      result.set(row.stockCode, themes);
    }

    return result;
  }

  private async getNaverThemeList(): Promise<Array<{ themeCode: number; themeName: string; sourceThemeNo: string | null }>> {
    return this.prisma.theme.findMany({
      where: {
        source: 'NAVER',
        deletedAt: null,
      },
      select: {
        themeCode: true,
        themeName: true,
        sourceThemeNo: true,
      },
      orderBy: { themeName: 'asc' },
    });
  }

  private formatDisplayTheme(
    themes: Array<{ themeCode: number; themeName: string }>,
    fallback?: string,
  ): string {
    if (themes.length === 0) return fallback || '-';
    if (themes.length === 1) return themes[0].themeName;
    return `${themes[0].themeName} 외 ${themes.length - 1}개`;
  }

  private matchesTheme(
    stockCode: string,
    stockUpName: string,
    themeFilters: number[],
    themeFilteredStockCodes: Set<string> | null,
  ): boolean {
    if (themeFilters.includes(0)) {
      return true;
    }

    if (themeFilteredStockCodes?.has(stockCode)) {
      return true;
    }

    if (!stockUpName || stockUpName === '-') {
      return false;
    }

    // upName???뚮쭏 肄붾뱶濡?蹂??
    const stockThemeCode = mapUpNameToThemeCode(stockUpName);

    // 蹂?섎맂 ?뚮쭏 肄붾뱶媛 ?꾪꽣 諛곗뿴???ы븿?섏뼱 ?덈뒗吏 ?뺤씤
    return stockThemeCode !== null && themeFilters.includes(stockThemeCode);
  }

  /**
   * ?쒖옣 吏???쇰큺 ?섏쭛 (KOSPI/KOSDAQ)
   * @param sectorCode ?낆쥌肄붾뱶 (001: KOSPI, 101: KOSDAQ)
   * @param indexStockCode DB ??μ슜 肄붾뱶 (INDEX_KOSPI, INDEX_KOSDAQ)
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

      // DB?????(吏?섍컪? 횞100 ?뺤닔濡?????洹몃?濡???? 怨꾩궛 ??/100)
      // parsePrice濡?遺???쒓굅 (Kiwoom API媛 '+'/'-' 遺?몃? 遺숈뿬??諛섑솚?섎뒗 寃쎌슦 ???
      // ka20006 dt = ?ㅼ젣 嫄곕옒??(ka10081怨??щ━ ?ㅼ쓬?좎씠 ?꾨떂) ??parseIndexDate ?ъ슜
      for (const candle of candles) {
        await this.chartStorage.saveCandle({
          stockCode: indexStockCode,
          candleType: 'day',
          candleTime: this.parseIndexDate(candle.dt),
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
   * ?꾩껜 醫낅ぉ ?쇰큺 ?섏쭛 (諛곗튂 蹂묐젹 泥섎━)
   * - BATCH_SIZE媛쒖뵫 ?숈떆 ?붿껌, 諛곗튂 媛?BATCH_DELAY_MS ?湲?
   * - 429 諛쒖깮 ??諛깆삤?????ъ떆??
   */
  async collectIndexCandles() {
    this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
    await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
    await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
    this.logger.log('Market index day candles collected.');
    // ka20006 doesn't include today's candle ??also fetch today's close via ka20001
    const todayClose = await this.collectTodayIndexClose();
    return { success: true, message: 'KOSPI + KOSDAQ index candles collected.', todayClose };
  }

  /**
   * ?ㅻ뒛 吏??醫낃? ?섏쭛 (ka20001 ?낆쥌?꾩옱媛)
   * ka20006 ?쇰큺 API???뱀씪 罹붾뱾???ы븿?섏? ?딆쑝誘濡? ??留덇컧 ??蹂꾨룄濡??몄텧
   */
  async collectTodayIndexClose() {
    const now = new Date();
    // KST ?좎쭨 湲곗??쇰줈 ?ㅻ뒛 ?먯젙 怨꾩궛 (?쒕쾭 ??꾩〈 臾닿?)
    const { kstNow, kstHours, kstMinutes } = this.getKstParts(now);
    const todayDate = this.todayKstDateOnly(now);
    const isAfterClose = kstHours > 15 || (kstHours === 15 && kstMinutes >= 40);

    if (!isKrxTradingDay(now) || !isAfterClose) {
      this.logger.warn(
        `Skipping today's index close: market close is not confirmed yet (date=${todayDate
          .toISOString()
          .slice(0, 10)}, kst=${String(kstHours).padStart(2, '0')}:${String(kstMinutes).padStart(2, '0')})`,
      );
      return {
        success: false,
        skipped: true,
        date: todayDate.toISOString().slice(0, 10),
        reason: 'MARKET_CLOSE_NOT_CONFIRMED',
      };
    }

    this.logger.log('Fetching today\'s index close via ka20001...');

    const [kospiData, kosdaqData] = await Promise.all([
      this.kiwoomRest.getSectorCurrentPrice('0', '001'),
      this.kiwoomRest.getSectorCurrentPrice('1', '101'),
    ]);

    // ka20001? ?ㅼ젣 吏?섍컪(횞1)??諛섑솚?섍퀬, ka20006? 횞100 ?뺤닔瑜?諛섑솚?섎?濡?
    // DB ?쇨????좎?瑜??꾪빐 횞100 怨깊븯?????(parsePrice濡?遺?몃룄 ?쒓굅)
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

    this.logger.log(`Today's index close saved ??KOSPI: ${kospiData.cur_prc}, KOSDAQ: ${kosdaqData.cur_prc}`);

    return {
      date: `${kstNow.getUTCFullYear()}-${String(kstNow.getUTCMonth() + 1).padStart(2, '0')}-${String(kstNow.getUTCDate()).padStart(2, '0')}`,
      kospi: kospiData.cur_prc,
      kosdaq: kosdaqData.cur_prc,
    };
  }

  async collectAllDayCandles(marketType: '0' | '10' = '0', days = 10) {
    const BATCH_SIZE = 5; // ?숈떆 ?붿껌 ??
    const BATCH_DELAY_MS = 600; // 諛곗튂 媛??湲?(ms)

    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}, batchSize: ${BATCH_SIZE}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // ?대떦 ?쒖옣 醫낅ぉ ?꾪꽣 (ETF/ETN ?쒖쇅)
    // - ETF: marketCode='8'?대씪 ?대? ?쒖쇅??
    // - ETN: 肄붾뱶媛 5/6/7濡??쒖옉 (marketCode='0'?댁?留?ETN)
    // - ?뚰뙆踰??ы븿 肄붾뱶: ETF/ETN 蹂??
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && /^\d+$/.test(s.code) && !/^[567]/.test(s.code),
    );

    this.logger.log(`Found ${stocks.length} stocks to process in batches of ${BATCH_SIZE}`);

    let success = 0;
    let failed = 0;
    let currentDelay = BATCH_DELAY_MS;
    const errors: { code: string; error: string }[] = [];

    // 諛곗튂 ?⑥쐞濡?遺꾪븷
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);

      // 諛곗튂 ??醫낅ぉ?ㅼ쓣 蹂묐젹濡?泥섎━
      // ?먯＜媛/?섏젙二쇨?瑜??④퍡 ?섏쭛??stockCandle 而щ읆 ?섎?瑜?backfillDayCandles? ?쇨??섍쾶 ?좎?.
      // - openPrice/closePrice : ?먯＜媛 (upd_stkpc_tp='0')
      // - adjOpenPrice/adjClosePrice : ?섏젙二쇨? (upd_stkpc_tp='1')
      const results = await Promise.allSettled(
        batch.map((stock) => this.collectStockDayCandlesWithAdjusted(stock.code, today, days)),
      );

      // 寃곌낵 泥섎━
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

      // 429 諛쒖깮 ??諛깆삤?????ъ떆??(?쒖감)
      if (batchHas429) {
        currentDelay = Math.min(currentDelay * 2, 10000);
        this.logger.warn(`Rate limited (429) on ${retryStocks.length} stocks. Backing off ${currentDelay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, currentDelay));

        for (const stock of retryStocks) {
          try {
            await this.collectStockDayCandlesWithAdjusted(stock.code, today, days);
            success++;
            await new Promise((resolve) => setTimeout(resolve, 500));
          } catch (retryError) {
            failed++;
            errors.push({ code: stock.code, error: (retryError as Error).message });
          }
        }
      } else {
        // ?깃났 ???쒕젅???먯쭊??蹂듦뎄
        currentDelay = Math.max(BATCH_DELAY_MS, currentDelay - 200);
      }

      // 吏꾪뻾 ?곹솴 濡쒓퉭
      const processed = Math.min(i + BATCH_SIZE, stocks.length);
      if (processed % 50 === 0 || processed === stocks.length) {
        const elapsed = ((processed / stocks.length) * 100).toFixed(1);
        this.logger.log(`Progress: ${processed}/${stocks.length} (${elapsed}%) - success: ${success}, failed: ${failed}`);
      }

      // 諛곗튂 媛??쒕젅??
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
   * ?⑥씪 醫낅ぉ???쇰큺???먯＜媛/?섏젙二쇨? ?묒そ 紐⑤몢 媛?몄? stockCandle ?????
   *
   * - openPrice/closePrice 而щ읆 : ?먯＜媛 (upd_stkpc_tp='0')
   * - adjOpenPrice/adjClosePrice : ?섏젙二쇨? (upd_stkpc_tp='1')
   *
   * collectAllDayCandles, backfillDayCandles ?묒そ 紐⑤몢?먯꽌 ?ъ슜??而щ읆 ?섎?瑜??쇨??섍쾶 ?좎??쒕떎.
   */
  async backfillAdjAnomalyStocks(threshold = 0.3, days = 400) {
    const rows = await this.prisma.$queryRaw<{ stock_code: string }[]>`
      SELECT DISTINCT stock_code FROM (
        SELECT stock_code, adj_close_price,
               LAG(adj_close_price) OVER (PARTITION BY stock_code ORDER BY candle_time) AS prev_adj
        FROM stock_candles
        WHERE candle_type = 'day'
          AND stock_code NOT LIKE 'INDEX_%'
          AND adj_close_price > 0
      ) t
      WHERE prev_adj > 0
        AND ABS(adj_close_price / prev_adj - 1) >= ${threshold}
      ORDER BY stock_code
    `;

    const stockCodes = rows.map((r) => r.stock_code);
    this.logger.log(`[AdjAnomaly] ${stockCodes.length} stocks detected. Starting backfill (days=${days})...`);

    this.backfillSpecificStocks(stockCodes, days)
      .then((results) => {
        const ok = results.filter((r) => r.status === 'ok').length;
        const fail = results.filter((r) => r.status === 'error').length;
        this.logger.log(`[AdjAnomaly] Backfill done: ${ok} ok, ${fail} failed`);
      })
      .catch((e) => this.logger.error(`[AdjAnomaly] Backfill error: ${(e as Error).message}`));

    return { started: true, stockCount: stockCodes.length, stocks: stockCodes };
  }

  async backfillSpecificStocks(stockCodes: string[], days = 400) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const results: { code: string; count?: number; status: string; error?: string }[] = [];
    for (const code of stockCodes) {
      try {
        const count = await this.collectStockDayCandlesWithAdjusted(code, today, days);
        this.logger.log(`Backfill done: ${code} ??${count} candles`);
        results.push({ code, count, status: 'ok' });
      } catch (e) {
        this.logger.error(`Backfill failed: ${code} ??${(e as Error).message}`);
        results.push({ code, status: 'error', error: (e as Error).message });
      }
    }
    return results;
  }

  private async collectStockDayCandlesWithAdjusted(
    stockCode: string,
    baseDate: string,
    days: number,
  ): Promise<number> {
    // getDayCandlesWithHistory??maxCandles留뚰겮 ?섏씠吏?ㅼ씠?? 5~10???섏??대㈃ 1?섏씠吏濡?異⑸텇.
    const rawData = await this.kiwoomRest.getDayCandlesWithHistory(stockCode, baseDate, days, '0');
    const adjData = await this.kiwoomRest.getDayCandlesWithHistory(stockCode, baseDate, days, '1');

    const adjMap = new Map(adjData.stk_dt_pole_chart_qry.map((item) => [item.dt, item]));

    const candlesToSave = rawData.stk_dt_pole_chart_qry.slice(0, days).map((item) => {
      const adj = adjMap.get(item.dt);
      return {
        stockCode,
        candleType: 'day',
        candleTime: this.parseDateOnly(item.dt),
        openPrice: this.parsePrice(item.open_pric),
        highPrice: this.parsePrice(item.high_pric),
        lowPrice: this.parsePrice(item.low_pric),
        closePrice: this.parsePrice(item.cur_prc),
        volume: BigInt(item.trde_qty || '0'),
        tradingValue: item.trde_prica ? BigInt(item.trde_prica) * 1_000_000n : null,
        adjOpenPrice: adj ? this.parsePrice(adj.open_pric) : this.parsePrice(item.open_pric),
        adjHighPrice: adj ? this.parsePrice(adj.high_pric) : this.parsePrice(item.high_pric),
        adjLowPrice: adj ? this.parsePrice(adj.low_pric) : this.parsePrice(item.low_pric),
        adjClosePrice: adj ? this.parsePrice(adj.cur_prc) : this.parsePrice(item.cur_prc),
      };
    });

    await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
    return candlesToSave.length;
  }

  /**
   * ?꾩껜 醫낅ぉ ?쇰큺 + 嫄곕옒?湲?諛깊븘 (getDayCandlesWithHistory ?ъ슜, ?섏씠吏?ㅼ씠??吏??
   */
  async backfillDayCandles(marketType: '0' | '10' = '0', days = 330) {
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
          // ?먯＜媛('0')? ?섏젙二쇨?('1') ?쒖감 ?붿껌 (rate limit 怨좊젮)
          const rawData = await this.kiwoomRest.getDayCandlesWithHistory(stock.code, today, days, '0');
          const adjData = await this.kiwoomRest.getDayCandlesWithHistory(stock.code, today, days, '1');

          const adjMap = new Map(adjData.stk_dt_pole_chart_qry.map((item) => [item.dt, item]));

          const candlesToSave = rawData.stk_dt_pole_chart_qry.map((item) => {
            const adj = adjMap.get(item.dt);
            return {
              stockCode: stock.code,
              candleType: 'day',
              candleTime: this.parseDateOnly(item.dt),
              openPrice: this.parsePrice(item.open_pric),
              highPrice: this.parsePrice(item.high_pric),
              lowPrice: this.parsePrice(item.low_pric),
              closePrice: this.parsePrice(item.cur_prc),
              volume: BigInt(item.trde_qty || '0'),
              tradingValue: item.trde_prica ? BigInt(item.trde_prica) * 1_000_000n : null,
              adjOpenPrice: adj ? this.parsePrice(adj.open_pric) : null,
              adjHighPrice: adj ? this.parsePrice(adj.high_pric) : null,
              adjLowPrice: adj ? this.parsePrice(adj.low_pric) : null,
              adjClosePrice: adj ? this.parsePrice(adj.cur_prc) : null,
            };
          });
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
   * tradingValue媛 null???쇰큺??李얠븘 ?ㅼ? ?곗씠?곕줈 梨꾩썙?ｊ린
   */
  private async saveHigherTimeframeCandles(
    stockCode: string,
    candleType: HigherTimeframeCandleType,
    items: Array<{
      dt: string;
      open_pric: string;
      high_pric: string;
      low_pric: string;
      cur_prc: string;
      trde_qty?: string;
      trde_prica?: string;
    }>,
  ): Promise<number> {
    const candlesToSave = items.map((item) => ({
      stockCode,
      candleType,
      candleTime: this.parseDateOnly(item.dt),
      openPrice: this.parsePrice(item.open_pric),
      highPrice: this.parsePrice(item.high_pric),
      lowPrice: this.parsePrice(item.low_pric),
      closePrice: this.parsePrice(item.cur_prc),
      volume: BigInt(item.trde_qty || '0'),
      tradingValue: item.trde_prica ? BigInt(item.trde_prica) : null,
      adjOpenPrice: this.parsePrice(item.open_pric),
      adjHighPrice: this.parsePrice(item.high_pric),
      adjLowPrice: this.parsePrice(item.low_pric),
      adjClosePrice: this.parsePrice(item.cur_prc),
    }));

    await Promise.all(candlesToSave.map((c) => this.chartStorage.saveCandle(c)));
    return candlesToSave.length;
  }

  private aggregateYearCandlesFromItems(
    items: Array<{
      dt: string;
      open_pric: string;
      high_pric: string;
      low_pric: string;
      cur_prc: string;
      trde_qty?: string;
      trde_prica?: string;
    }>,
  ) {
    const byYear = new Map<string, typeof items>();
    for (const item of items) {
      const year = item.dt.slice(0, 4);
      const bucket = byYear.get(year) ?? [];
      bucket.push(item);
      byYear.set(year, bucket);
    }

    return Array.from(byYear.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([year, yearItems]) => {
        const sortedAsc = [...yearItems].sort((a, b) => a.dt.localeCompare(b.dt));
        const first = sortedAsc[0];
        const last = sortedAsc[sortedAsc.length - 1];
        const high = Math.max(...sortedAsc.map((item) => this.parsePrice(item.high_pric)));
        const low = Math.min(...sortedAsc.map((item) => this.parsePrice(item.low_pric)));
        const volume = sortedAsc.reduce((sum, item) => sum + BigInt(item.trde_qty || '0'), 0n);
        const tradingValue = sortedAsc.reduce((sum, item) => sum + BigInt(item.trde_prica || '0'), 0n);

        return {
          dt: first.dt || `${year}0101`,
          open_pric: first.open_pric,
          high_pric: String(high),
          low_pric: String(low),
          cur_prc: last.cur_prc,
          trde_qty: volume.toString(),
          trde_prica: tradingValue.toString(),
        };
      });
  }

  private async collectStockHigherTimeframeCandles(
    stockCode: string,
    candleTypes: HigherTimeframeCandleType[],
    baseDate: string,
  ): Promise<Record<HigherTimeframeCandleType, number>> {
    const saved: Record<HigherTimeframeCandleType, number> = {
      week: 0,
      month: 0,
      year: 0,
    };

    let monthItems: Array<{
      dt: string;
      open_pric: string;
      high_pric: string;
      low_pric: string;
      cur_prc: string;
      trde_qty?: string;
      trde_prica?: string;
    }> | null = null;

    for (const candleType of candleTypes) {
      if (candleType === 'week') {
        saved.week = await this.saveWeekCandles(stockCode, baseDate);
      } else if (candleType === 'month') {
        if (!monthItems) {
          const monthData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);
          monthItems = monthData.stk_mth_pole_chart_qry;
        }
        saved.month = await this.saveHigherTimeframeCandles(stockCode, 'month', monthItems);
      } else {
        if (!monthItems) {
          const monthData = await this.kiwoomRest.getMonthCandles(stockCode, baseDate);
          monthItems = monthData.stk_mth_pole_chart_qry;
        }
        saved.year = await this.saveHigherTimeframeCandles(
          stockCode,
          'year',
          this.aggregateYearCandlesFromItems(monthItems),
        );
      }
    }

    return saved;
  }

  async backfillHigherTimeframeCandles(
    marketType: '0' | '10' = '0',
    candleTypes: HigherTimeframeCandleType[] = ['week', 'month', 'year'],
    stockCodes?: string[],
  ) {
    const BATCH_SIZE = 1;
    const BATCH_DELAY_MS = 1000;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const normalizedTypes = Array.from(new Set(candleTypes)).filter((type) =>
      ['week', 'month', 'year'].includes(type),
    ) as HigherTimeframeCandleType[];

    if (normalizedTypes.length === 0) {
      throw new Error('At least one candle type is required: week, month, year');
    }

    let stocks: Array<{ code: string }>;
    if (stockCodes?.length) {
      stocks = stockCodes
        .map((code) => code.trim())
        .filter((code) => /^\d+$/.test(code) && !/^[567]/.test(code))
        .map((code) => ({ code }));
    } else {
      const stockList = await this.kiwoomRest.getStockList(marketType);
      stocks = stockList.list.filter(
        (s) => s.marketCode === marketType && /^\d+$/.test(s.code) && !/^[567]/.test(s.code),
      );
    }

    this.logger.log(
      `Starting higher timeframe backfill: market=${marketType}, types=${normalizedTypes.join(',')}, stocks=${stocks.length}`,
    );

    let success = 0;
    let failed = 0;
    const savedTotals: Record<HigherTimeframeCandleType, number> = { week: 0, month: 0, year: 0 };
    const errors: { code: string; error: string }[] = [];

    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((stock) => this.collectStockHigherTimeframeCandles(stock.code, normalizedTypes, today)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          success++;
          for (const type of normalizedTypes) {
            savedTotals[type] += result.value[type];
          }
        } else {
          failed++;
          errors.push({ code: batch[j].code, error: result.reason?.message || 'Unknown' });
          this.logger.warn(`Higher timeframe backfill failed: ${batch[j].code} - ${result.reason?.message}`);
        }
      }

      const processed = Math.min(i + BATCH_SIZE, stocks.length);
      if (processed % 50 === 0 || processed === stocks.length) {
        this.logger.log(
          `Higher timeframe progress: ${processed}/${stocks.length} - success=${success}, failed=${failed}, saved=${JSON.stringify(savedTotals)}`,
        );
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    this.logger.log(`Higher timeframe backfill completed: success=${success}, failed=${failed}`);
    return {
      marketType,
      candleTypes: normalizedTypes,
      total: stocks.length,
      success,
      failed,
      saved: savedTotals,
      errors: errors.slice(0, 20),
    };
  }

  async fillMissingTradingValue() {
    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 1000;

    // tradingValue媛 null??醫낅ぉ 肄붾뱶 紐⑸줉 議고쉶
    const nullCandleStocks = await this.prisma.stockCandle.findMany({
      where: { candleType: 'day', tradingValue: null },
      select: { stockCode: true },
      distinct: ['stockCode'],
    });

    const stockCodes = nullCandleStocks.map((r) => r.stockCode);
    this.logger.log(`fillMissingTradingValue: ${stockCodes.length}媛?醫낅ぉ??tradingValue ?꾨씫 ?쇰큺 議댁옱`);

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
          // ?대떦 醫낅ぉ?먯꽌 tradingValue媛 null???쇱옄 紐⑸줉
          const nullDates = await this.prisma.stockCandle.findMany({
            where: { stockCode, candleType: 'day', tradingValue: null },
            select: { candleTime: true },
          });
          const nullDateSet = new Set(nullDates.map((r) => r.candleTime.toISOString()));

          // ?ㅼ??먯꽌 ?대떦 醫낅ぉ ?쇰큺 ?곗씠??議고쉶 (理쒕? 750??
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
        this.logger.log(`吏꾪뻾: ${processed}/${stockCodes.length} - ?낅뜲?댄듃: ${totalUpdated}嫄? ?ㅽ뙣: ${failed}`);
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    this.logger.log(`fillMissingTradingValue ?꾨즺: ${success}醫낅ぉ 泥섎━, ${totalUpdated}嫄??낅뜲?댄듃, ${failed}醫낅ぉ ?ㅽ뙣`);
    return { total: stockCodes.length, success, failed, updated: totalUpdated, errors: errors.slice(0, 20) };
  }

  /**
   * DB?먯꽌 ??λ맂 罹붾뱾 ?곗씠??議고쉶
   */
  async getStoredCandles(
    stockCode: string,
    candleType: string,
    startDate?: string,
    endDate?: string,
    snapshot?: StockDetailSnapshot | null,
    options?: { maskUnfixedPrices?: boolean },
  ) {
    const now = new Date();
    const defaultStart = new Date(now);
    defaultStart.setFullYear(defaultStart.getFullYear() - 1);

    const startTime = this.parseDateInput(startDate, defaultStart);
    const endTime = this.parseDateInput(endDate, now);
    endTime.setUTCHours(23, 59, 59, 999);

    const candles = await this.chartStorage.getCandles(stockCode, candleType, startTime, endTime);
    const realtimePrice = this.getUsableRealtimePrice(this.realtimeCache.getPrice(stockCode));
    if (!realtimePrice && ['day', 'week', 'month', 'year'].includes(candleType)) {
      this.autoSubscribeStocks([stockCode]).catch((error) => {
        this.logger.warn(`Detail chart auto-subscribe failed: ${error.message}`);
      });
    }
    const currentPeriodCandle =
      ['week', 'month', 'year'].includes(candleType) && (snapshot || realtimePrice)
        ? await this.buildCurrentPeriodAggregateCandle(
          stockCode,
          candleType as HigherTimeframeCandleType,
          snapshot,
          realtimePrice,
        )
        : null;
    const responseCandles = snapshot
      ? this.applySnapshotToStoredCandles(candles, candleType, snapshot, currentPeriodCandle)
      : realtimePrice
      ? this.applyRealtimeToStoredCandles(candles, candleType, realtimePrice, currentPeriodCandle)
      : candles;
    const shouldMaskUnfixedPrices =
      options?.maskUnfixedPrices === true &&
      ['day', 'week', 'month', 'year'].includes(candleType) &&
      this.isKrxMarketSessionNow();

    return {
      stockCode,
      candleType,
      candles: responseCandles.map((c, index) => {
        const closePrice = Number(c.closePrice);
        const prevClosePrice = index + 1 < responseCandles.length
          ? Number(responseCandles[index + 1].closePrice)
          : null;
        const changeRate =
          prevClosePrice && prevClosePrice > 0
            ? ((closePrice - prevClosePrice) / prevClosePrice) * 100
            : null;
        const changeRateText = c.changeRateOverride != null
          ? this.formatSignedPercentInput(c.changeRateOverride)
          : changeRate !== null
            ? this.formatSignedPercent(changeRate)
            : null;

        const time = this.formatStoredCandleTime(c.candleTime, candleType);

        return {
          time,
          period: time,
          candleTime: c.candleTime.toISOString(),
          open: shouldMaskUnfixedPrices ? '-' : String(c.openPrice),
          high: shouldMaskUnfixedPrices ? '-' : String(c.highPrice),
          low: shouldMaskUnfixedPrices ? '-' : String(c.lowPrice),
          close: shouldMaskUnfixedPrices ? '-' : String(c.closePrice),
          volume: c.volume.toString(),
          tradingValue: c.tradingValue?.toString() || null,
          changeRate: shouldMaskUnfixedPrices ? '-' : changeRateText,
        };
      }),
    };
  }

  private isKrxMarketSessionNow(): boolean {
    const now = new Date();
    if (!isKrxTradingDay(now)) return false;

    const nowKst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const minutes = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    return minutes >= 9 * 60 && minutes <= 16 * 60;
  }

  private async buildCurrentPeriodAggregateCandle(
    stockCode: string,
    candleType: HigherTimeframeCandleType,
    snapshot?: StockDetailSnapshot | null,
    realtimePrice?: any,
  ): Promise<any | null> {
    const today = this.todayKstDateOnly();
    const todayKey = today.toISOString().split('T')[0];
    const currentPrice = Number(snapshot?.currentPrice ?? realtimePrice?.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

    const periodStart = this.getCurrentStoredPeriodStart(candleType, today);
    const periodEnd = new Date(today);
    periodEnd.setUTCHours(23, 59, 59, 999);

    const dayCandles = await this.chartStorage.getCandles(stockCode, 'day', periodStart, periodEnd);
    const existingToday = dayCandles.find((c) => c.candleTime.toISOString().split('T')[0] === todayKey);
    const openPrice = Number(existingToday?.openPrice ?? realtimePrice?.openPrice ?? currentPrice);
    const highSource = Number(snapshot?.dayHigh ?? realtimePrice?.highPrice ?? currentPrice);
    const lowSource = Number(snapshot?.dayLow ?? realtimePrice?.lowPrice ?? currentPrice);
    const highPrice = Math.max(Number(existingToday?.highPrice ?? currentPrice), currentPrice, highSource);
    const lowPrice = Math.min(Number(existingToday?.lowPrice ?? currentPrice), currentPrice, lowSource);
    const volume = this.toNonNegativeBigInt(snapshot?.volume ?? realtimePrice?.accVolume);
    const tradingValue = this.normalizeTradingValueToWon(snapshot?.tradingValue ?? realtimePrice?.accAmount);

    const todayCandle = {
      ...(existingToday ?? {}),
      candleTime: today,
      openPrice,
      highPrice,
      lowPrice,
      closePrice: currentPrice,
      volume: volume > 0n ? volume : (existingToday?.volume ?? 0n),
      tradingValue: tradingValue > 0n ? tradingValue : (existingToday?.tradingValue ?? null),
    };
    const aggregateSource = [
      todayCandle,
      ...dayCandles.filter((c) => c.candleTime.toISOString().split('T')[0] !== todayKey),
    ];

    const oldest = aggregateSource[aggregateSource.length - 1];
    const latest = aggregateSource[0];
    const aggregateTradingValue = aggregateSource.reduce((sum, c) => sum + (c.tradingValue ?? 0n), 0n);

    return {
      candleTime: periodStart,
      openPrice: Number(oldest.openPrice),
      highPrice: Math.max(...aggregateSource.map((c) => Number(c.highPrice))),
      lowPrice: Math.min(...aggregateSource.map((c) => Number(c.lowPrice))),
      closePrice: Number(latest.closePrice),
      volume: aggregateSource.reduce((sum, c) => sum + (c.volume ?? 0n), 0n),
      tradingValue: aggregateTradingValue > 0n ? aggregateTradingValue : null,
      changeRateOverride: snapshot?.changeRate ?? realtimePrice?.changeRate,
    };
  }

  private applySnapshotToStoredCandles(
    candles: any[],
    candleType: string,
    snapshot: StockDetailSnapshot,
    currentPeriodCandle?: any | null,
  ): any[] {
    if (!['day', 'week', 'month', 'year'].includes(candleType)) return candles;

    const today = this.todayKstDateOnly();
    const todayKey = today.toISOString().split('T')[0];
    const currentPrice = Number(snapshot.currentPrice);
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return candles;

    const volume = this.toNonNegativeBigInt(snapshot.volume);
    const tradingValue = this.normalizeTradingValueToWon(snapshot.tradingValue);
    const dayHigh = Number(snapshot.dayHigh || currentPrice);
    const dayLow = Number(snapshot.dayLow || currentPrice);

    if (candleType === 'day') {
      const todayIndex = candles.findIndex((c) => c.candleTime.toISOString().split('T')[0] === todayKey);
      const base = todayIndex >= 0 ? candles[todayIndex] : {};
      const realtimeDayCandle = {
        ...base,
        candleTime: today,
        openPrice: Number(base.openPrice || currentPrice),
        highPrice: Math.max(Number(base.highPrice || currentPrice), currentPrice, dayHigh),
        lowPrice: Math.min(Number(base.lowPrice || currentPrice), currentPrice, dayLow),
        closePrice: currentPrice,
        volume: volume > 0n ? volume : (base.volume ?? 0n),
        tradingValue: tradingValue > 0n ? tradingValue : (base.tradingValue ?? null),
        changeRateOverride: snapshot.changeRate,
      };

      if (todayIndex >= 0) {
        return candles.map((c, index) => index === todayIndex ? realtimeDayCandle : c);
      }
      return [realtimeDayCandle, ...candles];
    }

    const currentPeriodStart = this.getCurrentStoredPeriodStart(candleType, today);
    const aggregateCandle = currentPeriodCandle ?? {
      candleTime: currentPeriodStart,
      openPrice: currentPrice,
      highPrice: Math.max(currentPrice, dayHigh),
      lowPrice: Math.min(currentPrice, dayLow),
      closePrice: currentPrice,
      volume,
      tradingValue: tradingValue > 0n ? tradingValue : null,
      changeRateOverride: snapshot.changeRate,
    };

    if (candles.length === 0) {
      return [aggregateCandle];
    }

    const latest = candles[0];
    if (!this.isSameStoredCandlePeriod(latest.candleTime, today, candleType)) {
      return [aggregateCandle, ...candles];
    }

    return [{ ...latest, ...aggregateCandle }, ...candles.slice(1)];
  }

  private applyRealtimeToStoredCandles(
    candles: any[],
    candleType: string,
    realtimePrice: any,
    currentPeriodCandle?: any | null,
  ): any[] {
    if (!['day', 'week', 'month', 'year'].includes(candleType)) return candles;

    const today = this.todayKstDateOnly();
    const todayKey = today.toISOString().split('T')[0];
    const currentPrice = Number(realtimePrice.currentPrice);
    const openPrice = Number(realtimePrice.openPrice || currentPrice);
    const highPrice = Number(realtimePrice.highPrice || currentPrice);
    const lowPrice = Number(realtimePrice.lowPrice || currentPrice);
    const volume = BigInt(Math.max(0, Math.trunc(Number(realtimePrice.accVolume || 0))));
    const tradingValue = this.normalizeTradingValueToWon(realtimePrice.accAmount);

    if (candleType === 'day') {
      const todayIndex = candles.findIndex((c) => c.candleTime.toISOString().split('T')[0] === todayKey);
      const realtimeDayCandle = {
        ...(todayIndex >= 0 ? candles[todayIndex] : {}),
        candleTime: today,
        openPrice,
        highPrice,
        lowPrice,
        closePrice: currentPrice,
        volume,
        tradingValue,
      };

      if (todayIndex >= 0) {
        return candles.map((c, index) => index === todayIndex ? realtimeDayCandle : c);
      }
      return [realtimeDayCandle, ...candles];
    }

    const aggregateCandle = currentPeriodCandle ?? {
      candleTime: this.getCurrentStoredPeriodStart(candleType, today),
      openPrice,
      highPrice,
      lowPrice,
      closePrice: currentPrice,
      volume,
      tradingValue: tradingValue > 0n ? tradingValue : null,
      changeRateOverride: realtimePrice.changeRate,
    };

    if (candles.length === 0) {
      return [aggregateCandle];
    }

    const latest = candles[0];
    if (!this.isSameStoredCandlePeriod(latest.candleTime, today, candleType)) {
      return [aggregateCandle, ...candles];
    }

    return [{ ...latest, ...aggregateCandle }, ...candles.slice(1)];
  }

  private getCurrentStoredPeriodStart(candleType: string, today: Date): Date {
    if (candleType === 'week') return this.getWeekStart(today);
    if (candleType === 'month') {
      return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    }
    if (candleType === 'year') {
      return new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    }
    return today;
  }

  private isSameStoredCandlePeriod(candleTime: Date, today: Date, candleType: string): boolean {
    if (candleType === 'week') {
      return this.getWeekStart(candleTime).getTime() === this.getWeekStart(today).getTime();
    }
    if (candleType === 'month') {
      return candleTime.getUTCFullYear() === today.getUTCFullYear() &&
        candleTime.getUTCMonth() === today.getUTCMonth();
    }
    if (candleType === 'year') {
      return candleTime.getUTCFullYear() === today.getUTCFullYear();
    }
    return candleTime.toISOString().split('T')[0] === today.toISOString().split('T')[0];
  }

  private getWeekStart(date: Date): Date {
    const day = date.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    result.setUTCDate(result.getUTCDate() + mondayOffset);
    return result;
  }

  private formatStoredCandleTime(candleTime: Date, candleType: string): string {
    const isoDate = candleTime.toISOString().split('T')[0];
    if (candleType === 'month') return isoDate.slice(0, 7);
    if (candleType === 'year') return isoDate.slice(0, 4);
    return candleTime.toISOString();
  }

  private formatSignedPercent(value: number): string {
    return `${value.toFixed(2)}%`;
  }

  private formatSignedPercentInput(value: string | number): string {
    const numeric = Number(String(value).replace(/[%+,]/g, ''));
    if (!Number.isFinite(numeric)) return String(value);
    return this.formatSignedPercent(numeric);
  }

  private toNonNegativeBigInt(value: string | number | bigint | null | undefined): bigint {
    if (value == null) return 0n;
    if (typeof value === 'bigint') return value > 0n ? value : 0n;
    const parsed = Number(String(value).replace(/,/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) return 0n;
    return BigInt(Math.trunc(parsed));
  }

  private normalizeTradingValueToWon(value: string | number | bigint | null | undefined): bigint {
    const raw = this.toNonNegativeBigInt(value);
    if (raw === 0n) return 0n;

    // Kiwoom daily/realtime trading value is often delivered in million KRW units.
    // Stored candles use KRW, so normalize small values to the same scale.
    return raw < 10_000_000n ? raw * 1_000_000n : raw;
  }

  private parseDateInput(dateStr: string | undefined, fallback: Date): Date {
    if (!dateStr) return new Date(fallback);
    if (/^\d{8}$/.test(dateStr)) {
      return new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`);
    }
    return new Date(dateStr);
  }

  /**
   * YYYYMMDD 臾몄옄????Date 蹂??
   */
  private normalizeYYYYMMDD(dateStr: string): string {
    return dateStr.includes('-') ? dateStr.replace(/-/g, '') : dateStr;
  }

  private formatYYYYMMDD(dateStr: string): string {
    const normalized = this.normalizeYYYYMMDD(dateStr);
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }

  private formatDateToYYYYMMDD(date: Date): string {
    return date.toISOString().split('T')[0].replace(/-/g, '');
  }

  private parseYYYYMMDD(dateStr: string): Date {
    const normalized = this.normalizeYYYYMMDD(dateStr);
    const y = normalized.substring(0, 4);
    const m = normalized.substring(4, 6);
    const d = normalized.substring(6, 8);
    return new Date(`${y}-${m}-${d}`);
  }

  /**
   * ?⑥씪 醫낅ぉ RS 異붿씠 怨꾩궛 (洹몃옒?꾩슜)
   * rsFilters ??POST /stocks? ?숈씪???뺤떇, ?좎쭨??YYYYMMDD
   */
  async getRsHistory(
    stockCode: string,
    startDate: string,
    endDate: string,
    rsFilters?: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>,
  ) {
    // rsFilters ??湲곌컙(?щ젰????怨?媛以묒튂濡?蹂??
    let periods: number[];
    let weights: number[];
    const normalizedRsFilters = rsFilters?.map((f) => ({
      rsStartDate: this.normalizeYYYYMMDD(f.rsStartDate),
      rsEndDate: this.normalizeYYYYMMDD(f.rsEndDate),
      strength: f.strength,
    }));

    if (normalizedRsFilters && normalizedRsFilters.length > 0) {
      periods = normalizedRsFilters.map((f) => {
        const from = this.parseYYYYMMDD(f.rsStartDate); // ?댁쟾 ?좎쭨 (earlier)
        const to = this.parseYYYYMMDD(f.rsEndDate);     // ?댄썑 ?좎쭨 (later)
        const diffDays = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 ? diffDays : 63;
      });
      weights = normalizedRsFilters.map((f) => f.strength);
    } else {
      periods = [63];
      weights = [100];
    }

    // 醫낅ぉ ?쒖옣 議고쉶 ??吏??肄붾뱶 寃곗젙
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
    });
    const indexCode = company?.marketType === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI';

    // 猷⑸갚 踰꾪띁 (?곸뾽?????щ젰?? 理쒕? 湲곌컙 횞 1.5)
    const maxPeriod = Math.max(...periods);
    const bufferDays = Math.ceil(maxPeriod * 1.5);
    const fetchStart = this.parseYYYYMMDD(startDate);
    fetchStart.setDate(fetchStart.getDate() - bufferDays);
    const fetchEnd = this.parseYYYYMMDD(endDate);
    const appliedRsFilters = normalizedRsFilters && normalizedRsFilters.length > 0
      ? normalizedRsFilters
      : (() => {
        const defaultStart = new Date(fetchEnd);
        defaultStart.setDate(defaultStart.getDate() - periods[0]);
        return [{
          rsStartDate: this.formatDateToYYYYMMDD(defaultStart),
          rsEndDate: this.normalizeYYYYMMDD(endDate),
          strength: weights[0],
        }];
      })();
    const longestFilter = appliedRsFilters.reduce((max, filter) => {
      const filterDays = this.parseYYYYMMDD(filter.rsEndDate).getTime() - this.parseYYYYMMDD(filter.rsStartDate).getTime();
      const maxDays = this.parseYYYYMMDD(max.rsEndDate).getTime() - this.parseYYYYMMDD(max.rsStartDate).getTime();
      return filterDays > maxDays ? filter : max;
    });
    const queryStartDate = this.formatYYYYMMDD(longestFilter.rsStartDate);
    const queryEndDate = this.formatYYYYMMDD(longestFilter.rsEndDate);

    // 醫낅ぉ + 吏???쇰큺 議고쉶
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

    // startDate ?댄썑 嫄곕옒?쇰쭔 寃곌낵濡?諛섑솚 (踰꾪띁 湲곌컙 ?쒖쇅)
    const filtersWithPeriods = appliedRsFilters.map((filter, index) => {
      if (!normalizedRsFilters || normalizedRsFilters.length === 0) {
        return { ...filter, period: periods[index] ?? 63 };
      }

      const filterStart = this.parseYYYYMMDD(filter.rsStartDate);
      const filterEnd = this.parseYYYYMMDD(filter.rsEndDate);
      const tradingDayCount = indexCandles.filter((c) => {
        const candleDate = c.candleTime;
        return candleDate >= filterStart && candleDate <= filterEnd;
      }).length;

      return {
        ...filter,
        period: tradingDayCount > 0 ? tradingDayCount : periods[index],
      };
    });
    const tradingPeriods = filtersWithPeriods.map((filter) => filter.period);

    const rangeStart = this.parseYYYYMMDD(startDate);
    const tradeDatesInRange = stockCandles.filter((c) => c.candleTime >= rangeStart);

    const data: Array<{ date: string; rsRaw: number }> = [];

    for (const candle of tradeDatesInRange) {
      const tradeDate = candle.candleTime;
      const stockUpTo = stockCandles.filter((c) => c.candleTime <= tradeDate);
      const indexUpTo = indexCandles.filter((c) => c.candleTime <= tradeDate);

      if (stockUpTo.length === 0 || indexUpTo.length === 0) continue;

      const lastStock = stockUpTo[stockUpTo.length - 1];
      const lastIndex = indexUpTo[indexUpTo.length - 1];
      // 醫낅ぉ? ?섏젙二쇨? ?곗꽑, 吏?섎뒗 ?섏젙二쇨? ?놁쓬
      const closeNow = (lastStock.adjClosePrice ?? lastStock.closePrice).toNumber();
      const indexNow = lastIndex.closePrice.toNumber();

      const rsValues: number[] = [];
      for (const period of tradingPeriods) {
        if (stockUpTo.length <= period || indexUpTo.length <= period) {
          rsValues.push(0);
          continue;
        }
        const pastStock = stockUpTo[stockUpTo.length - 1 - period];
        const pastIndex = indexUpTo[indexUpTo.length - 1 - period];
        const pastPrice = (pastStock.adjClosePrice ?? pastStock.closePrice).toNumber();
        const indexPast = pastIndex.closePrice.toNumber();
        if (pastPrice > 0 && indexPast > 0) {
          rsValues.push((closeNow / pastPrice) / (indexNow / indexPast));
        } else {
          rsValues.push(0);
        }
      }

      // 媛以??됯퇏
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

    return {
      stockCode,
      indexCode,
      periods: tradingPeriods,
      weights,
      rsFilters: filtersWithPeriods,
      queryStartDate,
      queryEndDate,
      count: data.length,
      data,
    };
  }

  /**
   * ?ㅼ떆媛?援щ룆 ?쒖옉
   */
  async startRealtime(stockCode: string) {

    // 罹먯떆??援щ룆 異붽?
    this.realtimeCache.addSubscription(stockCode);

    // ?ㅼ떆媛??뚯뒪 援щ룆 ?쒖옉 (0B: 泥닿껐, 0D: ?멸?)
    await this.realtimeSource.subscribe(stockCode, ['0B', '0D']);

    return { success: true, stockCode };
  }

  /**
   * ?ㅼ떆媛?援щ룆 以묒?
   */
  async stopRealtime(stockCode: string) {

    // ?ㅼ떆媛??뚯뒪 援щ룆 ?댁젣
    await this.realtimeSource.unsubscribe(stockCode);

    // 罹먯떆?먯꽌 ?쒓굅
    this.realtimeCache.removeSubscription(stockCode);

    return { success: true, stockCode };
  }

  /**
   * ?ㅼ떆媛?援щ룆 ?쒖옉 (?щ윭 醫낅ぉ)
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
   * ?ㅼ떆媛?援щ룆 以묒? (?щ윭 醫낅ぉ)
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
   * ?ㅼ떆媛?罹먯떆 ?곹깭 議고쉶
   */
  async getRealtimeCacheStats() {
    const stats = this.realtimeCache.getCacheStats();
    const subscribedStocks = this.realtimeCache.getSubscribedStocks();

    return {
      ...stats,
      subscribedStockCodes: subscribedStocks.slice(0, 10), // 泥섏쓬 10媛쒕쭔
      totalSubscribed: subscribedStocks.length,
    };
  }

  /**
   * 醫낅ぉ ?먮룞 援щ룆 (?꾩쭅 援щ룆?섏? ?딆? 醫낅ぉ留? ?섏씠吏 議고쉶 ???ъ슜)
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
   * ?꾪꽣 ?듦낵 醫낅ぉ ?꾩껜 ?쇨큵 援щ룆 (?쒕쾭 ?쒖옉 ??/ ?ш퀎???꾨즺 ??
   * - DB StockDailyMetrics?먯꽌 rank > 0??醫낅ぉ ?꾩껜瑜?援щ룆
   * - ?대? 援щ룆??醫낅ぉ? ?ㅽ궢
   */
  async subscribeFilteredStocks(): Promise<void> {
    if (!this.realtimeSource.isConnected()) {
      this.logger.warn('WebSocket not connected, skipping bulk subscription');
      return;
    }

    // 理쒖떊 嫄곕옒?쇱쓽 ?꾪꽣 ?듦낵 醫낅ぉ 議고쉶 (rank > 0)
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

    // subscribeBatch: 100醫낅ぉ???⑥씪 REG ?붿껌?쇰줈 ?꾩넚 (媛쒕퀎 ?붿껌 嫄댁닔 珥덇낵 諛⑹?)
    await this.realtimeSource.subscribeBatch(newCodes, ['0B', '0D']);

    // 罹먯떆?먮룄 援щ룆 ?깅줉 (status API 議고쉶 ???뺥솗??諛섏쁺?섎룄濡?
    newCodes.forEach((code) => this.realtimeCache.addSubscription(code));

    this.logger.log(`Bulk subscription completed: ${newCodes.length} stocks submitted`);
  }

  /**
   * 罹붾뱾 ?쒓컙 ?뚯떛 (YYYYMMDDHHmmss)
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
   * 媛寃??뚯떛 (遺???쒓굅)
   */
  private parsePrice(priceStr: string): number {
    return parseFloat(priceStr.replace(/[+\-]/g, ''));
  }

  /**
   * ?좎쭨 ?뚯떛 (YYYYMMDD ??Date)
   * ka10081/ka20006 紐⑤몢 dt = ?ㅼ젣 嫄곕옒?쇱쓣 諛섑솚?섎?濡?洹몃?濡??ъ슜
   */
  private parseDateOnly(dateStr: string): Date {
    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6)) - 1;
    const day = parseInt(dateStr.substring(6, 8));
    return new Date(Date.UTC(year, month, day));
  }

  private parseIndexDate(dateStr: string): Date {
    return this.parseDateOnly(dateStr);
  }

  private getKstParts(now: Date = new Date()): { kstNow: Date; kstHours: number; kstMinutes: number } {
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return {
      kstNow,
      kstHours: kstNow.getUTCHours(),
      kstMinutes: kstNow.getUTCMinutes(),
    };
  }

  private todayKstDateOnly(now: Date = new Date()): Date {
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));
  }

  /**
   * ?쇰퀎 吏??怨꾩궛 (諛곗튂 ?묒뾽)
   */
  async calculateDailyMetrics(marketType: '0' | '10' | 'all' = 'all', tradeDate?: string, writeLogFile: boolean = false) {
    this.logger.log(`Starting daily metrics calculation for market type: ${marketType}, date: ${tradeDate || 'today'}`);
    const parsedTradeDate = tradeDate
      ? /^\d{8}$/.test(tradeDate)
        ? `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
        : tradeDate
      : undefined;
    // 罹붾뱾? UTC 15:00????λ릺誘濡??좎쭨 臾몄옄?댁쓣 T15:00:00Z濡??뚯떛?댁빞 ?뱀씪 罹붾뱾 ?ы븿
    const date = parsedTradeDate ? new Date(`${parsedTradeDate}T15:00:00.000Z`) : undefined;

    // ??긽 KOSPI + KOSDAQ ?듯빀 ??궧 (?쒖쐞???꾩껜 ??먯꽌 留ㅺ린怨? ?쒖옣蹂?議고쉶 ???꾪꽣留?
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

    // ?섎룞 ?ш퀎????珥덇린???곹깭 媛깆떊
    this.initializationComplete = true;
    this.lastDataUpdate = new Date();

    // ?ш퀎?????덈줈 ?꾪꽣 ?듦낵??醫낅ぉ 援щ룆 媛깆떊 (諛깃렇?쇱슫??
    this.subscribeFilteredStocks().catch((error) => {
      this.logger.warn(`Post-metrics bulk subscription failed: ${(error as Error).message}`);
    });

    return result;
  }
}
