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
  };
  const realtimeCache: any = { getPrices: jest.fn(() => new Map()) };
  const service = new IssueThemeService(
    prisma,
    realtimeCache,
    new CurrentPriceResolver(),
    {} as any,
    new ThemeMetricsService(),
    {} as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('loads every latest metric that has an RS score', async () => {
    (service as any).getFilteredMetrics.mockRestore();
    const tradeDate = new Date('2026-07-25');
    prisma.stockDailyMetrics.findFirst.mockResolvedValue({ tradeDate });
    prisma.stockDailyMetrics.findMany.mockResolvedValue([
      { stockCode: 'HIGH', relativeStrengthScore: 90 },
      { stockCode: 'LOW', relativeStrengthScore: 70 },
    ]);

    const result = await (service as any).getFilteredMetrics();

    expect(result.metrics.map((metric: any) => metric.stockCode)).toEqual(['HIGH', 'LOW']);
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

  it('rejects search in heatmap view', async () => {
    await expect(service.getThemeList({
      search: 'AI', view: IssueThemeView.HEATMAP, filter: IssueThemeFilter.ALL,
      sort: IssueThemeSort.RS, favoritesOnly: false, display: 20, page: 1,
    })).rejects.toBeInstanceOf(BadRequestException);
  });
});
