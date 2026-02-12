import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '../../../generated/prisma';

@Injectable()
export class StockMetricsService {
  private readonly logger = new Logger(StockMetricsService.name);

  constructor(private readonly prisma: PrismaService) {}

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
      });
    });

    return metricsMap;
  }

  /**
   * 최신 거래일 조회
   */
  async getLatestTradeDate(marketType?: string): Promise<Date | null> {
    const where = marketType ? { marketType } : {};
    const latestDate = await this.prisma.stockDailyMetrics.findFirst({
      where,
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    return latestDate?.tradeDate || null;
  }

  /**
   * 최신 거래일의 종목별 지표 조회 (날짜 상관없이 가장 최근 데이터)
   */
  async getLatestMetrics(stockCodes: string[], marketType?: string): Promise<Map<string, any>> {
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
    days: number = 3,
  ): Promise<number[]> {
    const metrics = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode },
      orderBy: { tradeDate: 'desc' },
      take: days,
      select: { rank: true },
    });

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
    historicalCutoff.setDate(historicalCutoff.getDate() - Math.max(365, maxPeriod + 10));

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

      // 각 종목별 RS 계산
      const stockRS: Array<{ stockCode: string; rsScore: number }> = [];

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles.filter((c) => c.candleTime <= tradeDate);
        if (candlesUpToDate.length === 0) continue;

        // 여러 기간의 RS 계산
        const rsValues: number[] = [];
        for (const period of periods) {
          if (candlesUpToDate.length <= period) {
            rsValues.push(0);
            continue;
          }

          const currentPrice = candlesUpToDate[candlesUpToDate.length - 1].closePrice.toNumber();
          const pastPrice = candlesUpToDate[candlesUpToDate.length - 1 - period].closePrice.toNumber();

          // 해당 기간의 지수 과거가
          const indexPastCandles = indexCandles.filter((c) => c.candleTime <= tradeDate);
          if (indexPastCandles.length <= period) {
            rsValues.push(0);
            continue;
          }
          const indexPastPrice = indexPastCandles[indexPastCandles.length - 1 - period].closePrice.toNumber();

          if (pastPrice > 0 && indexPastPrice > 0) {
            const stockReturn = currentPrice / pastPrice;
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
          stockRS.push({ stockCode, rsScore: weightedRS });
        }
      }

      // RS 기준 정렬 및 랭킹
      stockRS.sort((a, b) => b.rsScore - a.rsScore);

      for (let i = 0; i < stockRS.length; i++) {
        const { stockCode, rsScore } = stockRS[i];
        const rank = i + 1;

        if (!resultMap.has(stockCode)) {
          resultMap.set(stockCode, []);
        }
        resultMap.get(stockCode)!.push({
          tradeDate: tradeDateOnly,
          rank,
          rsScore,
        });
      }
    }

    this.logger.log(`Runtime RS calculation completed for ${resultMap.size} stocks`);
    return resultMap;
  }

  /**
   * 기간 기반 RS 계산 (rsStartDate와 rsEndDate 사용)
   * endDate 종가를 기준으로 startDate 가격까지의 수익률 계산
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
    this.logger.log(
      `Calculating range RS for ${stockCodes.length} stocks, filters: ${JSON.stringify(rsFilters)}, index: ${indexCode}`,
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

    // 날짜를 일수로 변환
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const periodsData: Array<{ startDays: number; endDays: number; weight: number }> = [];
    let maxDays = 0;

    for (const filter of rsFilters) {
      const startDays = this.convertDateToDays(filter.rsStartDate, today);
      const endDays = this.convertDateToDays(filter.rsEndDate, today);
      periodsData.push({ startDays, endDays, weight: filter.strength });
      maxDays = Math.max(maxDays, endDays);
    }

    // 과거 데이터 조회 범위
    const historicalCutoff = new Date(tradeDates[0]);
    historicalCutoff.setDate(historicalCutoff.getDate() - Math.max(365, maxDays + 10));

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

      // 해당 거래일의 지수 데이터
      const indexCandlesUpToDate = indexCandles.filter((c) => c.candleTime <= tradeDate);
      if (indexCandlesUpToDate.length === 0) continue;

      // 각 종목별 RS 계산
      const stockRS: Array<{ stockCode: string; rsScore: number }> = [];

      for (const [stockCode, candles] of candlesByStock) {
        const candlesUpToDate = candles.filter((c) => c.candleTime <= tradeDate);
        if (candlesUpToDate.length === 0) continue;

        // 여러 기간의 RS 계산
        const rsValues: number[] = [];
        const weights: number[] = [];

        for (const periodData of periodsData) {
          const { startDays, endDays, weight } = periodData;

          // 데이터 충분한지 확인
          if (candlesUpToDate.length <= endDays || indexCandlesUpToDate.length <= endDays) {
            continue;
          }

          // startDays 전의 가격 (분자)
          const startPrice = candlesUpToDate[candlesUpToDate.length - 1 - startDays].closePrice.toNumber();
          // endDays 전의 종가 (분모, 기준가)
          const endPrice = candlesUpToDate[candlesUpToDate.length - 1 - endDays].closePrice.toNumber();

          // 지수도 동일한 기간
          const indexStartPrice = indexCandlesUpToDate[indexCandlesUpToDate.length - 1 - startDays].closePrice.toNumber();
          const indexEndPrice = indexCandlesUpToDate[indexCandlesUpToDate.length - 1 - endDays].closePrice.toNumber();

          if (endPrice > 0 && indexEndPrice > 0) {
            // endDate 종가 기준으로 startDate까지의 수익률
            const stockReturn = startPrice / endPrice;
            const indexReturn = indexStartPrice / indexEndPrice;
            const rs = stockReturn / indexReturn;

            rsValues.push(rs);
            weights.push(weight);
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
          stockRS.push({ stockCode, rsScore: weightedRS });
        }
      }

      // RS 기준 정렬 및 랭킹
      stockRS.sort((a, b) => b.rsScore - a.rsScore);

      for (let i = 0; i < stockRS.length; i++) {
        const { stockCode, rsScore } = stockRS[i];
        const rank = i + 1;

        if (!resultMap.has(stockCode)) {
          resultMap.set(stockCode, []);
        }
        resultMap.get(stockCode)!.push({
          tradeDate: tradeDateOnly,
          rank,
          rsScore,
        });
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
  async calculateAndSaveDailyMetrics(
    marketType: '0' | '10' | '8' = '0',
    tradeDate?: Date,
    indexCode: string = 'INDEX_KOSPI',
  ) {
    const targetDate = tradeDate || new Date();
    targetDate.setHours(0, 0, 0, 0);

    this.logger.log(
      `Starting metrics calculation for ${marketType} on ${targetDate.toISOString().split('T')[0]}, index: ${indexCode}`,
    );

    // 1. 모든 일봉 데이터 한번에 조회 (52주 = 365일)
    const historicalCutoff = new Date(targetDate);
    historicalCutoff.setDate(historicalCutoff.getDate() - 365);

    const [allCandles, indexCandles] = await Promise.all([
      this.prisma.stockCandle.findMany({
        where: {
          candleType: 'day',
          candleTime: { gte: historicalCutoff },
          stockCode: { not: { startsWith: 'INDEX_' } },
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

    this.logger.log(`Loaded ${allCandles.length} stock candles, ${indexCandles.length} index candles`);

    if (indexCandles.length === 0) {
      this.logger.warn(`No index candles found for ${indexCode}. Cannot calculate RS.`);
      return { success: false, count: 0, date: targetDate };
    }

    // 종목별 그룹핑
    const candlesByStock = new Map<string, typeof allCandles>();
    for (const candle of allCandles) {
      if (!candlesByStock.has(candle.stockCode)) {
        candlesByStock.set(candle.stockCode, []);
      }
      candlesByStock.get(candle.stockCode)!.push(candle);
    }

    // 지수 데이터 준비
    const latestIndex = indexCandles[indexCandles.length - 1];
    const indexCloseNow = latestIndex.closePrice.toNumber();
    const index63Ago = indexCandles.length > 63
      ? indexCandles[indexCandles.length - 64].closePrice.toNumber()
      : null;

    // 2. 각 종목별 계산
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
      passedFilters: boolean;
      candleTime: Date;
      rsScore?: number;
      rank?: number;
    }

    const calculations: StockCalc[] = [];

    for (const [stockCode, candles] of candlesByStock) {
      if (candles.length === 0) continue;

      const latest = candles[candles.length - 1];
      const closePrice = latest.closePrice.toNumber();

      // 52주 고/저가
      let high52w = -Infinity;
      let low52w = Infinity;
      for (const c of candles) {
        const h = c.highPrice.toNumber();
        const l = c.lowPrice.toNumber();
        if (h > high52w) high52w = h;
        if (l < low52w) low52w = l;
      }

      // 전일 종가
      const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
      const prevClose = prev ? prev.closePrice.toNumber() : 0;

      // MA200 (현재)
      const ma200Slice = candles.slice(-200);
      const ma200 = ma200Slice.length >= 200
        ? ma200Slice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      // MA200 (20일 전)
      const ma200_20dSlice = candles.length >= 220
        ? candles.slice(-(200 + 20), -20)
        : [];
      const ma200_20d = ma200_20dSlice.length >= 200
        ? ma200_20dSlice.reduce((sum, c) => sum + c.closePrice.toNumber(), 0) / 200
        : null;

      // RS(63): (종목종가/63일전종가) / (지수종가/63일전지수종가)
      const close63Ago = candles.length > 63
        ? candles[candles.length - 64].closePrice.toNumber()
        : null;

      let rsRaw = 0;
      if (close63Ago && close63Ago > 0 && index63Ago && index63Ago > 0) {
        const stockReturn = closePrice / close63Ago;
        const indexReturn = indexCloseNow / index63Ago;
        rsRaw = stockReturn / indexReturn;
      }

      // 거래대금 (DB에 tradingValue 있으면 사용, 없으면 종가×거래량 근사)
      const tradingValue = latest.tradingValue
        ? Number(latest.tradingValue)
        : closePrice * Number(latest.volume);

      // === 5개 필터 ===
      const f1 = closePrice >= low52w * 1.3;                          // 현재가 >= 52주저 × 1.3
      const f2 = closePrice >= 0.75 * high52w;                        // 현재가 >= 0.75 × 52주고
      const f3 = ma200 !== null && ma200_20d !== null && ma200 > ma200_20d; // MA200 상승추세
      const f4 = rsRaw > 0;                                            // RS 계산 가능
      const f5 = tradingValue >= MIN_TRADING_VALUE;                    // 거래대금 >= 10억

      const passedFilters = f1 && f2 && f3 && f4 && f5;

      const isNewHigh = latest.highPrice.toNumber() >= high52w;

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
        passedFilters,
        candleTime: latest.candleTime,
      });
    }

    // 3. 필터 통과 종목 → RS 내림차순 정렬 → 점수 + 랭킹
    const filtered = calculations.filter((c) => c.passedFilters);
    filtered.sort((a, b) => b.rsRaw - a.rsRaw);

    const totalFiltered = filtered.length;
    this.logger.log(`Filter passed: ${totalFiltered} / ${calculations.length} stocks`);

    for (let i = 0; i < filtered.length; i++) {
      const topPercent = ((i + 1) / totalFiltered) * 100;
      filtered[i].rsScore = this.percentileToScore(topPercent);
      filtered[i].rank = i + 1;
    }

    // 필터 미통과 종목: 점수 0, 랭크 0
    for (const calc of calculations) {
      if (!calc.passedFilters) {
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
          const data = {
            stockCode: calc.stockCode,
            tradeDate: new Date(calc.candleTime.getTime()),
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
          };

          // tradeDate를 날짜만 사용 (시간 제거)
          data.tradeDate.setHours(0, 0, 0, 0);

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

    return {
      success: true,
      count: calculations.length,
      filtered: totalFiltered,
      date: targetDate,
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
