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
  }

  /**
   * 종목 구독 제거
   */
  removeSubscription(stockCode: string): void {
    this.subscribedStocks.delete(stockCode);
    this.priceCache.delete(stockCode);
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
        currentPrice: this.parseAbsolute(values['10']),   // 현재가 (부호 제거, 항상 양수)
        changeAmount: this.parseSigned(values['11']),      // 전일대비 (부호 유지)
        changeRate: this.parseSigned(values['12']),        // 등락률 (부호 유지, 예: -1.25)
        volume: this.parseAbsolute(values['15']),          // 거래량
        accVolume: this.parseAbsolute(values['13']),       // 누적거래량
        accAmount: this.parseAbsolute(values['14']),       // 누적거래대금
        openPrice: this.parseAbsolute(values['16']),       // 시가
        highPrice: this.parseAbsolute(values['17']),       // 고가
        lowPrice: this.parseAbsolute(values['18']),        // 저가
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
   * 절대값 파싱 (부호 제거) - 현재가, 거래량 등 항상 양수인 필드용
   */
  private parseAbsolute(value: string | undefined): number {
    if (!value) return 0;
    return parseFloat(value.replace(/[+\-]/g, '')) || 0;
  }

  /**
   * 부호 보존 파싱 - 등락률, 전일대비 등 음수가 의미 있는 필드용
   */
  private parseSigned(value: string | undefined): number {
    if (!value) return 0;
    return parseFloat(value) || 0;
  }

  /**
   * 전체 캐시 반환
   */
  getAllPrices(): Map<string, RealtimePrice> {
    return new Map(this.priceCache);
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
