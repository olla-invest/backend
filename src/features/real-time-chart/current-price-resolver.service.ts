import {
  getKrxTradingDateByOffset,
  isKrxTradingDay,
  previousTradingDay,
} from '../../common/utils/market-calendar.util';
import { Injectable } from '@nestjs/common';
import { RealtimePrice } from './realtime-price-cache.service';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
// Closing-auction prints arrive shortly after 15:30; later 0B ticks are after-hours trades.
const REGULAR_SESSION_END_MINUTES = 15 * 60 + 35;

/** True when a tick was received during the KRX regular session (09:00–15:35 KST, incl. closing auction). */
export function isRegularSessionTick(timestamp: Date): boolean {
  if (!Number.isFinite(timestamp.getTime()) || !isKrxTradingDay(timestamp))
    return false;
  const kst = new Date(timestamp.getTime() + KST_OFFSET_MS);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return minutes >= 9 * 60 && minutes < REGULAR_SESSION_END_MINUTES;
}

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
    if (
      !Number.isFinite(realtimePrice.currentPrice) ||
      realtimePrice.currentPrice <= 0
    ) {
      return undefined;
    }

    const timestamp = new Date(realtimePrice.timestamp);
    const age = now.getTime() - timestamp.getTime();
    if (!Number.isFinite(age) || age < 0 || !isRegularSessionTick(timestamp))
      return undefined;

    const nowKst = this.toKst(now);
    const minutes = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    const tradingDay = isKrxTradingDay(now);
    const marketSession =
      tradingDay && minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
    if (marketSession) {
      return this.toKstDateKey(now) === this.toKstDateKey(timestamp) &&
        age <= CurrentPriceResolver.MAX_REALTIME_AGE_MS
        ? realtimePrice
        : undefined;
    }

    // A last-trade quote remains useful after close and through weekends/holidays.
    // It is not labelled a finalized closing price; the EOD candle remains authoritative.
    const expectedDate =
      tradingDay && minutes < 9 * 60
        ? this.toKstDateKey(previousTradingDay(now))
        : getKrxTradingDateByOffset(this.toKstDateKey(now), 0);
    return this.toKstDateKey(timestamp) === expectedDate
      ? realtimePrice
      : undefined;
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
