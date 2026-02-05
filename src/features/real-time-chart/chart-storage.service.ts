import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KiwoomTickData, KiwoomQuoteData } from '../../integrations/kiwoom/types/kiwoom.types';
import { Decimal } from '@generated/prisma/runtime/client';

@Injectable()
export class ChartStorageService {
  private readonly logger = new Logger(ChartStorageService.name);
  private candleBuffers = new Map<string, CandleBuffer>(); // key: stockCode_candleType

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 실시간 체결 데이터 수신 (0B)
   */
  @OnEvent('kiwoom.realtime.0B')
  async handleTickData(event: {
    stockCode: string;
    type: string;
    values: KiwoomTickData;
  }): Promise<void> {
    const { stockCode, values } = event;

    try {
      // 틱 데이터 저장
      await this.saveTickData(stockCode, values);

      // 1분봉 캔들 업데이트
      await this.updateMinuteCandle(stockCode, values);
    } catch (error) {
      this.logger.error(`Failed to handle tick data for ${stockCode}`, error);
    }
  }

  /**
   * 실시간 호가 데이터 수신 (0D)
   */
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

  /**
   * 틱 데이터 저장
   */
  private async saveTickData(stockCode: string, values: KiwoomTickData): Promise<void> {
    const tickTime = this.parseTime(values['20']); // 체결시간 (HHmmss)
    const price = this.parseDecimal(values['10']); // 현재가
    const volume = BigInt(values['15']); // 거래량
    const prevDayCompare = this.parseDecimal(values['11']); // 전일대비
    const changeRate = this.parseDecimal(values['12']); // 등락율
    const askPrice = this.parseDecimal(values['27']); // 매도호가
    const bidPrice = this.parseDecimal(values['28']); // 매수호가
    const accVolume = BigInt(values['13']); // 누적거래량
    const accTradingValue = BigInt(values['14']); // 누적거래대금

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

    this.logger.debug(`Saved tick data for ${stockCode} at ${tickTime.toISOString()}`);
  }

  /**
   * 호가 데이터 저장
   */
  private async saveQuoteData(stockCode: string, values: KiwoomQuoteData): Promise<void> {
    const quoteTime = this.parseTime(values['21']); // 호가시간

    await this.prisma.stockQuote.create({
      data: {
        stockCode,
        quoteTime,
        askPrice1: this.parseDecimal(values['41']),
        askVolume1: BigInt(values['61']),
        bidPrice1: this.parseDecimal(values['51']),
        bidVolume1: BigInt(values['71']),
        askPrice2: this.parseDecimal(values['42']),
        askVolume2: BigInt(values['62']),
        bidPrice2: this.parseDecimal(values['52']),
        bidVolume2: BigInt(values['72']),
        askPrice3: this.parseDecimal(values['43']),
        askVolume3: BigInt(values['63']),
        bidPrice3: this.parseDecimal(values['53']),
        bidVolume3: BigInt(values['73']),
        askPrice4: this.parseDecimal(values['44']),
        askVolume4: BigInt(values['64']),
        bidPrice4: this.parseDecimal(values['54']),
        bidVolume4: BigInt(values['74']),
        askPrice5: this.parseDecimal(values['45']),
        askVolume5: BigInt(values['65']),
        bidPrice5: this.parseDecimal(values['55']),
        bidVolume5: BigInt(values['75']),
        totalAskVolume: BigInt(values['121']),
        totalBidVolume: BigInt(values['125']),
      },
    });

    this.logger.debug(`Saved quote data for ${stockCode} at ${quoteTime.toISOString()}`);
  }

  /**
   * 1분봉 캔들 업데이트
   */
  private async updateMinuteCandle(stockCode: string, values: KiwoomTickData): Promise<void> {
    const tickTime = this.parseTime(values['20']);
    const price = this.parseDecimal(values['10']);
    const volume = BigInt(values['15']);

    // 1분 단위로 캔들 시간 정규화 (초 제거)
    const candleTime = new Date(tickTime);
    candleTime.setSeconds(0, 0);

    const bufferKey = `${stockCode}_1min`;

    if (!this.candleBuffers.has(bufferKey)) {
      this.candleBuffers.set(bufferKey, {
        stockCode,
        candleType: '1min',
        candleTime,
        openPrice: price,
        highPrice: price,
        lowPrice: price,
        closePrice: price,
        volume: volume,
      });
    } else {
      const buffer = this.candleBuffers.get(bufferKey)!;

      // 새로운 분봉 시작
      if (buffer.candleTime.getTime() !== candleTime.getTime()) {
        // 기존 캔들 저장
        await this.saveCandle(buffer);

        // 새 캔들 버퍼 생성
        this.candleBuffers.set(bufferKey, {
          stockCode,
          candleType: '1min',
          candleTime,
          openPrice: price,
          highPrice: price,
          lowPrice: price,
          closePrice: price,
          volume: volume,
        });
      } else {
        // 기존 캔들 업데이트
        buffer.highPrice = this.max(buffer.highPrice, price);
        buffer.lowPrice = this.min(buffer.lowPrice, price);
        buffer.closePrice = price;
        buffer.volume = buffer.volume + volume;
      }
    }
  }

