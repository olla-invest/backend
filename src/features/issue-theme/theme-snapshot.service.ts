import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OnEvent } from '@nestjs/event-emitter';
import { CurrentRankService } from '../real-time-chart/current-rank.service';
import { ThemeMetricsService } from './theme-metrics.service';
import { ThemeAiSummaryService } from './theme-ai-summary.service';

export interface ThemeSnapshotItem {
  themeCode: number;
  rank: number;
  previousRank: number | null;
  risingCount: number;
  totalCount: number;
  upCount: number;
  flatCount: number;
  downCount: number;
  risingRatio: number;
  avgChangeRate: number;
  avgRsScore: number;
  shortTermRs: number | null;
  momentum: number | null;
  newHighCount: number;
  stockSnapshotTime: Date;
  snapshotDate: Date;
}

export interface ThemeSnapshotStock {
  stockCode: string;
  currentRank: number;
  currentPrice: number;
  relativeStrengthScore: number;
  priceChangeRate: number;
  priceChange1d: number | null;
  tradingValue: bigint | null;
  previousTradingValueRatio: number | null;
  isNewHigh: boolean;
  highPrice52w: number | null;
  shortTermRs: number | null;
}

type ThemeSourceRow = {
  theme_code: number;
  stock_code: string;
  rs_score: string;
  change_rate: string;
  trading_value: bigint | null;
  previous_trading_value_ratio: string | null;
  is_new_high: boolean | null;
};

@Injectable()
export class ThemeSnapshotService {
  private readonly logger = new Logger(ThemeSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly currentRank: CurrentRankService,
    private readonly themeMetrics: ThemeMetricsService,
    private readonly themeAiSummary: ThemeAiSummaryService,
  ) {}

  @OnEvent('stock-ranks.finalized')
  async handleStockRanksFinalized({ tradeDate }: { tradeDate: string }): Promise<void> {
    const date = new Date(`${tradeDate}T00:00:00.000Z`);
    await this.buildDailySnapshot(date);
    // AI 요약은 확정된 당일 스냅샷에만 필요하므로 백필 경로에서는 호출하지 않는다.
    void this.themeAiSummary
      .generateForTradeDate(date, Number(process.env.THEME_AI_SUMMARY_LIMIT || 20))
      .catch((error) => this.logger.error(
        `[theme-snapshot] AI summary batch failed: ${error?.message ?? error}`,
      ));
  }

