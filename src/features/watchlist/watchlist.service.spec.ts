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
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any);

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

  it('compares the latest snapshot rank with the finalized closing rank the chart shows as D-1', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-10T07:00:00.000Z'));
    const prisma: any = {
      stockCurrentRankSnapshot: {
        findFirst: jest.fn().mockResolvedValue({
          tradeDate: new Date('2026-08-10'),
          snapshotTime: new Date('2026-08-10T06:50:00.000Z'),
        }),
        findMany: jest.fn().mockResolvedValue([{ stockCode: '189300', currentRank: 2 }]),
      },
      stockDailyMetrics: {
        findMany: jest.fn().mockResolvedValue([{ stockCode: '189300', currentRank: 3 }]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new WatchlistService(prisma, {} as any, {} as any, {} as any, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any) as any;

    const result = await service.getStockCurrentRankContext(
      ['189300'],
      new Date('2026-08-10'),
    );

    expect(result.currentRankMap.get('189300')).toBe(2);
    expect(result.previousRankMap.get('189300')).toBe(3);
    // 직전 거래일의 마지막 스냅샷(당일 지표로 다시 매긴 순위)은 D-1이 아니다.
    expect(prisma.stockCurrentRankSnapshot.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.stockDailyMetrics.findMany).toHaveBeenCalledWith({
      where: { stockCode: { in: ['189300'] }, tradeDate: new Date('2026-08-10') },
      select: { stockCode: true, currentRank: true },
    });
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
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any);

    const result = await service.getHighlights('user-1');

    expect(result.highlights[0]).toMatchObject({
      rank: 1, prevRank: 2, previousRank: 2, rankChange: 1,
      risingCount: 1, totalCount: 1, upCount: 1, flatCount: 0, downCount: 0,
    });
  });

  it('does not override an exact stock snapshot rank with a recomputed display rank', () => {
    const service = new WatchlistService({} as any, {} as any, {} as any, {} as any, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any) as any;
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

  it('leaves the previous rank empty for a new entry so the screen shows "-"', () => {
    const service = new WatchlistService({} as any, {} as any, {} as any, {} as any, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any) as any;
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

    // 신규 진입은 직전 순위를 현재 순위로 채우지 않는다 (채우면 '1→1' 처럼 D-1 에 1위가 둘로 보인다).
    expect(item.rank).toBe(2);
    expect(item.prevRank).toBeNull();
    expect(item.rankChange).toBeNull();
  });

  it('shows the same-day current price and never the previous-day metric close', () => {
    const service = new WatchlistService({} as any, {} as any, {} as any, {} as any, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any) as any;
    const entry = {
      companyId: 'company-1', addedDate: new Date(), memo: null,
      company: { stockCode: '189300', companyName: '씨이랩', marketType: 'KOSDAQ' },
    };
    const metric = { relativeStrengthScore: 97, closePrice: '30000', priceChange1d: '500', priceChangeRate1d: '1.7', highPrice52w: '31000' };

    const priced = service.buildStockItem(entry, metric, null, {
      stockCode: '189300', priceDate: '2026-10-19', source: 'DAY_CANDLE',
      currentPrice: 31_500, changeAmount: 1_500, changeRate: 5,
      openPrice: 30_000, highPrice: 31_600, lowPrice: 29_900, accVolume: 1n, tradingValue: 1n,
    });
    const unpriced = service.buildStockItem(entry, metric, null, undefined);

    expect(priced).toMatchObject({
      closePrice: 31_500, priceChange1d: 1_500, priceChangeRate1d: 5, priceSource: 'DAY_CANDLE', isNewHigh: true,
    });
    expect(unpriced).toMatchObject({ closePrice: null, priceChange1d: null, priceChangeRate1d: null, priceSource: null });
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
    const service = new WatchlistService(prisma, {} as any, {} as any, issueThemeService, { ensureSubscribed: jest.fn().mockResolvedValue(undefined) } as any);

    const result = await service.getWatchlistThemes('user-1');

    expect(result.themes[0]).toMatchObject({
      rank: 2, prevRank: 4, risingCount: 1, totalCount: 1,
      upCount: 1, flatCount: 0, downCount: 0,
    });
    expect(prisma.themeDailySnapshot.findFirst).not.toHaveBeenCalled();
  });
});

describe('WatchlistService new-high flag', () => {
  const isAtNewHigh = (WatchlistService.prototype as any).isAtNewHigh;

  it('drops the previous day new-high flag once the current price is below the 52-week high', () => {
    expect(isAtNewHigh(31_000, { highPrice52w: '32000.00', isNewHigh: true })).toBe(false);
    expect(isAtNewHigh(32_000, { highPrice52w: '32000.00', isNewHigh: false })).toBe(true);
  });
});
