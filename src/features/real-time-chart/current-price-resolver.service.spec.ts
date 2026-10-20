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

  it('accepts a same-day tick during the KRX session', () => {
    const result = resolver.getUsableRealtimePrice(
      tick(),
      new Date('2026-08-05T01:09:59.000Z'),
    );

    expect(result?.currentPrice).toBe(31_500);
  });

  // 체결이 뜸한 종목의 마지막 tick 도 그날의 현재가다. 버리면 전일 종가로 떨어진다.
  it('keeps a same-day tick even after a long quiet period', () => {
    const result = resolver.getUsableRealtimePrice(
      tick(),
      new Date('2026-08-05T04:10:01.000Z'),
    );

    expect(result?.currentPrice).toBe(31_500);
  });

  it('checks the tick against an explicit price date', () => {
    expect(resolver.getUsableRealtimePrice(tick(), new Date('2026-08-05T04:00:00Z'), '2026-08-05')).toBeDefined();
    expect(resolver.getUsableRealtimePrice(tick(), new Date('2026-08-05T04:00:00Z'), '2026-08-04')).toBeUndefined();
  });

  it.each([
    ['08:59 KST on a trading day', '2026-10-06T23:59:00Z', '2026-10-06'],
    ['09:00 KST on a trading day', '2026-10-07T00:00:00Z', '2026-10-07'],
    ['after the close', '2026-10-07T12:00:00Z', '2026-10-07'],
    ['a Saturday', '2026-10-10T03:00:00Z', '2026-10-08'],
  ])('uses the right price date at %s', (_label, now, expected) => {
    expect(resolver.getPriceDateKey(new Date(now))).toBe(expected);
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
});