  async buildDailySnapshot(tradeDate: Date): Promise<{
    saved: number;
    tradeDate: string;
    stockSnapshotTime: string;
  }> {
    const date = this.dateKey(tradeDate);
    const latest = await this.prisma.$queryRawUnsafe<Array<{ snapshot_time: Date }>>(
      `
        SELECT snapshot_time
        FROM stock_current_rank_snapshots
        WHERE trade_date = $1::date
          AND price_change_rate IS NOT NULL
        ORDER BY snapshot_time DESC
        LIMIT 1
      `,
      date,
    );
    const stockSnapshotTime = latest[0]?.snapshot_time;
    if (!stockSnapshotTime) throw new Error(`stock snapshot not found for ${date}`);

    const sourceRows = await this.prisma.$queryRawUnsafe<ThemeSourceRow[]>(
      `
        WITH theme_memberships AS (
          SELECT st.stock_code, st.theme_code
          FROM stock_themes st
          JOIN themes t
            ON t.theme_code = st.theme_code
           AND t.deleted_at IS NULL
          WHERE st.source = 'NAVER'

          UNION

          SELECT st.stock_code, tgt.group_theme_code AS theme_code
          FROM stock_themes st
          JOIN theme_group_themes tgt
            ON tgt.theme_code = st.theme_code
          JOIN themes grouped_theme
            ON grouped_theme.theme_code = tgt.group_theme_code
           AND grouped_theme.source = 'GROUP'
           AND grouped_theme.deleted_at IS NULL
          WHERE st.source = 'NAVER'
        )
        SELECT
          membership.theme_code,
          s.stock_code,
          s.relative_strength_score::text AS rs_score,
          s.price_change_rate::text AS change_rate,
          s.trading_value,
          s.previous_trading_value_ratio::text,
          s.is_new_high
        FROM stock_current_rank_snapshots s
        JOIN theme_memberships membership
          ON membership.stock_code = s.stock_code
        WHERE s.trade_date = $1::date
          AND s.snapshot_time = $2::timestamp
          AND s.passed_dynamic_filters = TRUE
          AND s.current_rank IS NOT NULL
          AND s.price_change_rate IS NOT NULL
      `,
      date,
      stockSnapshotTime.toISOString(),
    );

    const groups = new Map<number, Map<string, ThemeSourceRow>>();
    for (const row of sourceRows) {
      const stocks = groups.get(row.theme_code) ?? new Map<string, ThemeSourceRow>();
      stocks.set(row.stock_code, row);
      groups.set(row.theme_code, stocks);
    }

    const themeCodes = [...groups.keys()];
    const historyRows = themeCodes.length === 0 ? [] : await this.prisma.$queryRawUnsafe<Array<{
      theme_code: number;
      snapshot_date: Date;
      avg_rs_score: string;
    }>>(
      `
        SELECT theme_code, snapshot_date, avg_rs_score::text
        FROM (
          SELECT theme_code, snapshot_date, avg_rs_score,
                 ROW_NUMBER() OVER (PARTITION BY theme_code ORDER BY snapshot_date DESC) AS row_num
          FROM theme_daily_snapshots
          WHERE theme_code = ANY($1::int[])
            AND snapshot_date < $2::date
            AND stock_snapshot_time IS NOT NULL
        ) history
        WHERE row_num <= 62
        ORDER BY theme_code, snapshot_date
      `,
      themeCodes,
      date,
    );
    const histories = new Map<number, Array<{ tradeDate: string; avgRsScore: number }>>();
    for (const row of historyRows) {
      const history = histories.get(row.theme_code) ?? [];
      history.push({
        tradeDate: this.dateKey(row.snapshot_date),
        avgRsScore: Number(row.avg_rs_score),
      });
      histories.set(row.theme_code, history);
    }

    const themes = [...groups.entries()].map(([themeCode, stockMap]) => {
      const stocks = [...stockMap.values()];
      const changes = stocks.map((row) => Number(row.change_rate));
      const scores = stocks.map((row) => Number(row.rs_score));
      const totalCount = stocks.length;
      const risingCount = changes.filter((value) => value > 0).length;
      const upCount = risingCount;
      const downCount = changes.filter((value) => value < 0).length;
      const flatCount = changes.filter((value) => value === 0).length;
      const avgChangeRate = this.average(changes);
      const avgRsScore = this.average(scores);
      const history = [
        ...(histories.get(themeCode) ?? []),
        { tradeDate: date, avgRsScore },
      ];
      const historicalMetrics = this.themeMetrics.calculateDailyMetric(
        stocks.map((row) => ({
          stockCode: row.stock_code,
          rsScore: Number(row.rs_score),
          changeRate: Number(row.change_rate),
          isNewHigh: row.is_new_high === true,
        })),
        history,
      );
      return {
        themeCode,
        snapshotDate: new Date(`${date}T00:00:00.000Z`),
        rank: 0,
        risingCount,
        totalCount,
        risingRatio: this.round2((risingCount / totalCount) * 100),
        avgChangeRate,
        avgRsScore,
        themeScore: this.round2(avgChangeRate),
        highVolumeCount: stocks.filter((row) =>
          row.previous_trading_value_ratio != null && Number(row.previous_trading_value_ratio) >= 2,
        ).length,
        upCount,
        flatCount,
        downCount,
        shortTermRs: historicalMetrics.shortTermRs,
        momentum: historicalMetrics.momentum,
        newHighCount: stocks.filter((row) => row.is_new_high === true).length,
        stockSnapshotTime,
      };
    });
    themes.sort((a, b) =>
      b.avgRsScore - a.avgRsScore ||
      b.avgChangeRate - a.avgChangeRate ||
      a.themeCode - b.themeCode,
    );
    themes.forEach((theme, index) => { theme.rank = index + 1; });

    await this.prisma.$transaction(async (tx) => {
      await tx.themeDailySnapshot.deleteMany({ where: { snapshotDate: new Date(`${date}T00:00:00.000Z`) } });
      if (themes.length > 0) await tx.themeDailySnapshot.createMany({ data: themes });
    });
    this.logger.log(
      `[theme-snapshot] tradeDate=${date} stockSnapshotTime=${stockSnapshotTime.toISOString()} ` +
      `sourceRows=${sourceRows.length} themes=${themes.length}`,
    );
    return { saved: themes.length, tradeDate: date, stockSnapshotTime: stockSnapshotTime.toISOString() };
  }

