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

@Injectable()
export class CurrentPriceResolver {
  private static readonly KST_OFFSET_MS = 9 * 60 * 60 * 1000;

  /**
   * 지금 화면에 보여야 하는 가격의 거래일 (YYYY-MM-DD).
   * 거래일 09:00 이후는 오늘, 그 전·주말·휴장일은 직전 거래일.
   */
  getPriceDateKey(now = new Date()): string {
    const nowKst = this.toKst(now);
    const minutes = nowKst.getUTCHours() * 60 + nowKst.getUTCMinutes();
    if (isKrxTradingDay(now) && minutes < 9 * 60) {
      return this.toKstDateKey(previousTradingDay(now));
    }
    return getKrxTradingDateByOffset(this.toKstDateKey(now), 0);
  }

  /**
   * 가격 기준 거래일의 정규장 tick 이면 그대로 쓴다.
   * 체결이 뜸해 오래된 tick 도 그날의 마지막 체결가라서 버리지 않는다 (당일 일봉도 같은 tick 으로 만든다).
   */
  getUsableRealtimePrice(
    realtimePrice: RealtimePrice | undefined,
    now = new Date(),
    priceDateKey = this.getPriceDateKey(now),
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

    return this.toKstDateKey(timestamp) === priceDateKey
      ? realtimePrice
      : undefined;
  }

  private toKst(date: Date): Date {
    return new Date(date.getTime() + CurrentPriceResolver.KST_OFFSET_MS);
  }

  private toKstDateKey(date: Date): string {
    return this.toKst(date).toISOString().slice(0, 10);
  }
}
