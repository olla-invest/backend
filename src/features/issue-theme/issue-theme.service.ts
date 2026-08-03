import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePrice, RealtimePriceCacheService } from '../real-time-chart/realtime-price-cache.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';
import { ThemeMetricsService } from './theme-metrics.service';
import {
  IssueThemeFilter,
  IssueThemeListQueryDto,
  IssueThemeSort,
  IssueThemeView,
} from './dto/issue-theme-list-query.dto';
import { IssueThemeDetailQueryDto, IssueThemeStockSort } from './dto/issue-theme-detail-query.dto';
import { ThemeAiSummaryService } from './theme-ai-summary.service';

interface TradingValueChange {
  label: string;
  ratio: number | null;
  currentAccTradingValue: number | null;
  prevSameTimeAccTradingValue: number | null;
}

interface NaverThemeStock {
  name?: string;
  code?: string;
  price?: string;
}

interface NaverThemeItem {
  theme_no?: string;
  theme?: string;
  stocks?: NaverThemeStock[];
}

interface GroupingThemeItem {
  group_id: number;
  group_name: string;
  themes: string[];
}

interface GroupedThemeDefinition {
  groupId: number;
  themeCode: number;
  groupName: string;
  themeNames: Set<string>;
}

@Injectable()
export class IssueThemeService {
  private readonly logger = new Logger(IssueThemeService.name);
  private readonly minPrevTradingValueForRatio = 0;
  private readonly naverThemeSource = 'NAVER';
  private readonly groupedThemeSource = 'GROUP';
  private readonly naverThemeCodeOffset = 100000;
  private readonly groupThemeCodeOffset = 200000;
  private groupedThemeCache: Promise<GroupedThemeDefinition[]> | null = null;

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private getGroupThemeCode(groupId: number): number {
    return this.groupThemeCodeOffset + groupId;
  }

  private getGroupIdFromThemeCode(themeCode: number): number {
    return themeCode - this.groupThemeCodeOffset;
  }

  private isGroupedThemeCode(themeCode: number): boolean {
    return themeCode >= this.groupThemeCodeOffset;
  }

  private getGroupingThemePath(filePath?: string): string {
    return filePath || process.env.GROUPING_THEME_PATH || 'C:\\Users\\user\\Downloads\\theme_crawler\\grouping_theme.json';
  }

  private async getGroupedThemeDefinitions(): Promise<GroupedThemeDefinition[]> {
    if (!this.groupedThemeCache) {
      this.groupedThemeCache = (async () => {
        const resolvedPath = this.getGroupingThemePath();
        const parsed = JSON.parse(await readFile(resolvedPath, 'utf8')) as GroupingThemeItem[];
        if (!Array.isArray(parsed)) throw new Error('Grouping theme file must be a JSON array');

        return parsed
          .filter((item) => Number.isFinite(item.group_id) && item.group_name && Array.isArray(item.themes))
          .map((item) => ({
            groupId: item.group_id,
            themeCode: this.getGroupThemeCode(item.group_id),
            groupName: item.group_name,
            themeNames: new Set(item.themes),
          }));
      })();
    }
    return this.groupedThemeCache;
  }

  private async getGroupedThemeStockCounts(themeCodes: number[]): Promise<Map<number, number>> {
    const groupedCodes = themeCodes.filter((themeCode) => this.isGroupedThemeCode(themeCode));
    const result = new Map<number, number>();
    if (groupedCodes.length === 0) return result;

    const mappingRows = await this.prisma.themeGroupTheme.findMany({
      where: {
        groupThemeCode: { in: groupedCodes },
        theme: { source: this.naverThemeSource, deletedAt: null },
      },
      select: { groupThemeCode: true, themeCode: true },
    });

    if (mappingRows.length > 0) {
      const childThemeCodes = [...new Set(mappingRows.map((row) => row.themeCode))];
      const stockThemeRows = await this.prisma.stockTheme.findMany({
        where: {
          source: this.naverThemeSource,
          themeCode: { in: childThemeCodes },
        },
        select: { themeCode: true, stockCode: true },
      });
      const childThemeCodeToGroupCodes = new Map<number, number[]>();
      for (const row of mappingRows) {
        const groupCodes = childThemeCodeToGroupCodes.get(row.themeCode) ?? [];
        groupCodes.push(row.groupThemeCode);
        childThemeCodeToGroupCodes.set(row.themeCode, groupCodes);
      }
      const stocksByGroup = new Map<number, Set<string>>();
      for (const row of stockThemeRows) {
        const groupCodes = childThemeCodeToGroupCodes.get(row.themeCode) ?? [];
        for (const groupCode of groupCodes) {
          if (!stocksByGroup.has(groupCode)) stocksByGroup.set(groupCode, new Set<string>());
          stocksByGroup.get(groupCode)!.add(row.stockCode);
        }
      }
      for (const themeCode of groupedCodes) result.set(themeCode, stocksByGroup.get(themeCode)?.size ?? 0);
      return result;
    }

    const groupedThemes = await this.getGroupedThemeDefinitions();
    const groupsByCode = new Map(groupedThemes.map((group) => [group.themeCode, group]));
    const themeNames = new Set<string>();
    for (const themeCode of groupedCodes) {
      const group = groupsByCode.get(themeCode);
      if (!group) continue;
      for (const themeName of group.themeNames) themeNames.add(themeName);
    }
    if (themeNames.size === 0) return result;

    const childThemes = await this.prisma.theme.findMany({
      where: { source: this.naverThemeSource, themeName: { in: Array.from(themeNames) }, deletedAt: null },
      select: { themeCode: true, themeName: true },
    });
    const childThemeNameByCode = new Map(childThemes.map((theme) => [theme.themeCode, theme.themeName]));
    const stockThemeRows = await this.prisma.stockTheme.findMany({
      where: { source: this.naverThemeSource, themeCode: { in: childThemes.map((theme) => theme.themeCode) } },
      select: { themeCode: true, stockCode: true },
    });

    for (const themeCode of groupedCodes) {
      const group = groupsByCode.get(themeCode);
      if (!group) continue;
      const stockCodes = new Set<string>();
      for (const row of stockThemeRows) {
        const themeName = childThemeNameByCode.get(row.themeCode);
        if (themeName && group.themeNames.has(themeName)) stockCodes.add(row.stockCode);
      }
      result.set(themeCode, stockCodes.size);
    }
    return result;
  }

