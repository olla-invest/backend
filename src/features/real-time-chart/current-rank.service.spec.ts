import { CurrentPriceResolver } from './current-price-resolver.service';
import { CurrentRankService } from './current-rank.service';

describe('CurrentRankService price selection', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('uses the metric close when a cached tick is stale', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:20:01.000Z'));
    const realtimeCache = {
      getPrice: jest.fn().mockReturnValue({
        stockCode: '041830', currentPrice: 31_500, changeAmount: 500,
        changeRate: 1.61, volume: 1, accVolume: 1, accAmount: 1,
        openPrice: 31_000, highPrice: 31_700, lowPrice: 30_800,
        timestamp: new Date('2026-08-05T01:00:00.000Z'),
      }),
    };
    const service = new CurrentRankService(
      {} as any,
      realtimeCache as any,
      new CurrentPriceResolver(),
    ) as any;

    const rows = service.buildRankRows([
      {
        stock_code: '041830', trade_date: new Date('2026-08-04'), close_price: '30800',
        relative_strength_score: '90', rank: 1, high_price_52w: '35000',
        low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
        price_change_1d: '750', trading_value: 12_000n, is_new_high: false,
        short_term_rs: '88.67',
      },
    ], new Date('2026-08-05'), new Date('2026-08-05T01:20:00.000Z'), new Map([
      ['041830', 4_800n],
    ]));

    expect(rows[0]).toMatchObject({
      currentPrice: 30_800,
      closePrice: 30_800,
      priceSource: 'close',
      priceChangeRate: 2.5,
      priceChange1d: 750,
      tradingValue: 12_000n,
      previousTradingValueRatio: 2.5,
      isNewHigh: false,
      shortTermRs: 88.67,
    });
  });

  it('persists every theme aggregation fact in the stock snapshot row', async () => {
    const prisma = { $executeRawUnsafe: jest.fn().mockResolvedValue(1) };
    const service = new CurrentRankService(
      prisma as any,
      { getPrice: jest.fn() } as any,
      new CurrentPriceResolver(),
    ) as any;

    await service.saveSnapshotRows([{
      stockCode: '041830',
      tradeDate: '2026-08-05',
      snapshotTime: '2026-08-05T06:50:00.000Z',
      currentRank: 1,
      relativeStrengthScore: 90,
      currentPrice: 30_800,
      closePrice: 30_800,
      highPrice52w: 35_000,
      lowPrice52w: 20_000,
      ma50: 25_000,
      passedDynamicFilters: true,
      priceSource: 'close',
      priceChangeRate: 2.5,
      priceChange1d: 750,
      tradingValue: 12_000n,
      previousTradingValueRatio: 2.5,
      isNewHigh: false,
      shortTermRs: 88.67,
    }]);

    const [sql, ...params] = prisma.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('price_change_rate');
    expect(sql).toContain('previous_trading_value_ratio');
    expect(sql).toContain('short_term_rs');
    expect(sql).toContain('price_change_1d');
    expect(params).toEqual(expect.arrayContaining([2.5, 750, 12_000n, false]));
  });

  it('uses the live tick change amount when a fresh tick is usable', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T01:20:01.000Z'));
    const realtimeCache = {
      getPrice: jest.fn().mockReturnValue({
        stockCode: '041830', currentPrice: 31_500, changeAmount: 700,
        changeRate: 2.27, volume: 1, accVolume: 1, accAmount: 24_000,
        openPrice: 31_000, highPrice: 31_700, lowPrice: 30_800,
        timestamp: new Date('2026-08-05T01:20:00.000Z'),
      }),
    };
    const service = new CurrentRankService(
      {} as any,
      realtimeCache as any,
      new CurrentPriceResolver(),
    ) as any;

    const rows = service.buildRankRows([
      {
        stock_code: '041830', trade_date: new Date('2026-08-05'), close_price: '30800',
        relative_strength_score: '90', rank: 1, high_price_52w: '35000',
        low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
        price_change_1d: '750', trading_value: 12_000n, is_new_high: false,
        short_term_rs: '88.67',
      },
    ], new Date('2026-08-05'), new Date('2026-08-05T01:20:00.000Z'), new Map());

    expect(rows[0]).toMatchObject({
      priceSource: 'realtime',
      priceChangeRate: 2.27,
      priceChange1d: 700,
    });
  });

  it('compares trading value against the previous day at the same time of day', async () => {
    const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue([]) };
    const service = new CurrentRankService(
      prisma as any,
      { getPrice: jest.fn() } as any,
      new CurrentPriceResolver(),
    ) as any;

    await service.getPreviousTradingValues(
      new Date('2026-08-10'),
      new Date('2026-08-10T01:20:00.000Z'),
    );

    const [sql, ...params] = prisma.$queryRawUnsafe.mock.calls[0];
    expect(sql).toContain('snapshot_time::time');
    expect(params).toEqual(['2026-08-10', '01:20:00']);
  });

  it('rebuilds a historical closing snapshot without using the realtime cache', async () => {
    const realtimeCache = { getPrice: jest.fn(() => { throw new Error('realtime must not be read'); }) };
    const service = new CurrentRankService(
      {} as any,
      realtimeCache as any,
      new CurrentPriceResolver(),
    ) as any;
    jest.spyOn(service, 'getStaticFilteredMetrics').mockResolvedValue([{
      stock_code: '041830', trade_date: new Date('2026-08-10'), close_price: '30800',
      relative_strength_score: '90', rank: 1, high_price_52w: '35000',
      low_price_52w: '20000', ma_50: '25000', price_change_rate_1d: '2.5',
      price_change_1d: '750', trading_value: 12_000n, is_new_high: false,
      short_term_rs: '88.67',
    }]);
    jest.spyOn(service, 'getPreviousTradingValues').mockResolvedValue(new Map());
    const save = jest.spyOn(service, 'saveSnapshotRows').mockResolvedValue(undefined);

    const result = await service.rebuildClosingSnapshot(new Date('2026-08-10'));

    expect(result).toMatchObject({
      success: true,
      tradeDate: '2026-08-10',
      snapshotTime: '2026-08-10T06:50:00.000Z',
    });
    expect(save.mock.calls[0][0][0]).toMatchObject({
      currentPrice: 30_800,
      priceSource: 'close',
    });
    expect(realtimeCache.getPrice).not.toHaveBeenCalled();
  });
});
