import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getKrxTradingDateByOffset, isKrxTradingDay } from '../../common/utils/market-calendar.util';

@Injectable()
export class StockMetricsService {
  private readonly logger = new Logger(StockMetricsService.name);

  // MA200_20d 계산에 220 거래일 필요. 365 캘린더일(≈248~252 거래일)은 여유가 30개뿐이라
  // 거래정지 이력 종목이나 신규 상장 종목에서 SF3(MA200 상승추세)가 null로 처리되는 버그가 발생함.
  // 400 캘린더일(≈280 거래일)로 늘려 여유 60개를 확보.
  private static readonly CANDLE_LOOKBACK_DAYS = 400;
  private static readonly ADJ_RATIO_EPSILON = 0.03;

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private getCustomLogsDir(): string {
    const logsDir = path.join(process.cwd(), 'logs', 'custom');
    fs.mkdirSync(logsDir, { recursive: true });
    return logsDir;
  }

  private getCustomLogRef(fileName: string): string {
    return path.join('logs', 'custom', fileName).replace(/\\/g, '/');
  }

  private isExcludedInstrumentName(name?: string | null): boolean {
    const normalized = (name ?? '').replace(/\s+/g, '').toUpperCase();
    return (
      normalized.includes('\uC2A4\uD329') ||
      normalized.includes('SPAC') ||
      normalized.includes('\uAE30\uC5C5\uC778\uC218\uBAA9\uC801')
    );
  }

  private normalizePartialAdjustedCandles<T extends {
    stockCode?: string;
    close: number;
    high: number;
    low: number;
    adjClose: number | null;
    adjHigh: number | null;
    adjLow: number | null;
  }>(stockCode: string, candles: T[]): T[] {
    let activeRatio: number | null = null;
    let patched = 0;

    for (let i = candles.length - 1; i >= 0; i--) {
      const c = candles[i];
      if (c.close <= 0) continue;

      const ratio = c.adjClose != null && c.adjClose > 0 ? c.adjClose / c.close : 1;
      const hasCorporateActionRatio = Math.abs(ratio - 1) > StockMetricsService.ADJ_RATIO_EPSILON;

      if (hasCorporateActionRatio) {
        activeRatio = ratio;
        continue;
      }

      if (activeRatio == null) continue;

      c.adjClose = Math.round(c.close * activeRatio);
      c.adjHigh = Math.round(c.high * activeRatio);
      c.adjLow = Math.round(c.low * activeRatio);
      patched++;
    }

    if (patched > 0) {
      this.logger.warn(
        `[normalizePartialAdjustedCandles] ${stockCode}: patched ${patched} older candles with partial adjusted-price ratio`,
      );
    }

    return candles;
  }

