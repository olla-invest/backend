import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KiwoomTickData, KiwoomQuoteData } from '../../integrations/kiwoom/types/kiwoom.types';
import { Decimal } from '@generated/prisma/runtime/client';
import { isKrxTradingDay } from '../../common/utils/market-calendar.util';

@Injectable()
export class ChartStorageService {
  private readonly logger = new Logger(ChartStorageService.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('kiwoom.realtime.0B')
  async handleTickData(event: {
    stockCode: string;
    type: string;
    values: KiwoomTickData;
  }): Promise<void> {
    const { stockCode, values } = event;
    try {
      await this.saveTickData(stockCode, values);
    } catch (error) {
      this.logger.error(`Failed to handle tick data for ${stockCode}`, error);
    }
  }

  @OnEvent('kiwoom.realtime.0D')
  async handleQuoteData(event: {
    stockCode: string;
    type: string;
    values: KiwoomQuoteData;
  }): Promise<void> {
    const { stockCode, values } = event;
    try {
      await this.saveQuoteData(stockCode, values);
    } catch (error) {
      this.logger.error(`Failed to handle quote data for ${stockCode}`, error);
    }
  }

  private async saveTickData(stockCode: string, values: KiwoomTickData): Promise<void> {
    const tickTime = this.parseTime(values['20']);
    const price = this.parseDecimal(values['10']);
    const volume = this.parseBigInt(values['15']);
    const prevDayCompare = this.parseDecimal(values['11']);
    const changeRate = this.parseDecimal(values['12']);
    const askPrice = this.parseDecimal(values['27']);
    const bidPrice = this.parseDecimal(values['28']);
    const accVolume = this.parseBigInt(values['13']);
    const accTradingValue = this.parseBigInt(values['14']);

    await this.prisma.stockTick.create({
      data: {
        stockCode,
        tickTime,
        price,
        volume,
        prevDayCompare,
        changeRate,
        askPrice,
        bidPrice,
        accVolume,
        accTradingValue,
      },
    });
  }

  private async saveQuoteData(stockCode: string, values: KiwoomQuoteData): Promise<void> {
    const quoteTime = this.parseTime(values['21']);
    await this.prisma.stockQuote.create({
      data: {
        stockCode,
        quoteTime,
        askPrice1: this.parseDecimal(values['41']),
        askVolume1: this.parseBigInt(values['61']),
        bidPrice1: this.parseDecimal(values['51']),
        bidVolume1: this.parseBigInt(values['71']),
        askPrice2: this.parseDecimal(values['42']),
        askVolume2: this.parseBigInt(values['62']),
        bidPrice2: this.parseDecimal(values['52']),
        bidVolume2: this.parseBigInt(values['72']),
        askPrice3: this.parseDecimal(values['43']),
        askVolume3: this.parseBigInt(values['63']),
        bidPrice3: this.parseDecimal(values['53']),
        bidVolume3: this.parseBigInt(values['73']),
        askPrice4: this.parseDecimal(values['44']),
        askVolume4: this.parseBigInt(values['64']),
        bidPrice4: this.parseDecimal(values['54']),
        bidVolume4: this.parseBigInt(values['74']),
        askPrice5: this.parseDecimal(values['45']),
        askVolume5: this.parseBigInt(values['65']),
        bidPrice5: this.parseDecimal(values['55']),
        bidVolume5: this.parseBigInt(values['75']),
        totalAskVolume: this.parseBigInt(values['121']),
        totalBidVolume: this.parseBigInt(values['125']),
      },
    });
  }

  async saveCandle(candle: {
    stockCode: string;
    candleType: string;
    candleTime: Date;
    openPrice: number | Decimal;
    highPrice: number | Decimal;
    lowPrice: number | Decimal;
    closePrice: number | Decimal;
    volume: bigint;
    tradingValue?: bigint | null;
    adjOpenPrice?: number | Decimal | null;
    adjHighPrice?: number | Decimal | null;
    adjLowPrice?: number | Decimal | null;
    adjClosePrice?: number | Decimal | null;
  }): Promise<void> {
    // [Patch 2] 일봉은 한국거래소 거래일에만 저장.
    if (candle.candleType === 'day' && !isKrxTradingDay(candle.candleTime)) {
      this.logger.warn(
        `[saveCandle] Skip non-trading day candle ${candle.stockCode} @ ${candle.candleTime.toISOString()}`,
      );
      return;
    }

    // [Patch 5] 거래정지일 빈값 캔들 → 직전 정상 거래일 종가로 채워 저장
    let openPriceFinal = candle.openPrice;
    let highPriceFinal = candle.highPrice;
    let lowPriceFinal = candle.lowPrice;
    let closePriceFinal = candle.closePrice;
    let adjOpenPriceFinal = candle.adjOpenPrice ?? null;
    let adjHighPriceFinal = candle.adjHighPrice ?? null;
    let adjLowPriceFinal = candle.adjLowPrice ?? null;
    let adjClosePriceFinal = candle.adjClosePrice ?? null;
    let tradingValueFinal = candle.tradingValue;

    if (candle.candleType === 'day' && candle.volume === 0n) {
      const closeNum = this.toNumberSafe(candle.closePrice);
      if (closeNum <= 0) {
        const prior = await this.prisma.stockCandle.findFirst({
          where: {
            stockCode: candle.stockCode,
            candleType: 'day',
            candleTime: { lt: candle.candleTime },
            volume: { gt: 0n },
          },
          orderBy: { candleTime: 'desc' },
          select: { closePrice: true, adjClosePrice: true },
        });
        if (prior) {
          const fillClose = prior.closePrice;
          const fillAdjClose = prior.adjClosePrice ?? prior.closePrice;
          openPriceFinal = fillClose;
          highPriceFinal = fillClose;
          lowPriceFinal = fillClose;
          closePriceFinal = fillClose;
          adjOpenPriceFinal = fillAdjClose;
          adjHighPriceFinal = fillAdjClose;
          adjLowPriceFinal = fillAdjClose;
          adjClosePriceFinal = fillAdjClose;
          tradingValueFinal = 0n;
          this.logger.log(
            `[saveCandle] Suspended-day fill ${candle.stockCode} @ ${candle.candleTime
              .toISOString()
              .slice(0, 10)} -> close=${fillClose.toString()}`,
          );
        } else {
          this.logger.warn(
            `[saveCandle] Suspended-day ${candle.stockCode} @ ${candle.candleTime
              .toISOString()
              .slice(0, 10)} but no prior close found - keep raw`,
          );
        }
      }
    }

    await this.prisma.stockCandle.upsert({
      where: {
        stockCode_candleType_candleTime: {
          stockCode: candle.stockCode,
          candleType: candle.candleType,
          candleTime: candle.candleTime,
        },
      },
      update: {
        highPrice: highPriceFinal,
        lowPrice: lowPriceFinal,
        closePrice: closePriceFinal,
        volume: candle.volume,
        ...(tradingValueFinal !== undefined && { tradingValue: tradingValueFinal }),
        adjOpenPrice: adjOpenPriceFinal,
        adjHighPrice: adjHighPriceFinal,
        adjLowPrice: adjLowPriceFinal,
        adjClosePrice: adjClosePriceFinal,
      },
      create: {
        stockCode: candle.stockCode,
        candleType: candle.candleType,
        candleTime: candle.candleTime,
        openPrice: openPriceFinal,
        highPrice: highPriceFinal,
        lowPrice: lowPriceFinal,
        closePrice: closePriceFinal,
        volume: candle.volume,
        tradingValue: tradingValueFinal ?? null,
        adjOpenPrice: adjOpenPriceFinal,
        adjHighPrice: adjHighPriceFinal,
        adjLowPrice: adjLowPriceFinal,
        adjClosePrice: adjClosePriceFinal,
      },
    });

    this.logger.debug(
      `Saved ${candle.candleType} candle for ${candle.stockCode} at ${candle.candleTime.toISOString()}`,
    );
  }

  private toNumberSafe(v: number | Decimal | null | undefined): number {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    if (typeof (v as any).toNumber === 'function') return (v as Decimal).toNumber();
    return Number(v as any);
  }

  async getCandles(stockCode: string, candleType: string, startTime: Date, endTime: Date) {
    return await this.prisma.stockCandle.findMany({
      where: { stockCode, candleType, candleTime: { gte: startTime, lte: endTime } },
      orderBy: { candleTime: 'desc' },
    });
  }

  async getLatestClosingPrices(stockCodes: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();
    const latestCandles = await this.prisma.$queryRaw<
      Array<{ stockCode: string; closePrice: any }>
    >`
      SELECT DISTINCT ON (stock_code)
        stock_code as "stockCode",
        close_price as "closePrice"
      FROM stock_candles
      WHERE stock_code = ANY(${stockCodes})
        AND candle_type = 'day'
      ORDER BY stock_code, candle_time DESC
    `;
    latestCandles.forEach((candle) => {
      priceMap.set(candle.stockCode, Number(candle.closePrice));
    });
    return priceMap;
  }

  async getLatestDayCandleDate(): Promise<Date | null> {
    const latest = await this.prisma.stockCandle.findFirst({
      where: { candleType: 'day' },
      orderBy: { candleTime: 'desc' },
      select: { candleTime: true },
    });
    return latest?.candleTime || null;
  }

  /**
   * [Patch 2] 잔존 비거래일 일봉 캔들 정리
   */
  async cleanupNonTradingDayCandles(lookbackDays = 400, deleteLimit = 50_000): Promise<number> {
    const today = new Date();
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - lookbackDays);
    from.setUTCHours(0, 0, 0, 0);

    const distinctTimes = await this.prisma.stockCandle.findMany({
      where: { candleType: 'day', candleTime: { gte: from, lte: today } },
      distinct: ['candleTime'],
      select: { candleTime: true },
      orderBy: { candleTime: 'asc' },
    });

    const nonTradingDates = distinctTimes
      .map((r) => r.candleTime)
      .filter((d) => !isKrxTradingDay(d));

    if (nonTradingDates.length === 0) {
      this.logger.log('[cleanupNonTradingDayCandles] no residual non-trading-day candles found');
      return 0;
    }

    this.logger.warn(
      `[cleanupNonTradingDayCandles] Found ${nonTradingDates.length} non-trading dates with residual candles`,
    );

    let total = 0;
    for (const d of nonTradingDates) {
      if (total >= deleteLimit) break;
      const res = await this.prisma.stockCandle.deleteMany({
        where: { candleType: 'day', candleTime: d },
      });
      total += res.count;
      if (res.count > 0) {
        this.logger.warn(
          `[cleanupNonTradingDayCandles] Deleted ${res.count} candles for ${d.toISOString().slice(0, 10)}`,
        );
      }
    }
    this.logger.warn(`[cleanupNonTradingDayCandles] DONE. total deleted=${total}`);
    return total;
  }

