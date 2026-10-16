import { RedisPriceStoreService } from './redis-price-store.service';
import { isRegularSessionTick } from './current-price-resolver.service';
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

/**
 * 실시간 현재가 데이터
 */
export interface RealtimePrice {
  stockCode: string;
  currentPrice: number; // 현재가
  changeAmount: number; // 전일대비
  changeRate: number; // 등락률
  volume: number; // 거래량
  accVolume: number; // 누적거래량
  accAmount: number; // 누적거래대금
  openPrice: number; // 시가
  highPrice: number; // 고가
  lowPrice: number; // 저가
  timestamp: Date; // 수신 시각
}

@Injectable()
export class RealtimePriceCacheService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RealtimePriceCacheService.name);

  // 종목별 최신 현재가 캐시
  private priceCache = new Map<string, RealtimePrice>();

  // 구독 중인 종목 목록
  private subscribedStocks = new Set<string>();

  private readonly pendingPrices = new Map<string, RealtimePrice>();
  private flushTimer: ReturnType<typeof setInterval>;
  private refreshTimer: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(private readonly store: RedisPriceStoreService) {}

  async onModuleInit() {
    await this.refreshPrices();
    this.flushTimer = setInterval(() => {
      void this.flushPrices();
    }, 1000);
    this.refreshTimer = setInterval(() => {
      void this.refreshPrices();
    }, 5000);
    this.flushTimer.unref?.();
    this.refreshTimer.unref?.();
  }

  async onModuleDestroy() {
    clearInterval(this.flushTimer);
    clearInterval(this.refreshTimer);
    await this.refreshing;
    await this.flushing;
    await this.flushPrices();
    await this.store.close();
  }

  async refreshPrices(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        for (const price of await this.store.load()) {
          const current = this.priceCache.get(price.stockCode);
          if (
            !current ||
            price.timestamp.getTime() > current.timestamp.getTime()
          ) {
            this.priceCache.set(price.stockCode, price);
          }
        }
      } catch (error) {
        this.logger.warn(
          `Redis price refresh failed: ${(error as Error).message}`,
        );
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  async flushPrices(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.pendingPrices.size) return;
    const batch = [...this.pendingPrices.values()];
    this.flushing = (async () => {
      try {
        await this.store.save(batch);
        for (const price of batch) {
          if (this.pendingPrices.get(price.stockCode) === price)
            this.pendingPrices.delete(price.stockCode);
        }
      } catch (error) {
        this.logger.warn(
          `Redis price write failed; retaining ticks for retry: ${(error as Error).message}`,
        );
      }
    })();
    try {
      await this.flushing;
    } finally {
      this.flushing = null;
    }
  }

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
    if (
      !Number.isFinite(data.currentPrice) ||
      data.currentPrice <= 0 ||
      !Number.isFinite(data.timestamp.getTime()) ||
      data.timestamp.getTime() > Date.now() ||
      // After-hours trades must not overwrite the regular-session closing tick.
      !isRegularSessionTick(data.timestamp)
    )
      return;
    const current = this.priceCache.get(data.stockCode);
    if (current && current.timestamp > data.timestamp) return;
    this.priceCache.set(data.stockCode, data);
    this.pendingPrices.set(data.stockCode, data);
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
   * 키움 REG 응답이 실제로 성공한 종목만 "구독됨"으로 기록.
   * (구독 요청 전송 시점에 낙관적으로 기록하면, 요청이 거부돼도 재시도가 걸리지 않는 문제가 있었음 — 2026-07-16)
   */
  @OnEvent('kiwoom.subscription.confirmed')
  handleSubscriptionConfirmed(payload: { stockCodes: string[] }): void {
    payload.stockCodes.forEach((code) => this.addSubscription(code));
  }

  /**
   * 키움에서 실제로 해제된 종목은 구독 목록에서도 지워, 구독 관리자가 다시 등록할 수 있게 한다.
   */
  @OnEvent('kiwoom.subscription.removed')
  handleSubscriptionRemoved(payload: { stockCodes: string[] }): void {
    payload.stockCodes.forEach((code) => this.removeSubscription(code));
  }

  /**
   * 종목 구독 제거
   */
  removeSubscription(stockCode: string): void {
    this.subscribedStocks.delete(stockCode);
    // Latest prices outlive websocket subscriptions.
  }

  /**
   * 모든 구독 제거
   */
  clearSubscriptions(): void {
    this.subscribedStocks.clear();
    // Retain last received prices for post-close reads and reconnection.
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
        currentPrice: this.parseAbsolute(values['10']), // 현재가 (부호 제거, 항상 양수)
        changeAmount: this.parseSigned(values['11']), // 전일대비 (부호 유지)
        changeRate: this.parseSigned(values['12']), // 등락률 (부호 유지, 예: -1.25)
        volume: this.parseAbsolute(values['15']), // 거래량
        accVolume: this.parseAbsolute(values['13']), // 누적거래량
        accAmount: this.parseAbsolute(values['14']), // 누적거래대금
        openPrice: this.parseAbsolute(values['16']), // 시가
        highPrice: this.parseAbsolute(values['17']), // 고가
        lowPrice: this.parseAbsolute(values['18']), // 저가
        timestamp: new Date(),
      };

      // 캐시에 저장
      this.setPrice(realtimePrice);

      this.logger.debug(
        `Realtime tick: ${stockCode} ${realtimePrice.currentPrice} (${realtimePrice.changeRate > 0 ? '+' : ''}${realtimePrice.changeRate}%)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to handle realtime tick: ${error.message}`,
        error.stack,
      );
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
      redisKey: this.store.key,
      pendingRedisWrites: this.pendingPrices.size,
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