  /**
   * 캔들 데이터 저장
   */
  async saveCandle(candle: CandleBuffer | {
    stockCode: string;
    candleType: string;
    candleTime: Date;
    openPrice: number | Decimal;
    highPrice: number | Decimal;
    lowPrice: number | Decimal;
    closePrice: number | Decimal;
    volume: bigint;
  }): Promise<void> {
    await this.prisma.stockCandle.upsert({
      where: {
        stockCode_candleType_candleTime: {
          stockCode: candle.stockCode,
          candleType: candle.candleType,
          candleTime: candle.candleTime,
        },
      },
      update: {
        highPrice: candle.highPrice,
        lowPrice: candle.lowPrice,
        closePrice: candle.closePrice,
        volume: candle.volume,
      },
      create: {
        stockCode: candle.stockCode,
        candleType: candle.candleType,
        candleTime: candle.candleTime,
        openPrice: candle.openPrice,
        highPrice: candle.highPrice,
        lowPrice: candle.lowPrice,
        closePrice: candle.closePrice,
        volume: candle.volume,
      },
    });

    this.logger.debug(
      `Saved ${candle.candleType} candle for ${candle.stockCode} at ${candle.candleTime.toISOString()}`,
    );
  }

  /**
   * 과거 캔들 데이터 조회
   */
  async getCandles(
    stockCode: string,
    candleType: string,
    startTime: Date,
    endTime: Date,
  ) {
    return await this.prisma.stockCandle.findMany({
      where: {
        stockCode,
        candleType,
        candleTime: {
          gte: startTime,
          lte: endTime,
        },
      },
      orderBy: {
        candleTime: 'desc',
      },
    });
  }

  /**
   * 여러 종목의 최근 종가 조회 (일봉 기준)
   */
  async getLatestClosingPrices(stockCodes: string[]): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    // 각 종목별 최신 일봉 데이터 조회
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

    // Map으로 변환
    latestCandles.forEach((candle) => {
      priceMap.set(candle.stockCode, Number(candle.closePrice));
    });

    return priceMap;
  }

  /**
   * DB에 저장된 가장 최근 일봉 날짜 조회
   */
  async getLatestDayCandleDate(): Promise<Date | null> {
    const latest = await this.prisma.stockCandle.findFirst({
      where: { candleType: 'day' },
      orderBy: { candleTime: 'desc' },
      select: { candleTime: true },
    });
    return latest?.candleTime || null;
  }

  /**
   * 일봉 데이터가 N일 이상 존재하는지 확인
   */
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

  /**
   * 시간 파싱 (HHmmss -> Date)
   */
  private parseTime(timeStr: string): Date {
    const now = new Date();
    const hour = parseInt(timeStr.substring(0, 2));
    const minute = parseInt(timeStr.substring(2, 4));
    const second = parseInt(timeStr.substring(4, 6));

    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, second);
  }

  /**
   * Decimal 파싱 (부호 제거)
   */
  private parseDecimal(value: string): Decimal {
    const cleaned = value.replace(/[+\-]/g, '');
    return new Decimal(cleaned);
  }

  /**
   * Decimal 최대값
   */
  private max(a: Decimal, b: Decimal): Decimal {
    return new Decimal(a).greaterThan(b) ? a : b;
  }

  /**
   * Decimal 최소값
   */
  private min(a: Decimal, b: Decimal): Decimal {
    return new Decimal(a).lessThan(b) ? a : b;
  }
}

interface CandleBuffer {
  stockCode: string;
  candleType: string;
  candleTime: Date;
  openPrice: Decimal;
  highPrice: Decimal;
  lowPrice: Decimal;
  closePrice: Decimal;
  volume: bigint;
}
