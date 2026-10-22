import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { CurrentPriceResolver } from './current-price-resolver.service';
import { RealtimePrice, RealtimePriceCacheService } from './realtime-price-cache.service';
import { RedisPriceStoreService } from './redis-price-store.service';
import { normalizeTradingValueToWon, toNonNegativeBigInt } from './trading-value.util';

/**
 * REALTIME   — 가격 기준 거래일의 정규장 tick
 * DAY_CANDLE — 가격 기준 거래일의 일봉 (장중엔 tick 으로 30초마다 갱신, 마감 후엔 EOD 수집값)
 * KIWOOM     — 위 둘이 없어 키움 ka10001 로 직접 조회한 값
 * BASE_PRICE — 가격 기준 거래일에 체결이 없어 기준가(직전 일봉 종가)를 등락 0 으로 보여준다
 */
export type CurrentPriceSource = 'REALTIME' | 'DAY_CANDLE' | 'KIWOOM' | 'BASE_PRICE';

export interface CurrentPrice {
  stockCode: string;
  priceDate: string;
  source: CurrentPriceSource;
  currentPrice: number;
  changeAmount: number;
  changeRate: number;
  /** 전일대비기호 (1 상한, 2 상승, 3 보합, 4 하한, 5 하락) */
  changeSign: string;
  openPrice: number | null;
  highPrice: number | null;
  lowPrice: number | null;
  accVolume: bigint | null;
  /** 원 단위 */
  tradingValue: bigint | null;
}

export interface CurrentPriceOptions {
  /** 기준 거래일(YYYY-MM-DD). 생략하면 지금 시각으로 정한다. */
  priceDate?: string;
  /** tick·당일 일봉이 모두 없으면 키움에서 직접 조회한다 (구독되지 않은 관심종목 등, 소량 조회용). */
  fetchMissing?: boolean;
  now?: Date;
}

type DayCandleRow = {
  stockCode: string;
  candleDate: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: bigint | string | null;
  tradingValue: bigint | string | null;
};

type SharedFallbackEntry = Omit<CurrentPrice, 'accVolume' | 'tradingValue'> & {
  accVolume: string | null;
  tradingValue: string | null;
  cachedAt: number;
  /** 키움까지 조회한 결과인지. 아니면 키움 조회가 필요한 요청은 기준가 캐시를 믿지 않는다. */
  kiwoomChecked: boolean;
};

/**
 * 모든 화면이 쓰는 현재가 조합.
 * tick(Redis 가격 hash 의 로컬 사본) → Redis 공유 폴백 → 당일 일봉 → (fetchMissing) 키움 조회 → 기준가 순서이며,
 * 전일 지표(stock_daily_metrics) 가격으로는 떨어지지 않는다. DB·키움에서 만든 값은 Redis 에 다시 써서
 * 같은 종목을 1분 동안은 어느 인스턴스·요청이든 Redis 에서 읽는다.
 */
