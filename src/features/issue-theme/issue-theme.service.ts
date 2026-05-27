import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePriceCacheService } from '../real-time-chart/realtime-price-cache.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';

interface TradingValueChange {
  label: string;
  ratio: number | null;
  currentAccTradingValue: number | null;
  prevSameTimeAccTradingValue: number | null;
}

@Injectable()
export class IssueThemeService {
  private readonly logger = new Logger(IssueThemeService.name);
  private readonly minPrevTradingValueForRatio = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly kiwoomRest: KiwoomRestService,
  ) {}

  // ─── 헬퍼 ────────────────────────────────────────────────────────

  /** UTC 기준 KST 시각 반환 */
  private getKstNow(): Date {
    return new Date(Date.now() + 9 * 60 * 60 * 1000);
  }

  /** 현재 KST 시각을 10분 단위로 내린 HHmm 문자열 (ex: "1030") */
  private getCurrentSnapshotTime(): string {
    const kst = this.getKstNow();
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const mm = String(Math.floor(kst.getUTCMinutes() / 10) * 10).padStart(2, '0');
    return `${hh}${mm}`;
  }

  private isMarketOpenNow(): boolean {
    const kst = this.getKstNow();
    const hours = kst.getUTCHours();
    const minutes = kst.getUTCMinutes();

    if (hours < 9 || hours > 15) return false;
    if (hours === 15 && minutes >= 30) return false;
    return true;
  }

  private async getLiveTradingValueChanges(
    stockCodes: string[],
    prices: Map<string, { accAmount: number }>,
    metricsMap: Map<string, any>,
    tradeDate: Date,
  ): Promise<Map<string, TradingValueChange>> {
    if (stockCodes.length === 0) return new Map();

    const isMarketOpen = this.isMarketOpenNow();
    const snapshotTime = this.getCurrentSnapshotTime();
    const fallback: TradingValueChange = {
      label: '-',
      ratio: null,
      currentAccTradingValue: null,
      prevSameTimeAccTradingValue: null,
    };

    const tradingValueChangeMap = new Map(stockCodes.map((code) => [code, fallback]));
    const todayDate = this.dateOnly(tradeDate);
    const prevSnapshotDate = await this.prisma.stockTradingValueSnapshot.findFirst({
      where: { stockCode: { in: stockCodes }, snapshotDate: { lt: todayDate } },
      orderBy: { snapshotDate: 'desc' },
      select: { snapshotDate: true },
    });

    let prevIntradayMap = new Map<string, number>();
    if (prevSnapshotDate) {
      const prevSnapshots = await this.prisma.stockTradingValueSnapshot.findMany({
        where: {
          stockCode: { in: stockCodes },
          snapshotDate: prevSnapshotDate.snapshotDate,
          snapshotTime: { lte: snapshotTime },
        },
        orderBy: [{ stockCode: 'asc' }, { snapshotTime: 'desc' }],
      });
      for (const snapshot of prevSnapshots) {
        if (!prevIntradayMap.has(snapshot.stockCode)) {
          prevIntradayMap.set(snapshot.stockCode, Number(snapshot.accTradingValue));
        }
      }
    }

    let prevDailyMap = new Map<string, number>();
    const prevMetricDate = await this.prisma.stockDailyMetrics.findFirst({
      where: { stockCode: { in: stockCodes }, tradeDate: { lt: tradeDate } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (prevMetricDate) {
      const prevMetrics = await this.prisma.stockDailyMetrics.findMany({
        where: { stockCode: { in: stockCodes }, tradeDate: prevMetricDate.tradeDate },
        select: { stockCode: true, tradingValue: true },
      });
      prevDailyMap = new Map(
        prevMetrics
          .filter((m) => m.tradingValue != null)
          .map((m) => [m.stockCode, Number(m.tradingValue)]),
      );
    }

    for (const stockCode of stockCodes) {
      const realtimeAccAmount = prices.get(stockCode)?.accAmount;
      const currentAccTradingValue =
        isMarketOpen && realtimeAccAmount && realtimeAccAmount > 0
          ? realtimeAccAmount
          : metricsMap.get(stockCode)?.tradingValue != null
            ? Number(metricsMap.get(stockCode).tradingValue)
            : null;

      const prevSameTimeAccTradingValue =
        isMarketOpen && realtimeAccAmount && realtimeAccAmount > 0
          ? prevIntradayMap.get(stockCode) ?? prevDailyMap.get(stockCode) ?? null
          : prevDailyMap.get(stockCode) ?? null;

      if (
        currentAccTradingValue == null ||
        prevSameTimeAccTradingValue == null ||
        prevSameTimeAccTradingValue <= this.minPrevTradingValueForRatio
      ) {
        tradingValueChangeMap.set(stockCode, {
          ...fallback,
          currentAccTradingValue,
          prevSameTimeAccTradingValue,
        });
        continue;
      }

      const ratio = currentAccTradingValue / prevSameTimeAccTradingValue;
      tradingValueChangeMap.set(stockCode, {
        label: `${ratio.toFixed(1)}배`,
        ratio,
        currentAccTradingValue,
        prevSameTimeAccTradingValue,
      });
    }

    return tradingValueChangeMap;
  }

  private dateOnly(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }

  /** metrics에 DF 필터(DF1/DF2/DF3) 적용 */
  private applyDynamicFilter(metrics: any[]): any[] {
    return metrics.filter((m) => {
      const cp = Number(m.closePrice);
      const df1 = m.lowPrice52w != null && cp >= Number(m.lowPrice52w) * 1.3;
      const df2 = m.highPrice52w != null && cp >= Number(m.highPrice52w) * 0.75;
      const df3 = m.ma50 != null && cp > Number(m.ma50);
      return df1 && df2 && df3;
    });
  }

  // ─── 공통 데이터 로더 ─────────────────────────────────────────────

  /** 최신 거래일 기준 필터 통과 종목 조회 */
  private async getFilteredMetrics() {
    const latest = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (!latest) return { tradeDate: null, metrics: [] };

    const sfMetrics = await this.prisma.stockDailyMetrics.findMany({
      where: { tradeDate: latest.tradeDate, passedStaticFilters: true },
    });
    return { tradeDate: latest.tradeDate, metrics: this.applyDynamicFilter(sfMetrics) };
  }

  // ─── 이슈테마 목록 ────────────────────────────────────────────────

  async getThemeList(display: number = 20, page: number = 1) {
    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) return { updatedAt: null, total: 0, page, display, themes: [] };

    const stockCodes = metrics.map((m) => m.stockCode);

    // 종목 → themeCode 매핑
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes }, themeCode: { not: null }, deletedAt: null },
      select: { stockCode: true, themeCode: true },
    });
    const themeCodeMap = new Map<string, number>(
      companies.filter((c) => c.themeCode != null).map((c) => [c.stockCode, c.themeCode!]),
    );

    // 실시간 등락률
    const prices = this.realtimeCache.getPrices(stockCodes);

    // 테마별 그룹핑
    const themeGroups = new Map<number, { changeRates: number[] }>();
    for (const m of metrics) {
      const themeCode = themeCodeMap.get(m.stockCode);
      if (themeCode == null) continue;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { changeRates: [] });
      const rt = prices.get(m.stockCode);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      themeGroups.get(themeCode)!.changeRates.push(changeRate);
    }

    // 테마명 조회
    const themeCodes = Array.from(themeGroups.keys());
    const themes = await this.prisma.theme.findMany({
      where: { themeCode: { in: themeCodes }, deletedAt: null },
      select: { themeCode: true, themeName: true },
    });
    const themeNameMap = new Map(themes.map((t) => [t.themeCode, t.themeName]));

    // 전일 순위 스냅샷
    const prevSnapshots = await this.prisma.themeDailySnapshot.findMany({
      where: { themeCode: { in: themeCodes }, snapshotDate: { lt: tradeDate } },
      orderBy: { snapshotDate: 'desc' },
      distinct: ['themeCode'],
    });
    const prevRankMap = new Map(prevSnapshots.map((s) => [s.themeCode, s.rank]));

    // 상승비율 계산
    const themeList: any[] = [];
    for (const [themeCode, { changeRates }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      const upCount = changeRates.filter((r) => r >= 1).length;
      const downCount = changeRates.filter((r) => r <= -1).length;
      const flatCount = totalCount - upCount - downCount;
      themeList.push({ themeCode, themeName: themeNameMap.get(themeCode) ?? '알 수 없음', totalCount, risingCount, risingRatio: Math.round(risingRatio * 100) / 100, avgChangeRate: Math.round(avgChangeRate * 100) / 100, upCount, flatCount, downCount });
    }

    // 순위 산출 (상승비율 내림차순, 동률 동일순위, 다음 순위 건너뛰지 않음)
    themeList.sort((a, b) => b.risingRatio - a.risingRatio);
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (i > 0 && themeList[i].risingRatio === themeList[i - 1].risingRatio) {
        themeList[i].rank = themeList[i - 1].rank;
      } else {
        themeList[i].rank = rank;
        rank++;
      }
    }

    // 순위변동
    for (const t of themeList) {
      const prevRank = prevRankMap.get(t.themeCode);
      t.rankChange = prevRank != null ? prevRank - t.rank : null;
    }

    const total = themeList.length;
    const paged = themeList.slice((page - 1) * display, page * display);

    return { updatedAt: new Date().toISOString(), total, page, display, themes: paged };
  }

  // ─── 테마 상세 (팝업) ─────────────────────────────────────────────

  async getThemeDetail(themeCode: number, userId?: string) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);

    const { tradeDate, metrics: allMetrics } = await this.getFilteredMetrics();
    if (!tradeDate) return null;

    // 테마 내 종목만 필터
    const companies = await this.prisma.company.findMany({
      where: { themeCode, deletedAt: null },
      select: { stockCode: true, companyName: true },
    });
    const themeStockCodes = new Set(companies.map((c) => c.stockCode));
    const companyNameMap = new Map(companies.map((c) => [c.stockCode, c.companyName]));

    const metrics = allMetrics.filter((m) => themeStockCodes.has(m.stockCode));
    const filteredCodes = metrics.map((m) => m.stockCode);
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));

    // 실시간 가격
    const prices = this.realtimeCache.getPrices(filteredCodes);

    // 거래대금 변화는 팝업 로딩 중 키움 API를 호출하지 않고 캐시/DB 스냅샷으로 계산한다.
    const tradingValueChangeMap = await this.getLiveTradingValueChanges(
      filteredCodes,
      prices,
      metricsMap,
      tradeDate,
    );

    // 등락률/거래대금 집계
    const changeRates: number[] = [];
    let highVolumeCount = 0;

    const stockRows = filteredCodes.map((code) => {
      const m = metricsMap.get(code)!;
      const rt = prices.get(code);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      const currentPrice = rt ? rt.currentPrice : Number(m.closePrice);

      changeRates.push(changeRate);

      const tradingValueChange = tradingValueChangeMap.get(code) ?? {
        label: '-',
        ratio: null,
        currentAccTradingValue: null,
        prevSameTimeAccTradingValue: null,
      };
      if (tradingValueChange.ratio != null && tradingValueChange.ratio >= 2.0) {
        highVolumeCount++;
      }

      return {
        stockCode: code,
        companyName: companyNameMap.get(code) ?? '',
        currentPrice,
        changeRate,
        rsScore: Number(m.relativeStrengthScore),
        tradingValue: m.tradingValue != null ? m.tradingValue.toString() : null,
        tradingValueRatio: tradingValueChange.label,
        tradingValueChange: tradingValueChange.label,
        currentAccTradingValue: tradingValueChange.currentAccTradingValue,
        prevSameTimeAccTradingValue: tradingValueChange.prevSameTimeAccTradingValue,
      };
    });

    // RS점수 내림차순 정렬 후 순위 부여
    stockRows.sort((a, b) => b.rsScore - a.rsScore);
    stockRows.forEach((r: any, i) => { r.rank = i + 1; });

    // 인사이트 계산
    const totalCount = filteredCodes.length;
    const risingCount = changeRates.filter((r) => r > 0).length;
    const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
    const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);

    const prevSnapshot = await this.prisma.themeDailySnapshot.findFirst({
      where: { themeCode, snapshotDate: { lt: tradeDate } },
      orderBy: { snapshotDate: 'desc' },
    });

    const insights: string[] = [];
    if (prevSnapshot) {
      if (risingRatio - Number(prevSnapshot.risingRatio) >= 10 && risingRatio >= 50) {
        insights.push('테마 내 상승 종목 비율 증가');
      }
      if (highVolumeCount - prevSnapshot.highVolumeCount >= 2) {
        insights.push('거래대금 급증 종목 증가');
      }
    }
    if (avgChangeRate >= 2) insights.push('평균 등락률 상승');
    if (changeRates.some((r) => r >= 7)) insights.push('상위 종목 급등');

    // 순위/순위변동
    const currentSnapshot = await this.prisma.themeDailySnapshot.findFirst({
      where: { themeCode, snapshotDate: tradeDate },
    });
    const rankChange =
      currentSnapshot && prevSnapshot ? prevSnapshot.rank - currentSnapshot.rank : null;

    let isFavorite: boolean | null = null;
    if (userId) {
      const favorite = await this.prisma.userWatchlistTheme.findFirst({
        where: { userId, themeCode, deletedAt: null },
      });
      isFavorite = favorite != null;
    }

    return {
      themeCode,
      themeName: theme.themeName,
      imageUrl: theme.imageUrl ?? null,
      rank: currentSnapshot?.rank ?? null,
      rankChange,
      risingCount,
      totalCount,
      insights,
      isFavorite,
      stocks: stockRows,
      updatedAt: new Date().toISOString(),
    };
  }

  // ─── 테마 즐겨찾기 ────────────────────────────────────────────────

  async addFavorite(userId: string, themeCode: number) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);

    const existing = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: null },
    });
    if (existing) return { message: '이미 즐겨찾기에 추가된 테마입니다', themeCode };

    const deleted = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: { not: null } },
    });
    if (deleted) {
      await this.prisma.userWatchlistTheme.update({
        where: { userId_themeCode: { userId, themeCode } },
        data: { deletedAt: null, addedDate: new Date() },
      });
    } else {
      await this.prisma.userWatchlistTheme.create({
        data: { userId, themeCode },
      });
    }

    return { message: '즐겨찾기에 추가되었습니다', themeCode };
  }

  async removeFavorite(userId: string, themeCode: number) {
    const existing = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('즐겨찾기에 등록되지 않은 테마입니다');

    await this.prisma.userWatchlistTheme.update({
      where: { userId_themeCode: { userId, themeCode } },
      data: { deletedAt: new Date() },
    });

    return { message: '즐겨찾기에서 삭제되었습니다', themeCode };
  }

  // ─── 스냅샷 저장 ──────────────────────────────────────────────────

  /** 테마 일별 스냅샷 저장 (장 마감 후 1회 호출) */
  @Cron('50 15 * * 1-5', { timeZone: 'Asia/Seoul' })
  async saveThemeSnapshot() {
    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) return { saved: 0 };

    const stockCodes = metrics.map((m) => m.stockCode);
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes }, themeCode: { not: null }, deletedAt: null },
      select: { stockCode: true, themeCode: true },
    });
    const themeCodeMap = new Map(
      companies.filter((c) => c.themeCode != null).map((c) => [c.stockCode, c.themeCode!]),
    );

    const prices = this.realtimeCache.getPrices(stockCodes);
    const themeGroups = new Map<number, { changeRates: number[] }>();

    for (const m of metrics) {
      const themeCode = themeCodeMap.get(m.stockCode);
      if (themeCode == null) continue;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { changeRates: [] });
      const rt = prices.get(m.stockCode);
      const changeRate = rt ? rt.changeRate : (m.priceChangeRate1d ? Number(m.priceChangeRate1d) : 0);
      themeGroups.get(themeCode)!.changeRates.push(changeRate);
    }

    // 순위 산출
    const themeList: any[] = [];
    for (const [themeCode, { changeRates }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      const upCount = changeRates.filter((r) => r >= 1).length;
      const downCount = changeRates.filter((r) => r <= -1).length;
      const flatCount = totalCount - upCount - downCount;
      themeList.push({ themeCode, totalCount, risingCount, risingRatio, avgChangeRate, upCount, flatCount, downCount });
    }

    themeList.sort((a, b) => b.risingRatio - a.risingRatio);
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (i > 0 && themeList[i].risingRatio === themeList[i - 1].risingRatio) {
        themeList[i].rank = themeList[i - 1].rank;
      } else {
        themeList[i].rank = rank;
        rank++;
      }
    }

    const snapshotDate = new Date(Date.UTC(
      (tradeDate as Date).getUTCFullYear(),
      (tradeDate as Date).getUTCMonth(),
      (tradeDate as Date).getUTCDate(),
    ));

    await this.prisma.themeDailySnapshot.createMany({
      data: themeList.map((t) => ({
        themeCode: t.themeCode,
        snapshotDate,
        rank: t.rank,
        risingCount: t.risingCount,
        totalCount: t.totalCount,
        risingRatio: t.risingRatio,
        avgChangeRate: t.avgChangeRate,
        highVolumeCount: 0,
        upCount: t.upCount,
        flatCount: t.flatCount,
        downCount: t.downCount,
      })),
      skipDuplicates: true,
    });

    this.logger.log(`Theme snapshot saved: ${themeList.length} themes for ${snapshotDate.toISOString().split('T')[0]}`);
    return { saved: themeList.length, date: snapshotDate.toISOString().split('T')[0] };
  }

  async backfillThemeSnapshots(days: number = 60) {
    const normalizedDays = Math.min(Math.max(Math.floor(days) || 60, 1), 365);

    const inserted = await this.prisma.$queryRawUnsafe<{ snapshot_date: Date; theme_code: number }[]>(
      `
      WITH target_dates AS (
        SELECT DISTINCT trade_date
        FROM stock_daily_metrics
        ORDER BY trade_date DESC
        LIMIT $1
      ), filtered AS (
        SELECT
          m.trade_date,
          co.theme_code,
          COALESCE(m.price_change_rate_1d, 0)::numeric AS change_rate
        FROM stock_daily_metrics m
        JOIN companies co ON co.stock_code = m.stock_code
        JOIN target_dates td ON td.trade_date = m.trade_date
        WHERE co.theme_code IS NOT NULL
          AND co.deleted_at IS NULL
          AND m.passed_static_filters = TRUE
          AND m.low_price_52w IS NOT NULL
          AND m.close_price >= m.low_price_52w * 1.3
          AND m.high_price_52w IS NOT NULL
          AND m.close_price >= m.high_price_52w * 0.75
          AND m.ma_50 IS NOT NULL
          AND m.close_price > m.ma_50
      ), grouped AS (
        SELECT
          trade_date,
          theme_code,
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE change_rate > 0)::int AS rising_count,
          ROUND((COUNT(*) FILTER (WHERE change_rate > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) AS rising_ratio,
          AVG(change_rate) AS avg_change_rate,
          COUNT(*) FILTER (WHERE change_rate >= 1)::int AS up_count,
          COUNT(*) FILTER (WHERE change_rate <= -1)::int AS down_count,
          (COUNT(*) - COUNT(*) FILTER (WHERE change_rate >= 1) - COUNT(*) FILTER (WHERE change_rate <= -1))::int AS flat_count
        FROM filtered
        GROUP BY trade_date, theme_code
      ), ranked AS (
        SELECT
          trade_date,
          theme_code,
          DENSE_RANK() OVER (PARTITION BY trade_date ORDER BY rising_ratio DESC) AS rank,
          rising_count,
          total_count,
          rising_ratio,
          avg_change_rate,
          up_count,
          flat_count,
          down_count
        FROM grouped
      )
      INSERT INTO theme_daily_snapshots (
        snapshot_id,
        theme_code,
        snapshot_date,
        rank,
        rising_count,
        total_count,
        rising_ratio,
        avg_change_rate,
        high_volume_count,
        up_count,
        flat_count,
        down_count
      )
      SELECT
        gen_random_uuid(),
        theme_code,
        trade_date,
        rank,
        rising_count,
        total_count,
        rising_ratio,
        avg_change_rate,
        0,
        up_count,
        flat_count,
        down_count
      FROM ranked
      ON CONFLICT (theme_code, snapshot_date) DO NOTHING
      RETURNING snapshot_date, theme_code
      `,
      normalizedDays,
    );

    const dateRows = await this.prisma.$queryRawUnsafe<{ snapshot_date: Date; count: number }[]>(
      `
      SELECT snapshot_date, COUNT(*)::int AS count
      FROM theme_daily_snapshots
      GROUP BY snapshot_date
      ORDER BY snapshot_date DESC
      LIMIT $1
      `,
      normalizedDays,
    );

    return {
      days: normalizedDays,
      inserted: inserted.length,
      snapshotDates: dateRows.map((row) => ({
        date: row.snapshot_date.toISOString().slice(0, 10),
        count: row.count,
      })),
    };
  }

  /** 거래대금 스냅샷 저장 (10분 단위 호출) */
  @Cron('*/10 9-15 * * 1-5', { timeZone: 'Asia/Seoul' })
  async saveTradingValueSnapshot() {
    const snapshotTime = this.getCurrentSnapshotTime();
    const kstNow = this.getKstNow();
    const snapshotDate = new Date(Date.UTC(
      kstNow.getUTCFullYear(),
      kstNow.getUTCMonth(),
      kstNow.getUTCDate(),
    ));

    const allPrices = this.realtimeCache.getAllPrices();
    const snapshots: any[] = [];

    for (const [stockCode, price] of allPrices) {
      if (price.accAmount > 0) {
        snapshots.push({
          stockCode,
          snapshotDate,
          snapshotTime,
          accTradingValue: BigInt(Math.round(price.accAmount)),
        });
      }
    }

    if (snapshots.length === 0) return { saved: 0, time: snapshotTime };

    await this.prisma.stockTradingValueSnapshot.createMany({
      data: snapshots,
      skipDuplicates: true,
    });

    this.logger.log(`Trading value snapshot saved: ${snapshots.length} stocks at ${snapshotTime}`);
    return { saved: snapshots.length, time: snapshotTime };
  }

  // ─── 테마 동기화 ──────────────────────────────────────────────────

  /**
   * 키움 API 종목 리스트의 upName → themes 테이블 + company.theme_code 동기화
   * 최초 1회 또는 테마 데이터 갱신 시 수동 호출
   */
  async syncThemes(): Promise<{ themesCreated: number; companiesUpdated: number }> {
    this.logger.log('Starting theme sync from Kiwoom stock list...');

    // KOSPI + KOSDAQ 종목 리스트 조회 (upName 포함)
    const [kospiResult, kosdaqResult] = await Promise.all([
      this.kiwoomRest.getStockList('0'),
      this.kiwoomRest.getStockList('10'),
    ]);
    const allStocks = [
      ...kospiResult.list.filter((s) => s.code?.match(/^\d{6}$/)),
      ...kosdaqResult.list.filter((s) => s.code?.match(/^\d{6}$/)),
    ];
    this.logger.log(`Fetched ${allStocks.length} stocks from Kiwoom`);

    // 기존 테마 조회
    const existingThemes = await this.prisma.theme.findMany({ where: { deletedAt: null } });
    const themeNameToCode = new Map<string, number>(existingThemes.map((t) => [t.themeName, t.themeCode]));
    const maxCode = existingThemes.reduce((max, t) => Math.max(max, t.themeCode), 0);
    let nextCode = maxCode + 1;

    // 신규 upName → theme 생성
    const newThemes: { themeCode: number; themeName: string }[] = [];
    for (const stock of allStocks) {
      if (!stock.upName || themeNameToCode.has(stock.upName)) continue;
      themeNameToCode.set(stock.upName, nextCode);
      newThemes.push({ themeCode: nextCode, themeName: stock.upName });
      nextCode++;
    }

    if (newThemes.length > 0) {
      await this.prisma.theme.createMany({ data: newThemes, skipDuplicates: true });
      this.logger.log(`Created ${newThemes.length} new themes`);
    }

    // company.theme_code 업데이트 (배치)
    let companiesUpdated = 0;
    for (const stock of allStocks) {
      if (!stock.upName) continue;
      const themeCode = themeNameToCode.get(stock.upName);
      if (!themeCode) continue;
      const result = await this.prisma.company.updateMany({
        where: { stockCode: stock.code, deletedAt: null },
        data: { themeCode },
      });
      companiesUpdated += result.count;
    }

    this.logger.log(`Theme sync done: ${newThemes.length} themes created, ${companiesUpdated} companies updated`);
    return { themesCreated: newThemes.length, companiesUpdated };
  }
}