  /**
   * [Patch 5] 기존 빈 거래정지 일봉 백필
   */
  async backfillSuspendedDayCandles(lookbackDays = 400, updateLimit = 100_000): Promise<number> {
    const today = new Date();
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - lookbackDays);
    from.setUTCHours(0, 0, 0, 0);

    const empties = await this.prisma.stockCandle.findMany({
      where: {
        candleType: 'day',
        candleTime: { gte: from, lte: today },
        volume: 0n,
        closePrice: 0,
      },
      select: { stockCode: true, candleTime: true },
      orderBy: [{ stockCode: 'asc' }, { candleTime: 'asc' }],
    });

    if (empties.length === 0) {
      this.logger.log('[backfillSuspendedDayCandles] no empty halt candles found');
      return 0;
    }

    this.logger.warn(
      `[backfillSuspendedDayCandles] Found ${empties.length} empty halt candles; backfilling...`,
    );

    let updated = 0;
    const byStock = new Map<string, Date[]>();
    for (const e of empties) {
      if (!byStock.has(e.stockCode)) byStock.set(e.stockCode, []);
      byStock.get(e.stockCode)!.push(e.candleTime);
    }

    for (const [stockCode, times] of byStock) {
      if (updated >= updateLimit) break;
      times.sort((a, b) => a.getTime() - b.getTime());

      let priorClose: any = null;
      let priorAdjClose: any = null;

      const firstPrior = await this.prisma.stockCandle.findFirst({
        where: {
          stockCode,
          candleType: 'day',
          candleTime: { lt: times[0] },
          volume: { gt: 0n },
        },
        orderBy: { candleTime: 'desc' },
        select: { closePrice: true, adjClosePrice: true },
      });
      if (firstPrior) {
        priorClose = firstPrior.closePrice;
        priorAdjClose = firstPrior.adjClosePrice ?? firstPrior.closePrice;
      }

      for (const t of times) {
        if (updated >= updateLimit) break;

        if (!priorClose) {
          const p = await this.prisma.stockCandle.findFirst({
            where: {
              stockCode,
              candleType: 'day',
              candleTime: { lt: t },
              volume: { gt: 0n },
            },
            orderBy: { candleTime: 'desc' },
            select: { closePrice: true, adjClosePrice: true },
          });
          if (!p) {
            this.logger.warn(
              `[backfillSuspendedDayCandles] no prior close for ${stockCode} @ ${t
                .toISOString()
                .slice(0, 10)} - skip`,
            );
            continue;
          }
          priorClose = p.closePrice;
          priorAdjClose = p.adjClosePrice ?? p.closePrice;
        }

        await this.prisma.stockCandle.update({
          where: {
            stockCode_candleType_candleTime: {
              stockCode,
              candleType: 'day',
              candleTime: t,
            },
          },
          data: {
            openPrice: priorClose,
            highPrice: priorClose,
            lowPrice: priorClose,
            closePrice: priorClose,
            adjOpenPrice: priorAdjClose,
            adjHighPrice: priorAdjClose,
            adjLowPrice: priorAdjClose,
            adjClosePrice: priorAdjClose,
            tradingValue: 0n,
          },
        });
        updated++;
      }
    }

    this.logger.warn(
      `[backfillSuspendedDayCandles] DONE. updated=${updated} / found=${empties.length}`,
    );
    return updated;
  }

  async hasSufficientHistory(days: number): Promise<boolean> {
    const oldest = await this.prisma.stockCandle.findFirst({
      where: { candleType: 'day' },
      orderBy: { candleTime: 'asc' },
      select: { candleTime: true },
    });
    if (!oldest) return false;
    const now = new Date();
    const diffMs = now.getTime() - oldest.candleTime.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    return diffDays >= days;
  }

  private parseTime(timeStr: string): Date {
    const now = new Date();
    const hour = parseInt(timeStr.substring(0, 2));
    const minute = parseInt(timeStr.substring(2, 4));
    const second = parseInt(timeStr.substring(4, 6));
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second);
  }

  private parseDecimal(value: string): Decimal {
    const cleaned = (value || '0').replace(/[+\-,\s]/g, '').trim();
    return new Decimal(cleaned || '0');
  }

  private parseBigInt(value: string): bigint {
    const cleaned = (value || '0').replace(/[+\-,\s]/g, '').trim().split('.')[0];
    return BigInt(cleaned || '0');
  }
}
