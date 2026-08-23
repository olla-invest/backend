import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IRealtimeSource,
  REALTIME_SOURCE_TOKEN,
} from '../../integrations/kiwoom/websocket/realtime-source.interface';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { StockMetricsService } from './stock-metrics.service';

@Injectable()
export class RealtimeSubscriptionManager {
  private readonly logger = new Logger(RealtimeSubscriptionManager.name);
  private readonly retryCounts = new Map<string, number>();
  private static readonly MAX_RETRIES = 3;

  constructor(
    @Inject(REALTIME_SOURCE_TOKEN)
    private readonly realtimeSource: IRealtimeSource,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly metricsService: StockMetricsService,
  ) {}

  async ensureSubscribed(stockCodes: string[]): Promise<void> {
    if (!this.realtimeSource.isConnected()) {
      this.logger.warn('Realtime source disconnected; subscription sync skipped');
      return;
    }

    const subscribed = new Set(this.realtimeCache.getSubscribedStocks());
    const missing = [...new Set(stockCodes)].filter(
      (stockCode) => stockCode && !subscribed.has(stockCode),
    );
    if (missing.length === 0) return;

    await this.realtimeSource.subscribeBatch(missing, ['0B', '0D']);
    this.logger.log(`Submitted ${missing.length} missing realtime subscriptions`);
  }

  async subscribeFilteredStocks(): Promise<void> {
    const stockCodes = await this.metricsService.getFilteredStockCodes();
    await this.ensureSubscribed(stockCodes);
  }

  @OnEvent('kiwoom.subscription.confirmed')
  handleSubscriptionConfirmed(payload: { stockCodes: string[] }): void {
    payload.stockCodes.forEach((stockCode) => this.retryCounts.delete(stockCode));
  }

  @OnEvent('kiwoom.subscription.failed')
  async handleSubscriptionFailed(payload: {
    stockCodes: string[];
    types: string[];
    reason?: string;
  }): Promise<void> {
    for (const stockCode of payload.stockCodes) {
      const attempts = (this.retryCounts.get(stockCode) ?? 0) + 1;
      this.retryCounts.set(stockCode, attempts);
      if (attempts > RealtimeSubscriptionManager.MAX_RETRIES) {
        this.logger.error(
          `Subscription permanently failed for ${stockCode} after ${attempts} attempts: ${payload.reason}`,
        );
        continue;
      }

      setTimeout(() => {
        this.realtimeSource.subscribe(stockCode, payload.types).catch((error) => {
          this.logger.warn(
            `Retry subscribe failed for ${stockCode}: ${(error as Error).message}`,
          );
        });
      }, 2_000 * attempts);
    }
  }
}
