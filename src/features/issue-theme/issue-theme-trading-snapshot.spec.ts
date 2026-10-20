import { CurrentPriceResolver } from '../real-time-chart/current-price-resolver.service';
import { IssueThemeService } from './issue-theme.service';
describe('trading value snapshots', () => {
  afterEach(() => jest.useRealTimers());
  it.each(['2026-10-05T03:00:00Z', '2026-10-06T06:40:00Z'])(
    'does not save cached prices outside the trading session at %s',
    async (now) => {
      jest.useFakeTimers().setSystemTime(new Date(now));
      const prisma = { stockTradingValueSnapshot: { createMany: jest.fn() } };
      const cache = {
        getAllPrices: () =>
          new Map([
            [
              '020120',
              { accAmount: 1000, currentPrice: 8230, timestamp: new Date(now) },
            ],
          ]),
      };
      const service = new IssueThemeService(
        prisma as any,
        cache as any,
        new CurrentPriceResolver(),
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { getCurrentPrices: jest.fn().mockResolvedValue(new Map()) } as any,
      );
      await service.saveTradingValueSnapshot();
      expect(
        prisma.stockTradingValueSnapshot.createMany,
      ).not.toHaveBeenCalled();
    },
  );
});
