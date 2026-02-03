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
   * 최신 거래일의 종목별 지표 조회 (날짜 상관없이 가장 최근 데이터)
   */
  async getLatestMetrics(stockCodes: string[]): Promise<Map<string, any>> {
    // 가장 최근 거래일 찾기
    const latestDate = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });

    if (!latestDate) {
      return new Map();
    }

    // 해당 날짜의 모든 종목 지표 조회
    return this.getMetricsForDate(stockCodes, latestDate.tradeDate);
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
   * (배치 작업용 - 매일 장 마감 후 실행)
   */
  async calculateAndSaveDailyMetrics(
    marketType: '0' | '10' | '8' = '0',
    tradeDate?: Date,
  ) {
    const targetDate = tradeDate || new Date();
    this.logger.log(
      `Starting daily metrics calculation for ${marketType} on ${targetDate.toISOString().split('T')[0]}`,
    );

    // 1. 해당 거래일의 모든 종목 일봉 데이터 조회
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const candles = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        candleTime: {
          gte: startOfDay,
          lt: endOfDay,
        },
      },
      orderBy: { closePrice: 'desc' },
    });

    if (candles.length === 0) {
      this.logger.warn(`No candle data found for ${targetDate}`);
      return;
    }

    this.logger.log(`Found ${candles.length} stocks with candle data`);

    // 2. RS 점수 계산 (간단한 버전 - 종가 기준 순위)
    // TODO: 실제로는 시장 대비 수익률, 기간별 가중치 등을 고려해야 함
    const metricsToSave = [];

    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i];

      // 전일 종가 조회
      const prevCandle = await this.prisma.stockCandle.findFirst({
        where: {
          stockCode: candle.stockCode,
          candleType: 'day',
          candleTime: {
            lt: candle.candleTime,
          },
        },
        orderBy: { candleTime: 'desc' },
      });

      // 전일 대비 변화
      const priceChange1d = prevCandle
        ? candle.closePrice.sub(prevCandle.closePrice)
        : new Prisma.Decimal(0);
      const priceChangeRate1d =
        prevCandle && prevCandle.closePrice.toNumber() > 0
          ? priceChange1d.div(prevCandle.closePrice).mul(100)
          : new Prisma.Decimal(0);

      // 52주 최고가/최저가 조회 (간단 버전)
      const fiftyTwoWeeksAgo = new Date(targetDate);
      fiftyTwoWeeksAgo.setDate(fiftyTwoWeeksAgo.getDate() - 364);

      const priceStats = await this.prisma.stockCandle.aggregate({
        where: {
          stockCode: candle.stockCode,
          candleType: 'day',
          candleTime: {
            gte: fiftyTwoWeeksAgo,
            lte: candle.candleTime,
          },
        },
        _max: { highPrice: true },
        _min: { lowPrice: true },
      });

      const highPrice52w = priceStats._max.highPrice || candle.highPrice;
      const lowPrice52w = priceStats._min.lowPrice || candle.lowPrice;
      const isNewHigh = candle.highPrice.equals(highPrice52w);

      // 간단한 RS 점수 (1-100)
      // 실제로는 더 복잡한 계산 필요
      const relativeStrengthScore = new Prisma.Decimal(
        Math.min(100, Math.max(0, 100 - i / 10)),
      );

      metricsToSave.push({
        stockCode: candle.stockCode,
        tradeDate: new Date(candle.candleTime.setHours(0, 0, 0, 0)),
        closePrice: candle.closePrice,
        relativeStrengthScore,
        rank: i + 1,
        marketType,
        isNewHigh,
        highPrice52w,
        lowPrice52w,
        priceChange1d,
        priceChangeRate1d,
        volume1d: candle.volume,
      });
    }

    // 3. DB에 저장 (upsert)
    this.logger.log(`Saving metrics for ${metricsToSave.length} stocks`);

    for (const metric of metricsToSave) {
      await this.prisma.stockDailyMetrics.upsert({
        where: {
          stockCode_tradeDate: {
            stockCode: metric.stockCode,
            tradeDate: metric.tradeDate,
          },
        },
        create: metric,
        update: metric,
      });
    }

    this.logger.log(
      `Daily metrics calculation completed for ${metricsToSave.length} stocks`,
    );

    return {
      success: true,
      count: metricsToSave.length,
      date: targetDate,
    };
  }
}
