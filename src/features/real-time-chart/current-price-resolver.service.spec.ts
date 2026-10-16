import { CurrentPriceResolver } from './current-price-resolver.service';
import { RealtimePrice } from './realtime-price-cache.service';

const tick = (overrides: Partial<RealtimePrice> = {}): RealtimePrice => ({
  stockCode: '041830',
  currentPrice: 31_500,
  changeAmount: 500,
  changeRate: 1.61,
  volume: 10,
  accVolume: 100,
  accAmount: 3_000_000,
  openPrice: 31_000,
  highPrice: 31_700,
  lowPrice: 30_800,
  timestamp: new Date('2026-08-05T01:00:00.000Z'),
  ...overrides,
});

describe('CurrentPriceResolver', () => {
  const resolver = new CurrentPriceResolver();

  it('accepts a same-day tick no older than ten minutes during the KRX session', () => {
    const result = resolver.getUsableRealtimePrice(
      tick(),
      new Date('2026-08-05T01:09:59.000Z'),
    );

    expect(result?.currentPrice).toBe(31_500);
  });

  it('rejects a tick older than ten minutes', () => {
    const result = resolver.getUsableRealtimePrice(
      tick(),
      new Date('2026-08-05T01:10:01.000Z'),
    );

    expect(result).toBeUndefined();
  });

  it('rejects an intraday tick that is not from the latest trading day', () => {
    const result = resolver.getUsableRealtimePrice(
      tick(),
      new Date('2026-08-06T06:31:00.000Z'),
    );

    expect(result).toBeUndefined();
  });

  it.each(['2026-10-02T07:00:00Z', '2026-10-03T03:00:00Z', '2026-10-05T03:00:00Z', '2026-10-06T23:50:00Z'])('keeps the latest trading day price at %s', (time) => {
    const lastTick = tick({ timestamp: new Date(time === '2026-10-06T23:50:00Z' ? '2026-10-06T06:30:00Z' : '2026-10-02T06:30:00Z') });
    expect(resolver.getUsableRealtimePrice(lastTick, new Date(time))).toBe(lastTick);
  });

  it('rejects future timestamps and holiday ticks', () => {
    expect(resolver.getUsableRealtimePrice(tick({ timestamp: new Date('2026-10-06T03:01:00Z') }), new Date('2026-10-06T03:00:00Z'))).toBeUndefined();
    expect(resolver.getUsableRealtimePrice(tick({ timestamp: new Date('2026-10-05T03:00:00Z') }), new Date('2026-10-05T03:01:00Z'))).toBeUndefined();
  });

  it('keeps the closing-auction print but rejects after-hours ticks after close', () => {
    const now = new Date('2026-10-06T10:40:00Z');
    const closing = tick({ timestamp: new Date('2026-10-06T06:30:30Z') });
    expect(resolver.getUsableRealtimePrice(closing, now)).toBe(closing);
    // 16:28 and 18:00 KST: after-hours single-price trades, not the official close.
    expect(resolver.getUsableRealtimePrice(tick({ timestamp: new Date('2026-10-06T07:28:00Z') }), now)).toBeUndefined();
    expect(resolver.getUsableRealtimePrice(tick({ timestamp: new Date('2026-10-06T09:00:00Z') }), now)).toBeUndefined();
  });

  it('rejects zero and non-finite current prices', () => {
    const now = new Date('2026-08-05T01:05:00.000Z');

    expect(resolver.getUsableRealtimePrice(tick({ currentPrice: 0 }), now)).toBeUndefined();
    expect(
      resolver.getUsableRealtimePrice(tick({ currentPrice: Number.NaN }), now),
    ).toBeUndefined();
  });

  it('uses metric close and daily changes when the tick is stale', () => {
    const result = resolver.resolveMetricSnapshot(
      {
        closePrice: 30_800,
        priceChange1d: -200,
        priceChangeRate1d: -0.65,
      },
      tick(),
      new Date('2026-08-05T01:10:01.000Z'),
    );

    expect(result).toEqual({
      currentPrice: 30_800,
      closePrice: 30_800,
      changeRate: -0.65,
      priceChange1d: -200,
      priceChangeRate1d: -0.65,
      usedRealtime: false,
    });
  });

  it('uses open-to-current changes for a usable tick', () => {
    const result = resolver.resolveMetricSnapshot(
      {
        closePrice: 30_800,
        priceChange1d: -200,
        priceChangeRate1d: -0.65,
      },
      tick(),
      new Date('2026-08-05T01:05:00.000Z'),
    );

    expect(result).toEqual({
      currentPrice: 31_500,
      closePrice: 31_500,
      changeRate: (500 / 31_000) * 100,
      priceChange1d: 500,
      priceChangeRate1d: (500 / 31_000) * 100,
      usedRealtime: true,
    });
  });
});
