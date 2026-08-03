import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { StockListCacheService, RangeRsRankingCache, CustomRsHistoryCache } from './stock-list-cache.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { mapUpNameToThemeCode } from '../../common/constants/theme-codes';
import { getKrxTradingDateByOffset, isKrxTradingDay } from '../../common/utils/market-calendar.util';
import { buildRankChangePoints, computeCumulativeRankChange, sortWithNullsLast } from './rank-change.util';

type HigherTimeframeCandleType = 'week' | 'month' | 'year';

export type StockListSortBy = 'rs' | 'changeRate' | 'tradingValue' | 'rankChange';

export interface StockListOptions {
  /** 종목명 부분일치 검색어 */
  search?: string;
  /** 정렬 기준 (기본 rs = 시장대비강도 점수 높은 순) */
  sortBy?: StockListSortBy;
  /** 정렬 방향 (rs는 항상 desc) */
  sortOrder?: 'asc' | 'desc';
  /** true면 자동완성용 경량 응답 */
  suggest?: boolean;
}

/** 리스트 플로우 공통 항목 형태 (필터 통과 후) */
interface SortableStockItem {
  stock: { code: string; name: string };
  metrics?: any;
  /** RS 점수 (플로우별 계산값) */
  rsScore?: number;
  /** RS 기준 정렬상의 위치 (1-base). 검색/정렬과 무관한 랭킹 순위 */
  baseRank?: number;
}
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
    private readonly stockListCache: StockListCacheService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * - openPrice/closePrice 필드 : 비수정가 (upd_stkpc_tp='0')
   * - 데이터 없음: 52주(365일)씩 수집 (최초 기동 시)
   * - 데이터 있음: 마지막 데이터~최신 거래일까지 수집
   */
  async onModuleInit() {
    this.logger.log('Starting data initialization on server startup...');

    // 비동기적으로 백그라운드에서 초기화 실행 (서버 시작을 블로킹하지 않음)
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
   * 데이터 초기화 (캔들 수집 + 지표 계산)
   * - DB에 데이터가 없으면 52주(365일)씩 수집
   * - DB에 데이터가 있으면 마지막 데이터 날짜~최신 거래일 기간만 수집
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
      const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // 평일

      // DB에서 마지막 캔들 데이터 날짜 조회
      const lastCandleDate = await this.chartStorage.getLatestDayCandleDate();
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);

      let daysToFetch: number;
      let shouldSkipCollection = false;

      // 이전 거래일 계산 (가장 최근 거래일로 거슬러)
      const getPrevTradingDay = (): Date => {
        const d = new Date(today);
        d.setDate(d.getDate() - 1);
        while (d.getDay() === 0 || d.getDay() === 6) {
          d.setDate(d.getDate() - 1);
        }
        return d;
      };

      // 수집 기준일 결정:
      // - 장마감 후 (평일 15:30 이후): 최신 거래일 수집 포함 (오늘 캔들 가능)
      // - 그 외 (장중 혹은 주말): 이전 캔들까지 수집 (오늘 미확정 캔들 제외)
      const isAfterMarketClose = isWeekday && (currentHour > 15 || (currentHour === 15 && currentMinute > 30));
      const collectionTargetDate = isAfterMarketClose ? today : getPrevTradingDay();

      this.logger.log(
        `Collection mode: ${isAfterMarketClose ? '장마감 후 (오늘 포함)' : '장중 이전 (어제 기준)'}, target: ${collectionTargetDate.toISOString().split('T')[0]}`,
      );

      if (!lastCandleDate) {
        // 데이터가 없으면 52주치 수집 (최초 기동)
        daysToFetch = 365;
        this.logger.log('No existing data found. Fetching 52 weeks (365 days)...');
      } else {
        const lastDate = new Date(lastCandleDate);
        lastDate.setUTCHours(0, 0, 0, 0);
        const diffMs = collectionTargetDate.getTime() - lastDate.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) {
          // 이미 최신 데이터까지 갱신 완료
          shouldSkipCollection = true;
          this.logger.log(
            `Data is up to date (last: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}). Skipping collection.`,
          );
        } else {
          // 누락 일수만큼 수집 (API가 일봉을 역순으로 반환하므로 주말/공휴일은 자동 제외)
          daysToFetch = diffDays;
          this.logger.log(
            `Last data: ${lastDate.toISOString().split('T')[0]}, target: ${collectionTargetDate.toISOString().split('T')[0]}, gap: ${diffDays} days. Fetching...`,
          );
        }
      }

      // 데이터 수집 (스킵하지 않는 경우만)
      if (!shouldSkipCollection) {
        // 0. 시장 지수 캔들 수집 (KOSPI + KOSDAQ) - RS 계산에 필요
        this.logger.log('Collecting market index day candles (KOSPI + KOSDAQ)...');
        await this.collectSectorDayCandles('001', 'INDEX_KOSPI');
        await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ');
        // ka20006은 오늘 날짜 데이터 미포함 — 장마감 이후에는 ka20001로 최신 지수 별도 수집
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
        this.logger.log('Market index day candles collected.');

        for (const marketType of marketTypes) {
          const marketName = marketType === '0' ? 'KOSPI' : 'KOSDAQ';
          this.logger.log(`[${marketName}] Collecting day candles (${daysToFetch} days)...`);

          // 1. 캔들 데이터 수집
          const collectResult = await this.collectAllDayCandles(marketType, daysToFetch);
          this.logger.log(`[${marketName}] Day candles collected: ${collectResult.success}/${collectResult.total}`);
        }
      } else {
        this.logger.log('Data collection skipped (already up to date). Recalculating metrics only...');
        // 캔들 수집을 스킵해도 최신 지수 현재가는 항상 갱신 (ka20006 오늘 날짜 미포함)
        if (isAfterMarketClose) {
          await this.collectTodayIndexClose();
        }
      }

      // metrics 계산은 별도 00:05 cron에서만 실행 (initializeData에서는 캔들 수집만)
      this.initializationComplete = true;
      this.lastDataUpdate = new Date();

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      this.logger.log(`=== Data Initialization Completed in ${duration}s ===`);

      // 필터 통과 종목 전체 WebSocket 구독 (비동기)
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
    const currentRankSnapshotMap = mode === 'aggregated'
      ? await this.getLatestCurrentRankSnapshotMap(latest)
      : new Map<string, {
          currentRank: number | null;
          passedDynamicFilters: boolean;
          currentPrice: number;
          snapshotTime: Date;
          priceSource: string;
        }>();
    const passesCurrentDynamicFilters = (row: typeof allRows[number]) => {
      const snapshot = currentRankSnapshotMap.get(row.stockCode);
      if (snapshot) return snapshot.passedDynamicFilters;
      return passesDynamicFilters(row);
    };
    const effectiveCurrentRank = (row: typeof allRows[number]) => {
      const snapshotRank = currentRankSnapshotMap.get(row.stockCode)?.currentRank;
      return snapshotRank ?? row.currentRank ?? row.rank;
    };
    const filteredRows = allRows
      .filter((row) => marketMatches(row))
      .filter((row) => passesCurrentDynamicFilters(row));
    if (mode === 'aggregated') {
      filteredRows.sort(
        (a, b) => effectiveCurrentRank(a) - effectiveCurrentRank(b) || a.stockCode.localeCompare(b.stockCode),
      );
    }
    const totalCount = filteredRows.length;
    const rows = filteredRows.slice((page - 1) * pageSize, page * pageSize);
    const movingAverageMap = await this.getAdminMovingAverageMap(
      rows.map((row) => row.stockCode),
      latest,
    );
    const rsRawMap = await this.getAdminRsRawMap(rows, latest, companyMap);

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
          rank: mode === 'aggregated' ? effectiveCurrentRank(row) : row.rank,
          storedRank: row.rank,
          currentRank: row.currentRank,
          snapshotCurrentRank: currentRankSnapshotMap.get(row.stockCode)?.currentRank ?? null,
          currentRankSnapshotTime: currentRankSnapshotMap.get(row.stockCode)?.snapshotTime ?? null,
          currentPrice: currentRankSnapshotMap.get(row.stockCode)?.currentPrice ?? null,
          currentPriceSource: currentRankSnapshotMap.get(row.stockCode)?.priceSource ?? null,
          closePrice: Number(row.closePrice),
          relativeStrengthScore: Number(row.relativeStrengthScore),
          rsRaw: rsRawMap.get(row.stockCode) ?? null,
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

  private async getAdminRsRawMap(
    rows: Array<{ stockCode: string; closePrice: unknown }>,
    tradeDate: Date,
    companyMap: Map<string, { stockCode: string; companyName: string; marketType: string }>,
  ): Promise<Map<string, number | null>> {
    const result = new Map<string, number | null>();
    if (rows.length === 0) return result;

    const tradeDateStr = tradeDate.toISOString().slice(0, 10);
    const refDateStr = getKrxTradingDateByOffset(tradeDateStr, 63);
    const stockCodes = rows.map((row) => row.stockCode);
    const indexCodes = ['INDEX_KOSPI', 'INDEX_KOSDAQ'];

    const [stockRefs, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          stockCode: { in: stockCodes },
          candleType: 'day',
          candleTime: { lte: new Date(`${refDateStr}T00:00:00.000Z`) },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'desc' }],
        distinct: ['stockCode'],
        select: {
          stockCode: true,
          closePrice: true,
          adjClosePrice: true,
        },
      }),
      this.prisma.stockCandle.findMany({
        where: {
          stockCode: { in: indexCodes },
          candleType: 'day',
          candleTime: {
            in: [
              new Date(`${tradeDateStr}T00:00:00.000Z`),
              new Date(`${refDateStr}T00:00:00.000Z`),
            ],
          },
        },
        select: {
          stockCode: true,
          candleTime: true,
          closePrice: true,
          adjClosePrice: true,
        },
      }),
    ]);

    const stockRefMap = new Map(stockRefs.map((candle) => [
      candle.stockCode,
      Number(candle.adjClosePrice ?? candle.closePrice),
    ]));
    const indexMap = new Map<string, number>();
    for (const candle of indexCandles) {
      indexMap.set(`${candle.stockCode}:${candle.candleTime.toISOString().slice(0, 10)}`, Number(candle.adjClosePrice ?? candle.closePrice));
    }

    for (const row of rows) {
      const company = companyMap.get(row.stockCode);
      const indexCode = company?.marketType === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI';
      const closePrice = Number(row.closePrice);
      const close63Ago = stockRefMap.get(row.stockCode);
      const idxCloseNow = indexMap.get(`${indexCode}:${tradeDateStr}`);
      const idx63Ago = indexMap.get(`${indexCode}:${refDateStr}`);

      if (!close63Ago || !idxCloseNow || !idx63Ago || close63Ago <= 0 || idx63Ago <= 0) {
        result.set(row.stockCode, null);
        continue;
      }

      result.set(row.stockCode, (closePrice / close63Ago) / (idxCloseNow / idx63Ago));
    }

    return result;
  }

  private async getLatestCurrentRankSnapshotMap(tradeDate: Date): Promise<Map<string, {
    currentRank: number | null;
    passedDynamicFilters: boolean;
    currentPrice: number;
    snapshotTime: Date;
    priceSource: string;
  }>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      stock_code: string;
      current_rank: number | null;
      passed_dynamic_filters: boolean;
      current_price: string;
      snapshot_time: Date;
      price_source: string;
    }>>(
      `
        WITH latest AS (
          SELECT snapshot_time
          FROM stock_current_rank_snapshots
          WHERE trade_date = $1::date
          ORDER BY snapshot_time DESC
          LIMIT 1
        )
        SELECT
          s.stock_code,
          s.current_rank,
          s.passed_dynamic_filters,
          s.current_price::text,
          s.snapshot_time,
          s.price_source
        FROM stock_current_rank_snapshots s
        JOIN latest ON latest.snapshot_time = s.snapshot_time
        WHERE s.trade_date = $1::date
      `,
      tradeDate.toISOString().slice(0, 10),
    );

    return new Map(rows.map((row) => [
      row.stock_code,
      {
        currentRank: row.current_rank,
        passedDynamicFilters: row.passed_dynamic_filters,
        currentPrice: Number(row.current_price),
        snapshotTime: row.snapshot_time,
        priceSource: row.price_source,
      },
    ]));
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
        stockCodes: subscribedStocks.slice(0, 20), // 최대 20개까지 표시
      },
      cache: cacheStats,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 실시간 데이터 스트림 연결 확인
   * (필요 시간에 WebSocket 연결 확인 및 재연결)
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
   * 분봉 차트 데이터 조회 (실시간 데이터)
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
   * 틱봉 차트 데이터 조회
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

    const recentCandles = kiwoomData.stk_dt_pole_chart_qry.slice(0, days); // 최근 N개만

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
        // kiwoom getDayCandles는 upd_stkpc_tp='1'(수정주가)로 요청하므로 adj 필드도 동일값 사용
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
   * 종목 요약 정보 (현재가, 전일대비, 캔들, 캔들용 1주 고가, 52주 고가)
   */
  async getStockSummary(stockCode: string) {
    const today = this.formatDateToYYYYMMDD(this.todayKstDateOnly());
    const realtimePrice = this.getUsableRealtimePrice(this.realtimeCache.getPrice(stockCode));

    const [kiwoomData, dbCandles, company, basicInfo] = await Promise.all([
      this.kiwoomRest.getDayCandles(stockCode, today).catch((error) => {
        this.logger.warn(`Kiwoom day summary unavailable for ${stockCode}: ${error.message}`);
        return null;
      }),
      this.prisma.stockCandle.findMany({
        where: { stockCode, candleType: 'day' },
        orderBy: { candleTime: 'desc' },
        take: 2,
      }),
      this.prisma.company.findFirst({
        where: { stockCode, deletedAt: null },
        select: { listedShares: true },
      }),
      this.kiwoomRest.getStockBasicInfo(stockCode).catch((error) => {
        this.logger.warn(`Kiwoom market cap unavailable for ${stockCode}: ${error.message}`);
        return null;
      }),
    ]);

    const latest = kiwoomData?.stk_dt_pole_chart_qry?.[0] ?? null;
    const latestDbCandle = dbCandles[0] ?? null;
    const previousDbCandle = dbCandles[1] ?? null;
    const realtimeCurrentPrice = Number(realtimePrice?.currentPrice ?? 0);
    const dbCurrentPrice = latestDbCandle ? Number(latestDbCandle.closePrice) : 0;
    const kiwoomCurrentPrice = latest ? this.parsePrice(latest.cur_prc) : 0;
    const currentPrice =
      realtimeCurrentPrice > 0 ? realtimeCurrentPrice :
      dbCurrentPrice > 0 ? dbCurrentPrice :
      kiwoomCurrentPrice;

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      throw new Error(`No candle data for ${stockCode}`);
    }

    const previousDbClose = previousDbCandle ? Number(previousDbCandle.closePrice) : null;
    const kiwoomPrevDayCompareAbs = latest ? this.parsePrice(latest.pred_pre) : 0;
    const kiwoomSig = latest?.pred_pre_sig;
    const kiwoomPrevDayCompare = (kiwoomSig === '4' || kiwoomSig === '5') ? -kiwoomPrevDayCompareAbs : kiwoomPrevDayCompareAbs;
    const prevDayCompare =
      realtimePrice ? Number(realtimePrice.changeAmount) :
      previousDbClose != null && previousDbClose > 0 ? currentPrice - previousDbClose :
      kiwoomPrevDayCompare;
    const changeRate =
      realtimePrice ? Number(realtimePrice.changeRate).toFixed(2) :
      previousDbClose != null && previousDbClose > 0 ? (((currentPrice - previousDbClose) / previousDbClose) * 100).toFixed(2) :
      currentPrice - kiwoomPrevDayCompare !== 0 ? ((kiwoomPrevDayCompare / (currentPrice - kiwoomPrevDayCompare)) * 100).toFixed(2) :
      '0.00';
    const prevDayCompareSign =
      latest?.pred_pre_sig ??
      (prevDayCompare > 0 ? '2' : prevDayCompare < 0 ? '5' : '3');

    const listedShares = company?.listedShares ?? null;
    const kiwoomMarketCap = this.extractKiwoomMarketCap(basicInfo);
    const marketCap = kiwoomMarketCap;

    // 2. DB 기반 일봉 및 52주 고가 계산
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
      prevDayCompareSign,
      changeRate,
      volume: realtimePrice?.accVolume ?? latestDbCandle?.volume?.toString() ?? latest?.trde_qty ?? null,
      tradingValue: realtimePrice
        ? this.normalizeTradingValueToWon(realtimePrice.accAmount).toString()
        : latestDbCandle?.tradingValue?.toString() ?? latest?.trde_prica ?? null,
      listedShares: listedShares ? Number(listedShares) : null,
      marketCap,
      marketCapSource: marketCap != null ? 'kiwoom' : null,
      dayHigh: realtimePrice?.highPrice ?? (latestDbCandle ? Number(latestDbCandle.highPrice) : latest ? this.parsePrice(latest.high_pric) : currentPrice),
      dayLow: realtimePrice?.lowPrice ?? (latestDbCandle ? Number(latestDbCandle.lowPrice) : latest ? this.parsePrice(latest.low_pric) : currentPrice),
      week52High,
      week52Low,
    };
  }

  /**
   * 종목 리스트 조회 (필터링된 페이지네이션 + 지표 정보)
   *
   * @param rsPeriods - RS 계산 기간 (예: "63,126,252"), 없으면 기본 RS(63일) 사용
   * @param rsWeights - RS 가중치 (예: "50,30,20"), rsPeriods와 쌍으로 사용
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
    options?: StockListOptions,
  ) {
    this.logger.log(
      `Getting stock list for market type: ${marketType}, page: ${page}, pageSize: ${pageSize}, filters: ${JSON.stringify(filters)}, rsPeriods: ${rsPeriods}, rsWeights: ${rsWeights}, rsDates: ${rsDates}, options: ${JSON.stringify(options)}`,
    );

    // rsDates가 있으면 날짜를 기간수로 변환
    let calculatedPeriods = rsPeriods;
    if (rsDates && rsWeights) {
      calculatedPeriods = this.convertDatesToPeriods(rsDates);
      this.logger.log(`Converted dates ${rsDates} to periods: ${calculatedPeriods}`);
    }

    // 커스텀 RS 요청인 경우 동적 계산
    if (calculatedPeriods && rsWeights) {
      return this.getStockListWithCustomRS(
        marketType,
        page,
        pageSize,
        filters,
        calculatedPeriods,
        rsWeights,
        options,
      );
    }

    // 기본값 RS(63일) - 기존 플로우

    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    // 최신 지표 데이터 조회 (전체 종목)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (페이지네이션, 속도)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트에 지표 필터링 및 종가
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
        // 정적 필터 통과 여부 (지수값은 계산, DB 저장)
        if (!item.metrics?.passedStaticFilters) return false;

        // 동적 필터: 현재가 기준 실시간 적용 (실시간 가격 우선, 없으면 지수)
        const realtimePrice = this.getUsableRealtimePrice(allRealtimePrices.get(item.stock.code));
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;

        const low52w = item.metrics.lowPrice52w;
        const high52w = item.metrics.highPrice52w;
        const ma50 = item.metrics.ma50;

        // DF1: 현재가 >= 52주저가 × 1.3
        if (low52w != null && currentPrice < low52w * 1.3) return false;
        // DF2: 현재가 >= 52주고가 × 0.75
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
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => {
        // 1차 rsScore 내림차순 (점수 높은게 우선)
        const scoreDiff = b.rsScore - a.rsScore;
        if (scoreDiff !== 0) return scoreDiff;
        // 2차 현재 순위 오름차순 (동일 점수일 때 낮은 순위가 우선)
        const aRank = a.metrics?.currentRank ?? a.metrics?.rank ?? 999999;
        const bRank = b.metrics?.currentRank ?? b.metrics?.rank ?? 999999;
        const rankDiff = aRank - bRank;
        if (rankDiff !== 0) return rankDiff;
        // 3차 종목코드 오름차순 (완전 동률 시 결정론적 정렬)
        return a.stock.code.localeCompare(b.stock.code);
      });

    // RS 기준 위치 부여 (검색/정렬과 무관한 랭킹 순위) + 순위변동 계산용 전체 종목수
    const rankedStocks = stocksWithMetrics.map((item, index) => ({ ...item, baseRank: index + 1 }));
    const baseTotal = rankedStocks.length;

    // 최신 거래일 조회 (메타 데이터 및 순위 이력용)
    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const rankTotals = await this.metricsService.getCurrentRankTotals(3, latestTradeDate, this.isAfterAggregation());

    // 정렬기준 적용 (순위변동 정렬 시 전체 대상의 누적값 선계산)
    let rankChangeMap: Map<string, number | null> | undefined;
    if (options?.sortBy === 'rankChange') {
      rankChangeMap = await this.computeRankChangeMap(rankedStocks, baseTotal, latestTradeDate, rankTotals);
    }
    // 검색은 필터일 뿐이므로, 전체 리스트를 먼저 정렬해 표시 순위(displayRank)를 확정한 뒤
    // 검색을 적용한다 → 검색 결과에도 검색 전 리스트의 순위가 그대로 보인다.
    const sortedAll = this.sortStockItems(rankedStocks, options, {
      realtimePrices: allRealtimePrices,
      rankChangeMap,
    }).map((item, index) => ({ ...item, displayRank: index + 1 }));

    // 종목명 검색 (현재 랭킹 결과 내 부분일치, 순위 유지)
    const sortedStocks = this.applyStockNameSearch(sortedAll, options?.search);

    // 자동완성용 경량 응답
    if (options?.suggest) {
      return await this.buildSuggestResponse(sortedStocks, options);
    }

    // 페이지 처리 (페이지네이션)
    const totalCount = sortedStocks.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = sortedStocks.slice(startIndex, endIndex);

    // 페이지네이션된 종목들의 지수 및 순위 변화 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    // 자동 실시간 구독 (비동기적으로 백그라운드 실행)
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // 실시간 현재가 (이미 allRealtimePrices로 있음)
    const realtimePrices = allRealtimePrices;

    const currentRankHistoryMap = await this.metricsService.getCurrentRankHistory(pageStockCodes, 3, latestTradeDate, this.isAfterAggregation());
    const themeList = await this.getNaverThemeList();
    return {
      marketType,
      page,
      pageSize,
      totalCount,
      totalPages,
      count: paginatedData.length,
      // 메타 데이터: 데이터 기준일과 갱신 정보
      meta: {
        dataDate: latestTradeDate?.toISOString().split('T')[0] || null, // 데이터 기준 거래일
        lastUpdatedAt: this.lastDataUpdate?.toISOString() || null, // 마지막 데이터 갱신 시간
        isInitialized: this.initializationComplete, // 초기화 완료 여부
        queryStartDate: latestTradeDate ? getKrxTradingDateByOffset(latestTradeDate.toISOString().slice(0, 10), 63) : null,
        queryEndDate: latestTradeDate?.toISOString().split('T')[0] || null,
      },
      themeList,
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const currentRankHistory = currentRankHistoryMap.get(s.code) || [];

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = this.buildInvestmentIndicators(metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: item.displayRank,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? '코스피' : this.isKosdaqStock(s) ? '코스닥' : '-',
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
            today: item.displayRank,
            oneDayAgo: currentRankHistory[0] ?? null,
            twoDaysAgo: currentRankHistory[1] ?? null,
            threeDaysAgo: currentRankHistory[2] ?? null,
          },
          rankChange3d: rankChangeMap
            ? rankChangeMap.get(s.code) ?? null
            : this.buildRankChangeValue(currentRankHistory, rankTotals, item.baseRank ?? null, baseTotal),
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 커스텀 RS 설정으로 종목 리스트 조회 (동적 계산)
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
    options?: StockListOptions,
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
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    // 최신 거래일 조회 (캐시 키·메타 데이터·순위 이력용)
    const latestTradeDate = await this.metricsService.getLatestTradeDate();

    // 동적 RS 계산 (최근 4개 거래일: 오늘, D-1, D-2, D-3) — dataDate 기준 캐시 + in-flight dedupe
    const rsHistoryMap = await this.getOrComputeCustomRsHistory(
      validStocks,
      allStockCodes,
      periods,
      weights,
      marketType,
      latestTradeDate,
    );

    // 기본 지표 데이터 조회 (ma50, 52w 고가, isNewHigh, tradingValue 등)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (코스피, 코스닥)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트에 RS 필터링 및 종가
    const stocksWithRS = validStocks
      .map((s) => {
        const rsHistory = rsHistoryMap.get(s.code);
        const metrics = metricsMap.get(s.code);

        // 오늘 (첫번째) RS를 점수로
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
        const realtimePrice = this.getUsableRealtimePrice(allRealtimePrices.get(item.stock.code));
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
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank); // 점수 오름차순 (이미 계산됨)

    // RS 기준 위치 부여 (검색/정렬과 무관한 랭킹 순위)
    const rankedStocks = stocksWithRS.map((item, index) => ({ ...item, baseRank: index + 1 }));
    const baseTotal = rankedStocks.length;

    const rankTotals = await this.metricsService.getCurrentRankTotals(3, latestTradeDate, this.isAfterAggregation());

    // 정렬기준 적용 (전체 대상) → 표시 순위 확정 → 종목명 검색 (순위 유지)
    let rankChangeMap: Map<string, number | null> | undefined;
    if (options?.sortBy === 'rankChange') {
      rankChangeMap = await this.computeRankChangeMap(rankedStocks, baseTotal, latestTradeDate, rankTotals);
    }
    const sortedAll = this.sortStockItems(rankedStocks, options, {
      realtimePrices: allRealtimePrices,
      rankChangeMap,
    }).map((item, index) => ({ ...item, displayRank: index + 1 }));
    const sortedStocks = this.applyStockNameSearch(sortedAll, options?.search);

    // 자동완성용 경량 응답
    if (options?.suggest) {
      return await this.buildSuggestResponse(sortedStocks, options);
    }

    // 페이지네이션
    const totalCount = sortedStocks.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = sortedStocks.slice(startIndex, endIndex);

    // 페이지네이션된 종목들의 지수 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    // 자동 실시간 구독
    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    // 실시간 현재가 (이미 allRealtimePrices로 있음)
    const realtimePrices = allRealtimePrices;

    const currentRankHistoryMap = await this.metricsService.getCurrentRankHistory(pageStockCodes, 3, latestTradeDate, this.isAfterAggregation());
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
        queryStartDate: latestTradeDate ? (() => { const maxPeriod = periods.length > 0 ? Math.max(...periods) : 63; return getKrxTradingDateByOffset(latestTradeDate.toISOString().slice(0, 10), maxPeriod); })() : null,
        queryEndDate: latestTradeDate?.toISOString().split('T')[0] || null,
        customRS: { periods, weights },
      },
      themeList: await this.getNaverThemeList(),
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const currentRankHistory = currentRankHistoryMap.get(s.code) || [];

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = this.buildInvestmentIndicators(metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: item.displayRank,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? '코스피' : this.isKosdaqStock(s) ? '코스닥' : '-',
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
            today: item.displayRank,
            oneDayAgo: currentRankHistory[0] ?? null,
            twoDaysAgo: currentRankHistory[1] ?? null,
            threeDaysAgo: currentRankHistory[2] ?? null,
          },
          rankChange3d: rankChangeMap
            ? rankChangeMap.get(s.code) ?? null
            : this.buildRankChangeValue(currentRankHistory, rankTotals, item.baseRank ?? null, baseTotal),
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 종목 리스트 조회 (기간 기반 RS 필터)
   * rsFilters 배열에 담긴 각 기간의 RS를 계산하고 가중치를 적용
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
    options?: StockListOptions,
  ) {
    const _mem0 = process.memoryUsage();
    this.logger.log(
      `[getStockListWithRangeRS] START filters=${JSON.stringify(rsFilters)} ` +
      `heap=${Math.round(_mem0.heapUsed/1024/1024)}MB/${Math.round(_mem0.heapTotal/1024/1024)}MB rss=${Math.round(_mem0.rss/1024/1024)}MB`,
    );

    // rsFilters가 없으면 기본 플로우 사용
    if (!rsFilters || rsFilters.length === 0) {
      return this.getStockList(marketType, page, pageSize, filters, undefined, undefined, undefined, options);
    }

    // 종목 리스트 가져오기
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const themeFilteredStockCodes = await this.getThemeFilteredStockCodes(filters?.theme);

    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const periods = await this.metricsService.resolveTradingPeriodsFromRanges(rsFilters, 'INDEX_KOSPI');
    const weights = rsFilters.map((filter) => filter.strength);
    const tradeDateForLog = latestTradeDate
      ? latestTradeDate.toISOString().split('T')[0].replace(/-/g, '')
      : undefined;
    const dataDate = latestTradeDate?.toISOString().split('T')[0] ?? null;
    const cacheKey = this.stockListCache.buildRangeRsCacheKey({
      dataDate,
      marketType,
      periods,
      weights,
      rsFilters,
    });

    let rsRankingCache = await this.stockListCache.getRangeRsRankingCache(cacheKey);
    if (rsRankingCache) {
      this.logger.log(
        `[getStockListWithRangeRS] cache hit key=${cacheKey} rows=${rsRankingCache.rows.length}`,
      );
    } else {
      let rsFilterPromise = this.stockListCache.getInflight(cacheKey);
      if (!rsFilterPromise) {
        rsFilterPromise = this.metricsService.calculateRsFilterLog(
          allStockCodes,
          tradeDateForLog,
          periods.join(','),
          weights.join(','),
        )
          .then((result) => ({
            dataDate,
            marketType,
            periods,
            weights,
            logFile: result.logFile,
            rows: result.rows.map((row) => ({
              stockCode: row.stockCode,
              rank: row.rank,
              rsScore: row.rsScore,
            })),
            createdAt: new Date().toISOString(),
          } satisfies RangeRsRankingCache))
          .finally(() => this.stockListCache.deleteInflight(cacheKey));
        this.stockListCache.setInflight(cacheKey, rsFilterPromise);
      } else {
        this.logger.log(`[getStockListWithRangeRS] reusing in-flight RS calculation (key=${cacheKey})`);
      }

      rsRankingCache = await rsFilterPromise;
      await this.stockListCache.setRangeRsRankingCache(cacheKey, rsRankingCache);
    }

    this.logger.log(`Converted range filters to periods: ${periods}, weights: ${weights}`);

    const rsHistoryMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();
    for (const row of rsRankingCache.rows) {
      rsHistoryMap.set(row.stockCode, [{
        tradeDate: latestTradeDate ?? new Date(),
        rank: row.rank,
        rsScore: row.rsScore,
      }]);
    }

    // 기본 지표 데이터 조회 (ma50, 52w 고가, isNewHigh, tradingValue 등)
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);

    // 실시간 캐시에서 전체 종목 현재가 조회 (코스피, 코스닥)
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    // 종목 리스트에 RS 필터링 및 종가
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
          if (!this.matchesTheme(item.stock.code, stockTheme, filters.theme, themeFilteredStockCodes)) return false;
        }

        return true;
      })
      .sort((a, b) => a.rank - b.rank);

    // RS 기준 위치 부여 (검색/정렬과 무관한 랭킹 순위)
    const rankedStocks = stocksWithRS.map((item, index) => ({ ...item, baseRank: index + 1 }));
    const baseTotal = rankedStocks.length;

    const rankTotals = await this.metricsService.getCurrentRankTotals(3, latestTradeDate, this.isAfterAggregation());

    // 정렬기준 적용 (전체 대상) → 표시 순위 확정 → 종목명 검색 (순위 유지)
    let rankChangeMap: Map<string, number | null> | undefined;
    if (options?.sortBy === 'rankChange') {
      rankChangeMap = await this.computeRankChangeMap(rankedStocks, baseTotal, latestTradeDate, rankTotals);
    }
    const sortedAll = this.sortStockItems(rankedStocks, options, {
      realtimePrices: allRealtimePrices,
      rankChangeMap,
    }).map((item, index) => ({ ...item, displayRank: index + 1 }));
    const sortedStocks = this.applyStockNameSearch(sortedAll, options?.search);

    // 자동완성용 경량 응답
    if (options?.suggest) {
      return await this.buildSuggestResponse(sortedStocks, options);
    }

    // 페이지네이션
    const totalCount = sortedStocks.length;
    const totalPages = Math.ceil(totalCount / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedData = sortedStocks.slice(startIndex, endIndex);

    // 지수 및 실시간 가격 조회
    const pageStockCodes = paginatedData.map((d) => d.stock.code);
    const closingPrices = await this.chartStorage.getLatestClosingPrices(pageStockCodes);
    const naverThemesMap = await this.getNaverThemesByStockCodes(pageStockCodes);

    this.autoSubscribeStocks(pageStockCodes).catch((error) => {
      this.logger.warn(`Auto-subscribe failed: ${error.message}`);
    });

    const realtimePrices = allRealtimePrices;
    const themeList = await this.getNaverThemeList();
    const currentRankHistoryMap = await this.metricsService.getCurrentRankHistory(pageStockCodes, 3, latestTradeDate, this.isAfterAggregation());

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
        rangeRS: { filters: rsFilters, periods, weights, logFile: rsRankingCache.logFile },
      },
      themeList,
      stocks: await Promise.all(paginatedData.map(async (item, index) => {
        const s = item.stock;
        const metrics = item.metrics;
        const currentRankHistory = currentRankHistoryMap.get(s.code) || [];

        const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(s.code));
        const dbPrice = metrics?.closePrice || closingPrices.get(s.code) || 0;
        const priceChangeRateText = this.formatPriceChangeRateText(realtimePrice, metrics);
        const investmentIndicators = this.buildInvestmentIndicators(metrics);
        const investmentIndicatorsText = this.formatInvestmentIndicators(investmentIndicators);
        const naverThemes = naverThemesMap.get(s.code) ?? [];
        const naverThemeText = naverThemes.map((theme) => theme.themeName).join(', ');
        const displayTheme = this.formatDisplayTheme(naverThemes, s.upName);

        return {
          id: s.code,
          rank: item.displayRank,
          companyName: s.name,
          stockCode: s.code,
          currentPrice: realtimePrice?.currentPrice || dbPrice,
          exchange: this.isKospiStock(s) ? '코스피' : this.isKosdaqStock(s) ? '코스닥' : '-',
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
            today: item.displayRank,
            oneDayAgo: currentRankHistory[0] ?? null,
            twoDaysAgo: currentRankHistory[1] ?? null,
            threeDaysAgo: currentRankHistory[2] ?? null,
          },
          rankChange3d: rankChangeMap
            ? rankChangeMap.get(s.code) ?? null
            : this.buildRankChangeValue(currentRankHistory, rankTotals, item.baseRank ?? null, baseTotal),
          isVolatilityContraction: metrics?.isVolatilityContraction ?? false,
          isPriceCompression: metrics?.isPriceCompression ?? false,
          strengthContinuationDays: metrics?.strengthContinuationDays ?? null,
          isTrendTemplate: investmentIndicators.some((indicator) => indicator.type === 'TREND_TEMPLATE'),
        };
      })),
    };
  }

  /**
   * 종목 리스트 가져오기 (캐시 사용)
   * 'all'인 경우 KOSPI + KOSDAQ 전체 가져와서 필터링
   *
   * marketType 정의:
   *   '0'   = KOSPI (키움 API 그대로)
   *   '10'  = KOSDAQ (키움 API 그대로)
   *   'all' = 전체 (KOSPI + KOSDAQ 합산)
   */

  async getDefaultStockDisplayRankMap(
    targetStockCodes: string[],
    marketType: '0' | '10' | 'all' = 'all',
  ): Promise<Map<string, number>> {
    if (targetStockCodes.length === 0) return new Map();

    const targetSet = new Set(targetStockCodes);
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const metricsMap = await this.metricsService.getLatestMetrics(allStockCodes);
    const allRealtimePrices = this.realtimeCache.getPrices(allStockCodes);

    const rankedStocks = validStocks
      .map((stock) => {
        const metrics = metricsMap.get(stock.code);
        return {
          stock,
          metrics,
          rsScore: metrics?.relativeStrengthScore || 0,
        };
      })
      .filter((item) => {
        if (!item.metrics?.passedStaticFilters) return false;

        const realtimePrice = this.getUsableRealtimePrice(allRealtimePrices.get(item.stock.code));
        const currentPrice = realtimePrice?.currentPrice || item.metrics?.closePrice || 0;
        const low52w = item.metrics.lowPrice52w;
        const high52w = item.metrics.highPrice52w;
        const ma50 = item.metrics.ma50;

        if (low52w != null && currentPrice < low52w * 1.3) return false;
        if (high52w != null && currentPrice < high52w * 0.75) return false;
        if (ma50 != null && currentPrice <= ma50) return false;
        return true;
      })
      .sort((a, b) => {
        const aRank = a.metrics?.currentRank ?? a.metrics?.rank ?? 999999;
        const bRank = b.metrics?.currentRank ?? b.metrics?.rank ?? 999999;
        const rankDiff = aRank - bRank;
        if (rankDiff !== 0) return rankDiff;
        return b.rsScore - a.rsScore;
      });

    const displayRankMap = new Map<string, number>();
    rankedStocks.forEach((item, index) => {
      if (targetSet.has(item.stock.code)) {
        displayRankMap.set(item.stock.code, index + 1);
      }
    });
    return displayRankMap;
  }

  /** RS 프리셋 조합 (1주/1개월/3개월/6개월/12개월, 비중 100%) — 워밍 대상 */
  private static readonly RS_PRESET_PERIODS = [5, 21, 63, 126, 252];

  /**
   * 커스텀 RS(rsPeriods/rsWeights) 계산 결과 캐시 조회/계산.
   * 키 = dataDate + marketType + periods/weights 해시. 동일 키 동시 요청은 in-flight dedupe.
   * - forceRefresh: 캐시를 무시하고 재계산 (배치 직후 워밍용 — 배치 전 값이 남아있을 수 있음)
   * - ttlMs: 미지정 시 5분. 장 마감 후 데이터가 고정된 구간에는 긴 TTL 지정 가능
   */
  private async getOrComputeCustomRsHistory(
    validStocks: any[],
    allStockCodes: string[],
    periods: number[],
    weights: number[],
    marketType: '0' | '10' | 'all',
    latestTradeDate: Date | null,
    cacheOptions?: { ttlMs?: number; forceRefresh?: boolean },
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    const dataDate = latestTradeDate?.toISOString().split('T')[0] ?? null;
    const cacheKey = this.stockListCache.buildCustomRsCacheKey({ dataDate, marketType, periods, weights });

    let cache = cacheOptions?.forceRefresh
      ? null
      : await this.stockListCache.getCustomRsHistoryCache(cacheKey);

    if (cache) {
      this.logger.log(`[customRS] cache hit key=${cacheKey} rows=${cache.rows.length}`);
    } else {
      let inflight = this.stockListCache.getCustomRsInflight(cacheKey);
      if (!inflight) {
        inflight = this.computeCustomRsHistoryMap(validStocks, allStockCodes, periods, weights, marketType)
          .then((historyMap) => ({
            dataDate,
            marketType,
            periods,
            weights,
            rows: Array.from(historyMap.entries()).map(([stockCode, history]) => ({
              stockCode,
              history: history.map((h) => ({
                tradeDate: h.tradeDate.toISOString(),
                rank: h.rank,
                rsScore: h.rsScore,
              })),
            })),
            createdAt: new Date().toISOString(),
          } satisfies CustomRsHistoryCache))
          .finally(() => this.stockListCache.deleteCustomRsInflight(cacheKey));
        this.stockListCache.setCustomRsInflight(cacheKey, inflight);
      } else {
        this.logger.log(`[customRS] reusing in-flight calculation (key=${cacheKey})`);
      }
      cache = await inflight;
      await this.stockListCache.setCustomRsHistoryCache(cacheKey, cache, cacheOptions?.ttlMs);
    }

    return new Map(
      cache.rows.map((row) => [
        row.stockCode,
        row.history.map((h) => ({ tradeDate: new Date(h.tradeDate), rank: h.rank, rsScore: h.rsScore })),
      ]),
    );
  }

  /**
   * 동적 RS 계산 (최근 4개 거래일: 오늘, D-1, D-2, D-3)
   * 'all'은 KOSPI/KOSDAQ 각각 해당 시장 지수로 계산 후 병합
   */
  private async computeCustomRsHistoryMap(
    validStocks: any[],
    allStockCodes: string[],
    periods: number[],
    weights: number[],
    marketType: '0' | '10' | 'all',
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    if (marketType === 'all') {
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

      return new Map([...kospiRS, ...kosdaqRS]);
    }

    const indexCode = marketType === '0' ? 'INDEX_KOSPI' : 'INDEX_KOSDAQ';
    return await this.metricsService.calculateRuntimeRS(allStockCodes, periods, weights, indexCode, 4);
  }

  /**
   * 다음 KRX 개장(09:00 KST)까지 남은 ms.
   * 장 마감 후 확정 데이터는 다음 개장 전까지 변하지 않으므로 워밍 캐시 TTL로 사용.
   */
  private msUntilNextKrxMarketOpen(): number {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const now = new Date();

    for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
      const candidate = new Date(now.getTime() + dayOffset * DAY_MS);
      const kstDateStr = new Date(candidate.getTime() + 9 * HOUR_MS).toISOString().slice(0, 10);
      const openAt = new Date(`${kstDateStr}T09:00:00+09:00`);
      if (openAt > now && isKrxTradingDay(openAt)) {
        return openAt.getTime() - now.getTime();
      }
    }
    // 달력 데이터 없음 등 비정상 상황 폴백: 12시간
    return 12 * HOUR_MS;
  }

  /**
   * 프리셋 RS 캐시 워밍 (일 배치 지표 확정 후 호출).
   * 배치 전에 캐시된 값이 남아있을 수 있어 forceRefresh로 재계산하고,
   * 다음 개장까지 TTL을 늘려 저장한다. 개장 후에는 만료되어 기본 5분 TTL 흐름으로 복귀.
   */
  async warmCustomRsPresetCache(
    marketType: '0' | '10' | 'all' = 'all',
  ): Promise<{ warmed: number[]; failed: number[]; ttlMs: number }> {
    const validStocks = await this.fetchStockList(marketType);
    const allStockCodes = validStocks.map((s) => s.code);
    const latestTradeDate = await this.metricsService.getLatestTradeDate();
    const ttlMs = this.msUntilNextKrxMarketOpen();

    const warmed: number[] = [];
    const failed: number[] = [];
    for (const period of RealTimeChartService.RS_PRESET_PERIODS) {
      try {
        await this.getOrComputeCustomRsHistory(
          validStocks,
          allStockCodes,
          [period],
          [100],
          marketType,
          latestTradeDate,
          { ttlMs, forceRefresh: true },
        );
        warmed.push(period);
      } catch (error) {
        failed.push(period);
        this.logger.warn(`[warmCustomRsPresetCache] period=${period} failed: ${(error as Error).message}`);
      }
    }

    this.logger.log(
      `[warmCustomRsPresetCache] marketType=${marketType} warmed=[${warmed.join(',')}] failed=[${failed.join(',')}] ttlMs=${ttlMs}`,
    );
    return { warmed, failed, ttlMs };
  }

  /**
   * 종목명 부분일치 검색 (현재 필터 적용된 랭킹 결과 내, 대소문자 무시)
   */
  private applyStockNameSearch<T extends SortableStockItem>(items: T[], search?: string): T[] {
    const term = search?.trim().toLowerCase();
    if (!term) return items;
    return items.filter((item) => item.stock.name?.toLowerCase().includes(term));
  }

  /**
   * 정렬용 등락률 값: 실시간가 우선, 없으면 일별 지표 (formatPriceChangeRateText와 동일 소스)
   */
  private getChangeRateValue(item: SortableStockItem, realtimePrices: Map<string, any>): number | null {
    const realtimePrice = this.getUsableRealtimePrice(realtimePrices.get(item.stock.code));
    if (realtimePrice) {
      const rate = Number(realtimePrice.changeRate);
      if (Number.isFinite(rate)) return rate;
    }
    if (item.metrics?.priceChangeRate1d != null) {
      const rate = Number(item.metrics.priceChangeRate1d);
      if (Number.isFinite(rate)) return rate;
    }
    return null;
  }

  /**
   * 정렬기준 적용. rs(기본)는 이미 정렬된 순서 유지, 나머지는 null을 뒤로 보내고
   * 동률은 RS 기준 위치(baseRank)로 tie-break.
   */
  private sortStockItems<T extends SortableStockItem>(
    items: T[],
    options: StockListOptions | undefined,
    ctx: { realtimePrices: Map<string, any>; rankChangeMap?: Map<string, number | null> },
  ): T[] {
    const sortBy = options?.sortBy ?? 'rs';
    if (sortBy === 'rs') return items;

    const sortOrder = options?.sortOrder ?? 'desc';
    const tieBreak = (item: T) => item.baseRank ?? Number.MAX_SAFE_INTEGER;

    switch (sortBy) {
      case 'changeRate':
        return sortWithNullsLast(items, (item) => this.getChangeRateValue(item, ctx.realtimePrices), sortOrder, tieBreak);
      case 'tradingValue':
        return sortWithNullsLast(
          items,
          (item) => (item.metrics?.tradingValue != null ? Number(item.metrics.tradingValue) : null),
          sortOrder,
          tieBreak,
        );
      case 'rankChange':
        return sortWithNullsLast(items, (item) => ctx.rankChangeMap?.get(item.stock.code) ?? null, sortOrder, tieBreak);
      default:
        return items;
    }
  }

  /**
   * 순위변동(3일 누적 상승폭) 값. 오늘 순위는 정렬/검색과 무관한 RS 기준 위치(baseRank),
   * 오늘 N은 필터 통과 전체 종목수. D-1~D-3의 N은 해당 시점 전체 선별 종목수로 동적 산출.
   */
  private buildRankChangeValue(
    history: Array<number | null>,
    totals: Array<number | null>,
    todayRank: number | null,
    todayTotal: number,
  ): number | null {
    return computeCumulativeRankChange(buildRankChangePoints(history, totals, todayRank, todayTotal));
  }

  /**
   * 순위변동 정렬용: 대상 종목 전체의 3일 누적 상승폭 맵 계산
   */
  private async computeRankChangeMap(
    items: SortableStockItem[],
    todayTotal: number,
    latestTradeDate: Date | null,
    totals: Array<number | null>,
  ): Promise<Map<string, number | null>> {
    const stockCodes = items.map((item) => item.stock.code);
    const historyMap = await this.metricsService.getCurrentRankHistory(
      stockCodes,
      3,
      latestTradeDate,
      this.isAfterAggregation(),
    );

    const rankChangeMap = new Map<string, number | null>();
    for (const item of items) {
      const history = historyMap.get(item.stock.code) || [];
      rankChangeMap.set(
        item.stock.code,
        this.buildRankChangeValue(history, totals, item.baseRank ?? null, todayTotal),
      );
    }
    return rankChangeMap;
  }

  /**
   * suggest=true 자동완성용 경량 응답 (enrichment 생략, 상위 limit건)
   * - 조건 내 종목: RS 점수 + 순위 포함, 순위순 정렬
   * - 조건 밖 종목: 전체 상장 종목 중 종목명 매칭분을 inRanking=false로 뒤에 표시 (FE 선택 불가 처리용)
   */
  private async buildSuggestResponse<T extends SortableStockItem>(
    items: T[],
    options: StockListOptions | undefined,
    limit = 20,
  ) {
    const term = options?.search?.trim().toLowerCase();

    const inRankingItems = [...items].sort((a, b) => (a.baseRank ?? 0) - (b.baseRank ?? 0));
    const inRankingCodes = new Set(inRankingItems.map((item) => item.stock.code));

    // 현재 조건 밖 종목 (검색어가 있을 때만)
    // ETN(코드 5/6/7 시작)·ETF(marketCode '8')는 랭킹 대상이 아니므로 후보에서 제외
    let outOfRankingStocks: Array<{ code: string; name: string }> = [];
    if (term) {
      const allStocks = await this.fetchStockList('all');
      outOfRankingStocks = allStocks
        .filter(
          (s) =>
            !inRankingCodes.has(s.code) &&
            !/^[567]/.test(s.code) &&
            (s.marketCode == null || s.marketCode === '0' || s.marketCode === '10') &&
            s.name?.toLowerCase().includes(term),
        )
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    }

    const suggestions = [
      ...inRankingItems.map((item) => ({
        stockCode: item.stock.code,
        companyName: item.stock.name,
        rank: item.baseRank ?? null,
        relativeStrengthScore: item.rsScore != null ? Number(Number(item.rsScore).toFixed(2)) : null,
        inRanking: true,
      })),
      ...outOfRankingStocks.map((s) => ({
        stockCode: s.code,
        companyName: s.name,
        rank: null,
        relativeStrengthScore: null,
        inRanking: false,
      })),
    ].slice(0, limit);

    return {
      search: options?.search?.trim() || null,
      totalCount: inRankingItems.length + outOfRankingStocks.length,
      inRankingCount: inRankingItems.length,
      count: suggestions.length,
      suggestions,
    };
  }

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
      const rate = Number(realtimePrice.changeRate);
      if (!Number.isFinite(rate)) return '-';
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

  private buildInvestmentIndicators(metrics: any): InvestmentIndicator[] {
    const indicators: InvestmentIndicator[] = [];
    if (!metrics) return indicators;

    if (metrics.isVolatilityContraction) {
      indicators.push({ type: 'VOLATILITY_CONTRACTION', label: '변동성 축소' });
    }
    if (metrics.isPriceCompression) {
      indicators.push({ type: 'PRICE_COMPRESSION', label: '가격 압축' });
    }
    if (metrics.strengthContinuationDays != null && metrics.strengthContinuationDays > 0) {
      indicators.push({
        type: 'STRENGTH_CONTINUATION',
        label: '강도 지속',
        value: `${metrics.strengthContinuationDays}/10`,
      });
    }
    if (metrics.isTrendTemplate) {
      indicators.push({ type: 'TREND_TEMPLATE', label: '트렌드 템플릿' });
    }

    return indicators;
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
    const cached = await this.stockListCache.getStockList(marketType);
    if (cached) return cached;

    let validStocks: any[];

    try {
      if (marketType === 'all') {
        const [kospiResult, kosdaqResult] = await Promise.all([
          this.kiwoomRest.getStockList('0'),
          this.kiwoomRest.getStockList('10'),
        ]);
        const allList = [
          ...kospiResult.list.map((s: any) => ({ ...s, marketType: '0' })),
          ...kosdaqResult.list.map((s: any) => ({ ...s, marketType: '10' })),
        ];
        validStocks = allList.filter(
          (s: any) => s.code.match(/^\d{6}$/) && !s.code.endsWith('5') && !this.isHaltedState(s.state),
        );
      } else {
        const result = await this.kiwoomRest.getStockList(marketType);
        validStocks = result.list
          .filter((s: any) => s.code.match(/^\d{6}$/) && !s.code.endsWith('5') && !this.isHaltedState(s.state))
          .map((s: any) => ({ ...s, marketType }));
      }
    } catch (error) {
      this.logger.warn(
        `Kiwoom stock list unavailable for marketType=${marketType}. Falling back to DB metrics/company data: ${(error as Error).message}`,
      );
      validStocks = await this.fetchStockListFromDatabase(marketType);
    }

    await this.stockListCache.setStockList(marketType, validStocks);
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
        NOT: { tradingState: { contains: '정지' } },
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

  private isAfterAggregation(): boolean {
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const hours = kst.getUTCHours();
    const minutes = kst.getUTCMinutes();
    return hours > 15 || (hours === 15 && minutes >= 40);
  }

  private isHaltedState(state?: string): boolean {
    if (!state) return false;
    return state.includes('정지');
  }

  private normalizeTradingState(state?: string | null): string | null {
    if (!state) return null;

    const normalized = state.trim();
    if (!normalized) return null;

    if (this.isHaltedState(normalized)) {
      return '거래정지';
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
        `[syncTradingStates] 거래정지 종목 ${haltedStocks.length}개: ${haltedStocks.map((s) => `${s.code}(${s.state})`).join(', ')}`,
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

    await this.clearStockListCache();
    this.logger.log(`[syncTradingStates] ${uniqueStocks.length}개 종목 tradingState 업데이트 완료`);
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
   * 종목 리스트 캐시 초기화
   */
  async clearStockListCache(marketType?: '0' | '10' | 'all'): Promise<void> {
    await this.stockListCache.clearStockList(marketType);
  }

  /**
   * 날짜 문자열들을 최신으로부터 며칠 이전인지 계산하여 기간수로 변환
   * @param rsDates 쉼표로 구분된 날짜 문자열 (예: "2026-02-09,2026-01-15" 또는 "20260209,20260115")
   * @returns 쉼표로 구분된 기간수 문자열 (예: "1,26")
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
   * 단일 날짜 문자열을 최신으로부터 며칠 이전인지 계산
   * @param dateStr 날짜 문자열 (예: "2026-02-09" 또는 "20260209")
   * @returns 최신으로부터 며칠 이전인지 (예: 1)
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

    // 최신으로부터 며칠 이전인지 계산
    const diffMs = today.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    this.logger.log(`Date ${dateStr} is ${diffDays} days ago from today`);

    // 양수가 아니거나 0이면 기본값 사용
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * 디버그용 종목 리스트 Raw 조회 (필터 없음)
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
   * 테마 매핑 함수
   * @param stockUpName 종목의 업종명 (키움 API upName)
   * @param themeFilters 필터할 테마 코드 배열 (숫자 배열, 예: [101, 102, 302] = 제약, 바이오, 반도체)
   * @returns 매핑 여부
   */
  private async getThemeFilteredStockCodes(themeFilters?: number[]): Promise<Set<string> | null> {
    // 0(전체) 테마가 포함되어 있으면 모든 종목 적용
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

    // upName을 테마 코드로 변환
    const stockThemeCode = mapUpNameToThemeCode(stockUpName);

    // 변환된 테마 코드가 필터 배열에 포함되어 있는지 확인
    return stockThemeCode !== null && themeFilters.includes(stockThemeCode);
  }

  /**
   * 시장 지수 캔들 수집 (KOSPI/KOSDAQ)
   * @param sectorCode 업종코드 (001: KOSPI, 101: KOSDAQ)
   * @param indexStockCode DB 사용 코드 (INDEX_KOSPI, INDEX_KOSDAQ)
   * @param maxCandles 최대 수집 캔들 수 (기본 600 = 단일 페이지, 연속조회로 더 확장 가능)
   */
  async collectSectorDayCandles(sectorCode: string, indexStockCode: string, maxCandles = 600) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    try {
      const data = await this.kiwoomRest.getSectorDayCandlesWithHistory(sectorCode, today, maxCandles);
      const candles = data.inds_dt_pole_qry;

      if (!candles || !Array.isArray(candles)) {
        this.logger.warn(
          `No candles data received for sector ${sectorCode}. Response: ${JSON.stringify(data)}`,
        );
        return { success: false, count: 0 };
      }

      this.logger.log(`Fetched ${candles.length} sector day candles for ${sectorCode}`);

      // DB에 저장 (지수단위 ×100 그대로 저장, 조회 시 ÷100)
      // parsePrice로 부호 제거 (Kiwoom API가 '+'/'-' 부호를 포함해 반환하는 경우 있음)
      // ka20006 dt = 실제 거래일 (ka10081과 달리 역일자가 아님) → parseIndexDate 사용
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
   * 전체 종목 캔들 수집 (배치 처리)
   * - BATCH_SIZE만큼 동시 처리, 배치 간격 BATCH_DELAY_MS 대기
   * - 429 발생 시 지수 백오프 재시도
   */
  async collectIndexCandles(maxCandles = 600) {
    this.logger.log(`Collecting market index day candles (KOSPI + KOSDAQ), maxCandles=${maxCandles}...`);
    await this.collectSectorDayCandles('001', 'INDEX_KOSPI', maxCandles);
    await this.collectSectorDayCandles('101', 'INDEX_KOSDAQ', maxCandles);
    this.logger.log('Market index day candles collected.');
    // ka20006 doesn't include today's candle ??also fetch today's close via ka20001
    const todayClose = await this.collectTodayIndexClose();
    return { success: true, message: 'KOSPI + KOSDAQ index candles collected.', todayClose };
  }

  /**
   * 최신 지수 종가 수집 (ka20001 업종현재가)
   * ka20006 일봉 API에 오늘 날짜가 미포함이므로 장마감 후 별도 호출
   */
  async collectTodayIndexClose() {
    const now = new Date();
    // KST 날짜 기준으로 최신 마감 계산 (서버 시간대 무관)
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

    // ka20001은 실제 지수값(×1)을 반환하고, ka20006은 ×100 단위를 반환하므로
    // DB 저장을 위해 스케일을 맞춰 ×100 곱하기 (parsePrice로 부호도 제거)
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
    // 동시 처리 수. 실제 전송 속도는 KiwoomRestService의 전역 정속 페이싱(KIWOOM_REST_RPS)이
    // 제어하므로 여기서는 파이프라인을 채울 정도의 동시성만 유지한다.
    const BATCH_SIZE = 5;
    const RETRY_BACKOFF_MS = 5000; // 429 안전망 재시도 전 대기

    this.logger.log(`Starting bulk day candle collection for market: ${marketType}, days: ${days}, batchSize: ${BATCH_SIZE}`);

    const stockList = await this.kiwoomRest.getStockList(marketType);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // 해당 시장 종목 필터 (ETF/ETN 제외)
    // - ETF: marketCode='8'이지만 이미 제외됨
    // - ETN: 코드가 5/6/7로 시작 (marketCode='0'이어도 ETN)
    // - 특수코드 포함 종목: ETF/ETN 변환
    const stocks = stockList.list.filter(
      (s) => s.marketCode === marketType && /^\d+$/.test(s.code) && !/^[567]/.test(s.code),
    );

    this.logger.log(`Found ${stocks.length} stocks to process in batches of ${BATCH_SIZE}`);

    let success = 0;
    let failed = 0;
    const errors: { code: string; error: string }[] = [];

    // 배치 단위로 반복
    for (let i = 0; i < stocks.length; i += BATCH_SIZE) {
      const batch = stocks.slice(i, i + BATCH_SIZE);

      // 배치 내 종목들을 병렬로 처리
      // 비수정가/수정주가를 함께 수집해 stockCandle 두 필드를 백필하도록 collectStockDayCandlesWithAdjusted를 사용.
      // - openPrice/closePrice : 비수정가 (upd_stkpc_tp='0')
      // - adjOpenPrice/adjClosePrice : 수정주가 (upd_stkpc_tp='1')
      const results = await Promise.allSettled(
        batch.map((stock) => this.collectStockDayCandlesWithAdjusted(stock.code, today, days)),
      );

      // 결과 처리 (정속 페이싱으로 429는 원칙적으로 발생하지 않아야 하며, 아래 재시도는 안전망)
      const retryStocks: typeof batch = [];

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          success++;
        } else {
          const axiosError = result.reason as any;
          if (axiosError?.status === 429 || axiosError?.response?.status === 429) {
            retryStocks.push(batch[j]);
          } else {
            failed++;
            errors.push({ code: batch[j].code, error: result.reason?.message || 'Unknown error' });
            this.logger.warn(`Failed: ${batch[j].code} - ${result.reason?.message}`);
          }
        }
      }

      if (retryStocks.length > 0) {
        this.logger.warn(`Rate limited (429) on ${retryStocks.length} stocks. Retrying after ${RETRY_BACKOFF_MS}ms...`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));

        for (const stock of retryStocks) {
          try {
            await this.collectStockDayCandlesWithAdjusted(stock.code, today, days);
            success++;
          } catch (retryError) {
            failed++;
            errors.push({ code: stock.code, error: (retryError as Error).message });
            this.logger.warn(`Retry failed: ${stock.code} - ${(retryError as Error).message}`);
          }
        }
      }

      // 진행 상황 로그
      const processed = Math.min(i + BATCH_SIZE, stocks.length);
      if (processed % 50 === 0 || processed === stocks.length) {
        const elapsed = ((processed / stocks.length) * 100).toFixed(1);
        this.logger.log(`Progress: ${processed}/${stocks.length} (${elapsed}%) - success: ${success}, failed: ${failed}`);
      }
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
   * 단일 종목의 캔들에 비수정가/수정주가를 동시에 조회해 stockCandle에 저장.
   *
   * - openPrice/closePrice 컬럼 : 비수정가 (upd_stkpc_tp='0')
   * - adjOpenPrice/adjClosePrice : 수정주가 (upd_stkpc_tp='1')
   *
   * collectAllDayCandles, backfillDayCandles 양쪽 모두에서 사용하는 컬럼 채우기 방식을 통일.
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
    // getDayCandlesWithHistory는 maxCandles만큼 페이지네이션, 5~10배 크면 1페이지로 분리.
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
   * 전체 종목 캔들 + 거래대금 채우기 (getDayCandlesWithHistory 사용, 페이지네이션 지원)
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
          // 비수정가('0')와 수정주가('1') 순차 처리 (rate limit 고려)
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
   * tradingValue가 null인 캔들에 거래대금 데이터 재수집해 채우기
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

    // tradingValue가 null인 종목 코드 목록 조회
    const nullCandleStocks = await this.prisma.stockCandle.findMany({
      where: { candleType: 'day', tradingValue: null },
      select: { stockCode: true },
      distinct: ['stockCode'],
    });

    const stockCodes = nullCandleStocks.map((r) => r.stockCode);
    this.logger.log(`fillMissingTradingValue: ${stockCodes.length}개 종목의 tradingValue 누락 캔들 의심`);

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
          // 해당 종목에서 tradingValue가 null인 날짜 목록
          const nullDates = await this.prisma.stockCandle.findMany({
            where: { stockCode, candleType: 'day', tradingValue: null },
            select: { candleTime: true },
          });
          const nullDateSet = new Set(nullDates.map((r) => r.candleTime.toISOString()));

          // 키움에서 해당 종목 캔들 데이터 조회 (최대 750개)
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
        this.logger.log(`진행: ${processed}/${stockCodes.length} - 업데이트: ${totalUpdated}개, 실패: ${failed}`);
      }

      await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
    }

    this.logger.log(`fillMissingTradingValue 완료: ${success}종목 처리, ${totalUpdated}개 업데이트, ${failed}종목 실패`);
    return { total: stockCodes.length, success, failed, updated: totalUpdated, errors: errors.slice(0, 20) };
  }

  /**
   * DB에서 저장된 캔들 데이터 조회
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

    const [candles, previousCandle] = await Promise.all([
      this.chartStorage.getCandles(stockCode, candleType, startTime, endTime),
      this.prisma.stockCandle.findFirst({
        where: { stockCode, candleType, candleTime: { lt: startTime } },
        orderBy: { candleTime: 'desc' },
      }),
    ]);
    const realtimePrice = this.getUsableRealtimePrice(this.realtimeCache.getPrice(stockCode));
    if (!realtimePrice && ['day', 'week', 'month', 'year'].includes(candleType)) {
      this.autoSubscribeStocks([stockCode]).catch((error) => {
        this.logger.warn(`Detail chart auto-subscribe failed: ${error.message}`);
      });
    }
    const storedPeriodCandle = ['week', 'month', 'year'].includes(candleType)
      ? await this.buildStoredPeriodAggregateCandle(
        stockCode,
        candleType as HigherTimeframeCandleType,
        endTime,
      )
      : null;
    const currentPeriodCandle =
      ['week', 'month', 'year'].includes(candleType) && (snapshot || realtimePrice)
        ? await this.buildCurrentPeriodAggregateCandle(
          stockCode,
          candleType as HigherTimeframeCandleType,
          snapshot,
          realtimePrice,
        )
        : storedPeriodCandle;
    const responseCandles = snapshot
      ? this.applySnapshotToStoredCandles(candles, candleType, snapshot, currentPeriodCandle)
      : realtimePrice
      ? this.applyRealtimeToStoredCandles(candles, candleType, realtimePrice, currentPeriodCandle)
      : currentPeriodCandle
      ? this.applyAggregateToStoredCandles(candles, candleType, endTime, currentPeriodCandle)
      : candles;
    const shouldMaskUnfixedPrices =
      options?.maskUnfixedPrices === true &&
      ['day', 'week', 'month', 'year'].includes(candleType) &&
      this.shouldMaskCurrentUnfixedPeriodNow();
    const today = shouldMaskUnfixedPrices ? this.todayKstDateOnly() : null;

    const calculationCandles = previousCandle ? [...responseCandles, previousCandle] : responseCandles;

    return {
      stockCode,
      candleType,
      candles: responseCandles.map((c, index) => {
        const closePrice = Number(c.closePrice);
        const prevClosePrice = index + 1 < calculationCandles.length
          ? Number(calculationCandles[index + 1].closePrice)
          : null;
        const maskThisCandle =
          shouldMaskUnfixedPrices &&
          today != null &&
          this.isSameStoredCandlePeriod(c.candleTime, today, candleType);
        const changeRate =
          Number.isFinite(closePrice) && prevClosePrice != null && Number.isFinite(prevClosePrice) && prevClosePrice > 0
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
          open: maskThisCandle ? '-' : String(c.openPrice),
          high: maskThisCandle ? '-' : String(c.highPrice),
          low: maskThisCandle ? '-' : String(c.lowPrice),
          close: maskThisCandle ? '-' : String(c.closePrice),
          volume: maskThisCandle ? '-' : c.volume.toString(),
          tradingValue: maskThisCandle ? '-' : c.tradingValue?.toString() || null,
          changeRate: maskThisCandle ? '-' : changeRateText,
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

  private shouldMaskCurrentUnfixedPeriodNow(): boolean {
    const now = new Date();
    if (!isKrxTradingDay(now)) return true;
    return this.isKrxMarketSessionNow();
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

  private async buildStoredPeriodAggregateCandle(
    stockCode: string,
    candleType: HigherTimeframeCandleType,
    anchorDate: Date,
  ): Promise<any | null> {
    const periodStart = this.getCurrentStoredPeriodStart(candleType, anchorDate);
    const periodEnd = new Date(anchorDate);
    periodEnd.setUTCHours(23, 59, 59, 999);

    const dayCandles = await this.chartStorage.getCandles(stockCode, 'day', periodStart, periodEnd);
    if (dayCandles.length === 0) return null;

    const latest = dayCandles[0];
    const oldest = dayCandles[dayCandles.length - 1];
    const aggregateTradingValue = dayCandles.reduce((sum, c) => sum + (c.tradingValue ?? 0n), 0n);

    return {
      candleTime: periodStart,
      openPrice: Number(oldest.openPrice),
      highPrice: Math.max(...dayCandles.map((c) => Number(c.highPrice))),
      lowPrice: Math.min(...dayCandles.map((c) => Number(c.lowPrice))),
      closePrice: Number(latest.closePrice),
      volume: dayCandles.reduce((sum, c) => sum + (c.volume ?? 0n), 0n),
      tradingValue: aggregateTradingValue > 0n ? aggregateTradingValue : null,
    };
  }

  private applyAggregateToStoredCandles(
    candles: any[],
    candleType: string,
    anchorDate: Date,
    aggregateCandle: any,
  ): any[] {
    if (!['week', 'month', 'year'].includes(candleType)) return candles;
    if (candles.length === 0) return [aggregateCandle];

    const latest = candles[0];
    if (!this.isSameStoredCandlePeriod(latest.candleTime, anchorDate, candleType)) {
      return [aggregateCandle, ...candles];
    }

    return [{ ...latest, ...aggregateCandle }, ...candles.slice(1)];
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
   * YYYYMMDD 문자열을 Date로 변환
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
   * 단일 종목 RS 이력 계산 (그래프용)
   * rsFilters가 POST /stocks와 동일한 형식, 날짜는 YYYYMMDD
   */
  async getRsHistory(
    stockCode: string,
    startDate: string,
    endDate: string,
    rsFilters?: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>,
  ) {
    // rsFilters → 기간(일수)과 합산 가중치로 변환
    let periods: number[];
    let weights: number[];
    const normalizedRsFilters = rsFilters?.map((f) => ({
      rsStartDate: this.normalizeYYYYMMDD(f.rsStartDate),
      rsEndDate: this.normalizeYYYYMMDD(f.rsEndDate),
      strength: f.strength,
    }));

    if (normalizedRsFilters && normalizedRsFilters.length > 0) {
      periods = normalizedRsFilters.map((f) => {
        const from = this.parseYYYYMMDD(f.rsStartDate); // 이전 날짜 (earlier)
        const to = this.parseYYYYMMDD(f.rsEndDate);     // 이후 날짜 (later)
        const diffDays = Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
        return diffDays > 0 ? diffDays : 63;
      });
      weights = normalizedRsFilters.map((f) => f.strength);
    } else {
      periods = [63];
      weights = [100];
    }

    // 종목 시장 조회 및 지수 코드 결정
    const company = await this.prisma.company.findFirst({
      where: { stockCode, deletedAt: null },
    });
    const indexCode = company?.marketType === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI';

    // 여유 버퍼 (RS 계산을 위해 최대 기간 × 1.5)
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

    // 종목 + 지수 캔들 조회
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
        period: tradingDayCount > 1 ? tradingDayCount - 1 : periods[index],
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
      // 종목은 수정주가 우선, 지수는 수정주가 없음
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
   * 실시간 구독 시작
   */
  async startRealtime(stockCode: string) {

    // 실시간 스트림 구독 시작 (0B: 체결, 0D: 호가)
    // 캐시 등록은 kiwoom.subscription.confirmed 이벤트(REG 성공 ack)에서만 처리 —
    // 요청 시점에 낙관적으로 등록하면 REG가 거부돼도 재시도가 걸리지 않음 (2026-07-16 확인)
    await this.realtimeSource.subscribe(stockCode, ['0B', '0D']);

    return { success: true, stockCode };
  }

  /**
   * 실시간 구독 중지
   */
  async stopRealtime(stockCode: string) {

    // 실시간 스트림 구독 제거
    await this.realtimeSource.unsubscribe(stockCode);

    // 캐시에서 삭제
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
   * 종목 자동 구독 (아직 구독하지 않은 종목만 페이지 조회 시 사용)
   */
  private async autoSubscribeStocks(stockCodes: string[]) {
    const subscribedStocks = new Set(this.realtimeCache.getSubscribedStocks());
    const newStocks = stockCodes.filter((code) => !subscribedStocks.has(code));

    if (newStocks.length === 0) {
      return;
    }

    this.logger.log(`Auto-subscribing ${newStocks.length} new stocks`);

    // 종목별 개별 REG 대신 단일 배치 요청으로 전송 (동시 다건 조회 시 요청 건수 초과 방지)
    try {
      await this.realtimeSource.subscribeBatch(newStocks, ['0B', '0D']);
    } catch (error) {
      this.logger.warn(`Failed to auto-subscribe batch: ${(error as Error).message}`);
    }
  }

  private readonly subscriptionRetryCounts = new Map<string, number>();
  private static readonly MAX_SUBSCRIPTION_RETRIES = 3;

  /**
   * 재시도 끝에 성공(또는 다른 경로로 confirm)한 종목은 실패 카운트를 리셋 —
   * 서버 장기 구동 중 누적된 과거 실패 횟수 때문에 별개의 새 장애가 조기에 "영구 실패" 처리되는 것을 방지.
   */
  @OnEvent('kiwoom.subscription.confirmed')
  handleSubscriptionConfirmedForRetryReset(payload: { stockCodes: string[] }): void {
    payload.stockCodes.forEach((code) => this.subscriptionRetryCounts.delete(code));
  }

  /**
   * 키움이 REG 요청을 거부한 종목 재시도 (지수 백오프, 최대 3회).
   * 캐시에 "구독됨"으로 기록되지 않으므로 실패 시 다음 페이지 조회에서도 자동 재시도 대상이 되지만,
   * 그 전에 능동적으로 짧은 지연 후 재시도해 공백 기간을 줄인다.
   */
  @OnEvent('kiwoom.subscription.failed')
  async handleSubscriptionFailed(payload: { stockCodes: string[]; types: string[]; reason?: string }): Promise<void> {
    for (const code of payload.stockCodes) {
      const attempts = (this.subscriptionRetryCounts.get(code) ?? 0) + 1;
      this.subscriptionRetryCounts.set(code, attempts);

      if (attempts > RealTimeChartService.MAX_SUBSCRIPTION_RETRIES) {
        this.logger.error(`Subscription permanently failed for ${code} after ${attempts} attempts: ${payload.reason}`);
        continue;
      }

      const delayMs = 2000 * attempts;
      setTimeout(() => {
        this.realtimeSource.subscribe(code, payload.types).catch((error) => {
          this.logger.warn(`Retry subscribe failed for ${code}: ${(error as Error).message}`);
        });
      }, delayMs);
    }
  }

  /**
   * 필터 통과 종목 전체 일괄 구독 (서버 시작 후 / 메트릭 완료 후)
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

    // subscribeBatch: 100종목씩 단일 REG 요청으로 효율 (개별 요청 횟수 최소화 및 속도)
    // 캐시 등록은 kiwoom.subscription.confirmed 이벤트(REG 성공 ack)에서만 처리 — 여기서 낙관적으로
    // 기록하면 REG가 거부돼도 재시도가 걸리지 않아 다음 날 재시작 전까지 전일 종가에 멈춰버림 (2026-07-16 확인)
    await this.realtimeSource.subscribeBatch(newCodes, ['0B', '0D']);

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
   * 날짜 파싱 (YYYYMMDD → Date)
   * ka10081/ka20006 모두 dt = 실제 거래일을 반환하므로 그대로 사용
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
   * 종합 지표 계산 (배치 처리)
   */
  async calculateDailyMetrics(marketType: '0' | '10' | 'all' = 'all', tradeDate?: string, writeLogFile: boolean = false) {
    this.logger.log(`Starting daily metrics calculation for market type: ${marketType}, date: ${tradeDate || 'today'}`);
    const parsedTradeDate = tradeDate
      ? /^\d{8}$/.test(tradeDate)
        ? `${tradeDate.slice(0, 4)}-${tradeDate.slice(4, 6)}-${tradeDate.slice(6, 8)}`
        : tradeDate
      : undefined;
    // 캔들은 UTC 15:00 마감이므로 날짜 문자열을 T15:00:00Z로 파싱해야 오늘 캔들 포함
    const date = parsedTradeDate ? new Date(`${parsedTradeDate}T15:00:00.000Z`) : undefined;

    // 항상 KOSPI + KOSDAQ 함께 처리 (순위는 전체 기준으로 계산하므로 시장별 조회 후 필터)
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

    // 정상 완료 후 초기화 상태 갱신
    this.initializationComplete = true;
    this.lastDataUpdate = new Date();

    // 완료 후 새롭게 필터 통과한 종목 구독 갱신 (비동기)
    this.subscribeFilteredStocks().catch((error) => {
      this.logger.warn(`Post-metrics bulk subscription failed: ${(error as Error).message}`);
    });

    return result;
  }
}
