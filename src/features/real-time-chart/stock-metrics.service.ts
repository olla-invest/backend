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
      });
    });

    return metricsMap;
  }

  /**
   * 최신 거래일 조회
   */
  async getLatestTradeDate(): Promise<Date | null> {
    const latestDate = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    return latestDate?.tradeDate || null;
  }

  /**
   * 최신 거래일의 종목별 지표 조회 (날짜 상관없이 가장 최근 데이터)
   */
  async getLatestMetrics(stockCodes: string[]): Promise<Map<string, any>> {
    const latestDate = await this.getLatestTradeDate();

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
