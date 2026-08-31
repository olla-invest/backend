import { WatchlistService } from './watchlist.service';

describe('WatchlistService theme recommendations', () => {
  it('uses canonical current rank and counts instead of legacy theme snapshot values', async () => {
    const legacy = {
      themeCode: 34, rank: 4, risingCount: 1, totalCount: 3,
      upCount: 1, flatCount: 1, downCount: 1,
    };
    const prisma: any = {
      stockTheme: { findMany: jest.fn().mockResolvedValue([{ themeCode: 34 }]) },
      themeDailySnapshot: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({ snapshotDate: new Date('2026-08-10') })
          .mockResolvedValueOnce(legacy)
          .mockResolvedValueOnce({ snapshotDate: new Date('2026-08-10') })
          .mockResolvedValueOnce({ rank: 35 }),
      },
      theme: { findFirst: jest.fn().mockResolvedValue({
        themeCode: 34, themeName: 'OLED(유기 발광 다이오드)', imageUrl: null,
      }) },
    };
    const issueThemeService: any = {
      getCurrentThemeRankMap: jest.fn().mockResolvedValue(new Map([[34, {
        themeCode: 34, rank: 34, previousRank: 35, risingCount: 5, totalCount: 7,
        upCount: 5, flatCount: 0, downCount: 2,
      }]])),
    };
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService);

    const result = await (service as any).recommendTheme(
      [{ company: { stockCode: 'OLED-A' } }],
      new Set<number>(),
      0,
    );

    expect(result).toMatchObject({
      themeName: 'OLED(유기 발광 다이오드)', rank: 34, totalCount: 7,
      risingCount: 5, upCount: 5, flatCount: 0, downCount: 2,
    });
  });
});
