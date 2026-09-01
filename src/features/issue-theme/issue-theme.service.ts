import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { readFile } from 'fs/promises';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RealtimePriceCacheService } from '../real-time-chart/realtime-price-cache.service';
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
import { ThemeSnapshotService } from './theme-snapshot.service';

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeCache: RealtimePriceCacheService,
    private readonly kiwoomRest: KiwoomRestService,
    private readonly themeMetrics: ThemeMetricsService,
    private readonly themeAiSummary: ThemeAiSummaryService,
    private readonly themeSnapshot: ThemeSnapshotService,
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

  private dateOnly(d: Date): Date {
    const out = new Date(d);
    out.setUTCHours(0, 0, 0, 0);
    return out;
  }

  // ─── 공통 데이터 로더 ─────────────────────────────────────────────
  // ─── 이슈테마 목록 ────────────────────────────────────────────────

  async getThemeList(query: IssueThemeListQueryDto, userId?: string) {
    const { display, page } = query;
    const search = query.search?.trim() ?? '';
    if (query.favoritesOnly && !userId) throw new UnauthorizedException('관심테마 조회에는 로그인이 필요합니다');
    if (query.view === IssueThemeView.HEATMAP && search) {
      throw new BadRequestException('히트맵 보기에서는 테마 검색을 사용할 수 없습니다');
    }

    const canonicalSnapshots = await this.themeSnapshot.getLatestThemeItems();
    if (canonicalSnapshots.size === 0) {
      return {
        updatedAt: null,
        items: [],
        filterCounts: { all: 0, rs80: 0, momentum: 0, stockCount5: 0, changeRate5: 0, hasNewHigh: 0 },
        pagination: { page, display, total: 0, totalPages: 0 },
      };
    }
    const themeCodes = [...canonicalSnapshots.keys()];
    const firstSnapshot = canonicalSnapshots.values().next().value;
    const [themeRows, stocksByTheme] = await Promise.all([
      this.prisma.theme.findMany({
        where: { themeCode: { in: themeCodes }, deletedAt: null },
        select: { themeCode: true, themeName: true },
      }),
      this.themeSnapshot.getThemeStocksForThemes(
        themeCodes,
        firstSnapshot.snapshotDate,
        firstSnapshot.stockSnapshotTime,
      ),
    ]);
    const themeNames = new Map(themeRows.map((theme) => [theme.themeCode, theme.themeName]));
    const stockCodes = [...new Set([...stocksByTheme.values()].flat().map((stock) => stock.stockCode))];
    const companies = stockCodes.length > 0 ? await this.prisma.company.findMany({
      where: { stockCode: { in: stockCodes }, deletedAt: null },
      select: { stockCode: true, companyName: true },
    }) : [];
    const companyNames = new Map(companies.map((company) => [company.stockCode, company.companyName]));

    let items = [...canonicalSnapshots.values()]
      .filter((snapshot) => themeNames.has(snapshot.themeCode))
      .map((snapshot) => ({
        rank: snapshot.rank,
        previousRank: snapshot.previousRank,
        rankChange: snapshot.previousRank == null ? null : snapshot.previousRank - snapshot.rank,
        themeCode: snapshot.themeCode,
        themeName: themeNames.get(snapshot.themeCode)!,
        rsScore: snapshot.avgRsScore,
        avgRsScore: snapshot.avgRsScore,
        shortTermRs: snapshot.shortTermRs,
        momentum: snapshot.momentum,
        changeRate: snapshot.avgChangeRate,
        avgChangeRate: snapshot.avgChangeRate,
        stockCount: snapshot.totalCount,
        totalCount: snapshot.totalCount,
        eligibleStockCount: snapshot.totalCount,
        risingCount: snapshot.risingCount,
        newHighCount: snapshot.newHighCount,
        streakBadge: null,
        isFavorite: false,
        topStocks: [...(stocksByTheme.get(snapshot.themeCode) ?? [])]
          .sort((a, b) => b.relativeStrengthScore - a.relativeStrengthScore || a.stockCode.localeCompare(b.stockCode))
          .slice(0, 3)
          .map((stock) => ({ stockCode: stock.stockCode, stockName: companyNames.get(stock.stockCode) ?? '' })),
      }));

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

    const total = items.length;
    return {
      items: items.slice((page - 1) * display, page * display),
      filterCounts,
      pagination: { page, display, total, totalPages: total === 0 ? 0 : Math.ceil(total / display) },
      updatedAt: firstSnapshot.stockSnapshotTime.toISOString(),
    };
  }

  async getCurrentThemeRankMap(themeCodes: number[]): Promise<Map<number, any>> {
    if (themeCodes.length === 0) return new Map();
    const snapshots = await this.themeSnapshot.getLatestThemeItems(themeCodes);
    return new Map([...snapshots].map(([themeCode, snapshot]) => [themeCode, {
      themeCode,
      rank: snapshot.rank,
      previousRank: snapshot.previousRank,
      rankChange: snapshot.previousRank == null ? null : snapshot.previousRank - snapshot.rank,
      risingCount: snapshot.risingCount,
      totalCount: snapshot.totalCount,
      upCount: snapshot.upCount,
      flatCount: snapshot.flatCount,
      downCount: snapshot.downCount,
      risingRatio: snapshot.risingRatio,
      rsScore: snapshot.avgRsScore,
      avgRsScore: snapshot.avgRsScore,
      changeRate: snapshot.avgChangeRate,
      avgChangeRate: snapshot.avgChangeRate,
      shortTermRs: snapshot.shortTermRs,
      momentum: snapshot.momentum,
      newHighCount: snapshot.newHighCount,
      stockSnapshotTime: snapshot.stockSnapshotTime,
      snapshotDate: snapshot.snapshotDate,
    }]));
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

    return this.buildSnapshotThemeDetail(themeCode, theme, stockThemes, userId, query);
  }

  private async buildSnapshotThemeDetail(
    themeCode: number,
    theme: { themeName: string; imageUrl?: string | null },
    stockThemes: { stockCode: string; stockName: string | null; inclusionReason: string | null }[],
    userId: string | undefined,
    query: IssueThemeDetailQueryDto,
  ) {
    const currentTheme = (await this.getCurrentThemeRankMap([themeCode])).get(themeCode);
    if (!currentTheme?.snapshotDate || !currentTheme?.stockSnapshotTime) return null;
    const snapshotStocks = await this.themeSnapshot.getThemeStocks(
      themeCode,
      currentTheme.snapshotDate,
      currentTheme.stockSnapshotTime,
    );
    const companies = await this.prisma.company.findMany({
      where: { stockCode: { in: snapshotStocks.map((stock) => stock.stockCode) }, deletedAt: null },
      select: { stockCode: true, companyName: true },
    });
    const companyNames = new Map(companies.map((company) => [company.stockCode, company.companyName]));
    const memberships = new Map(stockThemes.map((stock) => [stock.stockCode, stock]));
    const stockRows = snapshotStocks.map((stock) => {
      const membership = memberships.get(stock.stockCode);
      const ratio = stock.previousTradingValueRatio;
      return {
        stockCode: stock.stockCode,
        companyName: companyNames.get(stock.stockCode) ?? membership?.stockName ?? '',
        inclusionReason: membership?.inclusionReason ?? null,
        currentPrice: stock.currentPrice,
        closePrice: stock.currentPrice,
        changeRate: stock.priceChangeRate,
        priceChange1d: stock.priceChange1d ?? null,
        priceChangeRate1d: stock.priceChangeRate,
        priceSource: 'STOCK_SNAPSHOT',
        rsScore: stock.relativeStrengthScore,
        shortTermRs: stock.shortTermRs,
        tradingValue: stock.tradingValue?.toString() ?? null,
        previousTradingValueRatio: ratio,
        isNewHigh: stock.isNewHigh,
        newHighRate: stock.highPrice52w != null && stock.highPrice52w > 0
          ? this.round2(((stock.currentPrice - stock.highPrice52w) / stock.highPrice52w) * 100)
          : null,
        tradingValueRatio: ratio == null ? '-' : `${ratio.toFixed(1)}배`,
        tradingValueChange: ratio == null ? '-' : `${ratio.toFixed(1)}배`,
        currentAccTradingValue: stock.tradingValue == null ? null : Number(stock.tradingValue),
        prevSameTimeAccTradingValue: ratio != null && ratio > 0 && stock.tradingValue != null
          ? Number(stock.tradingValue) / ratio : null,
      };
    });
    const nullableDesc = (a: number | null, b: number | null) =>
      a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : b - a;
    stockRows.sort((a, b) => {
      if (query.stockSort === IssueThemeStockSort.SHORT_TERM_RS) return nullableDesc(a.shortTermRs, b.shortTermRs) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.CHANGE_RATE) return b.changeRate - a.changeRate || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.TRADING_VALUE) return nullableDesc(a.currentAccTradingValue, b.currentAccTradingValue) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.PREVIOUS_RATIO) return nullableDesc(a.previousTradingValueRatio, b.previousTradingValueRatio) || a.stockCode.localeCompare(b.stockCode);
      if (query.stockSort === IssueThemeStockSort.NEW_HIGH) return Number(b.isNewHigh) - Number(a.isNewHigh) || a.stockCode.localeCompare(b.stockCode);
      return b.rsScore - a.rsScore || a.stockCode.localeCompare(b.stockCode);
    });
    stockRows.forEach((stock: any, index) => { stock.rank = index + 1; });

    let isFavorite: boolean | null = null;
    if (userId) {
      isFavorite = await this.prisma.userWatchlistTheme.findFirst({
        where: { userId, themeCode, deletedAt: null },
      }) != null;
    }
    const [aiSummaryRecord, relatedThemes] = await Promise.all([
      this.themeAiSummary.getLatestSuccess(themeCode),
      this.getSnapshotRelatedThemes(
        themeCode,
        currentTheme.snapshotDate,
        currentTheme.stockSnapshotTime,
      ),
    ]);
    const insights: string[] = [];
    if (currentTheme.avgChangeRate >= 2) insights.push('평균 등락률 상승');
    if (stockRows.some((stock) => stock.changeRate >= 7)) insights.push('상위 종목 급등');

    return {
      themeCode,
      themeName: theme.themeName,
      imageUrl: theme.imageUrl ?? null,
      rank: currentTheme.rank,
      rankChange: currentTheme.rankChange,
      risingCount: currentTheme.risingCount,
      totalCount: currentTheme.totalCount,
      avgRsScore: currentTheme.avgRsScore,
      rsScore: currentTheme.rsScore,
      shortTermRs: currentTheme.shortTermRs,
      momentum: currentTheme.momentum,
      changeRate: currentTheme.avgChangeRate,
      newHighCount: currentTheme.newHighCount,
      streakBadge: null,
      insights,
      isFavorite,
      stocks: stockRows.slice(0, query.stockDisplay),
      relatedThemes,
      aiSummary: aiSummaryRecord?.summary ?? null,
      aiSummaryUpdatedAt: aiSummaryRecord?.generatedAt?.toISOString() ?? null,
      aiSummarySources: Array.isArray(aiSummaryRecord?.sourceArticles) ? aiSummaryRecord.sourceArticles : [],
      updatedAt: currentTheme.stockSnapshotTime.toISOString(),
    };
  }

  // 연관 테마도 동일한 종목 스냅샷에서만 계산해야 상세 화면의 순위/등락률과 어긋나지 않는다.
  private async getSnapshotRelatedThemes(
    themeCode: number,
    snapshotDate: Date,
    stockSnapshotTime: Date,
  ) {
    const canonicalSnapshots = await this.themeSnapshot.getLatestThemeItems();
    if (!canonicalSnapshots.has(themeCode)) return [];
    const themeCodes = [...canonicalSnapshots.keys()];
    const [themeRows, stocksByTheme] = await Promise.all([
      this.prisma.theme.findMany({
        where: { themeCode: { in: themeCodes }, deletedAt: null },
        select: { themeCode: true, themeName: true },
      }),
      this.themeSnapshot.getThemeStocksForThemes(themeCodes, snapshotDate, stockSnapshotTime),
    ]);
    const themeNames = new Map(themeRows.map((theme) => [theme.themeCode, theme.themeName]));
    const toInput = (candidateCode: number) => {
      const snapshot = canonicalSnapshots.get(candidateCode)!;
      return {
        themeCode: candidateCode,
        themeName: themeNames.get(candidateCode) ?? '',
        rsScore: snapshot.avgRsScore,
        changeRate: snapshot.avgChangeRate,
        stockCodes: (stocksByTheme.get(candidateCode) ?? []).map((stock) => stock.stockCode),
      };
    };
    return this.themeMetrics.calculateRelatedThemes(
      toInput(themeCode),
      themeCodes.filter((candidateCode) => themeNames.has(candidateCode)).map(toInput),
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
  async generateAiSummaries(tradeDate: Date, limit = 20) {
    return this.themeAiSummary.generateForTradeDate(this.dateOnly(tradeDate), limit);
  }

  async regenerateAiSummary(themeCode: number, tradeDate: Date) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`Theme ${themeCode} not found`);
    return this.themeAiSummary.generateForTradeDate(this.dateOnly(tradeDate), 1, themeCode);
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
