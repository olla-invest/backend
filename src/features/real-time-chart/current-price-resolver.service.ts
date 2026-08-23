import { Injectable } from '@nestjs/common';
import { RealtimePrice } from './realtime-price-cache.service';

export interface MetricPriceFallback {
  closePrice: unknown;
  priceChange1d?: unknown;
  priceChangeRate1d?: unknown;
}

export interface ResolvedMetricPrice {
  currentPrice: number;
  closePrice: number;
  changeRate: number;
  priceChange1d: number | null;
  priceChangeRate1d: number | null;
  usedRealtime: boolean;
}

@Injectable()
export class CurrentPriceResolver {
  private static readonly KST_OFFSET_MS = 9 * 60 * 60 * 1000;
  private static readonly MAX_REALTIME_AGE_MS = 10 * 60 * 1000;

  getUsableRealtimePrice(
    realtimePrice: RealtimePrice | undefined,
    now = new Date(),
  ): RealtimePrice | undefined {
    if (!realtimePrice) return undefined;
    if (!Number.isFinite(realtimePrice.currentPrice) || realtimePrice.currentPrice <= 0) {
      return undefined;
    }

    const nowKst = this.toKst(now);
    const day = nowKst.getUTCDay();
    const minutes = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    const isWeekday = day >= 1 && day <= 5;
    const isMarketSession =
      isWeekday && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
    if (!isMarketSession) return undefined;

    const timestamp = new Date(realtimePrice.timestamp);
    if (Number.isNaN(timestamp.getTime())) return undefined;

    const sameKstDate =
      this.toKstDateKey(now) === this.toKstDateKey(timestamp);
    const isFresh =
      now.getTime() - timestamp.getTime() <=
      CurrentPriceResolver.MAX_REALTIME_AGE_MS;

    return sameKstDate && isFresh ? realtimePrice : undefined;
  }

  resolveMetricSnapshot(
    metric: MetricPriceFallback,
    realtimePrice?: RealtimePrice,
    now = new Date(),
  ): ResolvedMetricPrice {
    const usableRealtimePrice = this.getUsableRealtimePrice(realtimePrice, now);
    const currentPrice = usableRealtimePrice
      ? usableRealtimePrice.currentPrice
      : Number(metric.closePrice);
    const realtimeOpenPrice =
      usableRealtimePrice && usableRealtimePrice.openPrice > 0
        ? usableRealtimePrice.openPrice
        : null;
    const changeRate =
      realtimeOpenPrice != null
        ? ((currentPrice - realtimeOpenPrice) / realtimeOpenPrice) * 100
        : metric.priceChangeRate1d != null
          ? Number(metric.priceChangeRate1d)
          : null;
    const priceChange1d =
      realtimeOpenPrice != null
        ? currentPrice - realtimeOpenPrice
        : metric.priceChange1d != null
          ? Number(metric.priceChange1d)
          : null;

    return {
      currentPrice,
      closePrice: currentPrice,
      changeRate: changeRate ?? 0,
      priceChange1d,
      priceChangeRate1d: changeRate,
      usedRealtime: usableRealtimePrice != null,
    };
  }

  private toKst(date: Date): Date {
    return new Date(date.getTime() + CurrentPriceResolver.KST_OFFSET_MS);
  }

  private toKstDateKey(date: Date): string {
    return this.toKst(date).toISOString().slice(0, 10);
  }
}
