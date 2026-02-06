import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

/**
 * 실시간 현재가 데이터
 */
export interface RealtimePrice {
  stockCode: string;
  currentPrice: number;        // 현재가
  changeAmount: number;        // 전일대비
  changeRate: number;          // 등락률
  volume: number;              // 거래량
  accVolume: number;           // 누적거래량
  accAmount: number;           // 누적거래대금
  openPrice: number;           // 시가
  highPrice: number;           // 고가
  lowPrice: number;            // 저가
  timestamp: Date;             // 수신 시각
}

@Injectable()
export class RealtimePriceCacheService {
  private readonly logger = new Logger(RealtimePriceCacheService.name);

  // 종목별 최신 현재가 캐시
  private priceCache = new Map<string, RealtimePrice>();

  // 구독 중인 종목 목록
  private subscribedStocks = new Set<string>();

  /**
   * 캐시에서 현재가 조회
   */
  getPrice(stockCode: string): RealtimePrice | undefined {
    return this.priceCache.get(stockCode);
  }

  /**
   * 여러 종목의 현재가 조회
   */
  getPrices(stockCodes: string[]): Map<string, RealtimePrice> {
    const result = new Map<string, RealtimePrice>();
    for (const code of stockCodes) {
      const price = this.priceCache.get(code);
      if (price) {
        result.set(code, price);
      }
    }
    return result;
  }

  /**
   * 캐시에 현재가 저장
   */
  setPrice(data: RealtimePrice): void {
    this.priceCache.set(data.stockCode, data);
    this.logger.debug(`Price cached: ${data.stockCode} = ${data.currentPrice}`);
  }

  /**
   * 구독 중인 종목 목록 반환
   */
  getSubscribedStocks(): string[] {
    return Array.from(this.subscribedStocks);
  }

  /**
   * 종목 구독 추가
   */
  addSubscription(stockCode: string): void {
    this.subscribedStocks.add(stockCode);
    this.logger.log(`Added subscription: ${stockCode}`);
  }

  /**
   * 종목 구독 제거
   */
  removeSubscription(stockCode: string): void {
    this.subscribedStocks.delete(stockCode);
    this.priceCache.delete(stockCode);
    this.logger.log(`Removed subscription: ${stockCode}`);
  }

  /**
   * 모든 구독 제거
   */
  clearSubscriptions(): void {
    this.subscribedStocks.clear();
    this.priceCache.clear();
    this.logger.log('Cleared all subscriptions');
  }

  /**
   * WebSocket 실시간 체결 데이터 수신 (0B 타입)
   * EventEmitter로 발행된 이벤트를 구독
   */
  @OnEvent('kiwoom.realtime.0B')
  handleRealtimeTick(payload: {
    stockCode: string;
    type: string;
    values: Record<string, string>;
  }): void {
    try {
      const { stockCode, values } = payload;

      // 키움 실시간 체결 데이터 파싱
      const realtimePrice: RealtimePrice = {
        stockCode,
        currentPrice: this.parseNumber(values['10']),      // 현재가
        changeAmount: this.parseNumber(values['11']),      // 전일대비
        changeRate: this.parseNumber(values['12']),        // 등락률
        volume: this.parseNumber(values['15']),            // 거래량
        accVolume: this.parseNumber(values['13']),         // 누적거래량
        accAmount: this.parseNumber(values['14']),         // 누적거래대금
        openPrice: this.parseNumber(values['16']),         // 시가
        highPrice: this.parseNumber(values['17']),         // 고가
        lowPrice: this.parseNumber(values['18']),          // 저가
        timestamp: new Date(),
      };

      // 캐시에 저장
      this.setPrice(realtimePrice);

      this.logger.debug(
        `Realtime tick: ${stockCode} ${realtimePrice.currentPrice} (${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate}%)`,
      );
    } catch (error) {
      this.logger.error(`Failed to handle realtime tick: ${error.message}`, error.stack);
    }
  }

  /**
   * 숫자 파싱 헬퍼 (부호 제거)
   */
  private parseNumber(value: string | undefined): number {
    if (!value) return 0;
    return parseFloat(value.replace(/[+\-]/g, ''));
  }

  /**
   * 캐시 통계
   */
  getCacheStats() {
    return {
      cachedStocks: this.priceCache.size,
      subscribedStocks: this.subscribedStocks.size,
      oldestUpdate: this.getOldestUpdateTime(),
      newestUpdate: this.getNewestUpdateTime(),
    };
  }

  private getOldestUpdateTime(): Date | null {
    let oldest: Date | null = null;
    for (const price of this.priceCache.values()) {
      if (!oldest || price.timestamp < oldest) {
        oldest = price.timestamp;
      }
    }
    return oldest;
  }

  private getNewestUpdateTime(): Date | null {
    let newest: Date | null = null;
    for (const price of this.priceCache.values()) {
      if (!newest || price.timestamp > newest) {
        newest = price.timestamp;
      }
    }
    return newest;
  }
}