  private getStockPriceSnapshot(m: any, rt?: RealtimePrice) {
    const hasRealtimePrice = rt != null && rt.currentPrice > 0;
    const currentPrice = hasRealtimePrice ? rt.currentPrice : Number(m.closePrice);
    const realtimeOpenPrice = rt != null && rt.openPrice > 0 ? rt.openPrice : null;
    const changeRate = realtimeOpenPrice != null
      ? ((currentPrice - realtimeOpenPrice) / realtimeOpenPrice) * 100
      : m.priceChangeRate1d != null
        ? Number(m.priceChangeRate1d)
        : null;
    const priceChange1d = realtimeOpenPrice != null
      ? currentPrice - realtimeOpenPrice
      : m.priceChange1d != null
        ? Number(m.priceChange1d)
        : null;

    return {
      currentPrice,
      closePrice: currentPrice,
      changeRate: changeRate ?? 0,
      priceChange1d,
      priceChangeRate1d: changeRate,
      priceSource: rt != null ? 'REALTIME_CACHE' : 'DB',
    };
  }

  private getOpenToCurrentChangeRate(m: any, rt?: RealtimePrice): number {
    return this.getStockPriceSnapshot(m, rt).changeRate;
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly kiwoomRest: KiwoomRestService,
    private readonly themeMetrics: ThemeMetricsService,
    private readonly themeAiSummary: ThemeAiSummaryService,
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

  private getKstDateKey(date: Date): string {
    return new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  private getActiveRealtimePrice(prices: Map<string, RealtimePrice>, stockCode: string): RealtimePrice | undefined {
    const rt = prices.get(stockCode);
    if (!rt || !this.isMarketOpenNow()) return undefined;
    if (this.getKstDateKey(rt.timestamp) !== this.getKstDateKey(new Date())) return undefined;
    if (Date.now() - rt.timestamp.getTime() > 10 * 60 * 1000) return undefined;
    return rt;
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

  // ─── 공통 데이터 로더 ─────────────────────────────────────────────

  /** 최신 거래일 기준 RS 점수가 있는 종목 조회 */
  private async getFilteredMetrics() {
    const latest = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (!latest) return { tradeDate: null, metrics: [] };

    const measurableMetrics = await this.prisma.stockDailyMetrics.findMany({
      where: { tradeDate: latest.tradeDate, relativeStrengthScore: { not: null } },
    });
    return { tradeDate: latest.tradeDate, metrics: measurableMetrics };
  }

  private async getStockShortTermRs(stockCodes: string[], tradeDate: Date) {
    const result = new Map<string, number | null>(stockCodes.map((stockCode) => [stockCode, null]));
    if (stockCodes.length === 0) return result;

    const recentDates = await this.prisma.stockDailyMetrics.findMany({
      where: { tradeDate: { lte: tradeDate } },
      select: { tradeDate: true },
      distinct: ['tradeDate'],
      orderBy: { tradeDate: 'desc' },
      take: 3,
    });
    if (recentDates.length < 3) return result;

    const dateKeys = new Set(recentDates.map((row) => row.tradeDate.toISOString().slice(0, 10)));
    const rows = await this.prisma.stockDailyMetrics.findMany({
      where: {
        stockCode: { in: stockCodes },
        tradeDate: { in: recentDates.map((row) => row.tradeDate) },
      },
      select: { stockCode: true, tradeDate: true, relativeStrengthScore: true },
    });
    const scoresByStock = new Map<string, Map<string, number>>();
    for (const row of rows) {
      const dateKey = row.tradeDate.toISOString().slice(0, 10);
      if (!dateKeys.has(dateKey)) continue;
      const scores = scoresByStock.get(row.stockCode) ?? new Map<string, number>();
      scores.set(dateKey, Number(row.relativeStrengthScore));
      scoresByStock.set(row.stockCode, scores);
    }
    for (const stockCode of stockCodes) {
      const scores = scoresByStock.get(stockCode);
      if (!scores || scores.size !== recentDates.length) continue;
      result.set(
        stockCode,
        this.round2([...scores.values()].reduce((sum, score) => sum + score, 0) / recentDates.length),
      );
    }
    return result;
  }

  // ─── 이슈테마 목록 ────────────────────────────────────────────────

  async getThemeList(query: IssueThemeListQueryDto, userId?: string) {
    const { display, page } = query;
    const search = query.search?.trim() ?? '';
    if (query.favoritesOnly && !userId) throw new UnauthorizedException('관심테마 조회에는 로그인이 필요합니다');
    if (query.view === IssueThemeView.HEATMAP && search) {
      throw new BadRequestException('히트맵 보기에서는 테마 검색을 사용할 수 없습니다');
    }

    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) {
      return {
        updatedAt: null,
        items: [],
        filterCounts: { all: 0, rs80: 0, momentum: 0, stockCount5: 0, changeRate5: 0, hasNewHigh: 0 },
        pagination: { page, display, total: 0, totalPages: 0 },
      };
    }

    const stockCodes = metrics.map((m) => m.stockCode);

    const stockThemeRows = await this.prisma.stockTheme.findMany({
      where: { stockCode: { in: stockCodes }, source: this.naverThemeSource, theme: { deletedAt: null } },
      select: { stockCode: true, stockName: true, themeCode: true, theme: { select: { themeName: true } } },
    });
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));
    // 실시간 등락률
    const prices = this.realtimeCache.getPrices(stockCodes);

    const themeGroups = new Map<number, {
      themeName: string;
      stocks: any[];
    }>();

    for (const row of stockThemeRows) {
      const m = metricsMap.get(row.stockCode);
      if (!m) continue;
      const themeCode = row.themeCode;
      if (!themeGroups.has(themeCode)) {
        themeGroups.set(themeCode, {
          themeName: row.theme.themeName,
          stocks: [],
        });
      }
      const currentGroup = themeGroups.get(themeCode)!;
      if (currentGroup.stocks.some((stock) => stock.stockCode === row.stockCode)) continue;
      const rt = this.getActiveRealtimePrice(prices, row.stockCode);
      const changeRate = this.getOpenToCurrentChangeRate(m, rt);
      currentGroup.stocks.push({
        stockCode: row.stockCode,
        stockName: row.stockName,
        rsScore: Number(m.relativeStrengthScore),
        changeRate,
        isNewHigh: Boolean(m.isNewHigh),
      });
    }

    const themeCodes = [...themeGroups.keys()];
    const snapshots = themeCodes.length > 0
      ? await this.prisma.themeDailySnapshot.findMany({
      where: { themeCode: { in: themeCodes }, snapshotDate: { lte: tradeDate } },
      orderBy: { snapshotDate: 'desc' },
      })
      : [];
    const snapshotMap = new Map<number, any>();
    for (const snapshot of snapshots) if (!snapshotMap.has(snapshot.themeCode)) snapshotMap.set(snapshot.themeCode, snapshot);

    let items = [...themeGroups.entries()].map(([themeCode, group]) => {
      const metric = this.themeMetrics.calculateDailyMetric(group.stocks, []);
      const snapshot = snapshotMap.get(themeCode);
      const streakBadge = snapshot?.streakDirection
        ? this.themeMetrics.calculateStreak(Number(snapshot.avgChangeRate), {
            direction: snapshot.streakDirection,
            days: Math.max(0, snapshot.streakDays - 1),
          })
        : null;
      return {
        rank: null as number | null,
        previousRank: snapshot?.rank ?? null,
        rankChange: null as number | null,
        themeCode,
        themeName: group.themeName,
        rsScore: metric.rsScore,
        avgRsScore: metric.rsScore,
        shortTermRs: snapshot?.shortTermRs != null ? Number(snapshot.shortTermRs) : metric.shortTermRs,
        momentum: snapshot?.momentum != null ? Number(snapshot.momentum) : metric.momentum,
        changeRate: metric.changeRate,
        avgChangeRate: metric.changeRate,
        stockCount: metric.stockCount,
        totalCount: metric.eligibleStockCount,
        eligibleStockCount: metric.eligibleStockCount,
        risingCount: metric.risingCount,
        newHighCount: metric.newHighCount,
        streakBadge: streakBadge?.tone ? streakBadge : null,
        isFavorite: false,
        topStocks: [...group.stocks]
          .sort((a, b) => b.rsScore - a.rsScore || a.stockCode.localeCompare(b.stockCode))
          .slice(0, 3)
          .map((stock) => ({ stockCode: stock.stockCode, stockName: stock.stockName })),
      };
    });

    if (search) items = items.filter((item) => item.themeName.toLocaleLowerCase('ko').includes(search.toLocaleLowerCase('ko')));

    if (userId) {
      const favorites = await this.prisma.userWatchlistTheme.findMany({ where: { userId, deletedAt: null }, select: { themeCode: true } });
      const favoriteCodes = new Set(favorites.map((favorite) => favorite.themeCode));
      items.forEach((item) => { item.isFavorite = favoriteCodes.has(item.themeCode); });
      if (query.favoritesOnly) items = items.filter((item) => item.isFavorite);
    }

    const matchesFilter = (item: any, filter: IssueThemeFilter) => {
      if (filter === IssueThemeFilter.RS80) return (item.rsScore ?? 0) >= 80;
      if (filter === IssueThemeFilter.MOMENTUM) return item.momentum != null && item.momentum > 0;
      if (filter === IssueThemeFilter.STOCK_COUNT_5) return item.stockCount >= 5;
      if (filter === IssueThemeFilter.CHANGE_RATE_5) return (item.changeRate ?? 0) >= 5;
      if (filter === IssueThemeFilter.HAS_NEW_HIGH) return item.newHighCount >= 1;
      return true;
    };
    const filterCounts = {
      all: items.length,
      rs80: items.filter((item) => matchesFilter(item, IssueThemeFilter.RS80)).length,
      momentum: items.filter((item) => matchesFilter(item, IssueThemeFilter.MOMENTUM)).length,
      stockCount5: items.filter((item) => matchesFilter(item, IssueThemeFilter.STOCK_COUNT_5)).length,
      changeRate5: items.filter((item) => matchesFilter(item, IssueThemeFilter.CHANGE_RATE_5)).length,
      hasNewHigh: items.filter((item) => matchesFilter(item, IssueThemeFilter.HAS_NEW_HIGH)).length,
    };
    items = items.filter((item) => matchesFilter(item, query.filter));

    items.sort((a, b) => {
      if (query.sort === IssueThemeSort.CHANGE_RATE) return (b.changeRate ?? -Infinity) - (a.changeRate ?? -Infinity) || (b.rsScore ?? 0) - (a.rsScore ?? 0) || a.themeCode - b.themeCode;
      if (query.sort === IssueThemeSort.PREVIOUS_RANK) return (a.previousRank ?? Infinity) - (b.previousRank ?? Infinity) || (b.rsScore ?? 0) - (a.rsScore ?? 0) || a.themeCode - b.themeCode;
      return (b.rsScore ?? 0) - (a.rsScore ?? 0) || (b.changeRate ?? 0) - (a.changeRate ?? 0) || a.themeCode - b.themeCode;
    });
    items.forEach((item, index) => {
      item.rank = index + 1;
      item.rankChange = item.previousRank != null ? item.previousRank - item.rank : null;
    });

    const total = items.length;
    return {
      items: items.slice((page - 1) * display, page * display),
      filterCounts,
      pagination: { page, display, total, totalPages: total === 0 ? 0 : Math.ceil(total / display) },
      updatedAt: new Date().toISOString(),
    };
  }

