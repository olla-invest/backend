import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { IssueThemeService } from './issue-theme.service';
import { ThemeMetricsService } from './theme-metrics.service';
import { CurrentPriceResolver } from '../real-time-chart/current-price-resolver.service';
import { IssueThemeFilter, IssueThemeSort, IssueThemeView } from './dto/issue-theme-list-query.dto';

describe('IssueThemeService enhanced list', () => {
  const prisma: any = {
    stockTheme: { findMany: jest.fn() },
    stockDailyMetrics: { findFirst: jest.fn(), findMany: jest.fn() },
    themeDailySnapshot: { findMany: jest.fn() },
    userWatchlistTheme: { findMany: jest.fn() },
    theme: { findMany: jest.fn() },
    company: { findMany: jest.fn() },
  };
  const realtimeCache: any = { getPrices: jest.fn(() => new Map()) };
  const subscriptionManager: any = { ensureSubscribed: jest.fn().mockResolvedValue(undefined) };
  const themeSnapshot: any = {
    getLatestThemeItems: jest.fn().mockResolvedValue(new Map()),
    getThemeStocksForThemes: jest.fn().mockResolvedValue(new Map()),
  };
  const service = new IssueThemeService(
    prisma,
    realtimeCache,
    new CurrentPriceResolver(),
    subscriptionManager,
    {} as any,
    new ThemeMetricsService(),
    {} as any,
    themeSnapshot,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    subscriptionManager.ensureSubscribed.mockResolvedValue(undefined);
    const stockSnapshotTime = new Date('2026-07-25T06:50:00.000Z');
    const snapshotDate = new Date('2026-07-25');
    themeSnapshot.getLatestThemeItems.mockResolvedValue(new Map([
      [1, { themeCode: 1, rank: 1, previousRank: null, risingCount: 4, totalCount: 4,
        upCount: 4, flatCount: 0, downCount: 0, risingRatio: 100,
        avgChangeRate: 5, avgRsScore: 87.5, shortTermRs: null, momentum: null,
        newHighCount: 1, stockSnapshotTime, snapshotDate }],
      [2, { themeCode: 2, rank: 2, previousRank: null, risingCount: 2, totalCount: 3,
        upCount: 2, flatCount: 0, downCount: 1, risingRatio: 66.67,
        avgChangeRate: 1, avgRsScore: 65.67, shortTermRs: null, momentum: null,
        newHighCount: 0, stockSnapshotTime, snapshotDate }],
      [3, { themeCode: 3, rank: 3, previousRank: null, risingCount: 1, totalCount: 1,
        upCount: 1, flatCount: 0, downCount: 0, risingRatio: 100,
        avgChangeRate: 1, avgRsScore: 60, shortTermRs: null, momentum: null,
        newHighCount: 0, stockSnapshotTime, snapshotDate }],
    ]));
    prisma.theme.findMany.mockResolvedValue([
      { themeCode: 1, themeName: 'AI 로봇' },
      { themeCode: 2, themeName: '바이오' },
      { themeCode: 3, themeName: '단일 종목' },
    ]);
    prisma.company.findMany.mockResolvedValue([
      { stockCode: 'A', companyName: '에이' }, { stockCode: 'B', companyName: '비' },
      { stockCode: 'C', companyName: '씨' }, { stockCode: 'D', companyName: '디' },
      { stockCode: 'E', companyName: '이' }, { stockCode: 'F', companyName: '에프' },
      { stockCode: 'G', companyName: '지' }, { stockCode: 'H', companyName: '에이치' },
    ]);
    const stock = (stockCode: string, relativeStrengthScore: number) => ({
      stockCode, currentRank: 1, currentPrice: 100, relativeStrengthScore,
      priceChangeRate: 1, tradingValue: 100n, previousTradingValueRatio: null,
      isNewHigh: false, shortTermRs: null,
    });
    themeSnapshot.getThemeStocksForThemes.mockResolvedValue(new Map([
      [1, [stock('A', 90), stock('B', 85), stock('E', 88), stock('F', 87)]],
      [2, [stock('C', 95), stock('D', 82), stock('G', 20)]],
      [3, [stock('H', 60)]],
    ]));
    jest.spyOn(service as any, 'getFilteredMetrics').mockResolvedValue({
      tradeDate: new Date('2026-07-25'),
      metrics: [
        { stockCode: 'A', relativeStrengthScore: 90, priceChangeRate1d: 6, isNewHigh: true },
        { stockCode: 'B', relativeStrengthScore: 85, priceChangeRate1d: 4, isNewHigh: false },
        { stockCode: 'C', relativeStrengthScore: 95, priceChangeRate1d: 8, isNewHigh: false },
        { stockCode: 'D', relativeStrengthScore: 82, priceChangeRate1d: 5, isNewHigh: false },
        { stockCode: 'E', relativeStrengthScore: 88, priceChangeRate1d: 5, isNewHigh: false },
        { stockCode: 'F', relativeStrengthScore: 87, priceChangeRate1d: 5, isNewHigh: false },
        { stockCode: 'G', relativeStrengthScore: 20, priceChangeRate1d: -10, isNewHigh: false },
        { stockCode: 'H', relativeStrengthScore: 60, priceChangeRate1d: 1, isNewHigh: false },
        { stockCode: 'ZERO', relativeStrengthScore: 0, priceChangeRate1d: 20, isNewHigh: true },
      ],
    });
    prisma.stockTheme.findMany.mockImplementation(({ select }: any) => {
      if (select?.theme) {
        return Promise.resolve([
          { stockCode: 'A', stockName: '에이', themeCode: 1, theme: { themeName: 'AI 로봇' } },
          { stockCode: 'B', stockName: '비', themeCode: 1, theme: { themeName: 'AI 로봇' } },
          { stockCode: 'E', stockName: '이', themeCode: 1, theme: { themeName: 'AI 로봇' } },
          { stockCode: 'F', stockName: '에프', themeCode: 1, theme: { themeName: 'AI 로봇' } },
          { stockCode: 'ZERO', stockName: '미산출', themeCode: 1, theme: { themeName: 'AI 로봇' } },
          { stockCode: 'C', stockName: '씨', themeCode: 2, theme: { themeName: '바이오' } },
          { stockCode: 'D', stockName: '디', themeCode: 2, theme: { themeName: '바이오' } },
          { stockCode: 'G', stockName: '지', themeCode: 2, theme: { themeName: '바이오' } },
          { stockCode: 'H', stockName: '에이치', themeCode: 3, theme: { themeName: '단일 종목' } },
        ]);
      }
      return Promise.resolve([
        { stockCode: 'A', themeCode: 1 },
        { stockCode: 'B', themeCode: 1 },
        { stockCode: 'E', themeCode: 1 },
        { stockCode: 'F', themeCode: 1 },
        { stockCode: 'ZERO', themeCode: 1 },
        { stockCode: 'C', themeCode: 2 },
        { stockCode: 'D', themeCode: 2 },
        { stockCode: 'G', themeCode: 2 },
        { stockCode: 'H', themeCode: 3 },
      ]);
    });
    prisma.themeDailySnapshot.findMany.mockResolvedValue([]);
    prisma.userWatchlistTheme.findMany.mockResolvedValue([{ themeCode: 1 }]);
  });

  it('does not start realtime subscriptions while serving a finalized theme snapshot', async () => {
    await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    expect(subscriptionManager.ensureSubscribed).not.toHaveBeenCalled();
  });

  it('combines search, favorites and selected filter with AND semantics', async () => {
    const result = await service.getThemeList({
      search: 'AI', view: IssueThemeView.RANK, filter: IssueThemeFilter.CHANGE_RATE_5,
      sort: IssueThemeSort.RS, favoritesOnly: true, display: 20, page: 1,
    }, 'user-1');

    expect(result.items.map((item: any) => item.themeCode)).toEqual([1]);
    expect(result.items[0].isFavorite).toBe(true);
    expect(result.filterCounts.all).toBe(1);
    expect(result.filterCounts.changeRate5).toBe(1);
  });

  it('includes the top three RS stocks in each list item', async () => {
    const result = await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    expect(result.items.find((item: any) => item.themeCode === 1)?.topStocks).toEqual([
      { stockCode: 'A', stockName: '에이' },
      { stockCode: 'E', stockName: '이' },
      { stockCode: 'F', stockName: '에프' },
    ]);
  });

  it('includes themes and stocks below RS80 in the all filter', async () => {
    const result = await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    const theme = result.items.find((item: any) => item.themeCode === 2);
    expect(theme).toMatchObject({ stockCount: 3, eligibleStockCount: 3, rsScore: 65.67 });
    expect(result.items.find((item: any) => item.themeCode === 3)).toMatchObject({
      stockCount: 1, eligibleStockCount: 1, rsScore: 60,
    });
  });

  it('excludes zero RS stocks from theme list counts and metrics', async () => {
    const result = await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    expect(result.items.find((item: any) => item.themeCode === 1)).toMatchObject({
      stockCount: 4,
      eligibleStockCount: 4,
      rsScore: 87.5,
      changeRate: 5,
      newHighCount: 1,
    });
  });

  it('applies RS80 to the average theme RS only when selected', async () => {
    const result = await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.RS80, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    expect(result.items.map((item: any) => item.themeCode)).toEqual([1]);
  });

  it('loads only latest RS metrics that pass the realtime-chart dynamic filters', async () => {
    (service as any).getFilteredMetrics.mockRestore();
    const tradeDate = new Date('2026-07-25');
    prisma.stockDailyMetrics.findFirst.mockResolvedValue({ tradeDate });
    prisma.stockDailyMetrics.findMany.mockResolvedValue([
      {
        stockCode: 'PASS', relativeStrengthScore: 90, closePrice: 80,
        lowPrice52w: 50, highPrice52w: 100, ma50: 70,
      },
      {
        stockCode: 'LOW52', relativeStrengthScore: 99, closePrice: 64,
        lowPrice52w: 50, highPrice52w: 80, ma50: 60,
      },
      {
        stockCode: 'HIGH52', relativeStrengthScore: 98, closePrice: 74,
        lowPrice52w: 50, highPrice52w: 100, ma50: 60,
      },
      {
        stockCode: 'MA50', relativeStrengthScore: 97, closePrice: 70,
        lowPrice52w: 50, highPrice52w: 90, ma50: 70,
      },
    ]);
    realtimeCache.getPrices.mockReturnValue(new Map());

    const result = await (service as any).getFilteredMetrics();

    expect(result.metrics.map((metric: any) => metric.stockCode)).toEqual(['PASS']);
    expect(prisma.stockDailyMetrics.findMany).toHaveBeenCalledWith({
      where: { tradeDate, relativeStrengthScore: { gt: 0 } },
    });
  });

  it('requires authentication for favorites', async () => {
    await expect(service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: true, display: 20, page: 1,
    })).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses the canonical theme snapshot for current theme ranks and counts', async () => {
    themeSnapshot.getLatestThemeItems.mockResolvedValue(new Map([[34, {
      themeCode: 34, rank: 34, previousRank: 4, risingCount: 5, totalCount: 7,
      upCount: 5, flatCount: 0, downCount: 2, risingRatio: 71.43,
      avgChangeRate: 6.89, avgRsScore: 67.29, shortTermRs: 70,
      momentum: 2, newHighCount: 1, stockSnapshotTime: new Date('2026-08-10T06:50:00Z'),
      snapshotDate: new Date('2026-08-10'),
    }]]));

    const result = await service.getCurrentThemeRankMap([34]);

    expect(result.get(34)).toMatchObject({
      rank: 34, rankChange: -30, totalCount: 7, risingCount: 5,
      upCount: 5, flatCount: 0, downCount: 2,
    });
  });

  it('builds the list without reading daily metrics or realtime prices', async () => {
    (service as any).getFilteredMetrics.mockRejectedValue(new Error('legacy metrics must not be read'));
    realtimeCache.getPrices.mockImplementation(() => { throw new Error('realtime must not be read'); });

    const result = await service.getThemeList({
      view: IssueThemeView.RANK, filter: IssueThemeFilter.ALL, sort: IssueThemeSort.RS,
      favoritesOnly: false, display: 20, page: 1,
    });

    expect(result.items).toHaveLength(3);
    expect(themeSnapshot.getThemeStocksForThemes).toHaveBeenCalledTimes(1);
  });

  it('rejects search in heatmap view', async () => {
    await expect(service.getThemeList({
      search: 'AI', view: IssueThemeView.HEATMAP, filter: IssueThemeFilter.ALL,
      sort: IssueThemeSort.RS, favoritesOnly: false, display: 20, page: 1,
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
