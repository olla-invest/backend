import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { CurrentPriceResolver } from './current-price-resolver.service';

type MetricRow = {
  stock_code: string;
  trade_date: Date;
  close_price: string;
  relative_strength_score: string;
  rank: number;
  high_price_52w: string | null;
  low_price_52w: string | null;
  ma_50: string | null;
};

type CurrentRankRow = {
  stockCode: string;
  tradeDate: string;
  snapshotTime: string;
  currentRank: number | null;
  relativeStrengthScore: number;
  currentPrice: number;
  closePrice: number;
  highPrice52w: number | null;
  lowPrice52w: number | null;
  ma50: number | null;
  passedDynamicFilters: boolean;
  priceSource: 'realtime' | 'close';
};

@Injectable()
export class CurrentRankService {
  private readonly logger = new Logger(CurrentRankService.name);
  private static readonly SNAPSHOT_SAVE_BATCH = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly currentPriceResolver: CurrentPriceResolver,
  ) {}

  async createCurrentRankSnapshot(now: Date = new Date(), tradeDate?: Date) {
    const metricTradeDate = await this.getLatestMetricTradeDate();
    if (!metricTradeDate) {
      this.logger.warn('[current-rank] no stock_daily_metrics rows found');
      return { success: false, count: 0, rankedCount: 0, tradeDate: null, snapshotTime: null };
    }

    // snapshotTradeDate를 오늘 KST 날짜가 아닌 메트릭 기준 날짜로 맞춰야 한다.
    // 실시간 차트는 getLatestCurrentRankSnapshotMap(metricTradeDate)로 조회하므로
    // trade_date가 다르면 스냅샷을 찾지 못하고 배치 currentRank로 fallback된다.
    const snapshotTradeDate = tradeDate ? this.dateOnly(tradeDate) : this.dateOnly(metricTradeDate);
    const metrics = await this.getStaticFilteredMetrics(metricTradeDate);
    if (metrics.length === 0) {
      this.logger.warn(`[current-rank] no SF-passed metrics for ${this.toDateOnly(metricTradeDate)}`);
      return {
        success: false,
        count: 0,
        rankedCount: 0,
        tradeDate: this.toDateOnly(snapshotTradeDate),
        snapshotTime: null,
      };
    }

    const snapshotTime = this.truncateToTenMinutes(now);
    const rows = this.buildRankRows(metrics, snapshotTradeDate, snapshotTime);
    await this.saveSnapshotRows(rows);

    const rankedCount = rows.filter((row) => row.passedDynamicFilters).length;
    this.logger.log(
      `[current-rank] snapshot saved tradeDate=${this.toDateOnly(snapshotTradeDate)} metricDate=${this.toDateOnly(metricTradeDate)} ` +
      `snapshotTime=${snapshotTime.toISOString()} ` +
      `rows=${rows.length} ranked=${rankedCount}`,
    );

    return {
      success: true,
      count: rows.length,
      rankedCount,
      tradeDate: this.toDateOnly(snapshotTradeDate),
      snapshotTime: snapshotTime.toISOString(),
    };
  }

  async finalizeDailyCurrentRank(tradeDate?: Date) {
    const targetTradeDate = tradeDate ? this.dateOnly(tradeDate) : await this.getLatestMetricTradeDate();
    if (!targetTradeDate) {
      this.logger.warn('[current-rank] no metrics date found for finalization');
      return { success: false, updated: 0, tradeDate: null, snapshotTime: null };
    }

    let snapshotTime = await this.getLatestSnapshotTime(targetTradeDate);
    if (!snapshotTime) {
      const snapshot = await this.createCurrentRankSnapshot(new Date(), targetTradeDate);
      if (!snapshot.success) {
        return { success: false, updated: 0, tradeDate: this.toDateOnly(targetTradeDate), snapshotTime: null };
      }
      snapshotTime = new Date(snapshot.snapshotTime!);
    }

    const updatedRows = await this.prisma.$queryRawUnsafe<Array<{ updated: number }>>(
      `
        WITH latest AS (
          SELECT stock_code, current_rank
          FROM stock_current_rank_snapshots
          WHERE trade_date = $1::date
            AND snapshot_time = $2::timestamp
            AND passed_dynamic_filters = TRUE
        ), reset AS (
          UPDATE stock_daily_metrics
          SET current_rank = NULL,
              updated_at = NOW()
          WHERE trade_date = $1::date
          RETURNING 1
        ), applied AS (
          UPDATE stock_daily_metrics m
          SET current_rank = latest.current_rank,
              updated_at = NOW()
          FROM latest
          WHERE m.trade_date = $1::date
            AND m.stock_code = latest.stock_code
          RETURNING 1
        )
        SELECT COUNT(*)::int AS updated FROM applied
      `,
      this.toDateOnly(targetTradeDate),
      snapshotTime.toISOString(),
    );

    const updated = updatedRows[0]?.updated ?? 0;
    this.logger.log(
      `[current-rank] finalized tradeDate=${this.toDateOnly(targetTradeDate)} snapshotTime=${snapshotTime.toISOString()} updated=${updated}`,
    );

    return {
      success: true,
      updated,
      tradeDate: this.toDateOnly(targetTradeDate),
      snapshotTime: snapshotTime.toISOString(),
    };
  }

  async pruneSnapshots(retentionDays = 90) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
    cutoff.setUTCHours(0, 0, 0, 0);

    const rows = await this.prisma.$queryRawUnsafe<Array<{ deleted: number }>>(
      `
        WITH deleted AS (
          DELETE FROM stock_current_rank_snapshots
          WHERE trade_date < $1::date
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM deleted
      `,
      this.toDateOnly(cutoff),
    );

    return { deleted: rows[0]?.deleted ?? 0, cutoff: this.toDateOnly(cutoff) };
  }

  private async getLatestMetricTradeDate(): Promise<Date | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ trade_date: Date }>>(
      `
        SELECT trade_date
        FROM stock_daily_metrics
        WHERE passed_static_filters = TRUE
        ORDER BY trade_date DESC
        LIMIT 1
      `,
    );
    return rows[0]?.trade_date ? this.dateOnly(rows[0].trade_date) : null;
  }

  private async getStaticFilteredMetrics(tradeDate: Date): Promise<MetricRow[]> {
    return this.prisma.$queryRawUnsafe<MetricRow[]>(
      `
        SELECT
          stock_code,
          trade_date,
          close_price::text,
          relative_strength_score::text,
          rank,
          high_price_52w::text,
          low_price_52w::text,
          ma_50::text
        FROM stock_daily_metrics
        WHERE trade_date = $1::date
          AND passed_static_filters = TRUE
          AND rank > 0
        ORDER BY rank ASC, stock_code ASC
      `,
      this.toDateOnly(tradeDate),
    );
  }

  private async getLatestSnapshotTime(tradeDate: Date): Promise<Date | null> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ snapshot_time: Date }>>(
      `
        SELECT snapshot_time
        FROM stock_current_rank_snapshots
        WHERE trade_date = $1::date
        ORDER BY snapshot_time DESC
        LIMIT 1
      `,
      this.toDateOnly(tradeDate),
    );
    return rows[0]?.snapshot_time ?? null;
  }

  private buildRankRows(metrics: MetricRow[], snapshotTradeDate: Date, snapshotTime: Date): CurrentRankRow[] {
    const tradeDate = this.toDateOnly(snapshotTradeDate);
    const rows = metrics.map((metric) => {
      const realtimePrice = this.currentPriceResolver.getUsableRealtimePrice(
        this.realtimeCache.getPrice(metric.stock_code),
      );
      const closePrice = Number(metric.close_price);
      const currentPrice = realtimePrice?.currentPrice && realtimePrice.currentPrice > 0
        ? realtimePrice.currentPrice
        : closePrice;
      const highPrice52w = metric.high_price_52w == null ? null : Number(metric.high_price_52w);
      const lowPrice52w = metric.low_price_52w == null ? null : Number(metric.low_price_52w);
      const ma50 = metric.ma_50 == null ? null : Number(metric.ma_50);
      const passedDynamicFilters =
        lowPrice52w != null &&
        highPrice52w != null &&
        ma50 != null &&
        currentPrice >= lowPrice52w * 1.3 &&
        currentPrice >= highPrice52w * 0.75 &&
        currentPrice > ma50;

      return {
        stockCode: metric.stock_code,
        tradeDate,
        snapshotTime: snapshotTime.toISOString(),
        currentRank: null,
        relativeStrengthScore: Number(metric.relative_strength_score),
        currentPrice,
        closePrice,
        highPrice52w,
        lowPrice52w,
        ma50,
        passedDynamicFilters,
        priceSource: realtimePrice ? 'realtime' as const : 'close' as const,
      };
    });

    // relativeStrengthScore(퍼센타일 1-99)로 정렬하면 동점이 많아 stockCode 순으로 밀림.
    // 배치 rank(rsRaw 기반 연속값 정렬)를 그대로 사용하는 것이 실시간 차트 순위와 일치함.
    // getStaticFilteredMetrics가 rank ASC로 조회하므로 sort 없이 순서를 유지한다.
    rows
      .filter((row) => row.passedDynamicFilters)
      .forEach((row, index) => {
        row.currentRank = index + 1;
      });

    return rows;
  }

  private async saveSnapshotRows(rows: CurrentRankRow[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CurrentRankService.SNAPSHOT_SAVE_BATCH) {
      const chunk = rows.slice(i, i + CurrentRankService.SNAPSHOT_SAVE_BATCH);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      let p = 1;

      for (const row of chunk) {
        placeholders.push(
          `($${p++}::uuid, $${p++}::text, $${p++}::date, $${p++}::timestamp, $${p++}::int, ` +
          `$${p++}::numeric, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, $${p++}::numeric, ` +
          `$${p++}::numeric, $${p++}::boolean, $${p++}::text)`,
        );
        params.push(
          randomUUID(),
          row.stockCode,
          row.tradeDate,
          row.snapshotTime,
          row.currentRank,
          row.relativeStrengthScore,
          row.currentPrice,
          row.closePrice,
          row.highPrice52w,
          row.lowPrice52w,
          row.ma50,
          row.passedDynamicFilters,
          row.priceSource,
        );
      }

      await this.prisma.$executeRawUnsafe(
        `
          INSERT INTO stock_current_rank_snapshots (
            snapshot_id, stock_code, trade_date, snapshot_time, current_rank,
            relative_strength_score, current_price, close_price, high_price_52w,
            low_price_52w, ma_50, passed_dynamic_filters, price_source
          )
          VALUES ${placeholders.join(', ')}
          ON CONFLICT (trade_date, snapshot_time, stock_code) DO UPDATE SET
            current_rank = EXCLUDED.current_rank,
            relative_strength_score = EXCLUDED.relative_strength_score,
            current_price = EXCLUDED.current_price,
            close_price = EXCLUDED.close_price,
            high_price_52w = EXCLUDED.high_price_52w,
            low_price_52w = EXCLUDED.low_price_52w,
            ma_50 = EXCLUDED.ma_50,
            passed_dynamic_filters = EXCLUDED.passed_dynamic_filters,
            price_source = EXCLUDED.price_source
        `,
        ...params,
      );
    }
  }

  private truncateToTenMinutes(date: Date): Date {
    const out = new Date(date);
    out.setUTCSeconds(0, 0);
    out.setUTCMinutes(Math.floor(out.getUTCMinutes() / 10) * 10);
    return out;
  }

  private dateOnly(date: Date): Date {
    const out = new Date(date);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }

  private todayKstDateOnly(now: Date = new Date()): Date {
    const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()));
  }

  private toDateOnly(date: Date): string {
    return this.dateOnly(date).toISOString().slice(0, 10);
  }
}
