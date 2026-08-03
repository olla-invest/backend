import { RealTimeChartService } from './real-time-chart.service';

describe('RealTimeChartService stock list RS ordering', () => {
  it('ranks higher RS scores first and uses current rank then stock code for ties', async () => {
    const metricsService = {
      getLatestMetrics: jest.fn().mockResolvedValue(new Map([
        ['LOW', {
          relativeStrengthScore: 91,
          currentRank: 1,
          rank: 1,
          passedStaticFilters: true,
          closePrice: 100,
        }],
        ['TIE-B', {
          relativeStrengthScore: 97,
          currentRank: 3,
          rank: 3,
          passedStaticFilters: true,
          closePrice: 100,
        }],
        ['TIE-A', {
          relativeStrengthScore: 97,
          currentRank: 2,
          rank: 2,
          passedStaticFilters: true,
          closePrice: 100,
        }],
      ])),
      getLatestTradeDate: jest.fn().mockResolvedValue(new Date('2026-08-03T00:00:00.000Z')),
      getCurrentRankTotals: jest.fn().mockResolvedValue([]),
      getCurrentRankHistory: jest.fn().mockResolvedValue(new Map()),
    };
    const chartStorage = {
      getLatestClosingPrices: jest.fn().mockResolvedValue(new Map()),
    };
    const realtimeCache = { getPrices: jest.fn().mockReturnValue(new Map()) };
    const service = new RealTimeChartService(
      {} as any,
      {} as any,
      chartStorage as any,
      metricsService as any,
      realtimeCache as any,
      {} as any,
      {} as any,
    ) as any;
    service.fetchStockList = jest.fn().mockResolvedValue([
      { code: 'LOW', name: '낮은 점수', marketCode: '0' },
      { code: 'TIE-B', name: '동점 후순위', marketCode: '0' },
      { code: 'TIE-A', name: '동점 선순위', marketCode: '0' },
    ]);
    service.getThemeFilteredStockCodes = jest.fn().mockResolvedValue(undefined);
    service.getNaverThemesByStockCodes = jest.fn().mockResolvedValue(new Map());
    service.getNaverThemeList = jest.fn().mockResolvedValue([]);
    service.autoSubscribeStocks = jest.fn().mockResolvedValue(undefined);

    const result = await service.getStockList('all', 1, 10);

    expect(result.stocks.map((stock: any) => ({
      stockCode: stock.stockCode,
      rank: stock.rank,
      relativeStrengthScore: stock.relativeStrengthScore,
    }))).toEqual([
      { stockCode: 'TIE-A', rank: 1, relativeStrengthScore: 97 },
      { stockCode: 'TIE-B', rank: 2, relativeStrengthScore: 97 },
      { stockCode: 'LOW', rank: 3, relativeStrengthScore: 91 },
    ]);
  });
});