  /**
   * 특정 거래일의 종목별 지표 조회
   */
  async getMetricsForDate(
    stockCodes: string[],
    tradeDate: Date,
  ): Promise<Map<string, any>> {
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate,
      },
    });

    const metricsMap = new Map<string, any>();
    metrics.forEach((metric) => {
      metricsMap.set(metric.stockCode, {
        relativeStrengthScore: Number(metric.relativeStrengthScore),
        rank: metric.rank,
        isNewHigh: metric.isNewHigh,
        closePrice: Number(metric.closePrice),
        priceChange1d: metric.priceChange1d ? Number(metric.priceChange1d) : null,
        priceChangeRate1d: metric.priceChangeRate1d
          ? Number(metric.priceChangeRate1d)
          : null,
        tradingValue: metric.tradingValue ? Number(metric.tradingValue) : 0,
        ma50: metric.ma50 ? Number(metric.ma50) : null,
        passedStaticFilters: metric.passedStaticFilters,
        highPrice52w: metric.highPrice52w ? Number(metric.highPrice52w) : null,
        lowPrice52w: metric.lowPrice52w ? Number(metric.lowPrice52w) : null,
        isTrendTemplate: metric.isTrendTemplate,
        isVolatilityContraction: metric.isVolatilityContraction,
        isPriceCompression: metric.isPriceCompression,
        strengthContinuationDays: metric.strengthContinuationDays,
      });
    });

    return metricsMap;
  }

  /**
   * 최신 거래일 조회
   */
  async getLatestTradeDate(marketType?: string): Promise<Date | null> {
    // passedStaticFilters: true 인 레코드 중 가장 최신 날짜 반환
    // → 주말/휴일에 메트릭이 저장되더라도 실제 거래일 기준으로 폴백
    const where: any = { passedStaticFilters: true };
    if (marketType) where.marketType = marketType;
    const latestDate = await this.prisma.stockDailyMetrics.findFirst({
      where,
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    return latestDate?.tradeDate || null;
  }

  /**
   * 특정 거래일 기준 SF1~SF5 정적 필터 통과 종목 코드 조회
   * calculateRangeRS 사전 필터링용 (전체 종목 → 통과 종목만 추려서 연산량 감소)
   */
  async getPassedStaticFilterCodes(stockCodes: string[], tradeDate: Date): Promise<string[]> {
    const _mem = process.memoryUsage();
    this.logger.log(
      `[getPassedStaticFilterCodes] START stockCodes=${stockCodes.length} tradeDate=${tradeDate.toISOString().split('T')[0]} ` +
      `heap=${Math.round(_mem.heapUsed/1024/1024)}MB/${Math.round(_mem.heapTotal/1024/1024)}MB rss=${Math.round(_mem.rss/1024/1024)}MB`,
    );
    const rows = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate,
        passedStaticFilters: true,
      },
      select: { stockCode: true },
    });
    return rows.map((r) => r.stockCode);
  }

  /**
   * 최신 거래일 기준 필터 통과 종목 코드 조회 (rank > 0)
   * WebSocket 일괄 구독용
   */
  async getFilteredStockCodes(): Promise<string[]> {
    const latestDate = await this.getLatestTradeDate();
    if (!latestDate) return [];

    const filtered = await this.prisma.stockDailyMetrics.findMany({
      where: {
        tradeDate: latestDate,
        passedStaticFilters: true,
      },
      orderBy: { rank: 'asc' },
      take: 200,
      select: { stockCode: true },
    });

    return filtered.map((m) => m.stockCode);
  }

  /**
   * 최신 거래일의 종목별 지표 조회 (날짜 상관없이 가장 최근 데이터)
   */
  async getLatestMetrics(stockCodes: string[], marketType?: string): Promise<Map<string, any>> {
    const _mem = process.memoryUsage();
    this.logger.debug(
      `[getLatestMetrics] START stockCodes=${stockCodes.length} ` +
      `heap=${Math.round(_mem.heapUsed/1024/1024)}MB/${Math.round(_mem.heapTotal/1024/1024)}MB rss=${Math.round(_mem.rss/1024/1024)}MB`,
    );
    const latestDate = await this.getLatestTradeDate(marketType);

    if (!latestDate) {
      return new Map();
    }

    return this.getMetricsForDate(stockCodes, latestDate);
  }

  /**
   * 최근 N일간의 순위 변동 조회
   */
  async getRankingHistory(
    stockCode: string,
    days: number = 4,
  ): Promise<number[]> {
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode },
      orderBy: { tradeDate: 'desc' },
      take: days,
      select: { rank: true, tradeDate: true },
    });

    this.logger.debug(`RankHistory for ${stockCode}: ${JSON.stringify(metrics)}`);

    return metrics.map((m) => m.rank);
  }

  /**
   * 여러 종목의 최근 N개 거래일 지표 이력 조회
   * 반환: Map<stockCode, Array<{tradeDate, rank, rsScore}>>
   */
  async getRecentMetricsHistory(
    stockCodes: string[],
    days: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    // 최근 N개 거래일 조회
    const recentDates = await this.prisma.stockDailyMetrics.findMany({
      orderBy: { tradeDate: 'desc' },
      take: days,
      distinct: ['tradeDate'],
      select: { tradeDate: true },
    });

    if (recentDates.length === 0) {
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.tradeDate);

    // 해당 종목들의 최근 N개 거래일 지표 조회
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate: { in: tradeDates },
      },
      orderBy: [
        { stockCode: 'asc' },
        { tradeDate: 'desc' },
      ],
      select: {
        stockCode: true,
        tradeDate: true,
        rank: true,
        relativeStrengthScore: true,
      },
    });

    // 종목별로 그룹핑
    const historyMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const metric of metrics) {
      if (!historyMap.has(metric.stockCode)) {
        historyMap.set(metric.stockCode, []);
      }
      historyMap.get(metric.stockCode)!.push({
        tradeDate: metric.tradeDate,
        rank: metric.rank,
        rsScore: Number(metric.relativeStrengthScore),
      });
    }

    return historyMap;
  }

  /**
   * 런타임에 커스텀 RS 계산 (사용자 설정 기간 + 가중치)
   *
   * @param stockCodes - 대상 종목 코드 목록
   * @param periods - RS 계산 기간 배열 (예: [63, 126, 252])
   * @param weights - RS 가중치 배열 (예: [50, 30, 20])
   * @param indexCode - 지수 코드 (INDEX_KOSPI, INDEX_KOSDAQ)
   * @param tradingDays - 계산할 거래일 수 (기본 4: 당일, D-1, D-2, D-3)
   *
   * @returns Map<stockCode, Array<{tradeDate, rank, rsScore}>> - 종목별 최근 N일 랭크 이력
   */
  async calculateRuntimeRS(
    stockCodes: string[],
    periods: number[],
    weights: number[],
    indexCode: string,
    tradingDays: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    this.logger.log(
      `Calculating runtime RS for ${stockCodes.length} stocks, periods: ${periods}, weights: ${weights}, index: ${indexCode}`,
    );

    // 최근 N개 거래일 조회
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
      },
      orderBy: { candleTime: 'desc' },
      take: tradingDays,
      distinct: ['candleTime'],
      select: { candleTime: true },
    });

    if (recentDates.length === 0) {
      this.logger.warn('No trading days found');
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.candleTime);
    this.logger.log(`Found ${tradeDates.length} recent trading days`);

    // 최대 기간 계산 (52주 = 365일)
    const maxPeriod = Math.max(...periods);
    const historicalCutoff = new Date(tradeDates[0]);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - Math.max(365, maxPeriod + 10));

    // 일봉 데이터 조회
    const [stockCandles, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          stockCode: { in: stockCodes },
          candleTime: { gte: historicalCutoff },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      this.prisma.stockCandle.findMany({
        where: {
          stockCode: indexCode,
          candleType: 'day',
          candleTime: { gte: historicalCutoff },
        },
        orderBy: { candleTime: 'asc' },
      }),
    ]);

    this.logger.log(`Loaded ${stockCandles.length} stock candles, ${indexCandles.length} index candles`);

    // 종목별 그룹핑
    const candlesByStock = new Map<string, typeof stockCandles>();
    for (const candle of stockCandles.filter((c) => isKrxTradingDay(c.candleTime))) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 각 거래일별로 RS 계산 및 랭킹
    const resultMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const tradeDate of tradeDates) {
      const tradeDateOnly = new Date(tradeDate);
      tradeDateOnly.setHours(0, 0, 0, 0);

      // 해당 거래일의 지수 데이터 찾기
      const indexCandlesUpToDate = indexCandles.filter(
        (c) => c.candleTime <= tradeDate && isKrxTradingDay(c.candleTime),
      );
      if (indexCandlesUpToDate.length === 0) continue;

      const latestIndexCandle = indexCandlesUpToDate[indexCandlesUpToDate.length - 1];
      const indexCloseNow = latestIndexCandle.closePrice.toNumber();

      // 각 종목별 RS 계산 + 필터 적용
      const stockData: Array<{ stockCode: string; rsRaw: number; passedFilters: boolean }> = [];
      const MIN_TRADING_VALUE = 1_000_000_000; // 10억

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles
          .filter((c) => c.candleTime <= tradeDate)
          .filter((c) => c.volume > 0n);
        if (candlesUpToDate.length === 0) continue;

        const latest = candlesUpToDate[candlesUpToDate.length - 1];
        // 수정주가 우선, 없으면 원주가 fallback
        const adjPrice = (c: typeof latest) => (c.adjClosePrice ?? c.closePrice).toNumber();
        const closePrice = adjPrice(latest);

        // MA50 (수정주가 기준)
        const ma50Slice = candlesUpToDate.slice(-50);
        const ma50 = ma50Slice.length >= 50
          ? ma50Slice.reduce((sum, c) => sum + adjPrice(c), 0) / 50
          : null;

        // MA150 (수정주가 기준)
        const ma150Slice = candlesUpToDate.slice(-150);
        const ma150 = ma150Slice.length >= 150
          ? ma150Slice.reduce((sum, c) => sum + adjPrice(c), 0) / 150
          : null;

        // MA200 현재 (수정주가 기준)
        const ma200Slice = candlesUpToDate.slice(-200);
        const ma200 = ma200Slice.length >= 200
          ? ma200Slice.reduce((sum, c) => sum + adjPrice(c), 0) / 200
          : null;

        // 거래대금 (수정주가 기준 fallback)
        const tradingValue = latest.tradingValue
          ? Number(latest.tradingValue)
          : closePrice * Number(latest.volume);

        // 여러 기간의 RS 계산 (수정주가 기준)
        const rsValues: number[] = [];
        for (const period of periods) {
          if (candlesUpToDate.length <= period) {
            rsValues.push(0);
            continue;
          }

          const pastPrice = adjPrice(candlesUpToDate[candlesUpToDate.length - 1 - period]);

          // 해당 기간의 지수 과거가
          const indexPastCandles = indexCandles.filter(
            (c) => c.candleTime <= tradeDate && isKrxTradingDay(c.candleTime),
          );
          if (indexPastCandles.length <= period) {
            rsValues.push(0);
            continue;
          }
          const indexPastPrice = indexPastCandles[indexPastCandles.length - 1 - period].closePrice.toNumber();

          if (pastPrice > 0 && indexPastPrice > 0) {
            const stockReturn = closePrice / pastPrice;
            const indexReturn = indexCloseNow / indexPastPrice;
            rsValues.push(stockReturn / indexReturn);
          } else {
            rsValues.push(0);
          }
        }

        // 가중 평균 계산
        let weightedRS = 0;
        let totalWeight = 0;
        for (let i = 0; i < rsValues.length; i++) {
          if (rsValues[i] > 0) {
            weightedRS += rsValues[i] * weights[i];
            totalWeight += weights[i];
          }
        }

        if (totalWeight > 0) {
          weightedRS /= totalWeight;

          // 5개 정적 필터 (종가 기준)
          const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;           // MA50 > MA150
          const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;         // MA150 > MA200
          // SF3: MA200 20일 연속 상승추세 (단조 증가: 20일전 < 19일전 < ... < 현재)
          const sf3 = (() => {
            if (candlesUpToDate.length < 220) return false;
            let prev = -Infinity;
            for (let i = 20; i >= 0; i--) {
              const s = candlesUpToDate.slice(-200 - i, i === 0 ? undefined : -i);
              const ma = s.reduce((sum, c) => sum + adjPrice(c), 0) / 200;
              if (ma <= prev) return false;
              prev = ma;
            }
            return true;
          })();
          const sf4 = weightedRS > 0;                                             // RS > 0
          const sf5 = tradingValue >= MIN_TRADING_VALUE;                         // 거래대금 >= 10억

          const passedFilters = sf1 && sf2 && sf3 && sf4 && sf5;
          stockData.push({ stockCode, rsRaw: weightedRS, passedFilters });
        }
      }

      // 필터 통과 종목만 RS 기준 정렬 및 랭킹
      const filtered = stockData.filter((s) => s.passedFilters);
      filtered.sort((a, b) => b.rsRaw - a.rsRaw);

      const totalStocks = filtered.length;
      for (let i = 0; i < totalStocks; i++) {
        const { stockCode } = filtered[i];
        const rank = i + 1;
        // 상위 % 계산 → 1~99 점수 변환
        const topPercent = (rank / totalStocks) * 100;
        const score = this.percentileToScore(topPercent);

        if (!resultMap.has(stockCode)) {
          resultMap.set(stockCode, []);
        }
        resultMap.get(stockCode)!.push({
          tradeDate: tradeDateOnly,
          rank,
          rsScore: score,
        });
      }
    }

    this.logger.log(`Runtime RS calculation completed for ${resultMap.size} stocks`);
    return resultMap;
  }

  /**
   * 기간 기반 RS 계산 (rsStartDate와 rsEndDate 사용)
   * SF1~SF5는 passedStaticFilters로 사전 필터링된 종목만 입력받으므로 재계산하지 않음.
   * 각 필터 기간의 start/end 날짜 종가만 조회하여 메모리 사용량을 최소화.
   */
  async calculateRangeRS(
    stockCodes: string[],
    rsFilters: Array<{
      rsStartDate: string;
      rsEndDate: string;
      strength: number;
    }>,
    indexCode: string,
    tradingDays: number = 4,
  ): Promise<Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>> {
    const _mem0 = process.memoryUsage();
    this.logger.log(
      `[calculateRangeRS] START stocks=${stockCodes.length} index=${indexCode} filters=${JSON.stringify(rsFilters)} ` +
      `heap=${Math.round(_mem0.heapUsed/1024/1024)}MB/${Math.round(_mem0.heapTotal/1024/1024)}MB rss=${Math.round(_mem0.rss/1024/1024)}MB`,
    );

    // 최근 N개 거래일 조회 — 인덱스 캔들(하루 1행)로 대체하여 full-scan distinct 제거
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: indexCode,
      },
      orderBy: { candleTime: 'desc' },
      take: tradingDays,
      select: { candleTime: true },
    });

    if (recentDates.length === 0) {
      this.logger.warn('No trading days found');
      return new Map();
    }

    const tradeDates = recentDates.map((d) => d.candleTime);

    // 필터별 날짜 → 최신 거래일 기준 일수 변환.
    // "오늘" 기준으로 계산하면 휴장일/주말/장마감 후 요청에서 선택한 endDate가 밀릴 수 있다.
    const baseTradeDate = new Date(tradeDates[0]);
    baseTradeDate.setHours(0, 0, 0, 0);

    const periodsData = rsFilters.map((f) => ({
      startDays: this.convertDateToDays(f.rsStartDate, baseTradeDate),
      endDays: this.convertDateToDays(f.rsEndDate, baseTradeDate),
      weight: f.strength,
    }));

    // 필요한 날짜 범위 파악 (거래일 목록 조회용)
    const maxStartDays = Math.max(...periodsData.map((p) => p.startDays));
    const oldestTradeDate = tradeDates[tradeDates.length - 1];
    const rangeFrom = new Date(oldestTradeDate);
    rangeFrom.setDate(rangeFrom.getDate() - maxStartDays - 10); // 여유 10일

    // 범위 내 실제 거래일 목록 조회 — 인덱스 캔들 사용 (하루 1행으로 distinct 불필요, 수십 배 빠름)
    const tradingDateRows = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: indexCode,
        candleTime: { gte: rangeFrom },
      },
      orderBy: { candleTime: 'asc' },
      select: { candleTime: true },
    });
    const allTradingDates = tradingDateRows.map((r) => r.candleTime);

    const memUsage = process.memoryUsage();
    this.logger.log(
      `[calculateRangeRS] index=${indexCode} stocks=${stockCodes.length} tradingDates=${allTradingDates.length} ` +
      `heap=${Math.round(memUsage.heapUsed / 1024 / 1024)}MB / ${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
    );

    // tradeDate × 필터별 실제 start/end 거래일 resolve
    type DatePair = { startDate: Date; endDate: Date; weight: number };
    const tradeDatePeriods = new Map<string, DatePair[]>();
    const neededDatesSet = new Set<string>();

    for (const tradeDate of tradeDates) {
      const td = new Date(tradeDate);
      td.setHours(0, 0, 0, 0);
      const pairs: DatePair[] = [];

      for (const { startDays, endDays, weight } of periodsData) {
        const targetStart = new Date(td);
        targetStart.setDate(td.getDate() - startDays);
        const targetEnd = new Date(td);
        targetEnd.setDate(td.getDate() - endDays);

        // startDate: targetStart 이상의 첫 거래일 (gte)
        const startDate = allTradingDates.find((d) => d >= targetStart) ?? null;
        // endDate: targetEnd 이하의 마지막 거래일 (lte)
        let endDate: Date | null = null;
        for (let i = allTradingDates.length - 1; i >= 0; i--) {
          if (allTradingDates[i] <= targetEnd) { endDate = allTradingDates[i]; break; }
        }

        if (startDate && endDate && startDate < endDate) {
          pairs.push({ startDate, endDate, weight });
          neededDatesSet.add(startDate.toISOString());
          neededDatesSet.add(endDate.toISOString());
        }
      }
      tradeDatePeriods.set(tradeDate.toISOString(), pairs);
    }

    const neededDates = Array.from(neededDatesSet).map((s) => new Date(s));
    this.logger.log(
      `[calculateRangeRS] neededDates=${neededDates.length}, stockCodes=${stockCodes.length}, index=${indexCode} ` +
      `heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    );

    // 주식 종가: 필요한 날짜만 단일 쿼리로 조회
    const stockPriceRows = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { in: stockCodes },
        candleTime: { in: neededDates },
      },
      select: { stockCode: true, candleTime: true, closePrice: true },
    });

    // stockCode → (dateISO → price)
    const stockPriceMap = new Map<string, Map<string, number>>();
    for (const row of stockPriceRows) {
      if (!stockPriceMap.has(row.stockCode)) stockPriceMap.set(row.stockCode, new Map());
      stockPriceMap.get(row.stockCode)!.set(row.candleTime.toISOString(), row.closePrice.toNumber());
    }

    // 지수 종가: 필요한 날짜만 조회
    const indexRows = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: indexCode,
        candleTime: { in: neededDates },
      },
      select: { candleTime: true, closePrice: true },
    });
    const indexPriceMap = new Map<string, number>();
    for (const row of indexRows) {
      indexPriceMap.set(row.candleTime.toISOString(), row.closePrice.toNumber());
    }

    this.logger.log(
      `[calculateRangeRS] stockPriceRows=${stockPriceRows.length}, indexRows=${indexRows.length} ` +
      `heap=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    );

    // tradeDate별 RS 계산
    const perDateRSMap = new Map<string, Map<string, number>>();
    for (const tradeDate of tradeDates) perDateRSMap.set(tradeDate.toISOString(), new Map());

    for (const tradeDate of tradeDates) {
      const dateKey = tradeDate.toISOString();
      const pairs = tradeDatePeriods.get(dateKey) ?? [];
      const stockRSMap = perDateRSMap.get(dateKey)!;

      for (const stockCode of stockCodes) {
        const prices = stockPriceMap.get(stockCode);
        if (!prices) continue;

        const rsValues: number[] = [];
        const weights: number[] = [];

        for (const { startDate, endDate, weight } of pairs) {
          const startPrice = prices.get(startDate.toISOString());
          const endPrice = prices.get(endDate.toISOString());
          const indexStartPrice = indexPriceMap.get(startDate.toISOString());
          const indexEndPrice = indexPriceMap.get(endDate.toISOString());

          if (!startPrice || !endPrice || !indexStartPrice || !indexEndPrice) continue;
          if (endPrice <= 0 || indexEndPrice <= 0) continue;

          const rs = (endPrice / startPrice) / (indexEndPrice / indexStartPrice);
          rsValues.push(rs);
          weights.push(weight);
        }

        if (rsValues.length === 0) continue;

        let weightedRS = 0;
        let totalWeight = 0;
        for (let i = 0; i < rsValues.length; i++) {
          if (rsValues[i] > 0) {
            weightedRS += rsValues[i] * weights[i];
            totalWeight += weights[i];
          }
        }
        if (totalWeight > 0) stockRSMap.set(stockCode, weightedRS / totalWeight);
      }
    }

    // tradeDate별 랭킹 계산
    const resultMap = new Map<string, Array<{ tradeDate: Date; rank: number; rsScore: number }>>();

    for (const tradeDate of tradeDates) {
      const dateKey = tradeDate.toISOString();
      const tradeDateOnly = new Date(tradeDate);
      tradeDateOnly.setHours(0, 0, 0, 0);
      const stockRSMap = perDateRSMap.get(dateKey)!;

      const sorted = Array.from(stockRSMap.entries())
        .filter(([, rs]) => rs > 0)
        .sort(([, a], [, b]) => b - a);

      const totalStocks = sorted.length;
      this.logger.log(`[Range RS ${dateKey.split('T')[0]}] ${totalStocks} stocks with positive RS`);

      for (let i = 0; i < totalStocks; i++) {
        const [stockCode] = sorted[i];
        const rank = i + 1;
        const topPercent = (rank / totalStocks) * 100;
        const score = this.percentileToScore(topPercent);

        if (!resultMap.has(stockCode)) resultMap.set(stockCode, []);
        resultMap.get(stockCode)!.push({ tradeDate: tradeDateOnly, rank, rsScore: score });
      }
    }

    this.logger.log(`Range RS calculation completed for ${resultMap.size} stocks`);
    return resultMap;
  }

  /**
   * 날짜 문자열을 오늘로부터 며칠 전인지 계산
   */
  private convertDateToDays(dateStr: string, today: Date): number {
    let date: Date;
    if (dateStr.includes('-')) {
      date = new Date(dateStr);
    } else if (dateStr.length === 8) {
      const year = dateStr.substring(0, 4);
      const month = dateStr.substring(4, 6);
      const day = dateStr.substring(6, 8);
      date = new Date(`${year}-${month}-${day}`);
    } else {
      return 63;
    }

    if (isNaN(date.getTime())) {
      return 63;
    }

    date.setHours(0, 0, 0, 0);
    const diffMs = today.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 1;
  }

  /**
   * 전체 종목의 일별 지표 계산 및 저장
   *
   * 처리 순서:
   * 1. DB에서 전체 일봉 + 지수 일봉 한번에 조회
   * 2. 종목별 7개 필터 적용
   * 3. 필터 통과 종목의 RS(63) 계산
   * 4. RS 내림차순 정렬 → 상위% → 1~99 점수
   * 5. 랭킹 부여 및 DB 저장
   */
  /**
   * 최근 N개 거래일 날짜 조회
   */
  async getRecentTradingDates(count: number = 4): Promise<Date[]> {
    const recentDates = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: { not: { startsWith: 'INDEX_' } },
      },
      orderBy: { candleTime: 'desc' },
      take: count,
      distinct: ['candleTime'],
      select: { candleTime: true },
    });
    return recentDates.map((r) => r.candleTime);
  }

  async calculateAndSaveDailyMetrics(
    marketType: '0' | '10' | 'all' = 'all',
    tradeDate?: Date,
    indexCode: string = 'INDEX_KOSPI',
    stockCodes?: string[],
    stockIndexMap?: Map<string, string>,
    stockNameMap?: Map<string, string>,
    writeLogFile: boolean = false,
  ) {
    // 캔들은 UTC 15:00에 저장됨. targetDate를 UTC 15:00으로 설정해야 당일 캔들이 lte 조건에 포함됨.
    // 날짜 기준: 장 마감(KST 15:30) 이후부터 다음날 15:29까지는 항상 당일(거래일) 기준으로 고정.
    // → 오늘 오후 8시 조회 = 내일 오전 1시 조회 = 동일한 거래일 기준 (63거래일 전 일관성 보장)
    const targetDate = tradeDate ?? (() => {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const kstHours = kstNow.getUTCHours();
      const kstMinutes = kstNow.getUTCMinutes();
      const isAfterMarketClose = kstHours > 15 || (kstHours === 15 && kstMinutes >= 30);
      if (!isAfterMarketClose) {
        // 장 마감 전(~15:29 KST): 전날 거래일 기준
        const prev = new Date(kstNow);
        prev.setUTCDate(prev.getUTCDate() - 1);
        return new Date(`${prev.toISOString().split('T')[0]}T15:00:00.000Z`);
      }
      return new Date(`${kstNow.toISOString().split('T')[0]}T15:00:00.000Z`);
    })();

    this.logger.log(
      `Starting metrics calculation for ${marketType} on ${targetDate.toISOString().split('T')[0]}, index: ${indexCode}${stockIndexMap ? ' (multi-index)' : ''}`,
    );

    // 1. 캔들 조회 커트오프 + 지수 캔들 먼저 로드 (소량)
    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - StockMetricsService.CANDLE_LOOKBACK_DAYS);

    const indexCodesToLoad = stockIndexMap
      ? [...new Set(stockIndexMap.values())]
      : [indexCode];

    const indexResultArrays = await Promise.all(
      indexCodesToLoad.map((idx) =>
        this.prisma.stockCandle.findMany({
          where: {
            stockCode: idx,
            candleType: 'day',
            candleTime: { gte: historicalCutoff, lte: targetDate },
          },
          orderBy: { candleTime: 'asc' },
        }),
      ),
    );

    const indexCandlesMap = new Map<string, typeof indexResultArrays[0]>();
    indexCodesToLoad.forEach((idx, i) => {
      indexCandlesMap.set(
        idx,
        indexResultArrays[i].filter((c) => isKrxTradingDay(c.candleTime)),
      );
    });

    if (indexResultArrays.every((arr) => arr.length === 0)) {
      this.logger.warn(`No index candles found. Cannot calculate RS.`);
      return { success: false, count: 0, date: targetDate };
    }

    // KRX 캘린더 기준 63거래일 전 날짜를 먼저 확정한다.
    // DB 지수 캔들 행 개수로 밀어 계산하면 중간 누락 캔들 때문에 기준일이 더 과거로 흐를 수 있다.
    const tradeDateStrForRs = targetDate.toISOString().split('T')[0];
    const rs63AgoDate = getKrxTradingDateByOffset(tradeDateStrForRs, 63);

    const findIndexCandleByDate = (
      idxCandles: typeof indexResultArrays[0],
      dateStr: string,
    ) => idxCandles.find((c) => c.candleTime.toISOString().split('T')[0] === dateStr);

    const idx63AgoRefMap = new Map<string, { value: number; timeMs: number; date: string } | null>();
    const idxCloseNowMap = new Map<string, number>();
    const missingIndexCandles: string[] = [];
    for (const [idxCode, idxCandles] of indexCandlesMap) {
      const current = findIndexCandleByDate(idxCandles, tradeDateStrForRs);
      const ref = findIndexCandleByDate(idxCandles, rs63AgoDate);

      if (!current) {
        missingIndexCandles.push(`${idxCode}:${tradeDateStrForRs}`);
      }
      if (!ref) {
        missingIndexCandles.push(`${idxCode}:${rs63AgoDate}`);
      }

      idxCloseNowMap.set(idxCode, current?.closePrice.toNumber() ?? 0);
      idx63AgoRefMap.set(
        idxCode,
        ref
          ? {
              value: ref.closePrice.toNumber(),
              timeMs: ref.candleTime.getTime(),
              date: ref.candleTime.toISOString().split('T')[0],
            }
          : null,
      );
    }

    if (missingIndexCandles.length > 0) {
      this.logger.warn(
        `[RS 기준일 누락] 지수 캔들이 없어 계산을 중단합니다. missing=${missingIndexCandles.join(', ')}. ` +
        `먼저 지수 일봉을 백필/재수집해 주세요.`,
      );
      return {
        success: false,
        count: 0,
        filtered: 0,
        date: targetDate,
        message: 'Missing index candles for RS calculation',
        missingIndexCandles,
        rs63AgoDate,
      };
    }

    // 처리할 종목 코드 목록 확보 (stockCodes 파라미터 없으면 DB에서 조회)
    let allStockCodes: string[];
    if (stockCodes && stockCodes.length > 0) {
      allStockCodes = stockCodes;
    } else {
      const codeRows = await this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { not: { startsWith: 'INDEX_' } },
        },
        distinct: ['stockCode'],
        select: { stockCode: true },
      });
      allStockCodes = codeRows.map((r) => r.stockCode);
    }
    allStockCodes = allStockCodes.filter((code) => !code.endsWith('5'));

    const exclusionInfos = await this.prisma.company.findMany({
      where: { stockCode: { in: allStockCodes } },
      select: { stockCode: true, companyName: true },
    });
    const excludedInstrumentCodes = new Set(
      exclusionInfos
        .filter((stock) => this.isExcludedInstrumentName(stock.companyName))
        .map((stock) => stock.stockCode),
    );
    if (excludedInstrumentCodes.size > 0) {
      allStockCodes = allStockCodes.filter((code) => !excludedInstrumentCodes.has(code));
      this.logger.log(`Excluded ${excludedInstrumentCodes.size} SPAC/instrument stocks by company name`);
    }

    this.logger.log(`Total stocks to process: ${allStockCodes.length}, indices: ${indexCodesToLoad.map((idx) => `${idx}(${indexCandlesMap.get(idx)?.length || 0})`).join(', ')}`);

    // 2. 종목별 계산 — 배치로 나눠 메모리 사용량 제어
    const CALC_BATCH_SIZE = 300; // 300종목 × 250거래일 ≈ 75,000 rows/배치
    const MIN_TRADING_VALUE = 1_000_000_000; // 10억

    interface StockCalc {
      stockCode: string;
      closePrice: number;
      high52w: number;
      low52w: number;
      isNewHigh: boolean;
      priceChange1d: number;
      priceChangeRate1d: number;
      volume: bigint;
      tradingValue: bigint;
      rsRaw: number;
      ma50: number | null;
      ma150: number | null;
      ma200: number | null;
      ma200_20d: number | null;
      close63Ago: number | null;
      idxCloseNow: number;
      idx63Ago: number | null;
      passedStaticFilters: boolean;
      isTrendTemplate: boolean;
      candleTime: Date;
      rsScore?: number;
      rank?: number;
      isVolatilityContraction: boolean;
      isPriceCompression: boolean;
      strengthContinuationDays: number | null;
    }

    const calculations: StockCalc[] = [];
    const filterStats = { total: 0, sf1Fail: 0, sf2Fail: 0, sf3Fail: 0, sf4Fail: 0, sf5Fail: 0, passed: 0 };

    for (let batchStart = 0; batchStart < allStockCodes.length; batchStart += CALC_BATCH_SIZE) {
      const batchCodes = allStockCodes.slice(batchStart, batchStart + CALC_BATCH_SIZE);

      const rawCandles = await this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { in: batchCodes },
        },
        select: {
          stockCode: true,
          candleTime: true,
          openPrice: true,
          adjOpenPrice: true,
          closePrice: true,
          adjClosePrice: true,
          highPrice: true,
          lowPrice: true,
          adjHighPrice: true,
          adjLowPrice: true,
          volume: true,
          tradingValue: true,
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      });

      // Decimal → number 즉시 변환 (Prisma Decimal 객체 해제)
      type PlainCandle = {
        stockCode: string;
        candleTime: Date;
        open: number;
        adjOpen: number | null;
        close: number;
        adjClose: number | null;
        high: number;
        low: number;
        adjHigh: number | null;
        adjLow: number | null;
        volume: bigint;
        tradingValue: bigint | null;
      };
      const batchCandles: PlainCandle[] = rawCandles
        .map((c) => ({
          stockCode: c.stockCode,
          candleTime: c.candleTime,
          open: c.openPrice.toNumber(),
          adjOpen: c.adjOpenPrice?.toNumber() ?? null,
          close: c.closePrice.toNumber(),
          adjClose: c.adjClosePrice?.toNumber() ?? null,
          high: c.highPrice.toNumber(),
          low: c.lowPrice.toNumber(),
          adjHigh: c.adjHighPrice?.toNumber() ?? null,
          adjLow: c.adjLowPrice?.toNumber() ?? null,
          volume: c.volume,
          tradingValue: c.tradingValue,
        }))
        // [Patch 4] 비거래일(주말/한국공휴일) 잔존 캔들이 DB에 남아 있어도 계산에 섞이지 않도록
        // 메트릭스 계산 단계에서 한 번 더 안전망으로 거른다.
        .filter((c) => isKrxTradingDay(c.candleTime));

      const candlesByStock = new Map<string, PlainCandle[]>();
      for (const candle of batchCandles) {
        if (!candlesByStock.has(candle.stockCode)) candlesByStock.set(candle.stockCode, []);
        candlesByStock.get(candle.stockCode)!.push(candle);
      }

      this.logger.log(`Processing batch ${batchStart + batchCodes.length}/${allStockCodes.length} (${batchCandles.length} candles)`);

      for (const [stockCode, candles] of candlesByStock) {
      if (candles.length === 0) continue;
      this.normalizePartialAdjustedCandles(stockCode, candles);

      // [Patch 3] 거래정지(volume=0) 캔들은 MA/52주/TR 등 모든 추세 계산에서 제외.
      //   - 키움이 거래정지일에도 직전종가로 채워 내려주거나 0으로 비워두는 경우가 있어,
      //     평균/극값/변동률 계산에 그대로 섞이면 재개 직후 값이 왜곡된다.
      //   - tradeCandles = 거래일 + 실제 거래가 있었던 캔들 (volume > 0)
      const tradeCandles = candles.filter((c) => c.volume > 0n);

      // 거래정지 종목: volume=0이면 가장 가까운 과거 정상 거래일 종가로 fallback (latest 선정)
      let latestIdx = candles.length - 1;
      while (latestIdx > 0 && candles[latestIdx].volume === 0n) {
        latestIdx--;
      }
      const latest = candles[latestIdx];
      // 수정주가 우선, 없으면 원주가 fallback
      const adjP = (c: PlainCandle) => c.adjClose ?? c.close;
      const adjO = (c: PlainCandle) => c.adjOpen ?? c.open;
      const adjH = (c: PlainCandle) => c.adjHigh ?? c.high;
      const adjL = (c: PlainCandle) => c.adjLow ?? c.low;
      const closePrice = adjP(latest);
      const openPrice = adjO(latest);

      // [Patch 1] 52주 고/저가 (수정주가 기준 + 거래정지 캔들 제외)
      //   - 분할/병합 직후 원주가 high/low 가 그대로 max/min 에 잡혀 DF1/DF2 가 왜곡되는 문제 해결.
      //   - adjHigh/adjLow 가 NULL 인 과거 캔들은 원주가로 fallback.
      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of tradeCandles) {
        const h = adjH(c);
        const l = adjL(c);
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }
      if (!isFinite(high52w)) high52w = adjH(latest);
      if (!isFinite(low52w))  low52w  = adjL(latest);

      // [Patch 3] 전일 종가 — 거래정지 캔들을 건너뛰고 직전 "정상 거래일" 종가 사용
      // MA50 (수정주가 + volume>0)
      const ma50Slice = tradeCandles.slice(-50);
      const ma50 = ma50Slice.length >= 50
        ? ma50Slice.reduce((sum, c) => sum + adjP(c), 0) / 50
        : null;

      // MA150 (수정주가 + volume>0)
      const ma150Slice = tradeCandles.slice(-150);
      const ma150 = ma150Slice.length >= 150
        ? ma150Slice.reduce((sum, c) => sum + adjP(c), 0) / 150
        : null;

      // MA200 현재 (수정주가 + volume>0)
      const ma200Slice = tradeCandles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + adjP(c), 0) / 200
        : null;

      // RS(63): 종목별로 자기 시장 지수 사용
      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const idxCloseNow = idxCloseNowMap.get(stockIdxCode) ?? 0;

      const idx63AgoRef = idx63AgoRefMap.get(stockIdxCode) ?? null;
      const idx63Ago = idx63AgoRef ? idx63AgoRef.value : null;

      // 인덱스의 63거래일 전 기준일 이하에서 가장 가까운 정상 거래일 수정주가를 사용.
      // 거래정지/잔존 캔들이 기준일에 있어도 RS 계산에 섞이지 않게 한다.
      const close63Ago = (() => {
        if (idx63AgoRef === null) return null;
        for (let i = tradeCandles.length - 1; i >= 0; i--) {
          if (tradeCandles[i].candleTime.getTime() <= idx63AgoRef.timeMs) {
            return adjP(tradeCandles[i]);
          }
        }
        return null;
      })();

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = idxCloseNow / idx63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      // 거래대금 (DB에 tradingValue 있으면 사용, 없으면 수정주가×거래량 근사)
      // [Patch 1] 분할/병합 직후 원주가×거래량으로 잡으면 SF5(거래대금) 가 비정상으로 커지므로
      // adjClose 우선 사용.
      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : adjP(latest) * Number(latest.volume);

      // === 5개 정적 필터 (종가 기준, DB 저장) ===
      const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;           // MA50 > MA150
      const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;         // MA150 > MA200
      // SF3: MA200 20일 연속 상승추세 (단조 증가: 20일전 < 19일전 < ... < 현재)
      const sf3 = (() => {
        if (tradeCandles.length < 220) return false;
        let prev = -Infinity;
        for (let i = 20; i >= 0; i--) {
          const s = tradeCandles.slice(-200 - i, i === 0 ? undefined : -i);
          const ma = s.reduce((sum, c) => sum + adjP(c), 0) / 200;
          if (ma <= prev) return false;
          prev = ma;
        }
        return true;
      })();
      const sf4 = rsRaw > 0;                                                  // RS > 0
      const sf5 = tradingValue >= MIN_TRADING_VALUE;                          // 거래대금 >= 10억

      const passedStaticFilters = sf1 && sf2 && sf3 && sf4 && sf5;

      // 트렌드 템플릿 (Minervini): SF1+SF2+SF3 + 현재가>MA200 + DF1+DF2+DF3
      const tt_closeAboveMa200 = ma200 !== null && closePrice > ma200;
      const df1 = closePrice >= low52w * 1.3;
      const df2 = closePrice >= high52w * 0.75;
      const df3 = ma50 !== null && closePrice > ma50;
      const isTrendTemplate = sf1 && sf2 && sf3 && sf4 && tt_closeAboveMa200 && df1 && df2 && df3;

      // 디버그 통계 수집
      filterStats.total++;
      if (!sf1) filterStats.sf1Fail++;
      if (!sf2) filterStats.sf2Fail++;
      if (!sf3) filterStats.sf3Fail++;
      if (!sf4) filterStats.sf4Fail++;
      if (!sf5) filterStats.sf5Fail++;
      if (passedStaticFilters) filterStats.passed++;

      // [Patch 1] 신고가 판정도 수정주가(adjHigh) 기준
      const isNewHigh = adjH(latest) >= high52w;

      // === 투자 중요 지표 계산 (최근 10거래일 필요) ===
      // [Patch 3] TR / 가격압축 / 강도지속 모두 거래정지 캔들 제외 + 수정주가 기준
      const last11 = tradeCandles.slice(-11); // TR 계산에 prevClose 필요하므로 11개
      const last21 = tradeCandles.slice(-21);
      const last10 = tradeCandles.slice(-10);

      // 1) 변동성 축소: 최근 10일 True Range의 하락 추세 여부
      //    TR = max(adjHigh-adjLow, |adjHigh-prevAdjClose|, |adjLow-prevAdjClose|)
      //    앞 5일 평균 TR vs 뒤 5일 평균 TR 비교
      let isVolatilityContraction = false;
      if (last21.length >= 21) {
        const trValues: number[] = [];
        for (let i = 1; i < last21.length; i++) {
          const c = last21[i];
          const prev = last21[i - 1];
          const h = adjH(c);
          const l = adjL(c);
          const pc = adjP(prev);
          const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
          trValues.push(tr);
        }
        const atrValues: number[] = [];
        for (let i = 0; i <= trValues.length - 10; i++) {
          const window = trValues.slice(i, i + 10);
          atrValues.push(window.reduce((s, v) => s + v, 0) / 10);
        }
        const n = atrValues.length;
        const xAvg = (n - 1) / 2;
        const yAvg = atrValues.reduce((s, v) => s + v, 0) / n;
        const numerator = atrValues.reduce((s, y, x) => s + (x - xAvg) * (y - yAvg), 0);
        const denominator = atrValues.reduce((s, _y, x) => s + Math.pow(x - xAvg, 2), 0);
        isVolatilityContraction = denominator > 0 && numerator / denominator < 0;
      }

      // 2) 가격 압축: 오늘 고저폭이 최근 10일 중 최솟값 (수정주가 기준)
      let isPriceCompression = false;
      if (last10.length >= 10) {
        const todayRange = adjH(latest) - adjL(latest);
        const minRange = Math.min(...last10.map((c) => adjH(c) - adjL(c)));
        isPriceCompression = todayRange <= minRange;
      }

      // 3) 강도 지속: 최근 10거래일 중 종가 > 전일 종가인 날 수 (수정주가 기준)
      let strengthContinuationDays: number | null = null;
      if (last11.length >= 11) {
        let upDays = 0;
        for (let i = 1; i < last11.length; i++) {
          if (adjP(last11[i]) > adjP(last11[i - 1])) upDays++;
        }
        strengthContinuationDays = upDays;
      }

      calculations.push({
        stockCode,
        closePrice,
        high52w,
        low52w,
        isNewHigh,
        priceChange1d: closePrice - openPrice,
        priceChangeRate1d: openPrice > 0 ? ((closePrice - openPrice) / openPrice) * 100 : 0,
        volume: latest.volume,
        tradingValue: BigInt(Math.floor(tradingValue)),
        rsRaw,
        ma50,
        ma150,
        ma200,
        ma200_20d: null,
        close63Ago,
        idxCloseNow,
        idx63Ago,
        passedStaticFilters,
        isTrendTemplate,
        candleTime: latest.candleTime,
        isVolatilityContraction,
        isPriceCompression,
        strengthContinuationDays,
      });
      } // end candlesByStock loop
    } // end batch loop

    // 3. 정적 필터 통과 종목 → RS 내림차순 정렬 → 점수 + 랭킹
    const filtered = calculations.filter((c) => c.passedStaticFilters);
    filtered.sort((a, b) => b.rsRaw - a.rsRaw);

    const totalFiltered = filtered.length;
    this.logger.log(`Static filter passed: ${totalFiltered} / ${calculations.length} stocks`);
    this.logger.log(
      `[Static Filter Stats] Total: ${filterStats.total}, Passed: ${filterStats.passed}, ` +
      `SF1(MA50>MA150): ${filterStats.sf1Fail} fail, SF2(MA150>MA200): ${filterStats.sf2Fail} fail, ` +
      `SF3(MA200 uptrend): ${filterStats.sf3Fail} fail, SF4(RS>0): ${filterStats.sf4Fail} fail, SF5(거래대금>=10억): ${filterStats.sf5Fail} fail`,
    );

    for (let i = 0; i < filtered.length; i++) {
      const topPercent = ((i + 1) / totalFiltered) * 100;
      filtered[i].rsScore = this.percentileToScore(topPercent);
      filtered[i].rank = i + 1;
    }

    // 정적 필터 미통과 종목: 점수 0, 랭크 0
    for (const calc of calculations) {
      if (!calc.passedStaticFilters) {
        calc.rsScore = 0;
        calc.rank = 0;
      }
    }

    // 4. DB에 저장 — 단일 INSERT ... ON CONFLICT DO UPDATE chunk로 묶어서 라운드트립 최소화.
    //    기존 Promise.all(upsert) × 50 동시 실행은 connection pool 고갈 / lock contention 위험이 컸음.
    this.logger.log(`Saving metrics for ${calculations.length} stocks (bulk upsert)...`);

    const tradeDateNorm = new Date(targetDate);
    tradeDateNorm.setUTCHours(0, 0, 0, 0);
    const tradeDateIso = tradeDateNorm.toISOString().slice(0, 10);

    const SAVE_BATCH = 500;
    for (let i = 0; i < calculations.length; i += SAVE_BATCH) {
      const chunk = calculations.slice(i, i + SAVE_BATCH);
      if (chunk.length === 0) continue;

      // PostgreSQL parameterized VALUES list 생성. 컬럼 20개 × chunk.length.
      const COLUMNS_PER_ROW = 20;
      const valuePlaceholders: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const calc of chunk) {
        const slots: string[] = [];
        // metric_id : 스키마상 @default(uuid()) 이지만 일부 마이그레이션에는 DB 디폴트가 없을 수 있어
        // 클라이언트에서 UUID 생성. (gen_random_uuid는 pgcrypto 확장 필요)
        slots.push(`$${p++}::uuid`); params.push(randomUUID());
        // stock_code
        slots.push(`$${p++}::text`); params.push(calc.stockCode);
        // trade_date
        slots.push(`$${p++}::date`); params.push(tradeDateIso);
        // close_price
        slots.push(`$${p++}::numeric`); params.push(calc.closePrice);
        // relative_strength_score
        slots.push(`$${p++}::numeric`); params.push(calc.rsScore ?? 0);
        // rank
        slots.push(`$${p++}::int`); params.push(calc.rank ?? 0);
        // market_type
        slots.push(`$${p++}::text`); params.push(marketType);
        // is_new_high
        slots.push(`$${p++}::boolean`); params.push(calc.isNewHigh);
        // high_price_52w / low_price_52w
        slots.push(`$${p++}::numeric`); params.push(calc.high52w);
        slots.push(`$${p++}::numeric`); params.push(calc.low52w);
        // price_change_1d / price_change_rate_1d
        slots.push(`$${p++}::numeric`); params.push(calc.priceChange1d);
        slots.push(`$${p++}::numeric`); params.push(calc.priceChangeRate1d);
        // volume_1d / trading_value
        slots.push(`$${p++}::bigint`); params.push(calc.volume.toString());
        slots.push(`$${p++}::bigint`); params.push(calc.tradingValue.toString());
        // ma_50
        slots.push(`$${p++}::numeric`); params.push(calc.ma50);
        // passed_static_filters / is_trend_template / is_volatility_contraction / is_price_compression
        slots.push(`$${p++}::boolean`); params.push(calc.passedStaticFilters);
        slots.push(`$${p++}::boolean`); params.push(calc.isTrendTemplate);
        slots.push(`$${p++}::boolean`); params.push(calc.isVolatilityContraction);
        slots.push(`$${p++}::boolean`); params.push(calc.isPriceCompression);
        // strength_continuation_days
        slots.push(`$${p++}::int`); params.push(calc.strengthContinuationDays);
        if (slots.length !== COLUMNS_PER_ROW) {
          throw new Error(`Internal placeholder mismatch: expected ${COLUMNS_PER_ROW}, got ${slots.length}`);
        }
        valuePlaceholders.push(`(${slots.join(', ')})`);
      }

      const sql = `
        INSERT INTO stock_daily_metrics (
          metric_id, stock_code, trade_date, close_price, relative_strength_score, rank,
          market_type, is_new_high, high_price_52w, low_price_52w,
          price_change_1d, price_change_rate_1d, volume_1d, trading_value,
          ma_50, passed_static_filters, is_trend_template,
          is_volatility_contraction, is_price_compression, strength_continuation_days,
          updated_at
        )
        SELECT v.*, NOW() FROM ( VALUES ${valuePlaceholders.join(', ')} ) AS v
        ON CONFLICT (stock_code, trade_date) DO UPDATE SET
          close_price              = EXCLUDED.close_price,
          relative_strength_score  = EXCLUDED.relative_strength_score,
          rank                     = EXCLUDED.rank,
          market_type              = EXCLUDED.market_type,
          is_new_high              = EXCLUDED.is_new_high,
          high_price_52w           = EXCLUDED.high_price_52w,
          low_price_52w            = EXCLUDED.low_price_52w,
          price_change_1d          = EXCLUDED.price_change_1d,
          price_change_rate_1d     = EXCLUDED.price_change_rate_1d,
          volume_1d                = EXCLUDED.volume_1d,
          trading_value            = EXCLUDED.trading_value,
          ma_50                    = EXCLUDED.ma_50,
          passed_static_filters    = EXCLUDED.passed_static_filters,
          is_trend_template        = EXCLUDED.is_trend_template,
          is_volatility_contraction = EXCLUDED.is_volatility_contraction,
          is_price_compression     = EXCLUDED.is_price_compression,
          strength_continuation_days = EXCLUDED.strength_continuation_days,
          updated_at               = NOW()
      `;

      await this.prisma.$executeRawUnsafe(sql, ...params);
      this.logger.log(`Bulk upsert chunk ${i + chunk.length}/${calculations.length}`);
    }

    this.logger.log(
      `Metrics calculation completed: ${calculations.length} total, ${totalFiltered} filtered, saved.`,
    );

    this.eventEmitter.emit('metrics.updated', {
      tradeDate: targetDate.toISOString().split('T')[0],
      filteredCount: totalFiltered,
    });

    if (writeLogFile) {
      // 정적 + 동적 필터 모두 통과한 종목만 로그 (종가를 현재가로 사용)
      const dynamicFiltered = filtered.filter((calc) => {
        const df1 = calc.closePrice >= calc.low52w * 1.3;
        const df2 = calc.closePrice >= calc.high52w * 0.75;
        const df3 = calc.ma50 !== null && calc.closePrice > calc.ma50;
        return df1 && df2 && df3;
      });

      const now = new Date();
      const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const displayTimestamp = kstNow.toISOString().replace('T', ' ').substring(0, 19);
      const indexInfo = stockIndexMap ? 'KOSPI/KOSDAQ(종목별)' : indexCode.replace('INDEX_', '');
      const rs63RefInfo = indexCodesToLoad
        .map((idx) => {
          const ref = idx63AgoRefMap.get(idx);
          return `${idx.replace('INDEX_', '')}=${ref?.date ?? 'N/A'}`;
        })
        .join(', ');
      const tradeDateStr = targetDate.toISOString().split('T')[0];
      const runTimeStr = kstNow.toISOString().substring(11, 19).replace(/:/g, '');
      const fileTimestamp = `${tradeDateStr}_${runTimeStr}`;
      const logsDir = path.join(process.cwd(), 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      const rsLogPath = path.join(logsDir, `rs-scores-${fileTimestamp}.log`);
      const tsv = (value: unknown) => String(value ?? 'N/A').replace(/[\t\r\n]/g, ' ');
      const headers = [
        'rank',
        'code',
        'name',
        'rsRaw',
        'score',
        'closePrice',
        'close63Ago',
        'idxCloseNow',
        'idx63Ago',
        'MA50',
        'MA150',
        'MA200',
        'MA200_20d',
        'high52w',
        'low52w',
        'tradingValueEok',
        'isNewHigh',
        'df1_close_ge_low52w_x1_3',
        'df2_close_ge_high52w_x0_75',
        'df3_close_gt_MA50',
        'tradeDate',
        'runAt',
        'rs63Ref',
        'indexInfo',
        'marketType',
      ];
      const rsLogLines = [
        headers.join('\t'),
        ...dynamicFiltered.map((calc, i) => {
          const name = stockNameMap?.get(calc.stockCode) ?? '';
          const tradingValueEok = (Number(calc.tradingValue) / 1e8).toFixed(1);
          const df1Val = `${calc.closePrice}>=${(calc.low52w * 1.3).toFixed(0)}`;
          const df2Val = `${calc.closePrice}>=${(calc.high52w * 0.75).toFixed(0)}`;
          const df3Val = calc.ma50 !== null ? `${calc.closePrice}>${calc.ma50.toFixed(0)}` : 'N/A';
          return [
            i + 1,
            calc.stockCode,
            name,
            calc.rsRaw.toFixed(6),
            calc.rsScore ?? 0,
            calc.closePrice,
            calc.close63Ago !== null ? calc.close63Ago : 'N/A',
            calc.idxCloseNow,
            calc.idx63Ago !== null ? calc.idx63Ago : 'N/A',
            calc.ma50 !== null ? calc.ma50.toFixed(0) : 'N/A',
            calc.ma150 !== null ? calc.ma150.toFixed(0) : 'N/A',
            calc.ma200 !== null ? calc.ma200.toFixed(0) : 'N/A',
            calc.ma200_20d !== null ? calc.ma200_20d.toFixed(0) : 'N/A',
            calc.high52w,
            calc.low52w,
            tradingValueEok,
            calc.isNewHigh ? 'Y' : 'N',
            df1Val,
            df2Val,
            df3Val,
            tradeDateStr,
            displayTimestamp,
            rs63RefInfo,
            indexInfo,
            marketType,
          ].map(tsv).join('\t');
        }),
      ].join('\n');
      fs.writeFileSync(rsLogPath, rsLogLines + '\n', { encoding: 'utf-8' });
      this.logger.log(`RS scores written to logs/rs-scores-${fileTimestamp}.log (static: ${totalFiltered}, dynamic: ${dynamicFiltered.length})`);
    }

    return {
      success: true,
      count: calculations.length,
      filtered: totalFiltered,
      date: targetDate,
    };
  }

  /**
   * 특정 종목코드 리스트에 대한 RS 점수 로그 생성
   * 필터 통과 여부와 관계없이 모든 종목의 상세 값을 출력
   */
  async calculateCustomRsLog(
    stockCodes: string[],
    tradeDate?: string,
  ) {
    const targetDate = tradeDate
      ? new Date(`${tradeDate.substring(0, 4)}-${tradeDate.substring(4, 6)}-${tradeDate.substring(6, 8)}T15:00:00.000Z`)
      : (() => { const d = new Date(); d.setUTCHours(15, 0, 0, 0); return d; })();

    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - StockMetricsService.CANDLE_LOOKBACK_DAYS);

    // 종목 시장 정보 + 이름 조회
    const stockInfos = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes } },
      select: { stockCode: true, companyName: true, marketType: true },
    });
    const stockNameMap = new Map(stockInfos.map((s) => [s.stockCode, s.companyName]));
    const stockMarketMap = new Map(stockInfos.map((s) => [s.stockCode, s.marketType]));

    // 종목별 시장 지수 결정
    const stockIndexMap = new Map<string, string>();
    for (const code of stockCodes) {
      const market = stockMarketMap.get(code);
      stockIndexMap.set(code, market === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI');
    }

    const [allCandles, kospiCandles, kosdaqCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { in: stockCodes },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      this.prisma.stockCandle.findMany({
        where: { stockCode: 'INDEX_KOSPI', candleType: 'day', candleTime: { gte: historicalCutoff, lte: targetDate } },
        orderBy: { candleTime: 'asc' },
      }),
      this.prisma.stockCandle.findMany({
        where: { stockCode: 'INDEX_KOSDAQ', candleType: 'day', candleTime: { gte: historicalCutoff, lte: targetDate } },
        orderBy: { candleTime: 'asc' },
      }),
    ]);

    const indexCandlesMap = new Map([
      ['INDEX_KOSPI', kospiCandles.filter((c) => isKrxTradingDay(c.candleTime))],
      ['INDEX_KOSDAQ', kosdaqCandles.filter((c) => isKrxTradingDay(c.candleTime))],
    ]);

    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles.filter((c) => isKrxTradingDay(c.candleTime))) {
      if (!candlesByStock.has(candle.stockCode)) candlesByStock.set(candle.stockCode, []);
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    const MIN_TRADING_VALUE = 1_000_000_000;
    const rows: string[] = [];

    for (const stockCode of stockCodes) {
      const candles = candlesByStock.get(stockCode) ?? [];
      const name = stockNameMap.get(stockCode) ?? '';

      if (candles.length === 0) {
        rows.push(`code=${stockCode}, name=${name}, ERROR=캔들데이터없음`);
        continue;
      }

      const tradeCandles = candles.filter((c) => c.volume > 0n);
      if (tradeCandles.length === 0) {
        rows.push(`code=${stockCode}, name=${name}, ERROR=정상거래캔들없음`);
        continue;
      }

      const latest = tradeCandles[tradeCandles.length - 1];
      const adjP = (c: typeof latest) => (c.adjClosePrice ?? c.closePrice).toNumber();
      const adjH = (c: typeof latest) => (c.adjHighPrice ?? c.highPrice).toNumber();
      const adjL = (c: typeof latest) => (c.adjLowPrice ?? c.lowPrice).toNumber();
      const closePrice = adjP(latest);

      let high52w = -Infinity, low52w = Infinity;
      for (const c of tradeCandles) {
        const h = adjH(c), l = adjL(c);
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma50Slice = tradeCandles.slice(-50);
      const ma50 = ma50Slice.length >= 50 ? ma50Slice.reduce((s, c) => s + adjP(c), 0) / 50 : null;

      const ma150Slice = tradeCandles.slice(-150);
      const ma150 = ma150Slice.length >= 150 ? ma150Slice.reduce((s, c) => s + adjP(c), 0) / 150 : null;

      const ma200Slice = tradeCandles.slice(-200);
      const ma200 = ma200Slice.length >= 200 ? ma200Slice.reduce((s, c) => s + adjP(c), 0) / 200 : null;

      const ma200_20dSlice = tradeCandles.length >= 220 ? tradeCandles.slice(-220, -20) : [];
      const ma200_20d = ma200_20dSlice.length >= 200 ? ma200_20dSlice.reduce((s, c) => s + adjP(c), 0) / 200 : null;

      const stockIdxCode = stockIndexMap.get(stockCode) ?? 'INDEX_KOSPI';
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) ?? [];
      const idxCloseNow = stockIdxCandles.length > 0 ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber() : 0;
      const idx63AgoCandle = stockIdxCandles.length > 63 ? stockIdxCandles[stockIdxCandles.length - 64] : null;
      const idx63Ago = idx63AgoCandle ? idx63AgoCandle.closePrice.toNumber() : null;
      const close63Ago = idx63AgoCandle
        ? (() => {
            const refMs = idx63AgoCandle.candleTime.getTime();
            for (let i = tradeCandles.length - 1; i >= 0; i--) {
              if (tradeCandles[i].candleTime.getTime() <= refMs) return adjP(tradeCandles[i]);
            }
            return null;
          })()
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        rsRaw = (closePrice / close63Ago) / (idxCloseNow / idx63Ago);
      }

      const tradingValue = latest.tradingValue ? Number(latest.tradingValue) : closePrice * Number(latest.volume);
      const tv억 = (tradingValue / 1e8).toFixed(1);

      const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;
      const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;
      // SF3: MA200 20일 연속 상승추세 (단조 증가: 20일전 < 19일전 < ... < 현재)
      const sf3 = (() => {
        if (tradeCandles.length < 220) return false;
        let prev = -Infinity;
        for (let i = 20; i >= 0; i--) {
          const s = tradeCandles.slice(-200 - i, i === 0 ? undefined : -i);
          const ma = s.reduce((sum, c) => sum + adjP(c), 0) / 200;
          if (ma <= prev) return false;
          prev = ma;
        }
        return true;
      })();
      const sf4 = rsRaw > 0;
      const sf5 = tradingValue >= MIN_TRADING_VALUE;

      const df1 = closePrice >= low52w * 1.3;
      const df2 = closePrice >= high52w * 0.75;
      const df3 = ma50 !== null && closePrice > ma50;

      const sfResult = `sf1=${sf1?'O':'X'},sf2=${sf2?'O':'X'},sf3=${sf3?'O':'X'},sf4=${sf4?'O':'X'},sf5=${sf5?'O':'X'}`;
      const dfResult = `df1=${df1?'O':'X'},df2=${df2?'O':'X'},df3=${df3?'O':'X'}`;
      const passAll = sf1 && sf2 && sf3 && sf4 && sf5 && df1 && df2 && df3;

      rows.push([
        `code=${stockCode}`,
        `name=${name}`,
        `candles=${tradeCandles.length}`,
        `pass=${passAll ? 'Y' : 'N'}`,
        `[${sfResult}]`,
        `[${dfResult}]`,
        `rsRaw=${rsRaw.toFixed(6)}`,
        `closePrice=${closePrice}`,
        `close63Ago=${close63Ago ?? 'N/A'}`,
        `idxCloseNow=${idxCloseNow}`,
        `idx63Ago=${idx63Ago ?? 'N/A'}`,
        `MA50=${ma50 !== null ? ma50.toFixed(0) : 'N/A'}`,
        `MA150=${ma150 !== null ? ma150.toFixed(0) : 'N/A'}`,
        `MA200=${ma200 !== null ? ma200.toFixed(0) : 'N/A'}`,
        `MA200_20d=${ma200_20d !== null ? ma200_20d.toFixed(0) : 'N/A'}`,
        `52주고가=${high52w}`,
        `52주저가=${low52w}`,
        `거래대금=${tv억}억`,
        `df1조건=${closePrice}>=${(low52w * 1.3).toFixed(0)}`,
        `df2조건=${closePrice}>=${(high52w * 0.75).toFixed(0)}`,
        `df3조건=${ma50 !== null ? `${closePrice}>${ma50.toFixed(0)}` : 'N/A'}`,
      ].join(', '));
    }

    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const fileTimestamp = kstNow.toISOString().replace('T', '_').replace(/:/g, '').substring(0, 17);
    const displayTimestamp = kstNow.toISOString().replace('T', ' ').substring(0, 19);
    const kstTargetDate = new Date(targetDate.getTime() + 9 * 60 * 60 * 1000);
    const tradeDateStr = kstTargetDate.toISOString().split('T')[0];

    const logFile = `custom-rs-scores-${fileTimestamp}.log`;
    const logPath = path.join(this.getCustomLogsDir(), logFile);
    const header = `=== Custom RS Scores [${displayTimestamp}] | 조회기준일: ${tradeDateStr} | 종목수: ${stockCodes.length} | 데이터있음: ${candlesByStock.size} ===`;
    fs.writeFileSync(logPath, [header, ...rows].join('\n') + '\n', { encoding: 'utf-8' });

    this.logger.log(`Custom RS scores written to ${this.getCustomLogRef(logFile)}`);

    return {
      success: true,
      logFile: this.getCustomLogRef(logFile),
      total: stockCodes.length,
      found: candlesByStock.size,
    };
  }

  async calculateRsFilterLog(
    stockCodesInput: string[] | undefined,
    tradeDate?: string,
    rsPeriods?: string,
    rsWeights?: string,
    rsDates?: string,
  ) {
    const targetDate = tradeDate
      ? new Date(`${tradeDate.substring(0, 4)}-${tradeDate.substring(4, 6)}-${tradeDate.substring(6, 8)}T15:00:00.000Z`)
      : (() => { const d = new Date(); d.setUTCHours(15, 0, 0, 0); return d; })();

    // stockCodes 미입력 시 DB에서 KOSPI/KOSDAQ 보통주만 조회 (끝자리 5 우선주 제외)
    const stockCodes: string[] = stockCodesInput && stockCodesInput.length > 0
      ? stockCodesInput
      : (await this.prisma.company.findMany({
          where: { marketType: { in: ['KOSPI', 'KOSDAQ'] } },
          select: { stockCode: true },
        })).map((c) => c.stockCode).filter((code) => !code.endsWith('5'));

    // rsDates → 캘린더일수 변환 (targetDate 기준)
    let parsedPeriods: number[];
    let parsedWeights: number[];

    if (rsDates) {
      parsedPeriods = await this.resolveTradingPeriodsFromDates(rsDates, targetDate);
      parsedWeights = rsWeights
        ? rsWeights.split(',').map((w) => parseFloat(w.trim()))
        : parsedPeriods.map(() => 100 / parsedPeriods.length);
    } else if (rsPeriods) {
      parsedPeriods = rsPeriods.split(',').map((p) => parseInt(p.trim()));
      parsedWeights = rsWeights
        ? rsWeights.split(',').map((w) => parseFloat(w.trim()))
        : parsedPeriods.map(() => 100 / parsedPeriods.length);
    } else {
      parsedPeriods = [63];
      parsedWeights = [100];
    }

    if (parsedPeriods.length !== parsedWeights.length) {
      parsedWeights = parsedPeriods.map(() => 100 / parsedPeriods.length);
    }

    const maxPeriod = Math.max(...parsedPeriods);
    const historicalCutoff = new Date(targetDate);
    // 거래일 period → 달력일 변환 (거래일 1일 ≈ 달력일 1.5일): 충분한 여유를 주어 거래정지 종목도 커버
    const calendarDaysNeeded = Math.ceil(maxPeriod * 1.6) + 100;
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - Math.max(StockMetricsService.CANDLE_LOOKBACK_DAYS, calendarDaysNeeded));

    const stockInfos = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes } },
      select: { stockCode: true, companyName: true, marketType: true },
    });
    const stockNameMap = new Map(stockInfos.map((s) => [s.stockCode, s.companyName]));
    const stockMarketMap = new Map(stockInfos.map((s) => [s.stockCode, s.marketType]));
    const excludedInstrumentCodes = new Set(
      stockInfos
        .filter((stock) => this.isExcludedInstrumentName(stock.companyName))
        .map((stock) => stock.stockCode),
    );
    const effectiveStockCodes = stockCodes.filter((code) => !excludedInstrumentCodes.has(code));

    const stockIndexMap = new Map<string, string>();
    for (const code of effectiveStockCodes) {
      stockIndexMap.set(code, stockMarketMap.get(code) === 'KOSDAQ' ? 'INDEX_KOSDAQ' : 'INDEX_KOSPI');
    }

    const indexCodesToLoad = [...new Set(stockIndexMap.values())];

    const [allCandles, ...indexCandlesArr] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { in: effectiveStockCodes },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      ...indexCodesToLoad.map((idx) =>
        this.prisma.stockCandle.findMany({
          where: { stockCode: idx, candleType: 'day', candleTime: { gte: historicalCutoff, lte: targetDate } },
          orderBy: { candleTime: 'asc' },
        }),
      ),
    ]);

    const indexCandlesMap = new Map<string, typeof allCandles>();
    indexCodesToLoad.forEach((idx, i) => {
      indexCandlesMap.set(idx, indexCandlesArr[i].filter((c) => isKrxTradingDay(c.candleTime)));
    });

    const rawCandlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles.filter((c) => isKrxTradingDay(c.candleTime))) {
      if (!rawCandlesByStock.has(candle.stockCode)) rawCandlesByStock.set(candle.stockCode, []);
      rawCandlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 인덱스 거래일 기준으로 종목 캔들의 거래정지일을 이전 종가로 채우기
    const toKstDateStr = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    const fillSuspendedDays = (rawCandles: typeof allCandles, idxCandles: typeof allCandles): typeof allCandles => {
      if (rawCandles.length === 0) return rawCandles;
      const stockFirstDate = toKstDateStr(rawCandles[0].candleTime);
      const rawMap = new Map(rawCandles.map((c) => [toKstDateStr(c.candleTime), c]));
      const filled: typeof allCandles = [];
      let lastCandle = rawCandles[0];
      for (const idxC of idxCandles) {
        const dk = toKstDateStr(idxC.candleTime);
        if (dk < stockFirstDate) continue; // 상장 전 날짜 스킵
        const found = rawMap.get(dk);
        if (found) {
          lastCandle = found;
          filled.push(found);
        } else {
          // 거래정지일: 이전 거래일 종가로 채운 가상 캔들 (volume=0)
          filled.push({ ...lastCandle, candleTime: idxC.candleTime, volume: 0n, tradingValue: 0n });
        }
      }
      return filled;
    };

    const MIN_TRADING_VALUE = 1_000_000_000;

    type PassedStock = {
      stockCode: string;
      name: string;
      marketType: string;
      rsWeighted: number;
      rsValues: { period: number; rsRaw: number; stockAgo: number | null; idxAgo: number | null }[];
      closePrice: number;
      idxCloseNow: number;
      ma50: number | null;
      ma150: number | null;
      ma200: number | null;
      ma200_20d: number | null;
      high52w: number;
      low52w: number;
      tradingValueEok: string;
      isNewHigh: boolean;
      df1Val: string;
      df2Val: string;
      df3Val: string;
    };

    const passed: PassedStock[] = [];

    for (const stockCode of effectiveStockCodes) {
      const rawCandles = rawCandlesByStock.get(stockCode) ?? [];
      const name = stockNameMap.get(stockCode) ?? '';
      const mkt = stockMarketMap.get(stockCode) ?? '';
      const idxCode = stockIndexMap.get(stockCode) ?? 'INDEX_KOSPI';
      const idxCandles = indexCandlesMap.get(idxCode) ?? [];

      if (rawCandles.length === 0) continue;

      // 인덱스 거래일 기준으로 거래정지일 채우기 (이전 종가로 forward-fill)
      const candles = fillSuspendedDays(rawCandles, idxCandles);
      const tradeCandles = rawCandles.filter((c) => c.volume > 0n); // 실제 거래일만 (MA/거래대금용)
      if (tradeCandles.length === 0) continue;

      const latest = tradeCandles[tradeCandles.length - 1];
      const adjP = (c: typeof latest) => (c.adjClosePrice ?? c.closePrice).toNumber();
      const adjH = (c: typeof latest) => (c.adjHighPrice ?? c.highPrice).toNumber();
      const adjL = (c: typeof latest) => (c.adjLowPrice ?? c.lowPrice).toNumber();
      const closePrice = adjP(latest);
      const idxCloseNow = idxCandles.length > 0 ? idxCandles[idxCandles.length - 1].closePrice.toNumber() : 0;

      const rsValues: { period: number; rsRaw: number; stockAgo: number | null; idxAgo: number | null }[] = [];
      for (const period of parsedPeriods) {
        // RS 계산은 거래정지일이 채워진 candles 사용 (인덱스와 동일한 기준)
        if (candles.length <= period || idxCandles.length <= period) {
          rsValues.push({ period, rsRaw: 0, stockAgo: null, idxAgo: null });
          continue;
        }
        const stockAgo = adjP(candles[candles.length - 1 - period]);
        const idxAgo = idxCandles[idxCandles.length - 1 - period].closePrice.toNumber();
        rsValues.push({
          period,
          rsRaw: stockAgo > 0 && idxAgo > 0 ? (closePrice / stockAgo) / (idxCloseNow / idxAgo) : 0,
          stockAgo,
          idxAgo,
        });
      }

      let weightedRS = 0, totalWeight = 0;
      for (let i = 0; i < rsValues.length; i++) {
        if (rsValues[i].rsRaw > 0) {
          weightedRS += rsValues[i].rsRaw * parsedWeights[i];
          totalWeight += parsedWeights[i];
        }
      }
      if (totalWeight > 0) weightedRS /= totalWeight;

      let high52w = -Infinity, low52w = Infinity;
      for (const c of tradeCandles) {
        const h = adjH(c), l = adjL(c);
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma50Slice = tradeCandles.slice(-50);
      const ma50 = ma50Slice.length >= 50 ? ma50Slice.reduce((s, c) => s + adjP(c), 0) / 50 : null;
      const ma150Slice = tradeCandles.slice(-150);
      const ma150 = ma150Slice.length >= 150 ? ma150Slice.reduce((s, c) => s + adjP(c), 0) / 150 : null;
      const ma200Slice = tradeCandles.slice(-200);
      const ma200 = ma200Slice.length >= 200 ? ma200Slice.reduce((s, c) => s + adjP(c), 0) / 200 : null;
      const ma200_20dSlice = tradeCandles.length >= 220 ? tradeCandles.slice(-220, -20) : [];
      const ma200_20d = ma200_20dSlice.length >= 200 ? ma200_20dSlice.reduce((s, c) => s + adjP(c), 0) / 200 : null;

      const tradingValue = latest.tradingValue ? Number(latest.tradingValue) : closePrice * Number(latest.volume);

      const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;
      const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;
      const sf3 = (() => {
        if (tradeCandles.length < 220) return false;
        let prev = -Infinity;
        for (let i = 20; i >= 0; i--) {
          const s = tradeCandles.slice(-200 - i, i === 0 ? undefined : -i);
          const ma = s.reduce((sum, c) => sum + adjP(c), 0) / 200;
          if (ma <= prev) return false;
          prev = ma;
        }
        return true;
      })();
      const sf4 = weightedRS > 0;
      const sf5 = tradingValue >= MIN_TRADING_VALUE;
      const df1 = closePrice >= low52w * 1.3;
      const df2 = closePrice >= high52w * 0.75;
      const df3 = ma50 !== null && closePrice > ma50;
      if (!(sf1 && sf2 && sf3 && sf4 && sf5 && df1 && df2 && df3)) continue;

      passed.push({
        stockCode,
        name,
        marketType: mkt,
        rsWeighted: weightedRS,
        rsValues,
        closePrice,
        idxCloseNow,
        ma50,
        ma150,
        ma200,
        ma200_20d,
        high52w,
        low52w,
        tradingValueEok: (tradingValue / 1e8).toFixed(1),
        isNewHigh: closePrice >= high52w,
        df1Val: `${closePrice}>=${(low52w * 1.3).toFixed(0)}`,
        df2Val: `${closePrice}>=${(high52w * 0.75).toFixed(0)}`,
        df3Val: ma50 !== null ? `${closePrice}>${ma50.toFixed(0)}` : 'N/A',
      });
    }

    // rsWeighted 내림차순 정렬 후 rank/score 부여
    passed.sort((a, b) => b.rsWeighted - a.rsWeighted);
    const total = passed.length;

    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const fileTimestamp = kstNow.toISOString().replace('T', '_').replace(/:/g, '').substring(0, 17);
    const displayTimestamp = kstNow.toISOString().replace('T', ' ').substring(0, 19);
    const tradeDateStr = tradeDate
      ? `${tradeDate.substring(0, 4)}-${tradeDate.substring(4, 6)}-${tradeDate.substring(6, 8)}`
      : new Date(targetDate.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];
    const periodsInfo = parsedPeriods.map((p, i) => `${p}d(w=${parsedWeights[i].toFixed(0)})`).join('+');

    const tsv = (v: unknown) => String(v ?? 'N/A').replace(/[\t\r\n]/g, ' ');
    const fmtDate = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0];

    // 지수 캔들 기준으로 기간별 startDate/endDate 계산
    const refIdxCandles = indexCandlesMap.get('INDEX_KOSPI') ?? indexCandlesMap.get('INDEX_KOSDAQ') ?? [];
    const periodDateLines = parsedPeriods.map((p, i) => {
      const endCandle = refIdxCandles.length > 0 ? refIdxCandles[refIdxCandles.length - 1] : null;
      const startCandle = refIdxCandles.length > p ? refIdxCandles[refIdxCandles.length - 1 - p] : null;
      const startDate = startCandle ? fmtDate(startCandle.candleTime) : 'N/A';
      const endDate = endCandle ? fmtDate(endCandle.candleTime) : tradeDateStr;
      return `# period${i + 1}: ${p}d(w=${parsedWeights[i].toFixed(0)}%)  startDate=${startDate}  endDate=${endDate}`;
    });

    // 동적 기간 컬럼 헤더
    const periodHeaders = parsedPeriods.flatMap((p) => [`rs${p}d`, `close${p}dAgo`, `idx${p}dAgo`]);
    const headers = [
      'rank', 'code', 'name', 'rsWeighted', 'score',
      'closePrice', ...periodHeaders, 'idxCloseNow',
      'MA50', 'MA150', 'MA200', 'MA200_20d',
      'high52w', 'low52w', 'tradingValueEok', 'isNewHigh',
      'df1_close_ge_low52w_x1_3', 'df2_close_ge_high52w_x0_75', 'df3_close_gt_MA50',
      'tradeDate', 'runAt', 'periodsInfo', 'marketType',
    ];

    const dataRows = passed.map((s, i) => {
      const rank = i + 1;
      const topPercent = (rank / total) * 100;
      const score = this.percentileToScore(topPercent);
      const periodCols = s.rsValues.flatMap((r) => [r.rsRaw.toFixed(6), r.stockAgo ?? 'N/A', r.idxAgo ?? 'N/A']);
      return [
        rank, s.stockCode, s.name, s.rsWeighted.toFixed(6), score,
        s.closePrice, ...periodCols, s.idxCloseNow,
        s.ma50 !== null ? s.ma50.toFixed(0) : 'N/A',
        s.ma150 !== null ? s.ma150.toFixed(0) : 'N/A',
        s.ma200 !== null ? s.ma200.toFixed(0) : 'N/A',
        s.ma200_20d !== null ? s.ma200_20d.toFixed(0) : 'N/A',
        s.high52w, s.low52w, s.tradingValueEok,
        s.isNewHigh ? 'Y' : 'N',
        s.df1Val, s.df2Val, s.df3Val,
        tradeDateStr, displayTimestamp, periodsInfo, s.marketType,
      ].map(tsv).join('\t');
    });

    const logFile = `rs-filter-log-${fileTimestamp}.log`;
    const logPath = path.join(this.getCustomLogsDir(), logFile);
    const metaHeader = [
      `# RS Filter Log | 조회기준일: ${tradeDateStr} | 실행: ${displayTimestamp} | 필터통과: ${total}종목`,
      ...periodDateLines,
      '#',
    ].join('\n');
    fs.writeFileSync(logPath, [metaHeader, headers.join('\t'), ...dataRows].join('\n') + '\n', { encoding: 'utf-8' });

    this.logger.log(`RS filter log written to ${this.getCustomLogRef(logFile)} (passed: ${total})`);

    return {
      success: true,
      logFile: this.getCustomLogRef(logFile),
      total: stockCodes.length,
      found: rawCandlesByStock.size,
      passed: total,
      periodsUsed: parsedPeriods,
      weightsUsed: parsedWeights,
      rows: passed.map((s, i) => ({
        stockCode: s.stockCode,
        name: s.name,
        marketType: s.marketType,
        rank: i + 1,
        rsScore: this.percentileToScore(((i + 1) / total) * 100),
        rsWeighted: s.rsWeighted,
      })),
    };
  }

  async resolveTradingPeriodsFromRanges(
    rsFilters: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>,
    indexCode = 'INDEX_KOSPI',
  ): Promise<number[]> {
    const parseKey = (value: string) => {
      const trimmed = value.trim();
      return trimmed.includes('-')
        ? trimmed
        : `${trimmed.substring(0, 4)}-${trimmed.substring(4, 6)}-${trimmed.substring(6, 8)}`;
    };
    const toKstKey = (date: Date) => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const allKeys = rsFilters.flatMap((f) => [parseKey(f.rsStartDate), parseKey(f.rsEndDate)]);
    const minKey = allKeys.reduce((min, key) => key < min ? key : min, allKeys[0]);
    const maxKey = allKeys.reduce((max, key) => key > max ? key : max, allKeys[0]);
    const from = new Date(`${minKey}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 10);
    const to = new Date(`${maxKey}T23:59:59.999Z`);
    to.setUTCDate(to.getUTCDate() + 10);

    const candles = (await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: indexCode,
        candleTime: { gte: from, lte: to },
      },
      orderBy: { candleTime: 'asc' },
      select: { candleTime: true },
    })).filter((c) => isKrxTradingDay(c.candleTime));

    const keys = candles.map((c) => toKstKey(c.candleTime));

    return rsFilters.map((filter) => {
      const startKey = parseKey(filter.rsStartDate);
      const endKey = parseKey(filter.rsEndDate);
      const startIndex = keys.findIndex((key) => key >= startKey);
      let endIndex = -1;
      for (let i = keys.length - 1; i >= 0; i--) {
        if (keys[i] <= endKey) {
          endIndex = i;
          break;
        }
      }
      if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return 63;
      return endIndex - startIndex;
    });
  }

  async resolveTradingPeriodsFromDates(
    rsDates: string,
    targetDate: Date,
    indexCode = 'INDEX_KOSPI',
  ): Promise<number[]> {
    const parseKey = (value: string) => {
      const trimmed = value.trim();
      return trimmed.includes('-')
        ? trimmed
        : `${trimmed.substring(0, 4)}-${trimmed.substring(4, 6)}-${trimmed.substring(6, 8)}`;
    };
    const toKstKey = (date: Date) => new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateKeys = rsDates.split(',').map(parseKey).filter(Boolean);
    if (dateKeys.length === 0) return [63];

    const minKey = dateKeys.reduce((min, key) => key < min ? key : min, dateKeys[0]);
    const from = new Date(`${minKey}T00:00:00.000Z`);
    from.setUTCDate(from.getUTCDate() - 10);

    const candles = (await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        stockCode: indexCode,
        candleTime: { gte: from, lte: targetDate },
      },
      orderBy: { candleTime: 'asc' },
      select: { candleTime: true },
    })).filter((c) => isKrxTradingDay(c.candleTime));

    const keys = candles.map((c) => toKstKey(c.candleTime));
    if (keys.length === 0) return dateKeys.map(() => 63);

    const endIndex = keys.length - 1;
    return dateKeys.map((dateKey) => {
      const startIndex = keys.findIndex((key) => key >= dateKey);
      if (startIndex < 0 || endIndex <= startIndex) return 1;
      return endIndex - startIndex;
    });
  }

  writeRangeRsResultLog(params: {
    tradeDate?: Date | null;
    marketType: string;
    filters: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>;
    periods: number[];
    weights: number[];
    totalCount: number;
    rows: Array<{
      rank: number;
      stockCode: string;
      companyName: string;
      marketType?: string;
      theme?: string;
      rangeRank: number;
      rangeScore: number;
      closePrice?: number | null;
      tradingValue?: string | number | null;
      isNewHigh?: boolean;
      strengthContinuationDays?: number | null;
    }>;
  }) {
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    const fileTimestamp = kstNow.toISOString().replace('T', '_').replace(/:/g, '').substring(0, 17);
    const displayTimestamp = kstNow.toISOString().replace('T', ' ').substring(0, 19);
    const tradeDateStr = params.tradeDate
      ? new Date(params.tradeDate.getTime() + 9 * 60 * 60 * 1000).toISOString().split('T')[0]
      : 'N/A';
    const logFile = `range-rs-result-${fileTimestamp}.log`;
    const logPath = path.join(this.getCustomLogsDir(), logFile);
    const tsv = (v: unknown) => String(v ?? 'N/A').replace(/[\t\r\n]/g, ' ');
    const filterLines = params.filters.map((filter, index) =>
      `# period${index + 1}: ${filter.rsStartDate}~${filter.rsEndDate}  days=${params.periods[index]}  weight=${params.weights[index]}%`,
    );
    const headers = [
      'rank',
      'code',
      'name',
      'marketType',
      'theme',
      'rangeRank',
      'rangeScore',
      'closePrice',
      'tradingValue',
      'isNewHigh',
      'strengthContinuationDays',
    ];
    const rows = params.rows.map((row) => [
      row.rank,
      row.stockCode,
      row.companyName,
      row.marketType ?? '',
      row.theme ?? '',
      row.rangeRank,
      row.rangeScore,
      row.closePrice ?? '',
      row.tradingValue ?? '',
      row.isNewHigh ? 'Y' : 'N',
      row.strengthContinuationDays ?? '',
    ].map(tsv).join('\t'));
    const metaHeader = [
      `# Range RS Result Log | dataDate=${tradeDateStr} | runAt=${displayTimestamp} | marketType=${params.marketType} | total=${params.totalCount}`,
      ...filterLines,
      '#',
    ].join('\n');
    fs.writeFileSync(logPath, [metaHeader, headers.join('\t'), ...rows].join('\n') + '\n', { encoding: 'utf-8' });
    this.logger.log(`Range RS result log written to ${this.getCustomLogRef(logFile)} (total: ${params.totalCount})`);
    return { success: true, logFile: this.getCustomLogRef(logFile), total: params.totalCount };
  }

  /**
   * 디버그: 특정 종목들의 필터 상세 결과 조회
   * 종목별로 5개 필터 통과/실패 여부와 상세 값을 반환
   */
  async debugFilterCheck(
    stockCodes: string[],
    stockIndexMap?: Map<string, string>,
    indexCode: string = 'INDEX_KOSPI',
  ) {
    const targetDate = new Date();
    targetDate.setHours(0, 0, 0, 0);

    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - StockMetricsService.CANDLE_LOOKBACK_DAYS);

    const indexCodesToLoad = stockIndexMap
      ? [...new Set(stockIndexMap.values())]
      : [indexCode];

    const [allCandles, ...indexResultArrays] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff, lte: targetDate },
          stockCode: { in: stockCodes },
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      }),
      ...indexCodesToLoad.map((idx) =>
        this.prisma.stockCandle.findMany({
          where: {
            stockCode: idx,
            candleType: 'day',
            candleTime: { gte: historicalCutoff, lte: targetDate },
          },
          orderBy: { candleTime: 'asc' },
        }),
      ),
    ]);

    const indexCandlesMap = new Map<string, typeof allCandles>();
    indexCodesToLoad.forEach((idx, i) => {
      indexCandlesMap.set(idx, indexResultArrays[i].filter((c) => isKrxTradingDay(c.candleTime)));
    });

    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles.filter((c) => isKrxTradingDay(c.candleTime))) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    const MIN_TRADING_VALUE = 1_000_000_000;
    const results: Array<{
      stockCode: string;
      hasData: boolean;
      candleCount: number;
      closePrice: number;
      low52w: number;
      high52w: number;
      ma200: number | null;
      ma200_20d: number | null;
      rsRaw: number;
      tradingValue: number;
      f1: boolean; f1Detail: string;
      f2: boolean; f2Detail: string;
      f3: boolean; f3Detail: string;
      f4: boolean; f4Detail: string;
      f5: boolean; f5Detail: string;
      passedAll: boolean;
    }> = [];

    for (const stockCode of stockCodes) {
      const candles = candlesByStock.get(stockCode);
      if (!candles || candles.length === 0) {
        results.push({
          stockCode, hasData: false, candleCount: 0,
          closePrice: 0, low52w: 0, high52w: 0, ma200: null, ma200_20d: null, rsRaw: 0, tradingValue: 0,
          f1: false, f1Detail: 'No candle data',
          f2: false, f2Detail: 'No candle data',
          f3: false, f3Detail: 'No candle data',
          f4: false, f4Detail: 'No candle data',
          f5: false, f5Detail: 'No candle data',
          passedAll: false,
        });
        continue;
      }

      const tradeCandles = candles.filter((c) => c.volume > 0n);
      if (tradeCandles.length === 0) {
        results.push({
          stockCode, hasData: false, candleCount: 0,
          closePrice: 0, low52w: 0, high52w: 0, ma200: null, ma200_20d: null, rsRaw: 0, tradingValue: 0,
          f1: false, f1Detail: 'No normal trading candle data',
          f2: false, f2Detail: 'No normal trading candle data',
          f3: false, f3Detail: 'No normal trading candle data',
          f4: false, f4Detail: 'No normal trading candle data',
          f5: false, f5Detail: 'No normal trading candle data',
          passedAll: false,
        });
        continue;
      }

      const latest = tradeCandles[tradeCandles.length - 1];
      const adjP = (c: typeof latest) => (c.adjClosePrice ?? c.closePrice).toNumber();
      const adjH = (c: typeof latest) => (c.adjHighPrice ?? c.highPrice).toNumber();
      const adjL = (c: typeof latest) => (c.adjLowPrice ?? c.lowPrice).toNumber();
      const closePrice = adjP(latest);

      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of tradeCandles) {
        const h = adjH(c);
        const l = adjL(c);
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma200Slice = tradeCandles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + adjP(c), 0) / 200
        : null;

      const ma200_20dSlice = tradeCandles.length >= 220
        ? tradeCandles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + adjP(c), 0) / 200
        : null;

      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) || [];
      const idxCloseNow = stockIdxCandles.length > 0
        ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber()
        : 0;
      const idx63AgoCandle = stockIdxCandles.length > 63
        ? stockIdxCandles[stockIdxCandles.length - 64]
        : null;
      const idx63Ago = idx63AgoCandle
        ? idx63AgoCandle.closePrice.toNumber()
        : null;
      const close63Ago = idx63AgoCandle
        ? (() => {
            const refMs = idx63AgoCandle.candleTime.getTime();
            for (let i = tradeCandles.length - 1; i >= 0; i--) {
              if (tradeCandles[i].candleTime.getTime() <= refMs) return adjP(tradeCandles[i]);
            }
            return null;
          })()
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = idxCloseNow / idx63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : closePrice * Number(latest.volume);

      const f1 = closePrice >= low52w * 1.3;
      const f2 = closePrice >= 0.75 * high52w;
      // f3: MA200 20일 연속 상승추세 (단조 증가: 20일전 < 19일전 < ... < 현재)
      const f3 = (() => {
        if (tradeCandles.length < 220) return false;
        let prev = -Infinity;
        for (let i = 20; i >= 0; i--) {
          const s = tradeCandles.slice(-200 - i, i === 0 ? undefined : -i);
          const ma = s.reduce((sum, c) => sum + adjP(c), 0) / 200;
          if (ma <= prev) return false;
          prev = ma;
        }
        return true;
      })();
      const f4 = rsRaw > 0;
      const f5 = tradingValue >= MIN_TRADING_VALUE;

      results.push({
        stockCode,
        hasData: true,
        candleCount: tradeCandles.length,
        closePrice,
        low52w,
        high52w,
        ma200,
        ma200_20d,
        rsRaw,
        tradingValue,
        f1, f1Detail: `price(${closePrice}) >= low52w*1.3(${(low52w * 1.3).toFixed(0)})`,
        f2, f2Detail: `price(${closePrice}) >= 75%*high52w(${(high52w * 0.75).toFixed(0)})`,
        f3, f3Detail: `MA200 20일연속상승=${f3} MA200(${ma200?.toFixed(0) ?? 'null'}) MA200_20d(${ma200_20d?.toFixed(0) ?? 'null'}) candles:${candles.length}`,
        f4, f4Detail: `RS(${rsRaw.toFixed(4)}) > 0, close63Ago:${close63Ago}, idx63Ago:${idx63Ago}`,
        f5, f5Detail: `거래대금(${(tradingValue / 1e8).toFixed(1)}억) >= 10억`,
        passedAll: f1 && f2 && f3 && f4 && f5,
      });
    }

    return {
      date: targetDate.toISOString().split('T')[0],
      totalChecked: stockCodes.length,
      passed: results.filter(r => r.passedAll).length,
      failed: results.filter(r => !r.passedAll).length,
      noData: results.filter(r => !r.hasData).length,
      results,
    };
  }

  /**
   * 상위 퍼센트 → 1~99 점수 변환
   *
   * 기준:
   *   상위 1%  → 99점
   *   상위 5%  → 95점
   *   상위 10% → 90점
   *   상위 30% → 70점
   *   상위 100% → 1점
   */
  private percentileToScore(topPercent: number): number {
    let score: number;

    if (topPercent <= 1) {
      score = 99;
    } else if (topPercent <= 5) {
      score = 99 - (topPercent - 1) * (4 / 4); // 99 → 95
    } else if (topPercent <= 10) {
      score = 95 - (topPercent - 5) * (5 / 5); // 95 → 90
    } else if (topPercent <= 30) {
      score = 90 - (topPercent - 10) * (20 / 20); // 90 → 70
    } else {
      score = 70 - (topPercent - 30) * (69 / 70); // 70 → 1
    }

    return Math.max(1, Math.min(99, Math.round(score)));
  }
}
