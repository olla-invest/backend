import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../../generated/prisma';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class StockMetricsService {
  private readonly logger = new Logger(StockMetricsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

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
    this.logger.log(
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
    for (const candle of stockCandles) {
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
      const indexCandlesUpToDate = indexCandles.filter((c) => c.candleTime <= tradeDate);
      if (indexCandlesUpToDate.length === 0) continue;

      const latestIndexCandle = indexCandlesUpToDate[indexCandlesUpToDate.length - 1];
      const indexCloseNow = latestIndexCandle.closePrice.toNumber();

      // 각 종목별 RS 계산 + 필터 적용
      const stockData: Array<{ stockCode: string; rsRaw: number; passedFilters: boolean }> = [];
      const MIN_TRADING_VALUE = 1_000_000_000; // 10억

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles.filter((c) => c.candleTime <= tradeDate);
        if (candlesUpToDate.length === 0) continue;

        const latest = candlesUpToDate[candlesUpToDate.length - 1];
        const closePrice = latest.closePrice.toNumber();

        // MA50
        const ma50Slice = candlesUpToDate.slice(-50);
        const ma50 = ma50Slice.length >= 50
          ? ma50Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 50
          : null;

        // MA150
        const ma150Slice = candlesUpToDate.slice(-150);
        const ma150 = ma150Slice.length >= 150
          ? ma150Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 150
          : null;

        // MA200 (현재)
        const ma200Slice = candlesUpToDate.slice(-200);
        const ma200 = ma200Slice.length >= 200
          ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
          : null;

        // MA200 (20일 전)
        const ma200_20dSlice = candlesUpToDate.length >= 220
          ? candlesUpToDate.slice(-(200 + 20), -20)
          : [];
        const ma200_20d = ma200_20dSlice.length >= 200
          ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
          : null;

        // 거래대금
        const tradingValue = latest.tradingValue
          ? Number(latest.tradingValue)
          : closePrice * Number(latest.volume);

        // 여러 기간의 RS 계산
        const rsValues: number[] = [];
        for (const period of periods) {
          if (candlesUpToDate.length <= period) {
            rsValues.push(0);
            continue;
          }

          const pastPrice = candlesUpToDate[candlesUpToDate.length - 1 - period].closePrice.toNumber();

          // 해당 기간의 지수 과거가
          const indexPastCandles = indexCandles.filter((c) => c.candleTime <= tradeDate);
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
          const sf3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
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

    // 필터별 날짜 → 일수 변환
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const periodsData = rsFilters.map((f) => ({
      startDays: this.convertDateToDays(f.rsStartDate, today),
      endDays: this.convertDateToDays(f.rsEndDate, today),
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

          const rs = (startPrice / endPrice) / (indexStartPrice / indexEndPrice);
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
    // KST 기준 오늘 날짜를 UTC midnight으로 설정 (캔들 저장 방식과 일치: new Date('YYYY-MM-DD') = UTC midnight)
    const targetDate = tradeDate ?? (() => {
      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const kstDateStr = kstNow.toISOString().split('T')[0]; // 'YYYY-MM-DD' (KST 기준)
      return new Date(kstDateStr); // UTC midnight (= KST 당일 00:00 기준 캔들과 동일)
    })();

    this.logger.log(
      `Starting metrics calculation for ${marketType} on ${targetDate.toISOString().split('T')[0]}, index: ${indexCode}${stockIndexMap ? ' (multi-index)' : ''}`,
    );

    // 1. 365일 기준 커트오프 + 지수 캔들 먼저 로드 (소량)
    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - 365);

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
      indexCandlesMap.set(idx, indexResultArrays[i]);
    });

    if (indexResultArrays.every((arr) => arr.length === 0)) {
      this.logger.warn(`No index candles found. Cannot calculate RS.`);
      return { success: false, count: 0, date: targetDate };
    }

    // 인덱스별 63거래일 전 기준값 사전 계산 (종목 캔들 수가 달라도 같은 날짜 기준 적용)
    const idx63AgoRefMap = new Map<string, { value: number; timeMs: number } | null>();
    for (const [idxCode, idxCandles] of indexCandlesMap) {
      if (idxCandles.length > 63) {
        const ref = idxCandles[idxCandles.length - 64];
        idx63AgoRefMap.set(idxCode, {
          value: ref.closePrice.toNumber(),
          timeMs: ref.candleTime.getTime(),
        });
      } else {
        idx63AgoRefMap.set(idxCode, null);
      }
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
      close63Ago: number | null;
      idxCloseNow: number;
      idx63Ago: number | null;
      passedStaticFilters: boolean;
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
          closePrice: true,
          highPrice: true,
          lowPrice: true,
          volume: true,
          tradingValue: true,
        },
        orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
      });

      // Decimal → number 즉시 변환 (Prisma Decimal 객체 해제)
      type PlainCandle = { stockCode: string; candleTime: Date; close: number; high: number; low: number; volume: bigint; tradingValue: bigint | null };
      const batchCandles: PlainCandle[] = rawCandles.map((c) => ({
        stockCode: c.stockCode,
        candleTime: c.candleTime,
        close: c.closePrice.toNumber(),
        high: c.highPrice.toNumber(),
        low: c.lowPrice.toNumber(),
        volume: c.volume,
        tradingValue: c.tradingValue,
      }));

      const candlesByStock = new Map<string, PlainCandle[]>();
      for (const candle of batchCandles) {
        if (!candlesByStock.has(candle.stockCode)) candlesByStock.set(candle.stockCode, []);
        candlesByStock.get(candle.stockCode)!.push(candle);
      }

      this.logger.log(`Processing batch ${batchStart + batchCodes.length}/${allStockCodes.length} (${batchCandles.length} candles)`);

      for (const [stockCode, candles] of candlesByStock) {
      if (candles.length === 0) continue;

      const latest = candles[candles.length - 1];
      const closePrice = latest.close;

      // 52주 고/저가
      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of candles) {
        if (c.high > high52w) high52w = c.high;
        if (c.low < low52w) low52w = c.low;
      }

      // 전일 종가
      const prevClose = candles.length >= 2 ? candles[candles.length - 2].close : 0;

      // MA50
      const ma50Slice = candles.slice(-50);
      const ma50 = ma50Slice.length >= 50
        ? ma50Slice.reduce((sum, c) => sum + c.close, 0) / 50
        : null;

      // MA150
      const ma150Slice = candles.slice(-150);
      const ma150 = ma150Slice.length >= 150
        ? ma150Slice.reduce((sum, c) => sum + c.close, 0) / 150
        : null;

      // MA200 (현재)
      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + c.close, 0) / 200
        : null;

      // MA200 (20일 전)
      const ma200_20dSlice = candles.length >= 220
        ? candles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + c.close, 0) / 200
        : null;

      // RS(63): 종목별로 자기 시장 지수 사용
      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) || [];
      const idxCloseNow = stockIdxCandles.length > 0
        ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber()
        : 0;

      // 인덱스 기준 63거래일 전 값 + 날짜 (배열 인덱스 방식 → 날짜 매칭 방식으로 변경)
      // 종목마다 캔들 수가 달라도 동일한 거래일 기준으로 rsRaw 계산
      const idx63AgoRef = idx63AgoRefMap.get(stockIdxCode) ?? null;
      const idx63Ago = idx63AgoRef ? idx63AgoRef.value : null;

      // 인덱스의 63거래일 전 날짜와 정확히 일치하는 종목 종가 (Map으로 O(1) 조회)
      const candleTimeMap = new Map(candles.map(c => [c.candleTime.getTime(), c.close]));
      const close63Ago = idx63AgoRef !== null
        ? (candleTimeMap.get(idx63AgoRef.timeMs) ?? null)
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = idxCloseNow / idx63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      // 거래대금 (DB에 tradingValue 있으면 사용, 없으면 종가×거래량 근사)
      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : closePrice * Number(latest.volume);

      // === 5개 정적 필터 (종가 기준, DB 저장) ===
      const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;           // MA50 > MA150
      const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;         // MA150 > MA200
      const sf3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
      const sf4 = rsRaw > 0;                                                  // RS > 0
      const sf5 = tradingValue >= MIN_TRADING_VALUE;                          // 거래대금 >= 10억

      const passedStaticFilters = sf1 && sf2 && sf3 && sf4 && sf5;

      // 디버그 통계 수집
      filterStats.total++;
      if (!sf1) filterStats.sf1Fail++;
      if (!sf2) filterStats.sf2Fail++;
      if (!sf3) filterStats.sf3Fail++;
      if (!sf4) filterStats.sf4Fail++;
      if (!sf5) filterStats.sf5Fail++;
      if (passedStaticFilters) filterStats.passed++;

      const isNewHigh = latest.high >= high52w;

      // === 투자 중요 지표 계산 (최근 10거래일 필요) ===
      const last11 = candles.slice(-11); // TR 계산에 prevClose 필요하므로 11개
      const last10 = candles.slice(-10);

      // 1) 변동성 축소: 최근 10일 True Range의 하락 추세 여부
      //    TR = max(high-low, |high-prevClose|, |low-prevClose|)
      //    앞 5일 평균 TR vs 뒤 5일 평균 TR 비교
      let isVolatilityContraction = false;
      if (last11.length >= 11) {
        const trValues: number[] = [];
        for (let i = 1; i < last11.length; i++) {
          const c = last11[i];
          const prev = last11[i - 1];
          const tr = Math.max(
            c.high - c.low,
            Math.abs(c.high - prev.close),
            Math.abs(c.low - prev.close),
          );
          trValues.push(tr);
        }
        const first5Avg = trValues.slice(0, 5).reduce((s, v) => s + v, 0) / 5;
        const last5Avg  = trValues.slice(5).reduce((s, v) => s + v, 0) / 5;
        isVolatilityContraction = last5Avg < first5Avg;
      }

      // 2) 가격 압축: 오늘 고저폭이 최근 10일 중 최솟값
      let isPriceCompression = false;
      if (last10.length >= 10) {
        const todayRange = latest.high - latest.low;
        const minRange = Math.min(...last10.map((c) => c.high - c.low));
        isPriceCompression = todayRange <= minRange;
      }

      // 3) 강도 지속: 최근 10거래일 중 종가 > 전일 종가인 날 수
      let strengthContinuationDays: number | null = null;
      if (last11.length >= 11) {
        let upDays = 0;
        for (let i = 1; i < last11.length; i++) {
          if (last11[i].close > last11[i - 1].close) upDays++;
        }
        strengthContinuationDays = upDays;
      }

      calculations.push({
        stockCode,
        closePrice,
        high52w,
        low52w,
        isNewHigh,
        priceChange1d: closePrice - prevClose,
        priceChangeRate1d: prevClose > 0 ? ((closePrice - prevClose) / prevClose) * 100 : 0,
        volume: latest.volume,
        tradingValue: BigInt(Math.floor(tradingValue)),
        rsRaw,
        ma50,
        ma150,
        ma200,
        close63Ago,
        idxCloseNow,
        idx63Ago,
        passedStaticFilters,
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

    // 4. DB에 저장 (배치 upsert)
    this.logger.log(`Saving metrics for ${calculations.length} stocks...`);

    const SAVE_BATCH = 50;
    for (let i = 0; i < calculations.length; i += SAVE_BATCH) {
      const batch = calculations.slice(i, i + SAVE_BATCH);

      await Promise.all(
        batch.map((calc) => {
          // tradeDate는 targetDate 기준 (캔들 날짜가 아님)
          // - target=2026-03-20인데 주식 캔들이 2026-03-19까지만 있어도 2026-03-20으로 저장
          // - 이렇게 해야 target=2026-03-20과 target=2026-03-19가 서로 다른 DB 키를 가짐
          // setUTCHours: KST 서버에서 setHours 사용 시 날짜가 하루 밀리는 버그 방지
          const tradeDate = new Date(targetDate);
          tradeDate.setUTCHours(0, 0, 0, 0);

          const data = {
            stockCode: calc.stockCode,
            tradeDate,
            closePrice: new Prisma.Decimal(calc.closePrice),
            relativeStrengthScore: new Prisma.Decimal(calc.rsScore ?? 0),
            rank: calc.rank ?? 0,
            marketType,
            isNewHigh: calc.isNewHigh,
            highPrice52w: new Prisma.Decimal(calc.high52w),
            lowPrice52w: new Prisma.Decimal(calc.low52w),
            priceChange1d: new Prisma.Decimal(calc.priceChange1d),
            priceChangeRate1d: new Prisma.Decimal(calc.priceChangeRate1d),
            volume1d: calc.volume,
            tradingValue: calc.tradingValue,
            ma50: calc.ma50 !== null ? new Prisma.Decimal(calc.ma50) : null,
            passedStaticFilters: calc.passedStaticFilters,
            isVolatilityContraction: calc.isVolatilityContraction,
            isPriceCompression: calc.isPriceCompression,
            strengthContinuationDays: calc.strengthContinuationDays,
          };

          return this.prisma.stockDailyMetrics.upsert({
            where: {
              stockCode_tradeDate: {
                stockCode: calc.stockCode,
                tradeDate: data.tradeDate,
              },
            },
            create: data,
            update: data,
          });
        }),
      );
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
      const fileTimestamp = kstNow.toISOString().replace('T', '_').replace(/:/g, '').substring(0, 17);
      const displayTimestamp = kstNow.toISOString().replace('T', ' ').substring(0, 19);
      const indexInfo = stockIndexMap ? 'KOSPI/KOSDAQ(종목별)' : indexCode.replace('INDEX_', '');
      const kstTargetDate = new Date(targetDate.getTime() + 9 * 60 * 60 * 1000);
      const tradeDateStr = kstTargetDate.toISOString().split('T')[0];
      const rsLogPath = path.join(process.cwd(), 'logs', `rs-scores-${fileTimestamp}.log`);
      const rsLogLines = [
        `RS Scores [${displayTimestamp}] | 조회기준일: ${tradeDateStr} | 기준: RS(63일) | 지수: ${indexInfo} | 대상: ${marketType} | total=${calculations.length} static=${totalFiltered} filtered=${dynamicFiltered.length}`,
        ...dynamicFiltered.map((calc, i) => {
          const name = stockNameMap?.get(calc.stockCode) ?? '';
          const tv억 = (Number(calc.tradingValue) / 1e8).toFixed(1);
          const df1Val = `${calc.closePrice}>=${(calc.low52w * 1.3).toFixed(0)}`;
          const df2Val = `${calc.closePrice}>=${(calc.high52w * 0.75).toFixed(0)}`;
          const df3Val = calc.ma50 !== null ? `${calc.closePrice}>${calc.ma50.toFixed(0)}` : 'N/A';
          return [
            `rank=${i + 1}`,
            `code=${calc.stockCode}`,
            `name=${name}`,
            `rsRaw=${calc.rsRaw.toFixed(6)}`,
            `score=${calc.rsScore ?? 0}`,
            `closePrice=${calc.closePrice}`,
            `close63Ago=${calc.close63Ago !== null ? calc.close63Ago : 'N/A'}`,
            `idxCloseNow=${calc.idxCloseNow}`,
            `idx63Ago=${calc.idx63Ago !== null ? calc.idx63Ago : 'N/A'}`,
            `MA50=${calc.ma50 !== null ? calc.ma50.toFixed(0) : 'N/A'}`,
            `MA150=${calc.ma150 !== null ? calc.ma150.toFixed(0) : 'N/A'}`,
            `MA200=${calc.ma200 !== null ? calc.ma200.toFixed(0) : 'N/A'}`,
            `52주고가=${calc.high52w}`,
            `52주저가=${calc.low52w}`,
            `거래대금=${tv억}억`,
            `신고가=${calc.isNewHigh ? 'Y' : 'N'}`,
            `df1=${df1Val}`,
            `df2=${df2Val}`,
            `df3=${df3Val}`,
          ].join(', ');
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
      ? new Date(`${tradeDate.substring(0, 4)}-${tradeDate.substring(4, 6)}-${tradeDate.substring(6, 8)}`)
      : new Date();
    targetDate.setUTCHours(0, 0, 0, 0);

    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - 365);

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
      ['INDEX_KOSPI', kospiCandles],
      ['INDEX_KOSDAQ', kosdaqCandles],
    ]);

    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles) {
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

      const latest = candles[candles.length - 1];
      const closePrice = latest.closePrice.toNumber();

      let high52w = -Infinity, low52w = Infinity;
      for (const c of candles) {
        const h = c.highPrice.toNumber(), l = c.lowPrice.toNumber();
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma50Slice = candles.slice(-50);
      const ma50 = ma50Slice.length >= 50 ? ma50Slice.reduce((s, c) => s + c.closePrice.toNumber(), 0) / 50 : null;

      const ma150Slice = candles.slice(-150);
      const ma150 = ma150Slice.length >= 150 ? ma150Slice.reduce((s, c) => s + c.closePrice.toNumber(), 0) / 150 : null;

      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200 ? ma200Slice.reduce((s, c) => s + c.closePrice.toNumber(), 0) / 200 : null;

      const ma200_20dSlice = candles.length >= 220 ? candles.slice(-220, -20) : [];
      const ma200_20d = ma200_20dSlice.length >= 200 ? ma200_20dSlice.reduce((s, c) => s + c.closePrice.toNumber(), 0) / 200 : null;

      const stockIdxCode = stockIndexMap.get(stockCode) ?? 'INDEX_KOSPI';
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) ?? [];
      const idxCloseNow = stockIdxCandles.length > 0 ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber() : 0;
      const idx63Ago = stockIdxCandles.length > 63 ? stockIdxCandles[stockIdxCandles.length - 64].closePrice.toNumber() : null;
      const close63Ago = candles.length > 63 ? candles[candles.length - 64].closePrice.toNumber() : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && idx63Ago && idx63Ago > 0) {
        rsRaw = (closePrice / close63Ago) / (idxCloseNow / idx63Ago);
      }

      const tradingValue = latest.tradingValue ? Number(latest.tradingValue) : closePrice * Number(latest.volume);
      const tv억 = (tradingValue / 1e8).toFixed(1);

      const sf1 = ma50 !== null && ma150 !== null && ma50 > ma150;
      const sf2 = ma150 !== null && ma200 !== null && ma150 > ma200;
      const sf3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d;
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
        `candles=${candles.length}`,
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

    const logPath = path.join(process.cwd(), 'logs', `custom-rs-scores-${fileTimestamp}.log`);
    const header = `=== Custom RS Scores [${displayTimestamp}] | 조회기준일: ${tradeDateStr} | 종목수: ${stockCodes.length} | 데이터있음: ${candlesByStock.size} ===`;
    fs.writeFileSync(logPath, [header, ...rows].join('\n') + '\n', { encoding: 'utf-8' });

    this.logger.log(`Custom RS scores written to logs/custom-rs-scores-${fileTimestamp}.log`);

    return {
      success: true,
      logFile: `custom-rs-scores-${fileTimestamp}.log`,
      total: stockCodes.length,
      found: candlesByStock.size,
    };
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
    historicalCutoff.setUTCDate(historicalCutoff.getUTCDate() - 365);

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
      indexCandlesMap.set(idx, indexResultArrays[i]);
    });

    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles) {
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

      const latest = candles[candles.length - 1];
      const closePrice = latest.closePrice.toNumber();

      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of candles) {
        const h = c.highPrice.toNumber();
        const l = c.lowPrice.toNumber();
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      const ma200_20dSlice = candles.length >= 220
        ? candles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      const stockIdxCode = stockIndexMap?.get(stockCode) || indexCode;
      const stockIdxCandles = indexCandlesMap.get(stockIdxCode) || [];
      const idxCloseNow = stockIdxCandles.length > 0
        ? stockIdxCandles[stockIdxCandles.length - 1].closePrice.toNumber()
        : 0;
      const idx63Ago = stockIdxCandles.length > 63
        ? stockIdxCandles[stockIdxCandles.length - 64].closePrice.toNumber()
        : null;
      const close63Ago = candles.length > 63
        ? candles[candles.length - 64].closePrice.toNumber()
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
      const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d;
      const f4 = rsRaw > 0;
      const f5 = tradingValue >= MIN_TRADING_VALUE;

      results.push({
        stockCode,
        hasData: true,
        candleCount: candles.length,
        closePrice,
        low52w,
        high52w,
        ma200,
        ma200_20d,
        rsRaw,
        tradingValue,
        f1, f1Detail: `price(${closePrice}) >= low52w*1.3(${(low52w * 1.3).toFixed(0)})`,
        f2, f2Detail: `price(${closePrice}) >= 75%*high52w(${(high52w * 0.75).toFixed(0)})`,
        f3, f3Detail: `MA200(${ma200?.toFixed(0) ?? 'null'}) > MA200_20d(${ma200_20d?.toFixed(0) ?? 'null'}) candles:${candles.length}`,
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
