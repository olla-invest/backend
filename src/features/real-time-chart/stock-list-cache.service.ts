import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { createHash } from 'crypto';

export interface RangeRsRankingCache {
  dataDate: string | null;
  marketType: '0' | '10' | 'all';
  periods: number[];
  weights: number[];
  logFile?: string;
  rows: Array<{
    stockCode: string;
    rank: number;
    rsScore: number;
  }>;
  createdAt: string;
}

@Injectable()
export class StockListCacheService {
  private readonly logger = new Logger(StockListCacheService.name);
  private readonly STOCK_LIST_TTL = 60 * 60 * 1000; // 1시간
  private readonly RANGE_RS_TTL = 5 * 60 * 1000; // 5분

  // Promise는 직렬화 불가 — 인메모리 유지
  private readonly rsFilterInflight = new Map<string, Promise<RangeRsRankingCache>>();

  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
  ) {}

  private stockListKey(marketType: '0' | '10' | 'all'): string {
    return `real-time-chart:stock-list:${marketType}`;
  }

  async getStockList(marketType: '0' | '10' | 'all'): Promise<any[] | null> {
    try {
      return (await this.cacheManager.get<any[]>(this.stockListKey(marketType))) ?? null;
    } catch (error) {
      this.logger.warn(`stock-list cache get failed marketType=${marketType}: ${(error as Error).message}`);
      return null;
    }
  }

  async setStockList(marketType: '0' | '10' | 'all', data: any[]): Promise<void> {
    try {
      await this.cacheManager.set(this.stockListKey(marketType), data, this.STOCK_LIST_TTL);
    } catch (error) {
      this.logger.warn(`stock-list cache set failed marketType=${marketType}: ${(error as Error).message}`);
    }
  }

  async clearStockList(marketType?: '0' | '10' | 'all'): Promise<void> {
    try {
      if (marketType) {
        await this.cacheManager.del(this.stockListKey(marketType));
        this.logger.log(`Cleared cache for market type: ${marketType}`);
      } else {
        await Promise.all(
          (['0', '10', 'all'] as const).map((t) => this.cacheManager.del(this.stockListKey(t))),
        );
        this.logger.log('Cleared all stock list cache');
      }
    } catch (error) {
      this.logger.warn(`stock-list cache clear failed: ${(error as Error).message}`);
    }
  }

  buildRangeRsCacheKey(params: {
    dataDate: string | null;
    marketType: '0' | '10' | 'all';
    periods: number[];
    weights: number[];
    rsFilters: Array<{ rsStartDate: string; rsEndDate: string; strength: number }>;
  }): string {
    const payload = {
      version: 1,
      dataDate: params.dataDate,
      marketType: params.marketType,
      periods: params.periods,
      weights: params.weights,
      rsFilters: params.rsFilters.map((f) => ({
        rsStartDate: f.rsStartDate,
        rsEndDate: f.rsEndDate,
        strength: f.strength,
      })),
    };
    const hash = createHash('sha1').update(JSON.stringify(payload)).digest('hex');
    return `real-time-chart:range-rs:${params.dataDate ?? 'unknown'}:${params.marketType}:${hash}`;
  }

  async getRangeRsRankingCache(cacheKey: string): Promise<RangeRsRankingCache | null> {
    try {
      return (await this.cacheManager.get<RangeRsRankingCache>(cacheKey)) ?? null;
    } catch (error) {
      this.logger.warn(`[getStockListWithRangeRS] cache get failed key=${cacheKey}: ${(error as Error).message}`);
      return null;
    }
  }

  async setRangeRsRankingCache(cacheKey: string, value: RangeRsRankingCache): Promise<void> {
    try {
      await this.cacheManager.set(cacheKey, value, this.RANGE_RS_TTL);
      this.logger.log(
        `[getStockListWithRangeRS] cache set key=${cacheKey} rows=${value.rows.length} ttlMs=${this.RANGE_RS_TTL}`,
      );
    } catch (error) {
      this.logger.warn(`[getStockListWithRangeRS] cache set failed key=${cacheKey}: ${(error as Error).message}`);
    }
  }

  getInflight(cacheKey: string): Promise<RangeRsRankingCache> | undefined {
    return this.rsFilterInflight.get(cacheKey);
  }

  setInflight(cacheKey: string, promise: Promise<RangeRsRankingCache>): void {
    this.rsFilterInflight.set(cacheKey, promise);
  }

  deleteInflight(cacheKey: string): void {
    this.rsFilterInflight.delete(cacheKey);
  }
}