  async getCurrentThemeRankMap(themeCodes: number[]): Promise<Map<number, any>> {
    if (themeCodes.length === 0) return new Map();

    const themeCodeSet = new Set(themeCodes);
    const result = await this.getThemeList({
      view: IssueThemeView.RANK,
      filter: IssueThemeFilter.ALL,
      sort: IssueThemeSort.RS,
      favoritesOnly: false,
      display: 300,
      page: 1,
    });
    return new Map(
      result.items
        .filter((theme: any) => themeCodeSet.has(theme.themeCode))
        .map((theme: any) => [theme.themeCode, theme]),
    );
  }

  async adminListThemes(params: {
    page?: number;
    pageSize?: number;
    search?: string;
    source?: string;
    includeDeleted?: boolean;
  }) {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
    const where: any = {};

    if (!params.includeDeleted) where.deletedAt = null;
    if (params.source && params.source !== 'all') where.source = params.source;
    if (params.search?.trim()) {
      const search = params.search.trim();
      const numericCode = Number(search);
      where.OR = [
        { themeName: { contains: search, mode: 'insensitive' } },
        { sourceThemeNo: { contains: search, mode: 'insensitive' } },
      ];
      if (Number.isInteger(numericCode)) where.OR.push({ themeCode: numericCode });
    }

    const [totalCount, themes] = await Promise.all([
      this.prisma.theme.count({ where }),
      this.prisma.theme.findMany({
        where,
        orderBy: [{ source: 'asc' }, { themeCode: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          themeCode: true,
          themeName: true,
          source: true,
          sourceThemeNo: true,
          deletedAt: true,
          _count: { select: { stockThemes: true } },
        },
      }),
    ]);
    const groupedStockCounts = await this.getGroupedThemeStockCounts(
      themes.map((theme) => theme.themeCode),
    );

    return {
      themes: themes.map((theme) => ({
        themeCode: theme.themeCode,
        themeName: theme.themeName,
        source: theme.source,
        sourceThemeNo: theme.sourceThemeNo,
        stockCount: groupedStockCounts.get(theme.themeCode) ?? theme._count.stockThemes,
        status: theme.deletedAt ? 'DELETED' : 'ACTIVE',
      })),
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
    };
  }

  // ─── 테마 상세 (팝업) ─────────────────────────────────────────────

  async getThemeDetail(
    themeCode: number,
    userId?: string,
    query: IssueThemeDetailQueryDto = new IssueThemeDetailQueryDto(),
  ) {
    const isGroupedTheme = this.isGroupedThemeCode(themeCode);
    let theme: { themeName: string; imageUrl?: string | null } | null = null;
    let stockThemes: { stockCode: string; stockName: string | null; inclusionReason: string | null }[] = [];

    if (isGroupedTheme) {
      const groupId = this.getGroupIdFromThemeCode(themeCode);
      const group = (await this.getGroupedThemeDefinitions()).find((item) => item.groupId === groupId);
      if (!group) throw new NotFoundException(`Theme group ${themeCode} not found`);

      const storedGroup = await this.prisma.theme.findFirst({
        where: { themeCode, source: this.groupedThemeSource, deletedAt: null },
        select: { themeName: true, imageUrl: true },
      });
      theme = storedGroup ?? { themeName: group.groupName, imageUrl: null };
      let childThemeCodes = (await this.prisma.themeGroupTheme.findMany({
        where: {
          groupThemeCode: themeCode,
          theme: { source: this.naverThemeSource, deletedAt: null },
        },
        select: { themeCode: true },
      })).map((item) => item.themeCode);
      if (childThemeCodes.length === 0) {
        childThemeCodes = (await this.prisma.theme.findMany({
          where: { source: this.naverThemeSource, themeName: { in: Array.from(group.themeNames) }, deletedAt: null },
          select: { themeCode: true },
        })).map((item) => item.themeCode);
      }
      stockThemes = await this.prisma.stockTheme.findMany({
        where: { themeCode: { in: childThemeCodes }, source: this.naverThemeSource },
        select: { stockCode: true, stockName: true, inclusionReason: true },
      });
    } else {
      theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
      if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);

      stockThemes = await this.prisma.stockTheme.findMany({
        where: { themeCode, source: this.naverThemeSource },
        select: { stockCode: true, stockName: true, inclusionReason: true },
      });
    }

    const { tradeDate, metrics: allMetrics } = await this.getFilteredMetrics();
    if (!tradeDate) return null;
    const themeStockCodes = new Set(stockThemes.map((c) => c.stockCode));
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: Array.from(themeStockCodes) }, deletedAt: null },
      select: { stockCode: true, companyName: true },
    });
    const companyNameMap = new Map(companies.map((c) => [c.stockCode, c.companyName]));
    for (const row of stockThemes) {
      if (row.stockName && !companyNameMap.has(row.stockCode)) companyNameMap.set(row.stockCode, row.stockName);
    }
    const inclusionReasonMap = new Map(stockThemes.map((c) => [c.stockCode, c.inclusionReason]));

    const metrics = allMetrics.filter((m) => themeStockCodes.has(m.stockCode));
    const filteredCodes = metrics.map((m) => m.stockCode);
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));

    const prices = this.realtimeCache.getPrices(filteredCodes);

    // 거래대금 변화는 팝업 로딩 중 키움 API를 호출하지 않고 캐시/DB 스냅샷으로 계산한다.
    const tradingValueChangeMap = await this.getLiveTradingValueChanges(
      filteredCodes,
      prices,
      metricsMap,
      tradeDate,
    );
    const stockShortTermRs = await this.getStockShortTermRs(filteredCodes, tradeDate);

    // 등락률/거래대금 집계
    const changeRates: number[] = [];
    const rsScores: number[] = [];
    let highVolumeCount = 0;

    const stockRows = filteredCodes.map((code) => {
      const m = metricsMap.get(code)!;
      const rt = this.getActiveRealtimePrice(prices, code);
      const priceSnapshot = this.getStockPriceSnapshot(m, rt);
      const changeRate = priceSnapshot.changeRate;

      changeRates.push(changeRate);
      rsScores.push(Number(m.relativeStrengthScore));

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
        inclusionReason: inclusionReasonMap.get(code) ?? null,
        currentPrice: priceSnapshot.currentPrice,
        closePrice: priceSnapshot.closePrice,
        changeRate: priceSnapshot.changeRate,
        priceChange1d: priceSnapshot.priceChange1d,
        priceChangeRate1d: priceSnapshot.priceChangeRate1d,
        priceSource: priceSnapshot.priceSource,
        rsScore: Number(m.relativeStrengthScore),
        shortTermRs: stockShortTermRs.get(code) ?? null,
        tradingValue: m.tradingValue != null ? m.tradingValue.toString() : null,
        previousTradingValueRatio: tradingValueChange.ratio,
        isNewHigh: Boolean(m.isNewHigh),
        newHighRate: m.highPrice52w != null && Number(m.highPrice52w) > 0
          ? this.round2(((priceSnapshot.currentPrice - Number(m.highPrice52w)) / Number(m.highPrice52w)) * 100)
          : null,
        tradingValueRatio: tradingValueChange.label,
        tradingValueChange: tradingValueChange.label,
        currentAccTradingValue: tradingValueChange.currentAccTradingValue,
        prevSameTimeAccTradingValue: tradingValueChange.prevSameTimeAccTradingValue,
      };
    });

    const nullableDesc = (a: number | null, b: number | null) =>
      a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : b - a;
    stockRows.sort((a, b) => {
      if (query.stockSort === IssueThemeStockSort.SHORT_TERM_RS) return nullableDesc(a.shortTermRs, b.shortTermRs) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.CHANGE_RATE) return nullableDesc(a.changeRate, b.changeRate) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.TRADING_VALUE) return nullableDesc(a.currentAccTradingValue, b.currentAccTradingValue) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.PREVIOUS_RATIO) return nullableDesc(a.previousTradingValueRatio, b.previousTradingValueRatio) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.NEW_HIGH) return nullableDesc(a.newHighRate, b.newHighRate) || a.stockCode.localeCompare(b.stockCode);
      return b.rsScore - a.rsScore || a.stockCode.localeCompare(b.stockCode);
    });
    stockRows.forEach((r: any, i) => { r.rank = i + 1; });
    const displayedStockRows = stockRows.slice(0, query.stockDisplay);

    // 인사이트 계산
    const totalCount = filteredCodes.length;
    const risingCount = changeRates.filter((r) => r > 0).length;
    const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
    const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
    const avgRsScore = rsScores.reduce((a, b) => a + b, 0) / (rsScores.length || 1);

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

    // 현재 순위는 이슈테마 목록의 런타임 계산값을 사용하고, 스냅샷은 이전 순위 비교에만 사용한다.
    const currentTheme = (await this.getCurrentThemeRankMap([themeCode])).get(themeCode);
    const currentRank = currentTheme?.rank ?? null;
    const rankChange =
      currentRank != null && prevSnapshot ? prevSnapshot.rank - currentRank : null;

    let isFavorite: boolean | null = null;
    if (userId) {
      const favorite = await this.prisma.userWatchlistTheme.findFirst({
        where: { userId, themeCode, deletedAt: null },
      });
      isFavorite = favorite != null;
    }

    const [aiSummaryRecord, relatedThemes] = await Promise.all([
      this.themeAiSummary.getLatestSuccess(themeCode),
      this.getRelatedThemes(themeCode),
    ]);

    return {
      themeCode,
      themeName: theme.themeName,
      imageUrl: theme.imageUrl ?? null,
      rank: currentRank,
      rankChange,
      risingCount,
      totalCount,
      avgRsScore: this.round2(avgRsScore),
      rsScore: currentTheme?.rsScore ?? this.round2(avgRsScore),
      shortTermRs: currentTheme?.shortTermRs ?? null,
      momentum: currentTheme?.momentum ?? null,
      changeRate: currentTheme?.changeRate ?? this.round2(avgChangeRate),
      newHighCount: currentTheme?.newHighCount ?? stockRows.filter((stock) => stock.isNewHigh).length,
      streakBadge: currentTheme?.streakBadge ?? null,
      insights,
      isFavorite,
      stocks: displayedStockRows,
      relatedThemes,
      aiSummary: aiSummaryRecord?.summary ?? null,
      aiSummaryUpdatedAt: aiSummaryRecord?.generatedAt?.toISOString() ?? null,
      aiSummarySources: Array.isArray(aiSummaryRecord?.sourceArticles) ? aiSummaryRecord.sourceArticles : [],
      updatedAt: new Date().toISOString(),
    };
  }

  private async getRelatedThemes(themeCode: number) {
    const { metrics } = await this.getFilteredMetrics();
    const eligibleMetrics = metrics.filter((metric) => Number(metric.relativeStrengthScore) >= 80);
    const stockCodes = eligibleMetrics.map((metric) => metric.stockCode);
    if (stockCodes.length === 0) return [];
    const rows = await this.prisma.stockTheme.findMany({
      where: { stockCode: { in: stockCodes }, source: this.naverThemeSource, theme: { deletedAt: null } },
      select: { themeCode: true, stockCode: true, theme: { select: { themeName: true } } },
    });
    const groups = new Map<number, { themeName: string; stockCodes: string[] }>();
    for (const row of rows) {
      const group = groups.get(row.themeCode) ?? { themeName: row.theme.themeName, stockCodes: [] };
      if (!group.stockCodes.includes(row.stockCode)) group.stockCodes.push(row.stockCode);
      groups.set(row.themeCode, group);
    }
    const list = await this.getThemeList({
      view: IssueThemeView.RANK,
      filter: IssueThemeFilter.ALL,
      sort: IssueThemeSort.RS,
      favoritesOnly: false,
      display: 300,
      page: 1,
    });
    const itemMap = new Map(list.items.map((item) => [item.themeCode, item]));
    const currentGroup = groups.get(themeCode);
    if (!currentGroup) return [];
    return this.themeMetrics.calculateRelatedThemes(
      {
        themeCode,
        rsScore: itemMap.get(themeCode)?.rsScore ?? 0,
        stockCodes: currentGroup.stockCodes,
      },
      [...groups.entries()].map(([candidateCode, group]) => ({
        themeCode: candidateCode,
        themeName: group.themeName,
        rsScore: itemMap.get(candidateCode)?.rsScore ?? 0,
        changeRate: itemMap.get(candidateCode)?.changeRate ?? 0,
        stockCodes: group.stockCodes,
      })),
    );
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
    const stockThemeRows = await this.prisma.stockTheme.findMany({
      where: { stockCode: { in: stockCodes }, source: this.naverThemeSource, theme: { deletedAt: null } },
      select: { stockCode: true, themeCode: true },
    });
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));

    const prices = this.realtimeCache.getPrices(stockCodes);
    const themeGroups = new Map<number, { stockCodes: Set<string>; changeRates: number[]; rsScores: number[]; newHighCount: number }>();

    for (const row of stockThemeRows) {
      const m = metricsMap.get(row.stockCode);
      if (!m) continue;
      if (Number(m.relativeStrengthScore) < 80) continue;
      const themeCode = row.themeCode;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { stockCodes: new Set(), changeRates: [], rsScores: [], newHighCount: 0 });
      const currentGroup = themeGroups.get(themeCode)!;
      if (currentGroup.stockCodes.has(row.stockCode)) continue;
      currentGroup.stockCodes.add(row.stockCode);
      const rt = this.getActiveRealtimePrice(prices, row.stockCode);
      const changeRate = this.getOpenToCurrentChangeRate(m, rt);
      currentGroup.changeRates.push(changeRate);
      currentGroup.rsScores.push(Number(m.relativeStrengthScore));
      if (m.isNewHigh) currentGroup.newHighCount++;
    }

    // 순위 산출
    const themeList: any[] = [];
    for (const [themeCode, { changeRates, rsScores, newHighCount }] of themeGroups) {
      const totalCount = changeRates.length;
      if (totalCount < 2) continue;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      const avgRsScore = rsScores.reduce((a, b) => a + b, 0) / (rsScores.length || 1);
      const themeScore = this.round2(avgChangeRate);
      const upCount = changeRates.filter((r) => r >= 1).length;
      const downCount = changeRates.filter((r) => r <= -1).length;
      const flatCount = totalCount - upCount - downCount;
      themeList.push({ themeCode, totalCount, risingCount, risingRatio, avgChangeRate, avgRsScore, themeScore, upCount, flatCount, downCount, newHighCount });
    }

    themeList.sort((a, b) =>
      b.risingRatio - a.risingRatio ||
      b.themeCode - a.themeCode,
    );
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (
        i > 0 &&
        themeList[i].risingRatio === themeList[i - 1].risingRatio
      ) {
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

    const priorSnapshots = themeList.length > 0
      ? await this.prisma.themeDailySnapshot.findMany({
          where: { themeCode: { in: themeList.map((theme) => theme.themeCode) }, snapshotDate: { lt: snapshotDate } },
          orderBy: [{ themeCode: 'asc' }, { snapshotDate: 'desc' }],
        })
      : [];
    const historyByTheme = new Map<number, any[]>();
    for (const snapshot of priorSnapshots) {
      const history = historyByTheme.get(snapshot.themeCode) ?? [];
      if (history.length < 62) history.push(snapshot);
      historyByTheme.set(snapshot.themeCode, history);
    }

    for (const theme of themeList) {
      const history = historyByTheme.get(theme.themeCode) ?? [];
      const rsHistory = [
        ...history.map((snapshot) => ({
          tradeDate: snapshot.snapshotDate.toISOString().slice(0, 10),
          avgRsScore: Number(snapshot.avgRsScore),
        })).reverse(),
        { tradeDate: snapshotDate.toISOString().slice(0, 10), avgRsScore: theme.avgRsScore },
      ];
      const metric = this.themeMetrics.calculateDailyMetric(
        [{ stockCode: 'THEME-A', rsScore: theme.avgRsScore, changeRate: theme.avgChangeRate, isNewHigh: false },
         { stockCode: 'THEME-B', rsScore: theme.avgRsScore, changeRate: theme.avgChangeRate, isNewHigh: false }],
        rsHistory,
      );
      const previous = history[0];
      const streak = this.themeMetrics.calculateStreak(theme.avgChangeRate, previous ? {
        direction: previous.streakDirection ?? 'NEUTRAL',
        days: previous.streakDays ?? 0,
      } : null);
      theme.shortTermRs = metric.shortTermRs;
      theme.momentum = metric.momentum;
      theme.streakDirection = streak.direction;
      theme.streakDays = streak.days;
    }

    await this.prisma.themeDailySnapshot.deleteMany({
      where: { snapshotDate },
    });

    await this.prisma.themeDailySnapshot.createMany({
      data: themeList.map((t) => ({
        themeCode: t.themeCode,
        snapshotDate,
        rank: t.rank,
        risingCount: t.risingCount,
        totalCount: t.totalCount,
        risingRatio: t.risingRatio,
        avgChangeRate: t.avgChangeRate,
        avgRsScore: t.avgRsScore,
        themeScore: t.themeScore,
        highVolumeCount: 0,
        upCount: t.upCount,
        flatCount: t.flatCount,
        downCount: t.downCount,
        shortTermRs: t.shortTermRs,
        momentum: t.momentum,
        newHighCount: t.newHighCount,
        streakDirection: t.streakDirection,
        streakDays: t.streakDays,
      })),
      skipDuplicates: true,
    });

    this.logger.log(`Theme snapshot saved: ${themeList.length} themes for ${snapshotDate.toISOString().split('T')[0]}`);
    void this.themeAiSummary.generateForTradeDate(
      snapshotDate,
      Number(process.env.THEME_AI_SUMMARY_LIMIT || 20),
    ).catch((error) => this.logger.error(`Theme AI summary batch failed: ${error?.message ?? error}`));
    return { saved: themeList.length, date: snapshotDate.toISOString().split('T')[0] };
  }

  async generateAiSummaries(tradeDate: Date, limit = 20) {
    return this.themeAiSummary.generateForTradeDate(this.dateOnly(tradeDate), limit);
  }

  async regenerateAiSummary(themeCode: number, tradeDate: Date) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);
    return this.themeAiSummary.generateForTradeDate(this.dateOnly(tradeDate), 1, themeCode);
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
      ), filtered_raw AS (
        SELECT DISTINCT ON (m.trade_date, st.theme_code, m.stock_code)
          m.trade_date,
          st.theme_code,
          m.stock_code,
          COALESCE(m.price_change_rate_1d, 0)::numeric AS change_rate,
          m.relative_strength_score::numeric AS rs_score,
          m.is_new_high
        FROM stock_daily_metrics m
        JOIN stock_themes st ON st.stock_code = m.stock_code
        JOIN companies co ON co.stock_code = m.stock_code
        JOIN themes t ON t.theme_code = st.theme_code
        JOIN target_dates td ON td.trade_date = m.trade_date
        WHERE st.source = 'NAVER'
          AND t.deleted_at IS NULL
          AND co.deleted_at IS NULL
          AND m.relative_strength_score >= 80
        ORDER BY m.trade_date, st.theme_code, m.stock_code
      ), filtered AS (
        SELECT
          trade_date,
          theme_code,
          change_rate,
          rs_score,
          is_new_high
        FROM filtered_raw
      ), grouped AS (
        SELECT
          trade_date,
          theme_code,
          COUNT(*)::int AS total_count,
          COUNT(*) FILTER (WHERE change_rate > 0)::int AS rising_count,
          ROUND((COUNT(*) FILTER (WHERE change_rate > 0)::numeric / NULLIF(COUNT(*), 0)) * 100, 2) AS rising_ratio,
          AVG(change_rate) AS avg_change_rate,
          AVG(rs_score) AS avg_rs_score,
          COUNT(*) FILTER (WHERE is_new_high)::int AS new_high_count,
          COUNT(*) FILTER (WHERE change_rate >= 1)::int AS up_count,
          COUNT(*) FILTER (WHERE change_rate <= -1)::int AS down_count,
          (COUNT(*) - COUNT(*) FILTER (WHERE change_rate >= 1) - COUNT(*) FILTER (WHERE change_rate <= -1))::int AS flat_count
        FROM filtered
        GROUP BY trade_date, theme_code
        HAVING COUNT(*) >= 2
      ), scored AS (
        SELECT
          trade_date,
          theme_code,
          total_count,
          rising_count,
          rising_ratio,
          avg_change_rate,
          avg_rs_score,
          CASE WHEN COUNT(*) OVER (
            PARTITION BY theme_code ORDER BY trade_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
          ) = 3 THEN AVG(avg_rs_score) OVER (
            PARTITION BY theme_code ORDER BY trade_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
          ) END AS short_term_rs,
          CASE WHEN COUNT(*) OVER (
            PARTITION BY theme_code ORDER BY trade_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
          ) = 3 THEN
            AVG(avg_rs_score) OVER (
              PARTITION BY theme_code ORDER BY trade_date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
            ) - AVG(avg_rs_score) OVER (
              PARTITION BY theme_code ORDER BY trade_date ROWS BETWEEN 62 PRECEDING AND CURRENT ROW
            )
          END AS momentum,
          new_high_count,
          ROUND(avg_change_rate, 2) AS theme_score,
          up_count,
          flat_count,
          down_count
        FROM grouped
      ), ranked AS (
        SELECT
          trade_date,
          theme_code,
          DENSE_RANK() OVER (PARTITION BY trade_date ORDER BY rising_ratio DESC) AS rank,
          rising_count,
          total_count,
          rising_ratio,
          avg_change_rate,
          avg_rs_score,
          short_term_rs,
          momentum,
          new_high_count,
          theme_score,
          up_count,
          flat_count,
          down_count
        FROM scored
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
        avg_rs_score,
        theme_score,
        high_volume_count,
        up_count,
        flat_count,
        down_count,
        short_term_rs,
        momentum,
        new_high_count
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
        avg_rs_score,
        theme_score,
        0,
        up_count,
        flat_count,
        down_count,
        short_term_rs,
        momentum,
        new_high_count
      FROM ranked
      ON CONFLICT (theme_code, snapshot_date) DO UPDATE SET
        rank = EXCLUDED.rank,
        rising_count = EXCLUDED.rising_count,
        total_count = EXCLUDED.total_count,
        rising_ratio = EXCLUDED.rising_ratio,
        avg_change_rate = EXCLUDED.avg_change_rate,
        avg_rs_score = EXCLUDED.avg_rs_score,
        theme_score = EXCLUDED.theme_score,
        high_volume_count = EXCLUDED.high_volume_count,
        up_count = EXCLUDED.up_count,
        flat_count = EXCLUDED.flat_count,
        down_count = EXCLUDED.down_count,
        short_term_rs = EXCLUDED.short_term_rs,
        momentum = EXCLUDED.momentum,
        new_high_count = EXCLUDED.new_high_count
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

  private getNaverThemeCode(themeNo: string): number {
    return this.naverThemeCodeOffset + Number(themeNo);
  }

  private normalizeInclusionReason(value?: string, stockName?: string): string | null {
    if (!value) return null;
    let reason = value.trim();
    reason = reason.replace(/^테마\s*편입\s*사유/, '').trim();
    if (stockName && reason.startsWith(stockName)) {
      reason = reason.slice(stockName.length).trim();
    }
    return reason || null;
  }

  async syncGroupedThemes(filePath?: string): Promise<{
    groupsUpserted: number;
    groupsDeleted: number;
    mappingsUpserted: number;
    missingThemeNames: number;
    sourcePath: string;
  }> {
    const resolvedPath = this.getGroupingThemePath(filePath);
    const parsed = JSON.parse(await readFile(resolvedPath, 'utf8')) as GroupingThemeItem[];
    if (!Array.isArray(parsed)) throw new Error('Grouping theme file must be a JSON array');

    const validGroups = parsed.filter((item) =>
      Number.isFinite(item.group_id) &&
      item.group_name &&
      Array.isArray(item.themes),
    );
    const activeThemeCodes = validGroups.map((item) => this.getGroupThemeCode(item.group_id));

    const result = await this.prisma.$transaction(async (tx) => {
      let mappingsUpserted = 0;
      let missingThemeNames = 0;

      for (const item of validGroups) {
        const themeCode = this.getGroupThemeCode(item.group_id);
        await tx.theme.upsert({
          where: { themeCode },
          create: {
            themeCode,
            themeName: item.group_name,
            source: this.groupedThemeSource,
            sourceThemeNo: String(item.group_id),
            deletedAt: null,
          },
          update: {
            themeName: item.group_name,
            source: this.groupedThemeSource,
            sourceThemeNo: String(item.group_id),
            deletedAt: null,
          },
        });

        const themeNames = [...new Set(item.themes.map((themeName) => themeName?.trim()).filter(Boolean))];
        const childThemes = themeNames.length > 0
          ? await tx.theme.findMany({
            where: {
              source: this.naverThemeSource,
              themeName: { in: themeNames },
              deletedAt: null,
            },
            select: { themeCode: true, themeName: true },
          })
          : [];
        const matchedThemeNames = new Set(childThemes.map((theme) => theme.themeName));
        missingThemeNames += themeNames.filter((themeName) => !matchedThemeNames.has(themeName)).length;

        await tx.themeGroupTheme.deleteMany({ where: { groupThemeCode: themeCode } });
        if (childThemes.length > 0) {
          const created = await tx.themeGroupTheme.createMany({
            data: childThemes.map((theme) => ({
              groupThemeCode: themeCode,
              themeCode: theme.themeCode,
            })),
            skipDuplicates: true,
          });
          mappingsUpserted += created.count;
        }
      }

      await tx.themeGroupTheme.deleteMany({
        where: {
          groupTheme: {
            source: this.groupedThemeSource,
            themeCode: { notIn: activeThemeCodes },
          },
        },
      });

      const deleted = await tx.theme.updateMany({
        where: {
          source: this.groupedThemeSource,
          themeCode: { notIn: activeThemeCodes },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      });

      return { groupsDeleted: deleted.count, mappingsUpserted, missingThemeNames };
    });

    this.groupedThemeCache = null;
    this.logger.log(
      `Grouped themes synced: ${validGroups.length} groups, ${result.mappingsUpserted} mappings, ${result.groupsDeleted} deleted from ${resolvedPath}`,
    );

    return {
      groupsUpserted: validGroups.length,
      groupsDeleted: result.groupsDeleted,
      mappingsUpserted: result.mappingsUpserted,
      missingThemeNames: result.missingThemeNames,
      sourcePath: resolvedPath,
    };
  }

  async syncNaverThemes(filePath?: string): Promise<{
    themesUpserted: number;
    themesDeleted: number;
    mappingsCreated: number;
    uniqueStocks: number;
  }> {
    const resolvedPath = filePath || process.env.NAVER_THEMES_FULL_PATH || 'C:\\Users\\user\\Downloads\\theme_crawler\\naver_themes_full.json';
    const parsed = JSON.parse(await readFile(resolvedPath, 'utf8')) as NaverThemeItem[];
    if (!Array.isArray(parsed)) throw new Error('Naver theme file must be a JSON array');

    const validThemes = parsed.filter((item) => item.theme_no && item.theme && Number.isFinite(Number(item.theme_no)));
    const activeThemeCodes = validThemes.map((item) => this.getNaverThemeCode(item.theme_no!));
    const uniqueStocks = new Set<string>();
    const mappings: {
      themeCode: number;
      stockCode: string;
      stockName: string | null;
      inclusionReason: string | null;
      source: string;
    }[] = [];

    for (const item of validThemes) {
      const themeCode = this.getNaverThemeCode(item.theme_no!);
      for (const stock of item.stocks ?? []) {
        if (!stock.code?.match(/^\d{6}$/)) continue;
        uniqueStocks.add(stock.code);
        mappings.push({
          themeCode,
          stockCode: stock.code,
          stockName: stock.name || null,
          inclusionReason: this.normalizeInclusionReason(stock.price, stock.name),
          source: this.naverThemeSource,
        });
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      for (const item of validThemes) {
        const themeCode = this.getNaverThemeCode(item.theme_no!);
        await tx.theme.upsert({
          where: { themeCode },
          create: {
            themeCode,
            themeName: item.theme!,
            source: this.naverThemeSource,
            sourceThemeNo: item.theme_no!,
            deletedAt: null,
          },
          update: {
            themeName: item.theme!,
            source: this.naverThemeSource,
            sourceThemeNo: item.theme_no!,
            deletedAt: null,
          },
        });
      }

      const deleted = await tx.theme.updateMany({
        where: { source: this.naverThemeSource, themeCode: { notIn: activeThemeCodes }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.stockTheme.deleteMany({ where: { source: this.naverThemeSource } });
      let mappingsCreated = 0;
      for (let i = 0; i < mappings.length; i += 1000) {
        const created = await tx.stockTheme.createMany({ data: mappings.slice(i, i + 1000), skipDuplicates: true });
        mappingsCreated += created.count;
      }

      return { themesDeleted: deleted.count, mappingsCreated };
    });

    this.logger.log(
      `Naver themes synced: ${validThemes.length} themes, ${result.mappingsCreated} mappings from ${resolvedPath}`,
    );

    return {
      themesUpserted: validThemes.length,
      themesDeleted: result.themesDeleted,
      mappingsCreated: result.mappingsCreated,
      uniqueStocks: uniqueStocks.size,
    };
  }

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
