import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePrice, RealtimePriceCacheService } from '../real-time-chart/realtime-price-cache.service';
import { KiwoomRestService } from '../../integrations/kiwoom/rest/kiwoom-rest.service';

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

  private clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
  }

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

  private calculateThemeScore(params: {
    avgRsScore: number;
    totalCount: number;
    risingRatio: number;
    avgChangeRate?: number;
    maxTotalCount?: number;
  }): number {
    const countScore = params.maxTotalCount && params.maxTotalCount > 0
      ? this.clamp((params.totalCount / params.maxTotalCount) * 100, 0, 100)
      : this.clamp((Math.log10(params.totalCount + 1) / Math.log10(21)) * 100, 0, 100);
    const rawScore =
      params.avgRsScore * 0.5 +
      countScore * 0.3 +
      params.risingRatio * 0.2;
    return this.round2(rawScore);
  }

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

  async getThemeList(display: number = 20, page: number = 1, filters: {
    minAvgRsScore?: number;
    minTotalCount?: number;
    minThemeScore?: number;
  } = {}) {
    const allNaverThemes = await this.prisma.theme.findMany({
      where: { source: this.naverThemeSource, deletedAt: null },
      select: { themeCode: true, themeName: true },
      orderBy: { themeName: 'asc' },
    });

    const { tradeDate, metrics } = await this.getFilteredMetrics();
    if (!tradeDate) {
      const themeList = allNaverThemes
        .map((theme) => ({
          themeCode: theme.themeCode,
          themeName: theme.themeName,
          totalCount: 0,
          risingCount: 0,
          risingRatio: 0,
          avgChangeRate: 0,
          avgRsScore: 0,
          themeScore: 0,
          upCount: 0,
          flatCount: 0,
          downCount: 0,
          rank: null,
          rankChange: null,
        }))
        .filter((theme) => {
          if (filters.minAvgRsScore != null && theme.avgRsScore < filters.minAvgRsScore) return false;
          if (filters.minTotalCount != null && theme.totalCount < filters.minTotalCount) return false;
          if (filters.minThemeScore != null && theme.themeScore < filters.minThemeScore) return false;
          return true;
        });
      return {
        updatedAt: null,
        total: themeList.length,
        page,
        display,
        themes: themeList.slice((page - 1) * display, page * display),
      };
    }

    const stockCodes = metrics.map((m) => m.stockCode);

    const stockThemeRows = await this.prisma.stockTheme.findMany({
      where: { stockCode: { in: stockCodes }, source: this.naverThemeSource, theme: { deletedAt: null } },
      select: { stockCode: true, themeCode: true, theme: { select: { themeName: true } } },
    });
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));
    // 실시간 등락률
    const prices = this.realtimeCache.getPrices(stockCodes);

    const themeGroups = new Map<number, {
      themeName: string;
      stockCodes: Set<string>;
      changeRates: number[];
      rsScores: number[];
    }>();

    for (const theme of allNaverThemes) {
      themeGroups.set(theme.themeCode, {
        themeName: theme.themeName,
        stockCodes: new Set<string>(),
        changeRates: [],
        rsScores: [],
      });
    }

    for (const row of stockThemeRows) {
      const m = metricsMap.get(row.stockCode);
      if (!m) continue;
      const themeCode = row.themeCode;
      if (!themeGroups.has(themeCode)) {
        themeGroups.set(themeCode, {
          themeName: row.theme.themeName,
          stockCodes: new Set<string>(),
          changeRates: [],
          rsScores: [],
        });
      }
      const currentGroup = themeGroups.get(themeCode)!;
      if (currentGroup.stockCodes.has(row.stockCode)) continue;
      currentGroup.stockCodes.add(row.stockCode);
      const rt = this.getActiveRealtimePrice(prices, row.stockCode);
      const changeRate = this.getOpenToCurrentChangeRate(m, rt);
      currentGroup.changeRates.push(changeRate);
      currentGroup.rsScores.push(Number(m.relativeStrengthScore));
    }

    // 상승비율 계산
    const themeList: any[] = [];
    const maxTotalCount = Math.max(...Array.from(themeGroups.values()).map((group) => group.changeRates.length), 0);
    for (const [themeCode, { themeName, changeRates, rsScores }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      const avgRsScore = rsScores.reduce((a, b) => a + b, 0) / (rsScores.length || 1);
      const themeScore = this.calculateThemeScore({ avgRsScore, totalCount, risingRatio, maxTotalCount });
      const upCount = changeRates.filter((r) => r >= 1).length;
      const downCount = changeRates.filter((r) => r <= -1).length;
      const flatCount = totalCount - upCount - downCount;
      if (filters.minAvgRsScore != null && avgRsScore < filters.minAvgRsScore) continue;
      if (filters.minTotalCount != null && totalCount < filters.minTotalCount) continue;
      if (filters.minThemeScore != null && themeScore < filters.minThemeScore) continue;
      themeList.push({ themeCode, themeName, totalCount, risingCount, risingRatio: this.round2(risingRatio), avgChangeRate: this.round2(avgChangeRate), avgRsScore: this.round2(avgRsScore), themeScore, upCount, flatCount, downCount });
    }

    // 순위 산출 (평균 RS 50%, 집계 종목수 30%, 상승률 20%)
    themeList.sort((a, b) =>
      b.themeScore - a.themeScore ||
      b.avgRsScore - a.avgRsScore ||
      b.totalCount - a.totalCount ||
      a.themeName.localeCompare(b.themeName, 'ko'),
    );
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (
        i > 0 &&
        themeList[i].themeScore === themeList[i - 1].themeScore
      ) {
        themeList[i].rank = themeList[i - 1].rank;
      } else {
        themeList[i].rank = rank;
        rank++;
      }
    }

    // 순위변동
    for (const t of themeList) {
      t.rankChange = null;
    }

    const total = themeList.length;
    const paged = themeList.slice((page - 1) * display, page * display);

    return { updatedAt: new Date().toISOString(), total, page, display, themes: paged };
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

  async getThemeDetail(themeCode: number, userId?: string) {
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
    const avgRsScore = rsScores.reduce((a, b) => a + b, 0) / (rsScores.length || 1);
    const themeScore = this.round2(risingRatio);

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
      avgRsScore: this.round2(avgRsScore),
      themeScore,
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
    const stockThemeRows = await this.prisma.stockTheme.findMany({
      where: { stockCode: { in: stockCodes }, source: this.naverThemeSource, theme: { deletedAt: null } },
      select: { stockCode: true, themeCode: true },
    });
    const metricsMap = new Map(metrics.map((m) => [m.stockCode, m]));

    const prices = this.realtimeCache.getPrices(stockCodes);
    const themeGroups = new Map<number, { changeRates: number[]; rsScores: number[] }>();

    for (const row of stockThemeRows) {
      const m = metricsMap.get(row.stockCode);
      if (!m) continue;
      const themeCode = row.themeCode;
      if (!themeGroups.has(themeCode)) themeGroups.set(themeCode, { changeRates: [], rsScores: [] });
      const rt = this.getActiveRealtimePrice(prices, row.stockCode);
      const changeRate = this.getOpenToCurrentChangeRate(m, rt);
      themeGroups.get(themeCode)!.changeRates.push(changeRate);
      themeGroups.get(themeCode)!.rsScores.push(Number(m.relativeStrengthScore));
    }

    // 순위 산출
    const themeList: any[] = [];
    for (const [themeCode, { changeRates, rsScores }] of themeGroups) {
      const totalCount = changeRates.length;
      const risingCount = changeRates.filter((r) => r > 0).length;
      const risingRatio = totalCount > 0 ? (risingCount / totalCount) * 100 : 0;
      const avgChangeRate = changeRates.reduce((a, b) => a + b, 0) / (changeRates.length || 1);
      const avgRsScore = rsScores.reduce((a, b) => a + b, 0) / (rsScores.length || 1);
      const themeScore = this.calculateThemeScore({ avgRsScore, totalCount, risingRatio, avgChangeRate });
      const upCount = changeRates.filter((r) => r >= 1).length;
      const downCount = changeRates.filter((r) => r <= -1).length;
      const flatCount = totalCount - upCount - downCount;
      themeList.push({ themeCode, totalCount, risingCount, risingRatio, avgChangeRate, avgRsScore, themeScore, upCount, flatCount, downCount });
    }

    themeList.sort((a, b) =>
      b.themeScore - a.themeScore ||
      b.avgRsScore - a.avgRsScore ||
      b.risingRatio - a.risingRatio ||
      b.avgChangeRate - a.avgChangeRate ||
      b.totalCount - a.totalCount,
    );
    let rank = 1;
    for (let i = 0; i < themeList.length; i++) {
      if (
        i > 0 &&
        themeList[i].themeScore === themeList[i - 1].themeScore &&
        themeList[i].avgRsScore === themeList[i - 1].avgRsScore &&
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
          st.theme_code,
          COALESCE(m.price_change_rate_1d, 0)::numeric AS change_rate,
          m.relative_strength_score::numeric AS rs_score
        FROM stock_daily_metrics m
        JOIN stock_themes st ON st.stock_code = m.stock_code
        JOIN companies co ON co.stock_code = m.stock_code
        JOIN themes t ON t.theme_code = st.theme_code
        JOIN target_dates td ON td.trade_date = m.trade_date
        WHERE st.source = 'NAVER'
          AND t.deleted_at IS NULL
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
          AVG(rs_score) AS avg_rs_score,
          COUNT(*) FILTER (WHERE change_rate >= 1)::int AS up_count,
          COUNT(*) FILTER (WHERE change_rate <= -1)::int AS down_count,
          (COUNT(*) - COUNT(*) FILTER (WHERE change_rate >= 1) - COUNT(*) FILTER (WHERE change_rate <= -1))::int AS flat_count
        FROM filtered
        GROUP BY trade_date, theme_code
      ), scored AS (
        SELECT
          trade_date,
          theme_code,
          total_count,
          rising_count,
          rising_ratio,
          avg_change_rate,
          avg_rs_score,
          ROUND((
            (
              avg_rs_score * 0.50 +
              LEAST(100, GREATEST(0, (LN(total_count + 1) / LN(21)) * 100)) * 0.35 +
              rising_ratio * 0.15
            ) *
            CASE
              WHEN total_count <= 1 THEN 0.70
              WHEN total_count = 2 THEN 0.85
              ELSE 1
            END
          )::numeric, 2) AS theme_score,
          up_count,
          flat_count,
          down_count
        FROM grouped
      ), ranked AS (
        SELECT
          trade_date,
          theme_code,
          DENSE_RANK() OVER (PARTITION BY trade_date ORDER BY theme_score DESC, avg_rs_score DESC, rising_ratio DESC, avg_change_rate DESC, total_count DESC) AS rank,
          rising_count,
          total_count,
          rising_ratio,
          avg_change_rate,
          avg_rs_score,
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
        avg_rs_score,
        theme_score,
        0,
        up_count,
        flat_count,
        down_count
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
        down_count = EXCLUDED.down_count
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
