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
        low_price_52w: '20000', ma_50: '25000',
      },
    ], new Date('2026-08-05'), new Date('2026-08-05T01:20:00.000Z'));

    expect(rows[0]).toMatchObject({
      currentPrice: 30_800,
      closePrice: 30_800,
      priceSource: 'close',
    });
  });
});
