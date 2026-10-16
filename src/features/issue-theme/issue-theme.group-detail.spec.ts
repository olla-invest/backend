import { NotFoundException } from '@nestjs/common';
import { readFile } from 'fs/promises';
import { IssueThemeStockSort } from './dto/issue-theme-detail-query.dto';
import { IssueThemeService } from './issue-theme.service';
import { ThemeMetricsService } from './theme-metrics.service';

// grouping_theme.json does not exist on the servers; group requests must never touch it.
jest.mock('fs/promises', () => ({
  readFile: jest.fn(() => Promise.reject(new Error('grouping file must not be read'))),
}));

describe('IssueThemeService grouped theme detail', () => {
  const makeService = () => {
    const prisma: any = {
      theme: {
        findFirst: jest.fn(({ where }) => Promise.resolve(
          where.themeCode === 200051 && where.source === 'GROUP' ? { themeName: '남북경협', imageUrl: null } : null,
        )),
      },
      themeGroupTheme: {
        findMany: jest.fn().mockResolvedValue([{ themeCode: 100121 }, { themeCode: 100398 }]),
      },
      stockTheme: {
        findMany: jest.fn().mockResolvedValue([
          { stockCode: '119850', stockName: '지엔씨에너지', inclusionReason: null },
        ]),
      },
      company: { findMany: jest.fn().mockResolvedValue([{ stockCode: '119850', companyName: '지엔씨에너지' }]) },
      stockDailyMetrics: { findMany: jest.fn().mockResolvedValue([]) },
      themeDailySnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new IssueThemeService(
      prisma,
      { getPrices: jest.fn(() => new Map()), getPrice: jest.fn(() => undefined) } as any,
      { getUsableRealtimePrice: () => undefined } as any,
      {} as any,
      new ThemeMetricsService(),
      { getLatestSuccess: jest.fn().mockResolvedValue(null) } as any,
      {
        getLatestThemeItems: jest.fn().mockResolvedValue(new Map()),
        getThemeStocks: jest.fn().mockResolvedValue([
          { stockCode: '119850', currentRank: 5, currentPrice: 53500, relativeStrengthScore: 93,
            priceChangeRate: -2.37, tradingValue: null, previousTradingValueRatio: null, isNewHigh: false, shortTermRs: null },
        ]),
      } as any,
    );
    jest.spyOn(service, 'getCurrentThemeRankMap').mockResolvedValue(new Map([[200051, {
      rank: 14, previousRank: null, rankChange: null, risingCount: 0, totalCount: 1,
      rsScore: 93, avgRsScore: 93, changeRate: -2.37, newHighCount: 0,
      shortTermRs: 95, momentum: 1, stockSnapshotTime: new Date('2026-10-02T06:50:00Z'),
      snapshotDate: new Date('2026-10-02'),
    }]]) as any);
    return { service, prisma };
  };

  it('builds the group detail from the stored group and its child-theme links', async () => {
    const { service, prisma } = makeService();

    const result = await service.getThemeDetail(200051, undefined, {
      stockSort: IssueThemeStockSort.RS,
      stockDisplay: 20,
    });

    expect(result?.themeName).toBe('남북경협');
    expect(prisma.stockTheme.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { themeCode: { in: [100121, 100398] }, source: 'NAVER' },
    }));
    expect(result?.stocks.map((stock: any) => stock.stockCode)).toEqual(['119850']);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('answers 404 for a group that is not stored instead of failing on the missing file', async () => {
    const { service } = makeService();

    await expect(service.getThemeDetail(200099)).rejects.toBeInstanceOf(NotFoundException);
    expect(readFile).not.toHaveBeenCalled();
  });
});
