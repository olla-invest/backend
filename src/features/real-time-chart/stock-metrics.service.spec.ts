import { StockMetricsService } from './stock-metrics.service';

describe('StockMetricsService realtime subscription candidates', () => {
  it('returns every latest static-filter candidate without a fixed top-200 cut', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({
      stockCode: String(index).padStart(6, '0'),
    }));
    const prisma = {
      stockDailyMetrics: {
        findFirst: jest.fn().mockResolvedValue({ tradeDate: new Date('2026-08-05') }),
        findMany: jest.fn().mockImplementation(({ take }: { take?: number }) =>
          Promise.resolve(take == null ? rows : rows.slice(0, take)),
        ),
      },
    };
    const service = new StockMetricsService(prisma as any, {} as any);

    const result = await service.getFilteredStockCodes();

    expect(result).toHaveLength(250);
  });
});
