import { IssueThemeStockSort } from './dto/issue-theme-detail-query.dto';
import { IssueThemeService } from './issue-theme.service';
import { ThemeMetricsService } from './theme-metrics.service';

describe('IssueThemeService detail stock population', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('excludes zero RS stocks from the detail list and theme counts', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:20:01.000Z'));
    const prisma: any = {
      theme: {
        findFirst: jest.fn().mockResolvedValue({ themeName: 'AI 로봇', imageUrl: null }),
      },
      stockTheme: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: 'HIGH', stockName: '고RS', inclusionReason: null },
          { stockCode: 'LOW', stockName: '저RS', inclusionReason: null },
          { stockCode: 'ZERO', stockName: '미산출', inclusionReason: null },
        ]),
      },
      company: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: 'HIGH', companyName: '고RS' },
          { stockCode: 'LOW', companyName: '저RS' },
          { stockCode: 'ZERO', companyName: '미산출' },
        ]),
      },
      stockDailyMetrics: { findMany: jest.fn().mockResolvedValue([]) },
      themeDailySnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const realtimeCache: any = {
      getPrices: jest.fn(() => new Map([
        ['HIGH', {
          stockCode: 'HIGH', currentPrice: -100, changeAmount: -200, changeRate: -2,
          volume: 1, accVolume: 1, accAmount: 1, openPrice: 100,
          highPrice: 100, lowPrice: 90,
          timestamp: new Date('2026-08-05T01:20:00.000Z'),
        }],
      ])),
    };
    const themeAiSummary: any = { getLatestSuccess: jest.fn().mockResolvedValue(null) };
    const service = new IssueThemeService(
      prisma,
      realtimeCache,
      {} as any,
      new ThemeMetricsService(),
      themeAiSummary,
      { getLatestThemeItems: jest.fn().mockResolvedValue(new Map()), getThemeStocks: jest.fn().mockResolvedValue([
        { stockCode: 'HIGH', currentRank: 1, currentPrice: 100, relativeStrengthScore: 90,
          priceChangeRate: 2, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: null },
        { stockCode: 'LOW', currentRank: 2, currentPrice: 200, relativeStrengthScore: 70,
          priceChangeRate: -1, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: null },
      ]) } as any,
    );
    jest.spyOn(service, 'getCurrentThemeRankMap').mockResolvedValue(new Map([[1, {
      rank: 1, previousRank: null, rankChange: null, risingCount: 1, totalCount: 2,
      rsScore: 80, avgRsScore: 80, changeRate: 0.5, newHighCount: 0,
      shortTermRs: null, momentum: null, stockSnapshotTime: new Date('2026-07-25T06:50:00Z'),
      snapshotDate: new Date('2026-07-25'),
    }]]));

    const result = await service.getThemeDetail(1, undefined, {
      stockSort: IssueThemeStockSort.RS,
      stockDisplay: 20,
    });

    expect(result?.totalCount).toBe(2);
    expect(result?.avgRsScore).toBe(80);
    expect(result?.stocks.map((stock: any) => ({ stockCode: stock.stockCode, rsScore: stock.rsScore }))).toEqual([
      { stockCode: 'HIGH', rsScore: 90 },
      { stockCode: 'LOW', rsScore: 70 },
    ]);
    expect(result?.stocks.find((stock: any) => stock.stockCode === 'HIGH')).toMatchObject({
      currentPrice: 100,
      closePrice: 100,
      priceSource: 'STOCK_SNAPSHOT',
    });
  });

  it('returns and sorts complete three-trading-day stock RS averages', async () => {
    const prisma: any = {
      theme: {
        findFirst: jest.fn().mockResolvedValue({ themeName: 'AI 로봇', imageUrl: null }),
      },
      stockTheme: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: 'A', stockName: '에이', inclusionReason: null },
          { stockCode: 'B', stockName: '비', inclusionReason: null },
          { stockCode: 'C', stockName: '씨', inclusionReason: null },
        ]),
      },
      company: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: 'A', companyName: '에이' },
          { stockCode: 'B', companyName: '비' },
          { stockCode: 'C', companyName: '씨' },
        ]),
      },
      stockDailyMetrics: {
        findMany: jest.fn()
          .mockResolvedValueOnce([
            { tradeDate: new Date('2026-07-25') },
            { tradeDate: new Date('2026-07-24') },
            { tradeDate: new Date('2026-07-23') },
          ])
          .mockResolvedValueOnce([
            { stockCode: 'A', tradeDate: new Date('2026-07-23'), relativeStrengthScore: 70 },
            { stockCode: 'A', tradeDate: new Date('2026-07-24'), relativeStrengthScore: 80 },
            { stockCode: 'A', tradeDate: new Date('2026-07-25'), relativeStrengthScore: 90 },
            { stockCode: 'B', tradeDate: new Date('2026-07-23'), relativeStrengthScore: 80 },
            { stockCode: 'B', tradeDate: new Date('2026-07-24'), relativeStrengthScore: 90 },
            { stockCode: 'B', tradeDate: new Date('2026-07-25'), relativeStrengthScore: 100 },
            { stockCode: 'C', tradeDate: new Date('2026-07-24'), relativeStrengthScore: 99 },
            { stockCode: 'C', tradeDate: new Date('2026-07-25'), relativeStrengthScore: 99 },
          ]),
      },
      themeDailySnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const realtimeCache: any = { getPrices: jest.fn(() => new Map()) };
    const themeAiSummary: any = { getLatestSuccess: jest.fn().mockResolvedValue(null) };
    const service = new IssueThemeService(
      prisma,
      realtimeCache,
      {} as any,
      new ThemeMetricsService(),
      themeAiSummary,
      { getLatestThemeItems: jest.fn().mockResolvedValue(new Map()), getThemeStocks: jest.fn().mockResolvedValue([
        { stockCode: 'A', currentRank: 1, currentPrice: 100, relativeStrengthScore: 90,
          priceChangeRate: 1, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: 80 },
        { stockCode: 'B', currentRank: 2, currentPrice: 200, relativeStrengthScore: 95,
          priceChangeRate: 1, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: 90 },
        { stockCode: 'C', currentRank: 3, currentPrice: 300, relativeStrengthScore: 99,
          priceChangeRate: 1, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: null },
      ]) } as any,
    );
    jest.spyOn(service, 'getCurrentThemeRankMap').mockResolvedValue(new Map([[1, {
      rank: 1, previousRank: null, rankChange: null, risingCount: 3, totalCount: 3,
      rsScore: 94.67, avgRsScore: 94.67, changeRate: 1, newHighCount: 0,
      shortTermRs: null, momentum: null, stockSnapshotTime: new Date('2026-07-25T06:50:00Z'),
      snapshotDate: new Date('2026-07-25'),
    }]]));

    const result = await service.getThemeDetail(1, undefined, {
      stockSort: IssueThemeStockSort.SHORT_TERM_RS,
      stockDisplay: 20,
    });

    expect(result?.stocks.map((stock: any) => ({ stockCode: stock.stockCode, shortTermRs: stock.shortTermRs }))).toEqual([
      { stockCode: 'B', shortTermRs: 90 },
      { stockCode: 'A', shortTermRs: 80 },
      { stockCode: 'C', shortTermRs: null },
    ]);
    expect(prisma.stockDailyMetrics.findMany).not.toHaveBeenCalled();
  });
  it('derives price change amount, new-high gap, and related themes from the stock snapshot', async () => {
    const snapshotItem = (themeCode: number, rank: number, avgRsScore: number) => ({
      themeCode, rank, previousRank: null, risingCount: 2, totalCount: 3,
      upCount: 2, flatCount: 0, downCount: 1, risingRatio: 66.67,
      avgChangeRate: 1.5, avgRsScore, shortTermRs: 85, momentum: 2.5, newHighCount: 1,
      stockSnapshotTime: new Date('2026-08-10T06:50:00.000Z'),
      snapshotDate: new Date('2026-08-10'),
    });
    const snapshotStock = (stockCode: string, overrides: any = {}) => ({
      stockCode, currentRank: 1, currentPrice: 100, relativeStrengthScore: 90,
      priceChangeRate: 5, priceChange1d: 5, tradingValue: 1000n,
      previousTradingValueRatio: 2, isNewHigh: false, highPrice52w: 125,
      shortTermRs: 88, ...overrides,
    });
    const prisma: any = {
      theme: {
        findFirst: jest.fn().mockResolvedValue({ themeName: 'OLED', imageUrl: null }),
        findMany: jest.fn().mockResolvedValue([
          { themeCode: 1, themeName: 'OLED' },
          { themeCode: 2, themeName: '2차전지' },
        ]),
      },
      stockTheme: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: 'A', stockName: '에이', inclusionReason: 'OLED 소재' },
        ]),
      },
      company: {
        findMany: jest.fn().mockResolvedValue([{ stockCode: 'A', companyName: '에이' }]),
      },
      stockDailyMetrics: {
        findMany: jest.fn(() => { throw new Error('daily metrics must not be read'); }),
        findFirst: jest.fn(() => { throw new Error('daily metrics must not be read'); }),
      },
      themeDailySnapshot: {
        findFirst: jest.fn(() => { throw new Error('legacy theme snapshot must not be read'); }),
      },
    };
    const themeSnapshot: any = {
      getLatestThemeItems: jest.fn().mockResolvedValue(new Map([
        [1, snapshotItem(1, 34, 90)],
        [2, snapshotItem(2, 40, 82)],
      ])),
      getThemeStocks: jest.fn().mockResolvedValue([
        snapshotStock('A'),
        snapshotStock('B', { currentRank: 2, priceChange1d: -3, highPrice52w: null }),
        snapshotStock('C', { currentRank: 3, priceChange1d: null, highPrice52w: 200 }),
      ]),
      getThemeStocksForThemes: jest.fn().mockResolvedValue(new Map([
        [1, [snapshotStock('A'), snapshotStock('B'), snapshotStock('C')]],
        [2, [snapshotStock('A'), snapshotStock('B'), snapshotStock('D')]],
      ])),
    };
    const service = new IssueThemeService(
      prisma,
      { getPrices: jest.fn(() => new Map()) } as any,
      {} as any,
      new ThemeMetricsService(),
      { getLatestSuccess: jest.fn().mockResolvedValue(null) } as any,
      themeSnapshot,
    );

    const result = await service.getThemeDetail(1, undefined, {
      stockSort: IssueThemeStockSort.RS,
      stockDisplay: 20,
    });

    const stocks = new Map(result!.stocks.map((stock: any) => [stock.stockCode, stock]));
    expect(stocks.get('A')).toMatchObject({ priceChange1d: 5, newHighRate: -20 });
    expect(stocks.get('B')).toMatchObject({ priceChange1d: -3, newHighRate: null });
    expect(stocks.get('C')).toMatchObject({ priceChange1d: null, newHighRate: -50 });
    expect(result?.relatedThemes).toEqual([{
      themeCode: 2,
      themeName: '2차전지',
      sharedStockCount: 2,
      similarity: 0.5,
      rsScore: 82,
      changeRate: 1.5,
      signal: 'STRONG',
    }]);
  });
});
