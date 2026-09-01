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
  price_change_rate_1d: string | null;
  price_change_1d: string | null;
  trading_value: bigint | null;
  is_new_high: boolean;
  short_term_rs: string | null;
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
  priceChangeRate: number | null;
  priceChange1d: number | null;
  tradingValue: bigint | null;
  previousTradingValueRatio: number | null;
  isNewHigh: boolean;
  shortTermRs: number | null;
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
    const previousTradingValues = await this.getPreviousTradingValues(snapshotTradeDate, snapshotTime);
    const rows = this.buildRankRows(metrics, snapshotTradeDate, snapshotTime, previousTradingValues);
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

  async rebuildClosingSnapshot(tradeDate: Date) {
    const targetDate = this.dateOnly(tradeDate);
    const metrics = await this.getStaticFilteredMetrics(targetDate);
    if (metrics.length === 0) {
      return {
        success: false, count: 0, rankedCount: 0,
        tradeDate: this.toDateOnly(targetDate), snapshotTime: null,
      };
    }
    const snapshotTime = new Date(targetDate);
    snapshotTime.setUTCHours(6, 50, 0, 0);
    const previousTradingValues = await this.getPreviousTradingValues(targetDate, snapshotTime);
    const rows = this.buildRankRows(
      metrics,
      targetDate,
      snapshotTime,
      previousTradingValues,
      false,
    );
    await this.saveSnapshotRows(rows);
    return {
      success: true,
      count: rows.length,
      rankedCount: rows.filter((row) => row.passedDynamicFilters).length,
      tradeDate: this.toDateOnly(targetDate),
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
          m.stock_code,
          m.trade_date,
          m.close_price::text,
          m.relative_strength_score::text,
          m.rank,
          m.high_price_52w::text,
          m.low_price_52w::text,
          m.ma_50::text,
          m.price_change_rate_1d::text,
          m.price_change_1d::text,
          m.trading_value,
          m.is_new_high,
          (
            SELECT CASE WHEN COUNT(*) = 3 THEN AVG(recent.relative_strength_score)::text END
            FROM (
              SELECT history.relative_strength_score
              FROM stock_daily_metrics history
              WHERE history.stock_code = m.stock_code
                AND history.trade_date <= m.trade_date
                AND history.relative_strength_score > 0
              ORDER BY history.trade_date DESC
              LIMIT 3
            ) recent
          ) AS short_term_rs
        FROM stock_daily_metrics m
        WHERE m.trade_date = $1::date
          AND m.passed_static_filters = TRUE
          AND m.rank > 0
        ORDER BY m.rank ASC, m.stock_code ASC
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

  // 누적 거래대금은 장중에 계속 늘어나므로 전일 종가 스냅샷과 비교하면 비율이 항상 낮게 나온다.
  // 전일 같은 시각(없으면 그날 첫 스냅샷)의 누적 거래대금과 비교해야 전일비가 의미를 갖는다.
  private async getPreviousTradingValues(
    tradeDate: Date,
    snapshotTime: Date,
  ): Promise<Map<string, bigint>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      stock_code: string;
      trading_value: bigint;
    }>>(
      `
        WITH previous_date AS (
          SELECT MAX(trade_date) AS trade_date
          FROM stock_current_rank_snapshots
          WHERE trade_date < $1::date
            AND trading_value IS NOT NULL
        ), comparable_time AS (
          SELECT COALESCE(
            MAX(s.snapshot_time) FILTER (WHERE s.snapshot_time::time <= $2::time),
            MIN(s.snapshot_time)
          ) AS snapshot_time
          FROM stock_current_rank_snapshots s
          JOIN previous_date d ON d.trade_date = s.trade_date
          WHERE s.trading_value IS NOT NULL
        )
        SELECT s.stock_code, s.trading_value
        FROM stock_current_rank_snapshots s
        JOIN previous_date d ON d.trade_date = s.trade_date
        JOIN comparable_time t ON t.snapshot_time = s.snapshot_time
        WHERE s.trading_value IS NOT NULL
      `,
      this.toDateOnly(tradeDate),
      this.timeOfDay(snapshotTime),
    );
    return new Map(rows.map((row) => [row.stock_code, row.trading_value]));
  }

  private timeOfDay(date: Date): string {
    return date.toISOString().slice(11, 19);
  }

  private buildRankRows(
    metrics: MetricRow[],
    snapshotTradeDate: Date,
    snapshotTime: Date,
    previousTradingValues: Map<string, bigint> = new Map(),
    useRealtime = true,
  ): CurrentRankRow[] {
    const tradeDate = this.toDateOnly(snapshotTradeDate);
    const rows = metrics.map((metric) => {
      const realtimePrice = useRealtime
        ? this.currentPriceResolver.getUsableRealtimePrice(this.realtimeCache.getPrice(metric.stock_code))
        : null;
      const closePrice = Number(metric.close_price);
      const currentPrice = realtimePrice?.currentPrice && realtimePrice.currentPrice > 0
        ? realtimePrice.currentPrice
        : closePrice;
      const highPrice52w = metric.high_price_52w == null ? null : Number(metric.high_price_52w);
      const lowPrice52w = metric.low_price_52w == null ? null : Number(metric.low_price_52w);
      const ma50 = metric.ma_50 == null ? null : Number(metric.ma_50);
      const priceChangeRate = realtimePrice
        ? realtimePrice.changeRate
        : metric.price_change_rate_1d == null ? null : Number(metric.price_change_rate_1d);
      const priceChange1d = realtimePrice
        ? realtimePrice.changeAmount
        : metric.price_change_1d == null ? null : Number(metric.price_change_1d);
      const tradingValue = realtimePrice?.accAmount && realtimePrice.accAmount > 0
        ? BigInt(Math.trunc(realtimePrice.accAmount))
        : metric.trading_value;
      const previousTradingValue = previousTradingValues.get(metric.stock_code);
      const previousTradingValueRatio =
        tradingValue != null && previousTradingValue != null && previousTradingValue > 0n
          ? Number(tradingValue) / Number(previousTradingValue)
          : null;
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
        priceChangeRate,
        priceChange1d,
        tradingValue,
        previousTradingValueRatio,
        isNewHigh: highPrice52w != null ? currentPrice >= highPrice52w : metric.is_new_high,
        shortTermRs: metric.short_term_rs == null ? null : Number(metric.short_term_rs),
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
          `$${p++}::numeric, $${p++}::boolean, $${p++}::text, $${p++}::numeric, $${p++}::numeric, ` +
          `$${p++}::bigint, $${p++}::numeric, $${p++}::boolean, $${p++}::numeric)`,
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
          row.priceChangeRate,
          row.priceChange1d,
          row.tradingValue,
          row.previousTradingValueRatio,
          row.isNewHigh,
          row.shortTermRs,
        );
      }

      await this.prisma.$executeRawUnsafe(
        `
          INSERT INTO stock_current_rank_snapshots (
            snapshot_id, stock_code, trade_date, snapshot_time, current_rank,
            relative_strength_score, current_price, close_price, high_price_52w,
            low_price_52w, ma_50, passed_dynamic_filters, price_source,
            price_change_rate, price_change_1d, trading_value,
            previous_trading_value_ratio, is_new_high, short_term_rs
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
            price_source = EXCLUDED.price_source,
            price_change_rate = EXCLUDED.price_change_rate,
            price_change_1d = EXCLUDED.price_change_1d,
            trading_value = EXCLUDED.trading_value,
            previous_trading_value_ratio = EXCLUDED.previous_trading_value_ratio,
            is_new_high = EXCLUDED.is_new_high,
            short_term_rs = EXCLUDED.short_term_rs
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
