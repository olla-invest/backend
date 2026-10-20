import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import type { RealtimePrice } from './realtime-price-cache.service';

// Compare timestamps atomically so delayed writes from another instance cannot roll prices back.
const SAVE_PRICES = `
for i = 1, #ARGV, 3 do
  local previous = redis.call('HGET', KEYS[1], ARGV[i])
  local oldTime = 0
  if previous then
    local ok, value = pcall(cjson.decode, previous)
    if ok then oldTime = tonumber(value.receivedAt) or 0 end
  end
  if tonumber(ARGV[i + 1]) >= oldTime then
    redis.call('HSET', KEYS[1], ARGV[i], ARGV[i + 2])
  end
end
redis.call('EXPIRE', KEYS[1], 2592000)
return 1
`;

@Injectable()
export class RedisPriceStoreService {
  private readonly client: ReturnType<typeof createClient>;
  readonly key: string;
  private connecting: Promise<unknown> | null = null;

  constructor(config: ConfigService) {
    const mock = String(config.get('KIWOOM_USE_MOCK', 'false')) === 'true';
    this.key = config.get(
      'REALTIME_PRICE_REDIS_KEY',
      `olla:realtime:prices:${mock ? 'mock' : 'live'}:v1`,
    );
    this.client = createClient({
      socket: {
        host: config.get('REDIS_HOST', 'localhost'),
        port: Number(config.get('REDIS_PORT', 6379)),
        connectTimeout: 5000,
        reconnectStrategy: false,
      },
      password: config.get('REDIS_PASSWORD'),
      disableOfflineQueue: true,
    });
    // Callers log failures and keep serving their last local prices.
    this.client.on('error', () => {});
  }

  private async withDeadline<T>(operation: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            if (this.client.isOpen) this.client.destroy();
            reject(new Error('Redis price command timeout'));
          }, 5000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async ready() {
    if (this.client.isReady) return;
    if (!this.connecting) {
      this.connecting = this.withDeadline(() => this.client.connect()).finally(
        () => {
          this.connecting = null;
        },
      );
    }
    await this.connecting;
  }

  async load(): Promise<RealtimePrice[]> {
    await this.ready();
    const values = await this.withDeadline(() => this.client.hGetAll(this.key));
    const prices: RealtimePrice[] = [];
    for (const [code, raw] of Object.entries(values)) {
      try {
        const price = JSON.parse(raw);
        const timestamp = new Date(price.timestamp);
        if (
          price.stockCode === code &&
          Number.isFinite(price.currentPrice) &&
          price.currentPrice > 0 &&
          Number.isFinite(timestamp.getTime()) &&
          timestamp.getTime() <= Date.now() &&
          Date.now() - timestamp.getTime() < 30 * 86400000
        ) {
          prices.push({ ...price, timestamp });
        }
      } catch {
        /* Ignore a malformed field without discarding the other symbols. */
      }
    }
    return prices;
  }

  async save(prices: RealtimePrice[]): Promise<void> {
    if (!prices.length) return;
    await this.ready();
    await this.withDeadline(() =>
      this.client.eval(SAVE_PRICES, {
        keys: [this.key],
        arguments: prices.flatMap((price) => [
          price.stockCode,
          String(price.timestamp.getTime()),
          JSON.stringify({ ...price, receivedAt: price.timestamp.getTime() }),
        ]),
      }),
    );
  }

  private fallbackKey(priceDate: string): string {
    return `${this.key}:fallback:${priceDate}`;
  }

  /**
   * 가격 기준 거래일에 tick 이 없는 종목의 조합 가격(당일 일봉·키움 조회·기준가).
   * 인스턴스·요청마다 DB·키움을 다시 치지 않도록 Redis 에서 공유한다. 값의 신선도는 호출측이 판단한다.
   */
  async loadFallbackPrices(priceDate: string, stockCodes: string[]): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (!stockCodes.length) return result;
    await this.ready();
    const values = await this.withDeadline(() => this.client.hmGet(this.fallbackKey(priceDate), stockCodes));
    values.forEach((value, index) => {
      if (typeof value === 'string') result.set(stockCodes[index], value);
    });
    return result;
  }

  async saveFallbackPrices(priceDate: string, entries: Map<string, string>): Promise<void> {
    if (!entries.size) return;
    await this.ready();
    const key = this.fallbackKey(priceDate);
    await this.withDeadline(() =>
      this.client.multi().hSet(key, Object.fromEntries(entries)).expire(key, 2 * 86400).exec(),
    );
  }

  async close() {
    if (this.client.isOpen) this.client.destroy();
  }
}
