import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { IssueThemeService } from './issue-theme.service';
import { ThemeMetricsService } from './theme-metrics.service';
import { IssueThemeFilter, IssueThemeSort, IssueThemeView } from './dto/issue-theme-list-query.dto';

describe('IssueThemeService enhanced list', () => {
  const prisma: any = {
    stockTheme: { findMany: jest.fn() },
    themeDailySnapshot: { findMany: jest.fn() },
    userWatchlistTheme: { findMany: jest.fn() },
  };
  const realtimeCache: any = { getPrices: jest.fn(() => new Map()) };
  const service = new IssueThemeService(prisma, realtimeCache, {} as any, new ThemeMetricsService(), {} as any);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(service as any, 'getFilteredMetrics').mockResolvedValue({
      tradeDate: new Date('2026-07-25'),
      metrics: [
        { stockCode: 'A', relativeStrengthScore: 90, priceChangeRate1d: 6, isNewHigh: true },
        { stockCode: 'B', relativeStrengthScore: 85, priceChangeRate1d: 4, isNewHigh: false },
        { stockCode: 'C', relativeStrengthScore: 95, priceChangeRate1d: 8, isNewHigh: false },
        { stockCode: 'D', relativeStrengthScore: 82, priceChangeRate1d: 5, isNewHigh: false },
      ],
    });
    prisma.stockTheme.findMany.mockResolvedValue([
      { stockCode: 'A', themeCode: 1, theme: { themeName: 'AI 로봇' } },
      { stockCode: 'B', themeCode: 1, theme: { themeName: 'AI 로봇' } },
      { stockCode: 'C', themeCode: 2, theme: { themeName: '바이오' } },
      { stockCode: 'D', themeCode: 2, theme: { themeName: '바이오' } },
    ]);
    prisma.themeDailySnapshot.findMany.mockResolvedValue([]);
    prisma.userWatchlistTheme.findMany.mockResolvedValue([{ themeCode: 1 }]);
  });

  it('combines search, favorites and selected filter with AND semantics', async () => {
    const result = await service.getThemeList({
      search: 'AI', view: IssueThemeView.RANK, filter: IssueThemeFilter.CHANGE_RATE_5,
      sort: IssueThemeSort.RS, favoritesOnly: true, display: 20, page: 1,
    }, 'user-1');

    expect(result.items.map((item: any) => item.themeCode)).toEqual([1]);
    expect(result.filterCounts.all).toBe(1);
    expect(result.filterCounts.changeRate5).toBe(1);
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