  async buildLatestDailySnapshot() {
    const latest = await this.prisma.$queryRawUnsafe<Array<{ trade_date: Date }>>(
      `
        SELECT trade_date
        FROM stock_current_rank_snapshots
        WHERE price_change_rate IS NOT NULL
        ORDER BY trade_date DESC, snapshot_time DESC
        LIMIT 1
      `,
    );
    if (!latest[0]?.trade_date) throw new Error('stock snapshot not found');
    return this.buildDailySnapshot(latest[0].trade_date);
  }

  async backfillFromStockSnapshots(days: number): Promise<{
    requestedDays: number;
    rebuiltDates: string[];
    skippedDates: string[];
  }> {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      throw new Error('days must be an integer between 1 and 365');
    }
    const dates = await this.prisma.$queryRawUnsafe<Array<{ trade_date: Date }>>(
      `
        SELECT DISTINCT trade_date
        FROM stock_daily_metrics
        WHERE passed_static_filters = TRUE
        ORDER BY trade_date DESC
        LIMIT $1::int
      `,
      days,
    );
    dates.sort((a, b) => a.trade_date.getTime() - b.trade_date.getTime());
    const rebuiltDates: string[] = [];
    const skippedDates: string[] = [];
    for (const row of dates) {
      const date = this.dateKey(row.trade_date);
      const stockResult = await this.currentRank.rebuildClosingSnapshot(row.trade_date);
      if (!stockResult.success) {
        skippedDates.push(date);
        continue;
      }
      await this.buildDailySnapshot(row.trade_date);
      rebuiltDates.push(date);
    }
    return { requestedDays: days, rebuiltDates, skippedDates };
  }

  async getLatestThemeItems(themeCodes?: number[]): Promise<Map<number, ThemeSnapshotItem>> {
    const latest = await this.prisma.themeDailySnapshot.findFirst({
      where: { stockSnapshotTime: { not: null } },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true },
    });
    if (!latest) return new Map();
    const previous = await this.prisma.themeDailySnapshot.findFirst({
      where: { snapshotDate: { lt: latest.snapshotDate }, stockSnapshotTime: { not: null } },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true },
    });
    const [currentRows, previousRows] = await Promise.all([
      this.prisma.themeDailySnapshot.findMany({
        where: {
          snapshotDate: latest.snapshotDate,
          stockSnapshotTime: { not: null },
          ...(themeCodes ? { themeCode: { in: themeCodes } } : {}),
        },
      }),
      previous ? this.prisma.themeDailySnapshot.findMany({
        where: {
          snapshotDate: previous.snapshotDate,
          ...(themeCodes ? { themeCode: { in: themeCodes } } : {}),
        },
        select: { themeCode: true, rank: true },
      }) : Promise.resolve([]),
    ]);
    const previousRanks = new Map(previousRows.map((row) => [row.themeCode, row.rank]));
    return new Map(currentRows.map((row) => [row.themeCode, {
      themeCode: row.themeCode,
      rank: row.rank,
      previousRank: previousRanks.get(row.themeCode) ?? null,
      risingCount: row.risingCount,
      totalCount: row.totalCount,
      upCount: row.upCount,
      flatCount: row.flatCount,
      downCount: row.downCount,
      risingRatio: Number(row.risingRatio),
      avgChangeRate: Number(row.avgChangeRate),
      avgRsScore: Number(row.avgRsScore),
      shortTermRs: row.shortTermRs == null ? null : Number(row.shortTermRs),
      momentum: row.momentum == null ? null : Number(row.momentum),
      newHighCount: row.newHighCount,
      stockSnapshotTime: row.stockSnapshotTime!,
      snapshotDate: row.snapshotDate,
    }]));
  }

  async getThemeStocks(
    themeCode: number,
    tradeDate: Date,
    stockSnapshotTime: Date,
  ): Promise<ThemeSnapshotStock[]> {
    return (await this.getThemeStocksForThemes(
      [themeCode],
      tradeDate,
      stockSnapshotTime,
    )).get(themeCode) ?? [];
  }

  async getThemeStocksForThemes(
    themeCodes: number[],
    tradeDate: Date,
    stockSnapshotTime: Date,
  ): Promise<Map<number, ThemeSnapshotStock[]>> {
    if (themeCodes.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      theme_code: number;
      stock_code: string;
      current_rank: number;
      current_price: string;
      relative_strength_score: string;
      price_change_rate: string;
      price_change_1d: string | null;
      trading_value: bigint | null;
      previous_trading_value_ratio: string | null;
      is_new_high: boolean;
      high_price_52w: string | null;
      short_term_rs: string | null;
    }>>(
      `
        WITH theme_memberships AS (
          SELECT st.stock_code, st.theme_code
          FROM stock_themes st
          WHERE st.source = 'NAVER'

          UNION

          SELECT st.stock_code, tgt.group_theme_code AS theme_code
          FROM stock_themes st
          JOIN theme_group_themes tgt
            ON tgt.theme_code = st.theme_code
          WHERE st.source = 'NAVER'
        )
        SELECT DISTINCT ON (membership.theme_code, s.stock_code)
          membership.theme_code, s.stock_code, s.current_rank, s.current_price::text,
          s.relative_strength_score::text, s.price_change_rate::text,
          s.price_change_1d::text, s.trading_value,
          s.previous_trading_value_ratio::text, s.is_new_high,
          s.high_price_52w::text, s.short_term_rs::text
        FROM stock_current_rank_snapshots s
        JOIN theme_memberships membership ON membership.stock_code = s.stock_code
        WHERE membership.theme_code = ANY($1::int[])
          AND s.trade_date = $2::date
          AND s.snapshot_time = $3::timestamp
          AND s.passed_dynamic_filters = TRUE
          AND s.current_rank IS NOT NULL
          AND s.price_change_rate IS NOT NULL
        ORDER BY membership.theme_code, s.stock_code, s.current_rank
      `,
      themeCodes,
      this.dateKey(tradeDate),
      stockSnapshotTime.toISOString(),
    );
    const result = new Map<number, ThemeSnapshotStock[]>();
    for (const themeCode of themeCodes) result.set(themeCode, []);
    for (const row of rows) {
      result.get(row.theme_code)?.push({
        stockCode: row.stock_code,
        currentRank: row.current_rank,
        currentPrice: Number(row.current_price),
        relativeStrengthScore: Number(row.relative_strength_score),
        priceChangeRate: Number(row.price_change_rate),
        priceChange1d: row.price_change_1d == null ? null : Number(row.price_change_1d),
        tradingValue: row.trading_value,
        previousTradingValueRatio: row.previous_trading_value_ratio == null
          ? null : Number(row.previous_trading_value_ratio),
        isNewHigh: row.is_new_high,
        highPrice52w: row.high_price_52w == null ? null : Number(row.high_price_52w),
        shortTermRs: row.short_term_rs == null ? null : Number(row.short_term_rs),
      });
    }
    return result;
  }

  private average(values: number[]): number {
    return this.round2(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private dateKey(date: Date): string {
    return new Date(date).toISOString().slice(0, 10);
  }
}
