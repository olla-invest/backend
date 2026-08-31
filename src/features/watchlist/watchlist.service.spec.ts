import { WatchlistService } from './watchlist.service';

describe('WatchlistService theme recommendations', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

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

  it('uses exact current and previous stock snapshots for watchlist rank changes', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T07:00:00.000Z'));
    const prisma: any = {
      stockCurrentRankSnapshot: {
        findFirst: jest.fn()
          .mockResolvedValueOnce({
            tradeDate: new Date('2026-08-10'),
            snapshotTime: new Date('2026-08-10T06:50:00.000Z'),
          })
          .mockResolvedValueOnce({
            tradeDate: new Date('2026-08-09'),
            snapshotTime: new Date('2026-08-09T06:50:00.000Z'),
          }),
        findMany: jest.fn()
          .mockResolvedValueOnce([{ stockCode: '189300', currentRank: 2 }])
          .mockResolvedValueOnce([{ stockCode: '189300', currentRank: 3 }]),
      },
      stockDailyMetrics: {
        findMany: jest.fn().mockResolvedValue([{ stockCode: '189300', currentRank: 99 }]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new WatchlistService(prisma, {} as any, {} as any, {} as any) as any;

    const result = await service.getStockCurrentRankContext(
      ['189300'],
      new Date('2026-08-10'),
    );

    expect(result.currentRankMap.get('189300')).toBe(2);
    expect(result.previousRankMap.get('189300')).toBe(3);
    expect(prisma.stockDailyMetrics.findMany).not.toHaveBeenCalled();
  });

  it('includes canonical theme rank change and rise-flat-fall counts in highlights', async () => {
    const prisma: any = {
      userWatchlistTheme: { findMany: jest.fn().mockResolvedValue([{
        themeCode: 1,
        theme: { themeCode: 1, themeName: '국내 상장 중국기업', imageUrl: null },
      }]) },
      userWatchlist: { findMany: jest.fn().mockResolvedValue([]) },
      stockDailyMetrics: { findFirst: jest.fn() },
    };
    const issueThemeService: any = {
      getCurrentThemeRankMap: jest.fn().mockResolvedValue(new Map([[1, {
        themeCode: 1, rank: 1, previousRank: 2, rankChange: 1,
        risingCount: 1, totalCount: 1, upCount: 1, flatCount: 0, downCount: 0,
      }]])),
    };
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService);

    const result = await service.getHighlights('user-1');

    expect(result.highlights[0]).toMatchObject({
      rank: 1, prevRank: 2, previousRank: 2, rankChange: 1,
      risingCount: 1, totalCount: 1, upCount: 1, flatCount: 0, downCount: 0,
    });
  });

  it('does not override an exact stock snapshot rank with a recomputed display rank', () => {
    const service = new WatchlistService({} as any, {} as any, {} as any, {} as any) as any;
    const item = service.buildStockItem(
      {
        companyId: 'company-1', addedDate: new Date(), memo: null,
        company: { stockCode: '189300', companyName: '씨이랩', marketType: 'KOSDAQ' },
      },
      { rank: 99, currentRank: 99, relativeStrengthScore: 97 },
      null,
      undefined,
      {
        tradeDate: new Date('2026-08-10'), snapshotTime: new Date('2026-08-10T06:50:00Z'),
        currentRankMap: new Map([['189300', 2]]),
        previousRankMap: new Map([['189300', 3]]),
      },
      new Map([['189300', 6]]),
    );

    expect(item).toMatchObject({ rank: 2, prevRank: 3, rankChange: 1 });
  });

  it('returns null instead of a dash for a missing numeric rank', () => {
    const service = new WatchlistService({} as any, {} as any, {} as any, {} as any) as any;
    const item = service.buildStockItem(
      {
        companyId: 'company-1', addedDate: new Date(), memo: null,
        company: { stockCode: '189300', companyName: '씨이랩', marketType: 'KOSDAQ' },
      },
      { relativeStrengthScore: 97 },
      null,
      undefined,
      {
        tradeDate: new Date('2026-08-10'), snapshotTime: new Date('2026-08-10T06:50:00Z'),
        currentRankMap: new Map([['189300', 2]]), previousRankMap: new Map(),
      },
    );

    expect(item.prevRank).toBeNull();
    expect(item.rankChange).toBeNull();
  });

  it('serves watchlist theme counts and previous rank from the canonical map only', async () => {
    const prisma: any = {
      userWatchlistTheme: { findMany: jest.fn().mockResolvedValue([{
        themeCode: 2, addedDate: new Date(),
        theme: { themeCode: 2, themeName: '시멘트/레미콘', imageUrl: null },
      }]) },
      themeDailySnapshot: {
        findFirst: jest.fn(() => { throw new Error('legacy snapshot must not be read'); }),
      },
    };
    const issueThemeService: any = {
      getCurrentThemeRankMap: jest.fn().mockResolvedValue(new Map([[2, {
        themeCode: 2, rank: 2, previousRank: 4, rankChange: 2,
        risingCount: 1, totalCount: 1, upCount: 1, flatCount: 0, downCount: 0,
      }]])),
    };
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService);

    const result = await service.getWatchlistThemes('user-1');

    expect(result.themes[0]).toMatchObject({
      rank: 2, prevRank: 4, risingCount: 1, totalCount: 1,
      upCount: 1, flatCount: 0, downCount: 0,
    });
    expect(prisma.themeDailySnapshot.findFirst).not.toHaveBeenCalled();
  });
});
