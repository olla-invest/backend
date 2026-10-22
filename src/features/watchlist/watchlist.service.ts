import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CurrentPrice, CurrentPriceService } from '../real-time-chart/current-price.service';
import { RealTimeChartService } from '../real-time-chart/real-time-chart.service';
import { RealtimeSubscriptionManager } from '../real-time-chart/realtime-subscription-manager.service';
import { IssueThemeService } from '../issue-theme/issue-theme.service';

type StockCurrentRankContext = {
  tradeDate: Date | null;
  snapshotTime: Date | null;
  currentRankMap: Map<string, number | null>;
  previousRankMap: Map<string, number | null>;
};

@Injectable()
export class WatchlistService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currentPriceService: CurrentPriceService,
    private readonly realTimeChartService: RealTimeChartService,
    private readonly issueThemeService: IssueThemeService,
    private readonly subscriptionManager: RealtimeSubscriptionManager,
  ) {}

  /**
   * 관심종목은 실시간 차트 순위 밖일 수 있다. 구독해 두면 이후 체결이 Redis 가격에 쌓여
   * 다음 조회부터 키움 직접 조회 없이 캐시에서 읽는다. (상세 화면처럼 관리 대상에는 넣지 않는다)
   */
  private subscribeWatchlistStocks(stockCodes: string[]): void {
    if (stockCodes.length === 0) return;
    this.subscriptionManager.ensureSubscribed(stockCodes, { manage: false }).catch(() => undefined);
  }

  // ─── 관심종목 ─────────────────────────────────────────────────────

  async getWatchlistStocks(userId: string) {
    const watchlist = await this.prisma.userWatchlist.findMany({
      where: { userId, deletedAt: null },
      include: {
        company: {
          select: { companyId: true, companyName: true, stockCode: true, marketType: true },
        },
      },
      orderBy: { addedDate: 'desc' },
    });

    if (watchlist.length === 0) return { tradeDate: null, stocks: [] };

    const stockCodes = watchlist.map((w) => w.company.stockCode);
    this.subscribeWatchlistStocks(stockCodes);

    const latestMetric = await this.prisma.stockDailyMetrics.findFirst({
      where: { stockCode: { in: stockCodes } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });

    if (!latestMetric) {
      const currentPrices = await this.currentPriceService.getCurrentPrices(stockCodes, { fetchMissing: true });
      return { tradeDate: null, stocks: watchlist.map((w) => this.buildStockItem(w, null, null, currentPrices.get(w.company.stockCode))) };
    }

    const latestDate = latestMetric.tradeDate;
    const prevDateRecord = await this.prisma.stockDailyMetrics.findFirst({
      where: { tradeDate: { lt: latestDate } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });

    const [todayMetrics, prevMetrics] = await Promise.all([
      this.prisma.stockDailyMetrics.findMany({
        where: { stockCode: { in: stockCodes }, tradeDate: latestDate },
      }),
      prevDateRecord
        ? this.prisma.stockDailyMetrics.findMany({
            where: { stockCode: { in: stockCodes }, tradeDate: prevDateRecord.tradeDate },
          })
        : Promise.resolve([]),
    ]);

    const todayMap = new Map(todayMetrics.map((m) => [m.stockCode, m]));
    const prevMap = new Map(prevMetrics.map((m) => [m.stockCode, m]));

    // 관심종목은 실시간 구독 대상이 아닐 수 있어, tick·당일 일봉이 없으면 키움에서 직접 조회한다.
    const [currentPrices, currentRankContext, displayRankMap] = await Promise.all([
      this.currentPriceService.getCurrentPrices(stockCodes, { fetchMissing: true }),
      this.getStockCurrentRankContext(stockCodes, latestDate),
      this.realTimeChartService.getDefaultStockDisplayRankMap(stockCodes),
    ]);

    const stocks = watchlist.map((w) =>
      this.buildStockItem(
        w,
        todayMap.get(w.company.stockCode) ?? null,
        prevMap.get(w.company.stockCode) ?? null,
        currentPrices.get(w.company.stockCode),
        currentRankContext,
        displayRankMap,
      ),
    );
    stocks.sort((a, b) => this.compareNullableRank(a.rank, b.rank) || a.companyName.localeCompare(b.companyName, 'ko'));

    return {
      tradeDate: currentRankContext.tradeDate ?? latestDate,
      currentRankSnapshotTime: currentRankContext.snapshotTime,
      stocks,
    };
  }

  private buildStockItem(
    watchlistEntry: any,
    today: any,
    prev: any,
    price?: CurrentPrice,
    currentRankContext?: StockCurrentRankContext,
    displayRankMap?: Map<string, number>,
  ) {
    const stockCode = watchlistEntry.company.stockCode;
    const hasSnapshotRank = currentRankContext?.currentRankMap.has(stockCode) ?? false;
    const hasPreviousCurrentRank = currentRankContext?.previousRankMap.has(stockCode) ?? false;
    const rank = this.normalizeStockRank(hasSnapshotRank
      ? currentRankContext!.currentRankMap.get(stockCode) ?? null
      : displayRankMap?.get(stockCode) ?? today?.currentRank ?? today?.rank ?? null);
    const prevRank = this.normalizeStockRank(hasPreviousCurrentRank
      ? currentRankContext!.previousRankMap.get(stockCode) ?? null
      : prev?.currentRank ?? prev?.rank ?? null);
    const rankChange = rank != null && prevRank != null ? prevRank - rank : null;
    const events: string[] = [];
    if (today) {
      if (this.isAtNewHigh(price?.currentPrice, today)) events.push('NEW_HIGH');
      if (today.isVolatilityContraction) events.push('VOLATILITY_CONTRACTION');
      if (today.isPriceCompression) events.push('PRICE_COMPRESSION');
      if (today.isTrendTemplate) events.push('TREND_TEMPLATE');
      if (rank != null && prevRank != null) {
        if (rank < prevRank) events.push('RANK_UP');
        else if (rank > prevRank) events.push('RANK_DOWN');
      }
    }
    return {
      companyId: watchlistEntry.companyId,
      stockCode,
      companyName: watchlistEntry.company.companyName,
      marketType: watchlistEntry.company.marketType,
      addedDate: watchlistEntry.addedDate,
      memo: watchlistEntry.memo ?? null,
      closePrice: price?.currentPrice ?? null,
      priceChange1d: price?.changeAmount ?? null,
      priceChangeRate1d: price?.changeRate ?? null,
      priceSource: price?.source ?? null,
      rank: this.toDisplayRank(rank),
      prevRank: this.toDisplayRank(prevRank),
      rankChange,
      storedRank: today?.rank ?? null,
      currentRankSnapshotTime: currentRankContext?.snapshotTime ?? null,
      relativeStrengthScore: today ? Number(today.relativeStrengthScore) : null,
      isNewHigh: this.isAtNewHigh(price?.currentPrice, today),
      events,
    };
  }

  async addStock(userId: string, stockCode: string) {
    const company = await this.prisma.company.findFirst({ where: { stockCode, deletedAt: null } });
    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);

    const existing = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: null },
    });
    if (existing) throw new ConflictException(`이미 관심종목으로 등록된 종목입니다`);

    const deleted = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: { not: null } },
    });
    if (deleted) {
      return this.prisma.userWatchlist.update({
        where: { userId_companyId: { userId, companyId: company.companyId } },
        data: { deletedAt: null, addedDate: new Date() },
        include: { company: { select: { companyName: true, stockCode: true, marketType: true } } },
      });
    }

    return this.prisma.userWatchlist.create({
      data: { userId, companyId: company.companyId },
      include: { company: { select: { companyName: true, stockCode: true, marketType: true } } },
    });
  }

  async removeStock(userId: string, stockCode: string) {
    const company = await this.prisma.company.findFirst({ where: { stockCode, deletedAt: null } });
    if (!company) throw new NotFoundException(`종목코드 ${stockCode}를 찾을 수 없습니다`);

    const watchlistEntry = await this.prisma.userWatchlist.findFirst({
      where: { userId, companyId: company.companyId, deletedAt: null },
    });
    if (!watchlistEntry) throw new NotFoundException(`관심종목에 등록되지 않은 종목입니다`);

    await this.prisma.userWatchlist.update({
      where: { userId_companyId: { userId, companyId: company.companyId } },
      data: { deletedAt: new Date() },
    });
    return { message: '관심종목에서 삭제되었습니다', stockCode };
  }

  // ─── 관심테마 ─────────────────────────────────────────────────────

  /**
   * GET /watchlist/themes
   * 관심테마 현황 조회
   * - 이벤트: 테마 순위 상승/하락 텍스트
   * - 정렬: 테마명 가나다순
   */
  async getWatchlistThemes(userId: string) {
    const watchlistThemes = await this.prisma.userWatchlistTheme.findMany({
      where: { userId, deletedAt: null },
      include: { theme: { select: { themeCode: true, themeName: true, imageUrl: true } } },
    });

    if (watchlistThemes.length === 0) return { themes: [] };

    const themeCodes = watchlistThemes.map((w) => w.themeCode);

    const currentThemeMap = await this.issueThemeService.getCurrentThemeRankMap(themeCodes);

    const themes = watchlistThemes.map((w) => {
      const today = currentThemeMap.get(w.themeCode) ?? null;
      const prev = today?.previousRank != null ? { rank: today.previousRank } : null;
      return this.buildThemeItem(w, today, prev);
    });

    themes.sort((a, b) => this.compareNullableRank(a.rank, b.rank) || a.themeName.localeCompare(b.themeName, 'ko'));

    return { themes };
  }

  private buildThemeItem(watchlistEntry: any, today: any, prev: any) {
    const counts = this.normalizeThemeCounts(today);
    let event = '-';
    if (today && prev) {
      const diff = prev.rank - today.rank;
      if (diff > 0) {
        event = `테마 순위가 ${prev.rank} → ${today.rank}으로 상승했어요.(+${diff})`;
      } else if (diff < 0) {
        event = `테마 순위가 ${prev.rank} → ${today.rank}으로 하락했어요.(${diff})`;
      }
    }
    return {
      themeCode: watchlistEntry.themeCode,
      themeName: watchlistEntry.theme.themeName,
      imageUrl: watchlistEntry.theme.imageUrl ?? null,
      addedDate: watchlistEntry.addedDate,
      rank: today?.rank ?? null,
      prevRank: prev?.rank ?? null,
      risingCount: counts.risingCount,
      totalCount: counts.totalCount,
      upCount: counts.upCount,
      flatCount: counts.flatCount,
      downCount: counts.downCount,
      event,
    };
  }

  private normalizeThemeCounts(snapshot: any): {
    risingCount: number | null;
    totalCount: number | null;
    upCount: number | null;
    flatCount: number | null;
    downCount: number | null;
  } {
    if (!snapshot) {
      return { risingCount: null, totalCount: null, upCount: null, flatCount: null, downCount: null };
    }

    const upCount = snapshot.upCount ?? null;
    const flatCount = snapshot.flatCount ?? null;
    const downCount = snapshot.downCount ?? null;
    const bucketTotal =
      upCount != null && flatCount != null && downCount != null
        ? upCount + flatCount + downCount
        : null;

    return {
      risingCount: snapshot.risingCount ?? null,
      totalCount: bucketTotal ?? snapshot.totalCount ?? null,
      upCount,
      flatCount,
      downCount,
    };
  }

  async addTheme(userId: string, themeCode: number) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`테마코드 ${themeCode}를 찾을 수 없습니다`);

    const existing = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: null },
    });
    if (existing) throw new ConflictException(`이미 관심테마로 등록된 테마입니다`);

    // soft delete 복구
    const deleted = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: { not: null } },
    });
    if (deleted) {
      return this.prisma.userWatchlistTheme.update({
        where: { userId_themeCode: { userId, themeCode } },
        data: { deletedAt: null, addedDate: new Date() },
        include: { theme: { select: { themeName: true } } },
      });
    }

    return this.prisma.userWatchlistTheme.create({
      data: { userId, themeCode },
      include: { theme: { select: { themeName: true } } },
    });
  }

  async removeTheme(userId: string, themeCode: number) {
    const theme = await this.prisma.theme.findFirst({ where: { themeCode, deletedAt: null } });
    if (!theme) throw new NotFoundException(`테마코드 ${themeCode}를 찾을 수 없습니다`);

    const entry = await this.prisma.userWatchlistTheme.findFirst({
      where: { userId, themeCode, deletedAt: null },
    });
    if (!entry) throw new NotFoundException(`관심테마에 등록되지 않은 테마입니다`);

    await this.prisma.userWatchlistTheme.update({
      where: { userId_themeCode: { userId, themeCode } },
      data: { deletedAt: new Date() },
    });
    return { message: '관심테마에서 삭제되었습니다', themeCode };
  }

  // ─── 섹션 1: 오늘 주목해야 할 내 관심항목 Top5 ────────────────────

  /**
   * GET /watchlist/highlights
   * 관심테마 중 순위 기준 상위 2개 + 관심종목 중 현재 순위 기준 상위 3개
   */
  async getHighlights(userId: string) {
    const [watchlistThemes, watchlistStocks] = await Promise.all([
      this.prisma.userWatchlistTheme.findMany({
        where: { userId, deletedAt: null },
        include: { theme: { select: { themeCode: true, themeName: true, imageUrl: true } } },
      }),
      this.prisma.userWatchlist.findMany({
        where: { userId, deletedAt: null },
        include: {
          company: { select: { companyId: true, companyName: true, stockCode: true, marketType: true } },
        },
      }),
    ]);

    // 테마 Top2 - 이슈테마 화면의 현재 순위 기준
    const themeCodes = watchlistThemes.map((w) => w.themeCode);
    const currentThemeMap = await this.issueThemeService.getCurrentThemeRankMap(themeCodes);

    let topThemes: any[] = [];
    if (currentThemeMap.size > 0) {
      topThemes = Array.from(currentThemeMap.values())
        .sort((a: any, b: any) => this.compareNullableRank(a.rank, b.rank) || a.themeName.localeCompare(b.themeName, 'ko'))
        .slice(0, 2)
        .map((s: any) => {
          const w = watchlistThemes.find((wt) => wt.themeCode === s.themeCode)!;
          return {
            type: 'THEME',
            themeCode: s.themeCode,
            themeName: w.theme.themeName,
            imageUrl: w.theme.imageUrl ?? null,
            rank: s.rank,
            prevRank: this.toDisplayRank(s.previousRank),
            previousRank: this.toDisplayRank(s.previousRank),
            rankChange: s.rankChange ?? null,
            risingCount: s.risingCount,
            totalCount: s.totalCount,
            upCount: s.upCount ?? null,
            flatCount: s.flatCount ?? null,
            downCount: s.downCount ?? null,
          };
        });
    } else {
      topThemes = watchlistThemes.slice(0, 2).map((w) => ({
        type: 'THEME',
        themeCode: w.themeCode,
        themeName: w.theme.themeName,
        imageUrl: w.theme.imageUrl ?? null,
        rank: null,
        prevRank: null,
        previousRank: null,
        rankChange: null,
        risingCount: null,
        totalCount: null,
        upCount: null,
        flatCount: null,
        downCount: null,
      }));
    }

    // 종목 Top3 - 실시간 차트와 같은 현재 순위 기준
    const stockCodes = watchlistStocks.map((w) => w.company.stockCode);
    this.subscribeWatchlistStocks(stockCodes);
    const latestStockMetric = stockCodes.length > 0
      ? await this.prisma.stockDailyMetrics.findFirst({
          where: { stockCode: { in: stockCodes } },
          orderBy: { tradeDate: 'desc' },
          select: { tradeDate: true },
        })
      : null;

    let topStocks: any[] = [];
    if (latestStockMetric) {
      const [metrics, currentRankContext, displayRankMap] = await Promise.all([
        this.prisma.stockDailyMetrics.findMany({
          where: { stockCode: { in: stockCodes }, tradeDate: latestStockMetric.tradeDate },
        }),
        this.getStockCurrentRankContext(stockCodes, latestStockMetric.tradeDate),
        this.realTimeChartService.getDefaultStockDisplayRankMap(stockCodes),
      ]);
      const top3 = metrics
        .map((m) => ({
          metric: m,
          rank: this.normalizeStockRank(currentRankContext.currentRankMap.has(m.stockCode)
            ? currentRankContext.currentRankMap.get(m.stockCode) ?? null
            : displayRankMap.get(m.stockCode) ?? m.currentRank ?? m.rank ?? null),
        }))
        .sort((a, b) => this.compareNullableRank(a.rank, b.rank) || a.metric.stockCode.localeCompare(b.metric.stockCode))
        .slice(0, 3);
      const currentPrices = await this.currentPriceService.getCurrentPrices(
        top3.map(({ metric }) => metric.stockCode),
        { fetchMissing: true },
      );
      topStocks = top3
        .map(({ metric: m, rank }) => {
          const w = watchlistStocks.find((ws) => ws.company.stockCode === m.stockCode)!;
          const price = currentPrices.get(m.stockCode);
          return {
            type: 'STOCK',
            companyId: w.company.companyId,
            stockCode: m.stockCode,
            companyName: w.company.companyName,
            marketType: w.company.marketType,
            rank: this.toDisplayRank(rank),
            storedRank: m.rank,
            currentRankSnapshotTime: currentRankContext.snapshotTime,
            closePrice: price?.currentPrice ?? null,
            priceChangeRate1d: price?.changeRate ?? null,
            priceSource: price?.source ?? null,
            relativeStrengthScore: Number(m.relativeStrengthScore),
          };
        });
    } else {
      topStocks = watchlistStocks.slice(0, 3).map((w) => ({
        type: 'STOCK',
        companyId: w.company.companyId,
        stockCode: w.company.stockCode,
        companyName: w.company.companyName,
        marketType: w.company.marketType,
        rank: null,
        closePrice: null,
        priceChangeRate1d: null,
        relativeStrengthScore: null,
      }));
    }

    return { highlights: [...topThemes, ...topStocks] };
  }

  // ─── 섹션 4: 함께 보면 좋을 만한 종목·테마 ──────────────────────

  /**
   * GET /watchlist/recommendations
   * 테마 추천 1개 + 종목 추천 1개
   */
  async getRecommendations(userId: string) {
    const [watchlistThemes, watchlistStocks] = await Promise.all([
      this.prisma.userWatchlistTheme.findMany({ where: { userId, deletedAt: null } }),
      this.prisma.userWatchlist.findMany({
        where: { userId, deletedAt: null },
        include: { company: { select: { stockCode: true, themeCode: true } } },
      }),
    ]);

    const watchlistThemeCodes = new Set(watchlistThemes.map((w) => w.themeCode));

    // 날짜 기반 시드 (매일 다르게)
    const dayIndex = Math.floor(Date.now() / (1000 * 60 * 60 * 24));

    // ── 테마 추천 ──
    const recommendedTheme = await this.recommendTheme(watchlistStocks, watchlistThemeCodes, dayIndex);

    // ── 종목 추천 ──
    const recommendedStock = await this.recommendStock(watchlistThemeCodes, watchlistStocks, dayIndex);

    return { recommendedTheme, recommendedStock };
  }

  private buildThemeRecommendResult(reason: string, theme: any, snapshot: any, prevRank: number | null) {
    const rankChange = prevRank != null ? prevRank - snapshot.rank : null;
    const counts = this.normalizeThemeCounts(snapshot);

    return {
      reason,
      type: 'THEME',
      themeCode: snapshot.themeCode,
      themeName: theme.themeName,
      imageUrl: theme.imageUrl ?? null,
      rank: snapshot.rank,
      prevRank: this.toDisplayRank(prevRank),
      previousRank: this.toDisplayRank(prevRank),
      rankChange,
      rankHistory: {
        today: snapshot.rank,
        oneDayAgo: this.toDisplayRank(prevRank),
      },
      risingCount: counts.risingCount,
      totalCount: counts.totalCount,
      upCount: counts.upCount,
      flatCount: counts.flatCount,
      downCount: counts.downCount,
    };
  }

  private async recommendTheme(watchlistStocks: any[], watchlistThemeCodes: Set<number>, dayIndex: number) {
    // 1순위: 관심종목이 속한 네이버 테마 중 관심테마에 없는 것 → 테마 순위 가장 높은 1개
    const watchlistStockCodes = watchlistStocks.map((w) => w.company.stockCode).filter(Boolean);
    const stockThemeRows = watchlistStockCodes.length > 0
      ? await this.prisma.stockTheme.findMany({
          where: {
            stockCode: { in: watchlistStockCodes },
            source: 'NAVER',
            themeCode: { notIn: Array.from(watchlistThemeCodes) },
            theme: { deletedAt: null },
          },
          select: { themeCode: true },
        })
      : [];
    const stockThemeCodes = [...new Set(stockThemeRows.map((row) => row.themeCode))];

    if (stockThemeCodes.length > 0) {
      const candidates = await this.issueThemeService.getCurrentThemeRankMap(stockThemeCodes);
      const best = [...candidates.values()].sort((a, b) => a.rank - b.rank)[0];
      if (best) {
        const theme = await this.prisma.theme.findFirst({
          where: { themeCode: best.themeCode, deletedAt: null },
        });
        if (theme) {
          return this.buildThemeRecommendResult(
            '1순위', theme, best, best.previousRank ?? null,
          );
        }
      }
    }

    // 2순위: 동일한 현재 테마 스냅샷의 Top10 중 매일 다르게 1개
    const availableThemes = await this.prisma.theme.findMany({
      where: {
        themeCode: { notIn: Array.from(watchlistThemeCodes) },
        deletedAt: null,
      },
      select: { themeCode: true, themeName: true, imageUrl: true },
    });
    const availableCodes = availableThemes.map((theme) => theme.themeCode);
    const currentThemes = await this.issueThemeService.getCurrentThemeRankMap(availableCodes);
    const top10 = [...currentThemes.values()].sort((a, b) => a.rank - b.rank).slice(0, 10);
    if (top10.length === 0) return null;

    const picked = top10[dayIndex % top10.length];
    const theme = availableThemes.find((item) => item.themeCode === picked.themeCode);
    if (!theme) return null;

    return this.buildThemeRecommendResult('2순위', theme, picked, picked.previousRank ?? null);
  }

  private async buildStockRecommendResult(
    reason: string,
    metric: any,
    company: any,
    prevMetric: any,
    displayRank?: number | null,
    displayPrevRank?: number | null,
  ) {
    const events: string[] = [];
    const rank = this.normalizeStockRank(displayRank ?? metric.currentRank ?? metric.rank ?? null);
    const prevRank = this.normalizeStockRank(displayPrevRank ?? prevMetric?.currentRank ?? prevMetric?.rank ?? null);
    const rankChange = rank != null && prevRank != null ? prevRank - rank : null;

    const price = await this.currentPriceService.getCurrentPrice(metric.stockCode, { fetchMissing: true });
    if (this.isAtNewHigh(price?.currentPrice, metric)) events.push('NEW_HIGH');
    if (metric.isVolatilityContraction) events.push('VOLATILITY_CONTRACTION');
    if (metric.isPriceCompression) events.push('PRICE_COMPRESSION');
    if (metric.isTrendTemplate) events.push('TREND_TEMPLATE');
    if (rank != null && prevRank != null) {
      if (rank < prevRank) events.push('RANK_UP');
      else if (rank > prevRank) events.push('RANK_DOWN');
    }

    return {
      reason,
      type: 'STOCK',
      companyId: company.companyId,
      stockCode: metric.stockCode,
      companyName: company.companyName,
      marketType: company.marketType,
      rank: this.toDisplayRank(rank),
      prevRank: this.toDisplayRank(prevRank),
      previousRank: this.toDisplayRank(prevRank),
      rankChange,
      rankHistory: {
        today: this.toDisplayRank(rank),
        oneDayAgo: this.toDisplayRank(prevRank),
      },
      closePrice: price?.currentPrice ?? null,
      priceChangeRate1d: price?.changeRate ?? null,
      priceSource: price?.source ?? null,
      relativeStrengthScore: Number(metric.relativeStrengthScore),
      events,
    };
  }

  private async recommendStock(watchlistThemeCodes: Set<number>, watchlistStocks: any[], dayIndex: number) {
    const watchlistStockCodes = new Set(watchlistStocks.map((w) => w.company.stockCode));

    // 1순위: 관심테마 내 종목 중 RS 상위 top5 → 1개 노출
    if (watchlistThemeCodes.size > 0) {
      const themeStocks = await this.prisma.stockTheme.findMany({
        where: {
          themeCode: { in: Array.from(watchlistThemeCodes) },
          source: 'NAVER',
          theme: { deletedAt: null },
        },
        select: { stockCode: true },
      });
      const candidateCodes = [...new Set(themeStocks.map((row) => row.stockCode))]
        .filter((code) => !watchlistStockCodes.has(code));

      if (candidateCodes.length > 0) {
        const themeCompanies = await this.prisma.company.findMany({
          where: { stockCode: { in: candidateCodes }, deletedAt: null },
          select: { stockCode: true, companyId: true, companyName: true, marketType: true },
        });
        const existingCandidateCodes = new Set(themeCompanies.map((company) => company.stockCode));
        const latestMetric = await this.prisma.stockDailyMetrics.findFirst({
          where: { stockCode: { in: Array.from(existingCandidateCodes) } },
          orderBy: { tradeDate: 'desc' },
          select: { tradeDate: true },
        });
        if (latestMetric) {
          const top5 = await this.prisma.stockDailyMetrics.findMany({
            where: {
              stockCode: { in: Array.from(existingCandidateCodes) },
              tradeDate: latestMetric.tradeDate,
              rank: { gt: 0 },
            },
            orderBy: { rank: 'asc' },
            take: 5,
          });
          if (top5.length > 0) {
            const picked = top5[dayIndex % top5.length];
            const company = themeCompanies.find((c) => c.stockCode === picked.stockCode)!;
            const prevMetric = await this.prisma.stockDailyMetrics.findFirst({
              where: { stockCode: picked.stockCode, tradeDate: { lt: latestMetric.tradeDate } },
              orderBy: { tradeDate: 'desc' },
              select: { rank: true, currentRank: true },
            });
            const [displayRankMap, currentRankContext] = await Promise.all([
              this.realTimeChartService.getDefaultStockDisplayRankMap([picked.stockCode]),
              this.getStockCurrentRankContext([picked.stockCode], latestMetric.tradeDate),
            ]);
            const displayRank = currentRankContext.currentRankMap.has(picked.stockCode)
              ? currentRankContext.currentRankMap.get(picked.stockCode) ?? null
              : displayRankMap.get(picked.stockCode) ?? picked.currentRank ?? picked.rank ?? null;
            const displayPrevRank = currentRankContext.previousRankMap.has(picked.stockCode)
              ? currentRankContext.previousRankMap.get(picked.stockCode) ?? null
              : prevMetric?.currentRank ?? prevMetric?.rank ?? null;
            return this.buildStockRecommendResult('1순위', picked, company, prevMetric, displayRank, displayPrevRank);
          }
        }
      }
    }

    // 2순위: 오늘의 Top10 종목 중 매일 다르게 1개
    const latestMetric = await this.prisma.stockDailyMetrics.findFirst({
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (!latestMetric) return null;

    const top10 = await this.prisma.stockDailyMetrics.findMany({
      where: {
        tradeDate: latestMetric.tradeDate,
        stockCode: { notIn: Array.from(watchlistStockCodes) },
        rank: { gt: 0 },
      },
      orderBy: { rank: 'asc' },
      take: 10,
    });
    if (top10.length === 0) return null;

    const picked = top10[dayIndex % top10.length];
    const [company, prevMetric] = await Promise.all([
      this.prisma.company.findFirst({
        where: { stockCode: picked.stockCode, deletedAt: null },
        select: { companyId: true, companyName: true, marketType: true },
      }),
      this.prisma.stockDailyMetrics.findFirst({
        where: { stockCode: picked.stockCode, tradeDate: { lt: latestMetric.tradeDate } },
        orderBy: { tradeDate: 'desc' },
        select: { rank: true, currentRank: true },
      }),
    ]);
    if (!company) return null;

    const [displayRankMap, currentRankContext] = await Promise.all([
      this.realTimeChartService.getDefaultStockDisplayRankMap([picked.stockCode]),
      this.getStockCurrentRankContext([picked.stockCode], latestMetric.tradeDate),
    ]);
    const displayRank = currentRankContext.currentRankMap.has(picked.stockCode)
      ? currentRankContext.currentRankMap.get(picked.stockCode) ?? null
      : displayRankMap.get(picked.stockCode) ?? picked.currentRank ?? picked.rank ?? null;
    const displayPrevRank = currentRankContext.previousRankMap.has(picked.stockCode)
      ? currentRankContext.previousRankMap.get(picked.stockCode) ?? null
      : prevMetric?.currentRank ?? prevMetric?.rank ?? null;

    return this.buildStockRecommendResult('2순위', picked, company, prevMetric, displayRank, displayPrevRank);
  }

  // ─── 섹션 5: 내 관심 통합 목록 ───────────────────────────────────

  /**
   * GET /watchlist/my
   * 관심테마 + 관심종목 합산, addedDate 내림차순
   * 종목: 현재가 및 전일대비 평균수익률 등락 표시
   * 테마: 테마 내 상승 종목 수 / 전체 종목 수
   */
  async getMyWatchlist(userId: string) {
    const [watchlistThemes, watchlistStocks] = await Promise.all([
      this.prisma.userWatchlistTheme.findMany({
        where: { userId, deletedAt: null },
        include: { theme: { select: { themeCode: true, themeName: true, imageUrl: true } } },
      }),
      this.prisma.userWatchlist.findMany({
        where: { userId, deletedAt: null },
        include: {
          company: { select: { companyId: true, companyName: true, stockCode: true, marketType: true } },
        },
      }),
    ]);

    // 종목 지표
    const stockCodes = watchlistStocks.map((w) => w.company.stockCode);
    this.subscribeWatchlistStocks(stockCodes);
    const latestStockMetric = stockCodes.length > 0
      ? await this.prisma.stockDailyMetrics.findFirst({
          where: { stockCode: { in: stockCodes } },
          orderBy: { tradeDate: 'desc' },
          select: { tradeDate: true },
        })
      : null;

    let stockMetricMap = new Map<string, any>();
    let stockCurrentRankContext: StockCurrentRankContext = {
      tradeDate: null,
      snapshotTime: null,
      currentRankMap: new Map(),
      previousRankMap: new Map(),
    };
    let stockDisplayRankMap = new Map<string, number>();
    if (latestStockMetric) {
      const [metrics, currentRankContext, displayRankMap] = await Promise.all([
        this.prisma.stockDailyMetrics.findMany({
          where: { stockCode: { in: stockCodes }, tradeDate: latestStockMetric.tradeDate },
        }),
        this.getStockCurrentRankContext(stockCodes, latestStockMetric.tradeDate),
        this.realTimeChartService.getDefaultStockDisplayRankMap(stockCodes),
      ]);
      stockMetricMap = new Map(metrics.map((m) => [m.stockCode, m]));
      stockCurrentRankContext = currentRankContext;
      stockDisplayRankMap = displayRankMap;
    }

    // 테마 스냅샷
    const themeCodes = watchlistThemes.map((w) => w.themeCode);
    const currentThemeMap = await this.issueThemeService.getCurrentThemeRankMap(themeCodes);
    const items: any[] = [];

    for (const w of watchlistThemes) {
      const snapshot = currentThemeMap.get(w.themeCode) ?? null;
      const previousRank = snapshot?.previousRank ?? null;
      const rankChange = snapshot?.rankChange ?? (
        snapshot && previousRank != null ? previousRank - snapshot.rank : null
      );
      items.push({
        type: 'THEME',
        themeCode: w.themeCode,
        themeName: w.theme.themeName,
        imageUrl: w.theme.imageUrl ?? null,
        addedDate: w.addedDate,
        rank: snapshot?.rank ?? null,
        prevRank: previousRank,
        rankChange,
        ...this.normalizeThemeCounts(snapshot),
      });
    }

    const currentPrices = await this.currentPriceService.getCurrentPrices(stockCodes, { fetchMissing: true });
    for (const w of watchlistStocks) {
      const m = stockMetricMap.get(w.company.stockCode);
      const price = currentPrices.get(w.company.stockCode);
      const stockCode = w.company.stockCode;
      const hasSnapshotRank = stockCurrentRankContext.currentRankMap.has(stockCode);
      const hasPreviousCurrentRank = stockCurrentRankContext.previousRankMap.has(stockCode);
      const rank = this.normalizeStockRank(hasSnapshotRank
        ? stockCurrentRankContext.currentRankMap.get(stockCode) ?? null
        : stockDisplayRankMap.get(stockCode) ?? m?.currentRank ?? m?.rank ?? null);
      const prevRank = this.normalizeStockRank(hasPreviousCurrentRank
        ? stockCurrentRankContext.previousRankMap.get(stockCode) ?? null
        : null);
      const rankChange = rank != null && prevRank != null ? prevRank - rank : null;
      items.push({
        type: 'STOCK',
        companyId: w.company.companyId,
        stockCode,
        companyName: w.company.companyName,
        marketType: w.company.marketType,
        addedDate: w.addedDate,
        rank: this.toDisplayRank(rank),
        prevRank: this.toDisplayRank(prevRank),
        rankChange,
        storedRank: m?.rank ?? null,
        currentRankSnapshotTime: stockCurrentRankContext.snapshotTime,
        closePrice: price?.currentPrice ?? null,
        priceChangeRate1d: price?.changeRate ?? null,
        priceSource: price?.source ?? null,
        relativeStrengthScore: m ? Number(m.relativeStrengthScore) : null,
      });
    }

    // addedDate 내림차순
    items.sort((a, b) => new Date(b.addedDate).getTime() - new Date(a.addedDate).getTime());

    return { items };
  }

  private compareNullableRank(a?: number | string | null, b?: number | string | null) {
    const rankA = this.normalizeStockRank(a);
    const rankB = this.normalizeStockRank(b);
    if (rankA == null && rankB == null) return 0;
    if (rankA == null) return 1;
    if (rankB == null) return -1;
    return rankA - rankB;
  }

  // 신고가는 표시하는 현재가가 52주 고가 이상인지로 판단한다 (실시간 차트·테마 상세와 같은 기준).
  // 저장된 isNewHigh 는 지표 기준일(전일)의 고가 기준이라, 그대로 쓰면 오늘 신고가가 아니어도 하루 종일 표시된다.
  private isAtNewHigh(
    currentPrice: number | null | undefined,
    metric?: { highPrice52w?: unknown; isNewHigh?: boolean | null } | null,
  ): boolean {
    if (!metric) return false;
    const high52w = metric.highPrice52w == null ? null : Number(metric.highPrice52w);
    if (high52w == null || currentPrice == null || !(currentPrice > 0)) return metric.isNewHigh ?? false;
    return currentPrice >= high52w;
  }

  // rank 0(정적 필터 탈락)과 null(집계 제외)은 모두 RS 순위권 이탈로 간주
  private normalizeStockRank(rank?: number | string | null): number | null {
    return typeof rank === 'number' && rank > 0 ? rank : null;
  }

  // 숫자 필드는 숫자 또는 null만 반환한다. '-' 표시는 클라이언트 표현 단계에서 처리한다.
  // 직전 순위가 없으면(신규 진입·순위권 밖) 현재 순위로 채우지 않고 null 을 보낸다 → 화면은 '-' (기획 결정).
  private toDisplayRank(rank?: number | null): number | null {
    return rank ?? null;
  }


  private async getStockCurrentRankContext(
    stockCodes: string[],
    fallbackTradeDate?: Date,
  ): Promise<StockCurrentRankContext> {
    if (stockCodes.length === 0) {
      return { tradeDate: null, snapshotTime: null, currentRankMap: new Map(), previousRankMap: new Map() };
    }

    // 스냅샷 trade_date는 배치 메트릭 기준일(fallbackTradeDate)과 일치해야 한다.
    // 미래 날짜 스냅샷이 잔존하면 배치 메트릭과 불일치가 생기므로 lte 필터로 막는다.
    const snapshot = await this.prisma.stockCurrentRankSnapshot.findFirst({
      where: fallbackTradeDate ? { tradeDate: { lte: fallbackTradeDate } } : undefined,
      orderBy: [{ tradeDate: 'desc' }, { snapshotTime: 'desc' }],
      select: { tradeDate: true, snapshotTime: true },
    });
    if (snapshot) {
      const currentRows = await this.prisma.stockCurrentRankSnapshot.findMany({
        where: {
          tradeDate: snapshot.tradeDate,
          snapshotTime: snapshot.snapshotTime,
          stockCode: { in: stockCodes },
        },
        select: { stockCode: true, currentRank: true },
      });
      const previousRankMap = await this.getFinalizedDailyRankMap(stockCodes, snapshot.tradeDate);

      return {
        tradeDate: snapshot.tradeDate,
        snapshotTime: snapshot.snapshotTime,
        currentRankMap: new Map(currentRows.map((row) => [row.stockCode, row.currentRank])),
        previousRankMap,
      };
    }

    if (!fallbackTradeDate) {
      return { tradeDate: null, snapshotTime: null, currentRankMap: new Map(), previousRankMap: new Map() };
    }

    const currentRows = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode: { in: stockCodes }, tradeDate: fallbackTradeDate },
      select: { stockCode: true, currentRank: true },
    });

    return {
      tradeDate: fallbackTradeDate,
      snapshotTime: null,
      currentRankMap: new Map(currentRows.map((row) => [row.stockCode, row.currentRank])),
      previousRankMap: await this.getPreviousDailyCurrentRankMap(stockCodes, fallbackTradeDate),
    };
  }

  // 실시간 차트 D-1과 같은 값: 그 거래일의 장 마감 순위로 확정된 stock_daily_metrics.current_rank.
  // 직전 거래일의 마지막 스냅샷은 당일 지표로 다시 매긴 순위(테마용)라 D-1보다 하루 앞선 기준이 된다.
  private async getFinalizedDailyRankMap(
    stockCodes: string[],
    tradeDate: Date,
  ): Promise<Map<string, number | null>> {
    const rows = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode: { in: stockCodes }, tradeDate },
      select: { stockCode: true, currentRank: true },
    });
    return new Map(rows.map((row) => [row.stockCode, row.currentRank]));
  }

  private async getPreviousDailyCurrentRankMap(stockCodes: string[], tradeDate: Date): Promise<Map<string, number | null>> {
    const prevDateRecord = await this.prisma.stockDailyMetrics.findFirst({
      where: { tradeDate: { lt: tradeDate } },
      orderBy: { tradeDate: 'desc' },
      select: { tradeDate: true },
    });
    if (!prevDateRecord) return new Map();

    const rows = await this.prisma.stockDailyMetrics.findMany({
      where: { stockCode: { in: stockCodes }, tradeDate: prevDateRecord.tradeDate },
      select: { stockCode: true, currentRank: true },
    });

    return new Map(rows.map((row) => [row.stockCode, row.currentRank]));
  }
}