@Injectable()
export class CurrentPriceService {
  private readonly logger = new Logger(CurrentPriceService.name);
  private static readonly SHARED_FALLBACK_TTL_MS = 60 * 1000;
  private readonly kiwoomInflight = new Map<string, Promise<CurrentPrice | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly resolver: CurrentPriceResolver,
    private readonly kiwoomRest: KiwoomRestService,
    private readonly priceStore: RedisPriceStoreService,
  ) {}

  async getCurrentPrice(stockCode: string, options: CurrentPriceOptions = {}): Promise<CurrentPrice | undefined> {
    return (await this.getCurrentPrices([stockCode], options)).get(stockCode);
  }

  async getCurrentPrices(stockCodes: string[], options: CurrentPriceOptions = {}): Promise<Map<string, CurrentPrice>> {
    const now = options.now ?? new Date();
    const priceDate = options.priceDate ?? this.resolver.getPriceDateKey(now);
    const fetchFromKiwoom = Boolean(options.fetchMissing) && priceDate === this.toKstDateKey(now);
    const result = new Map<string, CurrentPrice>();
    const uniqueCodes = [...new Set(stockCodes.filter(Boolean))];

    // 장이 끝난 뒤에는 종가 체결(15:30 이후 수신)까지 받은 tick 만 그날 가격으로 쓴다.
    // 서버 중단·연결 끊김으로 종가를 놓친 tick 은 장중 가격이라, 그날 일봉(종가)을 먼저 본다.
    const sessionClosed = now.getTime() >= Date.parse(`${priceDate}T15:35:00+09:00`);
    const closingPrintAt = Date.parse(`${priceDate}T15:30:00+09:00`);
    const missedCloseTicks = new Map<string, RealtimePrice>();
    const withoutTick: string[] = [];
    for (const stockCode of uniqueCodes) {
      const tick = this.resolver.getUsableRealtimePrice(this.realtimeCache.getPrice(stockCode), now, priceDate);
      if (tick && sessionClosed && new Date(tick.timestamp).getTime() < closingPrintAt) {
        missedCloseTicks.set(stockCode, tick);
        withoutTick.push(stockCode);
      } else if (tick) {
        result.set(stockCode, this.fromTick(tick, priceDate));
      } else {
        withoutTick.push(stockCode);
      }
    }
    if (withoutTick.length === 0) return result;

    const shared = await this.loadSharedFallback(priceDate, withoutTick, now);
    const misses: string[] = [];
    for (const stockCode of withoutTick) {
      const hit = shared.get(stockCode);
      // 구독 밖 종목은 그 사이 체결됐을 수 있어, 키움을 확인하지 않은 '체결 없음' 캐시는 키움 조회 요청에 쓰지 않는다.
      if (hit && !(fetchFromKiwoom && hit.price.source === 'BASE_PRICE' && !hit.kiwoomChecked)) {
        result.set(stockCode, hit.price);
      } else {
        misses.push(stockCode);
      }
    }
    if (misses.length > 0) {
      const resolved = await this.resolveFromSources(misses, priceDate, fetchFromKiwoom);
      resolved.forEach((price, stockCode) => result.set(stockCode, price));
      this.saveSharedFallback(priceDate, resolved, fetchFromKiwoom, now);
    }

    // 그날 일봉도 키움 시세도 없으면, 기준가(등락 0)보다는 놓친 종가 직전의 마지막 체결이 낫다.
    for (const [stockCode, tick] of missedCloseTicks) {
      const price = result.get(stockCode);
      if (!price || price.source === 'BASE_PRICE') result.set(stockCode, this.fromTick(tick, priceDate));
    }
    return result;
  }

  private async resolveFromSources(
    stockCodes: string[],
    priceDate: string,
    fetchFromKiwoom: boolean,
  ): Promise<Map<string, CurrentPrice>> {
    const result = new Map<string, CurrentPrice>();
    const candlesByCode = await this.getRecentDayCandles(stockCodes, priceDate);
    const withoutDayCandle: string[] = [];
    for (const stockCode of stockCodes) {
      const [latest, previous] = candlesByCode.get(stockCode) ?? [];
      if (latest && latest.candleDate === priceDate) {
        result.set(stockCode, this.fromDayCandle(stockCode, priceDate, latest, previous));
      } else {
        withoutDayCandle.push(stockCode);
      }
    }

    const kiwoomQuotes = fetchFromKiwoom
      ? await this.fetchKiwoomQuotes(withoutDayCandle, priceDate)
      : new Map<string, CurrentPrice>();
    for (const stockCode of withoutDayCandle) {
      const quote = kiwoomQuotes.get(stockCode);
      if (quote) {
        result.set(stockCode, quote);
        continue;
      }
      const [lastCandle] = candlesByCode.get(stockCode) ?? [];
      if (lastCandle) result.set(stockCode, this.fromBasePrice(stockCode, priceDate, lastCandle));
    }
    return result;
  }

  private async loadSharedFallback(
    priceDate: string,
    stockCodes: string[],
    now: Date,
  ): Promise<Map<string, { price: CurrentPrice; kiwoomChecked: boolean }>> {
    const result = new Map<string, { price: CurrentPrice; kiwoomChecked: boolean }>();
    try {
      const raw = await this.priceStore.loadFallbackPrices(priceDate, stockCodes);
      for (const [stockCode, value] of raw) {
        const entry = this.parseSharedFallback(value);
        if (!entry || entry.stockCode !== stockCode || entry.priceDate !== priceDate) continue;
        const age = now.getTime() - entry.cachedAt;
        if (age < 0 || age >= CurrentPriceService.SHARED_FALLBACK_TTL_MS) continue;
        const { cachedAt: _cachedAt, kiwoomChecked, accVolume, tradingValue, ...price } = entry;
        result.set(stockCode, {
          price: {
            ...price,
            accVolume: accVolume == null ? null : BigInt(accVolume),
            tradingValue: tradingValue == null ? null : BigInt(tradingValue),
          },
          kiwoomChecked,
        });
      }
    } catch (error) {
      this.logger.warn(`Shared price cache read failed; resolving from DB: ${(error as Error).message}`);
    }
    return result;
  }

  private saveSharedFallback(
    priceDate: string,
    prices: Map<string, CurrentPrice>,
    kiwoomChecked: boolean,
    now: Date,
  ): void {
    if (prices.size === 0) return;
    const entries = new Map<string, string>();
    for (const [stockCode, price] of prices) {
      const entry: SharedFallbackEntry = {
        ...price,
        accVolume: price.accVolume == null ? null : price.accVolume.toString(),
        tradingValue: price.tradingValue == null ? null : price.tradingValue.toString(),
        cachedAt: now.getTime(),
        kiwoomChecked,
      };
      entries.set(stockCode, JSON.stringify(entry));
    }
    // 응답을 Redis 쓰기에 묶지 않는다. 실패해도 다음 요청이 다시 조회해 채운다.
    this.priceStore.saveFallbackPrices(priceDate, entries).catch((error) => {
      this.logger.warn(`Shared price cache write failed: ${(error as Error).message}`);
    });
  }

  private parseSharedFallback(value: string): SharedFallbackEntry | null {
    try {
      const entry = JSON.parse(value) as SharedFallbackEntry;
      return Number.isFinite(entry?.currentPrice) && entry.currentPrice > 0 && Number.isFinite(entry.cachedAt)
        ? entry
        : null;
    } catch {
      return null;
    }
  }

  private fromTick(tick: RealtimePrice, priceDate: string): CurrentPrice {
    return {
      stockCode: tick.stockCode,
      priceDate,
      source: 'REALTIME',
      currentPrice: tick.currentPrice,
      changeAmount: tick.changeAmount,
      changeRate: tick.changeRate,
      changeSign: this.resolveChangeSign(tick.changeSign, tick.changeAmount),
      openPrice: tick.openPrice > 0 ? tick.openPrice : null,
      highPrice: tick.highPrice > 0 ? tick.highPrice : null,
      lowPrice: tick.lowPrice > 0 ? tick.lowPrice : null,
      accVolume: toNonNegativeBigInt(tick.accVolume),
      // 실시간 누적거래대금은 백만원 단위라 원으로 맞춘다.
      tradingValue: tick.accAmount > 0 ? normalizeTradingValueToWon(tick.accAmount) : null,
    };
  }

  private fromDayCandle(
    stockCode: string,
    priceDate: string,
    candle: DayCandleRow,
    previous: DayCandleRow | undefined,
  ): CurrentPrice {
    const currentPrice = Number(candle.closePrice);
    const basePrice = previous ? Number(previous.closePrice) : null;
    const changeAmount = basePrice != null && basePrice > 0 ? currentPrice - basePrice : 0;
    return {
      stockCode,
      priceDate,
      source: 'DAY_CANDLE',
      currentPrice,
      changeAmount,
      changeRate: basePrice != null && basePrice > 0 ? (changeAmount / basePrice) * 100 : 0,
      changeSign: this.resolveChangeSign(undefined, changeAmount),
      openPrice: Number(candle.openPrice),
      highPrice: Number(candle.highPrice),
      lowPrice: Number(candle.lowPrice),
      accVolume: toNonNegativeBigInt(candle.volume),
      tradingValue: toNonNegativeBigInt(candle.tradingValue) > 0n
        ? normalizeTradingValueToWon(candle.tradingValue)
        : null,
    };
  }

  private fromBasePrice(stockCode: string, priceDate: string, lastCandle: DayCandleRow): CurrentPrice {
    return {
      stockCode,
      priceDate,
      source: 'BASE_PRICE',
      currentPrice: Number(lastCandle.closePrice),
      changeAmount: 0,
      changeRate: 0,
      changeSign: '3',
      openPrice: null,
      highPrice: null,
      lowPrice: null,
      accVolume: 0n,
      tradingValue: 0n,
    };
  }

  // 종목마다 기준일 이하 최근 일봉 2개 (당일 + 기준가). idx_stock_candle_query 로 종목당 2행만 읽는다.
  private async getRecentDayCandles(stockCodes: string[], priceDate: string): Promise<Map<string, DayCandleRow[]>> {
    const rows = await this.prisma.$queryRawUnsafe<DayCandleRow[]>(
      `
        SELECT
          code.stock_code AS "stockCode",
          to_char(c.candle_time, 'YYYY-MM-DD') AS "candleDate",
          c.open_price::text AS "openPrice",
          c.high_price::text AS "highPrice",
          c.low_price::text AS "lowPrice",
          c.close_price::text AS "closePrice",
          c.volume,
          c.trading_value AS "tradingValue"
        FROM unnest($1::text[]) AS code(stock_code)
        CROSS JOIN LATERAL (
          SELECT candle_time, open_price, high_price, low_price, close_price, volume, trading_value
          FROM stock_candles
          WHERE stock_code = code.stock_code
            AND candle_type = 'day'
            AND candle_time <= $2::date
          ORDER BY candle_time DESC
          LIMIT 2
        ) c
        ORDER BY code.stock_code, c.candle_time DESC
      `,
      stockCodes,
      priceDate,
    );
    const byCode = new Map<string, DayCandleRow[]>();
    for (const row of rows) {
      const list = byCode.get(row.stockCode) ?? [];
      list.push(row);
      byCode.set(row.stockCode, list);
    }
    return byCode;
  }

  // 키움 REST 는 계정 단위로 초당 4건으로 직렬화된다. 결과는 Redis 공유 폴백에 남고, 동시 요청은 합친다.
  private async fetchKiwoomQuotes(stockCodes: string[], priceDate: string): Promise<Map<string, CurrentPrice>> {
    const quotes = await Promise.all(stockCodes.map((stockCode) => this.getKiwoomQuote(stockCode, priceDate)));
    const result = new Map<string, CurrentPrice>();
    quotes.forEach((quote) => quote && result.set(quote.stockCode, quote));
    return result;
  }

  private async getKiwoomQuote(stockCode: string, priceDate: string): Promise<CurrentPrice | null> {
    const key = `${priceDate}:${stockCode}`;
    const inflight = this.kiwoomInflight.get(key);
    if (inflight) return inflight;

    const request = this.kiwoomRest.getStockBasicInfo(stockCode)
      .then((info) => this.fromKiwoomBasicInfo(stockCode, priceDate, info))
      .catch((error) => {
        this.logger.warn(`Kiwoom quote unavailable for ${stockCode}: ${(error as Error).message}`);
        return null;
      })
      .finally(() => this.kiwoomInflight.delete(key));
    this.kiwoomInflight.set(key, request);
    return request;
  }

  private fromKiwoomBasicInfo(stockCode: string, priceDate: string, info: any): CurrentPrice | null {
    const currentPrice = this.parseAbsolute(info?.cur_prc);
    if (!(currentPrice > 0)) return null;
    const basePrice = this.parseAbsolute(info?.base_pric);
    const changeAmount = basePrice > 0 ? currentPrice - basePrice : this.parseSigned(info?.pred_pre);
    const changeRate = basePrice > 0 ? (changeAmount / basePrice) * 100 : this.parseSigned(info?.flu_rt);
    return {
      stockCode,
      priceDate,
      source: 'KIWOOM',
      currentPrice,
      changeAmount,
      changeRate,
      changeSign: this.resolveChangeSign(info?.pre_sig, changeAmount),
      openPrice: this.parseAbsolute(info?.open_pric) || null,
      highPrice: this.parseAbsolute(info?.high_pric) || null,
      lowPrice: this.parseAbsolute(info?.low_pric) || null,
      accVolume: toNonNegativeBigInt(this.parseAbsolute(info?.trde_qty)),
      tradingValue: null,
    };
  }

  // 키움 부호는 상한(1)·하한(4)까지 알려준다. 등락 방향과 어긋나면 금액으로 다시 정한다.
  private resolveChangeSign(raw: unknown, changeAmount: number): string {
    const computed = changeAmount > 0 ? '2' : changeAmount < 0 ? '5' : '3';
    const sign = String(raw ?? '').replace(/[^1-5]/g, '');
    if (sign.length !== 1) return computed;
    const direction = sign === '1' || sign === '2' ? '2' : sign === '4' || sign === '5' ? '5' : '3';
    return direction === computed ? sign : computed;
  }

  private parseAbsolute(value: unknown): number {
    if (value == null) return 0;
    const parsed = Number(String(value).replace(/[+\-,]/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private parseSigned(value: unknown): number {
    if (value == null) return 0;
    const parsed = Number(String(value).replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private toKstDateKey(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
}
