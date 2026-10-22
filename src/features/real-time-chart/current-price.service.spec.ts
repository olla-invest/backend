import { CurrentPriceResolver } from './current-price-resolver.service';
import { CurrentPriceService } from './current-price.service';
import { RealtimePrice } from './realtime-price-cache.service';

const tick = (overrides: Partial<RealtimePrice> = {}): RealtimePrice => ({
  stockCode: '041830',
  currentPrice: 31_500,
  changeAmount: 700,
  changeRate: 2.27,
  volume: 10,
  accVolume: 100,
  accAmount: 5_684,
  openPrice: 31_000,
  highPrice: 31_700,
  lowPrice: 30_800,
  timestamp: new Date('2026-10-15T01:00:00.000Z'),
  ...overrides,
});

const candle = (stockCode: string, candleDate: string, closePrice: string, overrides: Record<string, unknown> = {}) => ({
  stockCode,
  candleDate,
  openPrice: '30000',
  highPrice: '31000',
  lowPrice: '29500',
  closePrice,
  volume: 1_000n,
  tradingValue: 30_000_000_000n,
  ...overrides,
});

// Redis 공유 폴백 hash 를 흉내 낸다 (priceDate 별 hash, 필드 = 종목코드).
const fakePriceStore = () => {
  const hashes = new Map<string, Map<string, string>>();
  return {
    hashes,
    loadFallbackPrices: jest.fn(async (priceDate: string, codes: string[]) => {
      const hash = hashes.get(priceDate) ?? new Map<string, string>();
      return new Map(codes.filter((code) => hash.has(code)).map((code) => [code, hash.get(code)!]));
    }),
    saveFallbackPrices: jest.fn(async (priceDate: string, entries: Map<string, string>) => {
      const hash = hashes.get(priceDate) ?? new Map<string, string>();
      entries.forEach((value, code) => hash.set(code, value));
      hashes.set(priceDate, hash);
    }),
  };
};

const build = (options: {
  ticks?: RealtimePrice[];
  candles?: ReturnType<typeof candle>[];
  basicInfo?: Record<string, string>;
  priceStore?: ReturnType<typeof fakePriceStore>;
} = {}) => {
  const ticks = new Map((options.ticks ?? []).map((t) => [t.stockCode, t]));
  const prisma = { $queryRawUnsafe: jest.fn().mockResolvedValue(options.candles ?? []) };
  const kiwoomRest = { getStockBasicInfo: jest.fn().mockResolvedValue(options.basicInfo ?? {}) };
  const priceStore = options.priceStore ?? fakePriceStore();
  const service = new CurrentPriceService(
    prisma as any,
    { getPrice: (code: string) => ticks.get(code) } as any,
    new CurrentPriceResolver(),
    kiwoomRest as any,
    priceStore as any,
  );
  return { service, prisma, kiwoomRest, priceStore };
};

describe('CurrentPriceService', () => {
  const duringSession = new Date('2026-10-15T04:00:00.000Z'); // 13:00 KST

  it('uses a same-day tick, even an old one, without touching the database', async () => {
    const { service, prisma } = build({ ticks: [tick()] });

    const price = await service.getCurrentPrice('041830', { now: duringSession });

    expect(price).toMatchObject({
      source: 'REALTIME',
      priceDate: '2026-10-15',
      currentPrice: 31_500,
      changeAmount: 700,
      changeRate: 2.27,
      tradingValue: 5_684_000_000n,
    });
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('falls back to the same-day day candle and compares it with the previous candle', async () => {
    const { service, prisma } = build({
      candles: [candle('041830', '2026-10-15', '30600'), candle('041830', '2026-10-14', '30000')],
    });

    const price = await service.getCurrentPrice('041830', { now: duringSession });

    expect(price).toMatchObject({
      source: 'DAY_CANDLE',
      currentPrice: 30_600,
      changeAmount: 600,
      changeRate: 2,
      highPrice: 31_000,
      tradingValue: 30_000_000_000n,
    });
    expect(prisma.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([['041830'], '2026-10-15']);
  });

  it('shows the base price with no change when the stock has not traded on the price date', async () => {
    const { service, kiwoomRest } = build({
      candles: [candle('041830', '2026-10-14', '30000'), candle('041830', '2026-10-13', '29000')],
    });

    const price = await service.getCurrentPrice('041830', { now: duringSession });

    expect(price).toMatchObject({ source: 'BASE_PRICE', currentPrice: 30_000, changeAmount: 0, changeRate: 0, tradingValue: 0n });
    expect(kiwoomRest.getStockBasicInfo).not.toHaveBeenCalled();
  });

  it('fetches a missing quote from Kiwoom once and shares it through Redis', async () => {
    const { service, kiwoomRest } = build({
      candles: [candle('041830', '2026-10-14', '30000')],
      basicInfo: { cur_prc: '+30900', base_pric: '30000', open_pric: '+30100', high_pric: '+31000', low_pric: '-29900', trde_qty: '1234' },
    });

    const first = await service.getCurrentPrice('041830', { now: duringSession, fetchMissing: true });
    const second = await service.getCurrentPrice('041830', { now: duringSession, fetchMissing: true });

    expect(first).toMatchObject({ source: 'KIWOOM', currentPrice: 30_900, changeAmount: 900, changeRate: 3, lowPrice: 29_900, accVolume: 1234n });
    expect(second).toEqual(first);
    expect(kiwoomRest.getStockBasicInfo).toHaveBeenCalledTimes(1);
  });

  it('does not call Kiwoom before the open, when the price date is the previous trading day', async () => {
    const { service, kiwoomRest } = build({ candles: [candle('041830', '2026-10-13', '30000')] });

    const price = await service.getCurrentPrice('041830', {
      now: new Date('2026-10-14T23:30:00.000Z'), // 10/15 08:30 KST
      fetchMissing: true,
    });

    expect(price).toMatchObject({ source: 'BASE_PRICE', priceDate: '2026-10-14' });
    expect(kiwoomRest.getStockBasicInfo).not.toHaveBeenCalled();
  });

  it('queries the database only for stocks without a usable tick', async () => {
    const { service, prisma } = build({
      ticks: [tick()],
      candles: [candle('000660', '2026-10-15', '200000'), candle('000660', '2026-10-14', '190000')],
    });

    const prices = await service.getCurrentPrices(['041830', '000660'], { now: duringSession });

    expect(prices.get('041830')?.source).toBe('REALTIME');
    expect(prices.get('000660')?.source).toBe('DAY_CANDLE');
    expect(prisma.$queryRawUnsafe.mock.calls[0][1]).toEqual(['000660']);
  });

  it('serves the next request and other instances from the Redis fallback for a minute', async () => {
    const priceStore = fakePriceStore();
    const candles = [candle('000660', '2026-10-15', '200000'), candle('000660', '2026-10-14', '190000')];
    const first = build({ candles, priceStore });
    const otherInstance = build({ candles, priceStore });

    const original = await first.service.getCurrentPrice('000660', { now: duringSession });
    const shared = await otherInstance.service.getCurrentPrice('000660', { now: new Date(duringSession.getTime() + 59_000) });
    const expired = await otherInstance.service.getCurrentPrice('000660', { now: new Date(duringSession.getTime() + 61_000) });

    expect(shared).toEqual(original);
    expect(shared?.tradingValue).toBe(30_000_000_000n);
    expect(first.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(otherInstance.prisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(expired?.source).toBe('DAY_CANDLE');
  });

  it('does not answer a Kiwoom-backed request with a base price cached without checking Kiwoom', async () => {
    const priceStore = fakePriceStore();
    const candles = [candle('041830', '2026-10-14', '30000')];
    const basicInfo = { cur_prc: '+30900', base_pric: '30000' };
    const list = build({ candles, basicInfo, priceStore });
    const watchlist = build({ candles, basicInfo, priceStore });

    expect((await list.service.getCurrentPrice('041830', { now: duringSession }))?.source).toBe('BASE_PRICE');
    expect((await watchlist.service.getCurrentPrice('041830', { now: duringSession, fetchMissing: true }))?.source).toBe('KIWOOM');
    // 키움 결과가 공유되므로, 이제 키움을 쓰지 않는 화면도 같은 가격을 본다.
    expect((await list.service.getCurrentPrice('041830', { now: duringSession }))?.currentPrice).toBe(30_900);
    expect(watchlist.kiwoomRest.getStockBasicInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps answering from the database when Redis is unavailable', async () => {
    const priceStore = fakePriceStore();
    priceStore.loadFallbackPrices.mockRejectedValue(new Error('Redis down'));
    priceStore.saveFallbackPrices.mockRejectedValue(new Error('Redis down'));
    const { service } = build({
      candles: [candle('041830', '2026-10-15', '30600'), candle('041830', '2026-10-14', '30000')],
      priceStore,
    });

    expect((await service.getCurrentPrice('041830', { now: duringSession }))?.currentPrice).toBe(30_600);
  });

  describe('after the close', () => {
    const afterClose = new Date('2026-10-15T13:00:00.000Z'); // 22:00 KST
    const missedCloseTick = tick({ timestamp: new Date('2026-10-15T05:17:00.000Z') }); // 14:17 KST, 서버 중단으로 종가를 놓침

    it('uses the day candle close instead of a tick that missed the closing print', async () => {
      const { service } = build({
        ticks: [missedCloseTick],
        candles: [candle('041830', '2026-10-15', '30600'), candle('041830', '2026-10-14', '30000')],
      });

      const price = await service.getCurrentPrice('041830', { now: afterClose });

      expect(price).toMatchObject({ source: 'DAY_CANDLE', currentPrice: 30_600 });
    });

    it('keeps the tick when it caught the closing print', async () => {
      const { service, prisma } = build({ ticks: [tick({ timestamp: new Date('2026-10-15T06:30:05.000Z') })] });

      const price = await service.getCurrentPrice('041830', { now: afterClose });

      expect(price?.source).toBe('REALTIME');
      expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    });

    it('falls back to the last tick rather than the base price when the day candle is missing', async () => {
      const { service } = build({ ticks: [missedCloseTick], candles: [candle('041830', '2026-10-14', '30000')] });

      const price = await service.getCurrentPrice('041830', { now: afterClose });

      expect(price).toMatchObject({ source: 'REALTIME', currentPrice: 31_500 });
    });

    it('still trusts an older same-day tick during the session', async () => {
      const { service } = build({ ticks: [missedCloseTick], candles: [candle('041830', '2026-10-15', '30600')] });

      const price = await service.getCurrentPrice('041830', { now: new Date('2026-10-15T06:00:00.000Z') }); // 15:00 KST

      expect(price?.source).toBe('REALTIME');
    });
  });

  it('keeps the upper-limit sign from the tick only when it matches the direction', async () => {
    const { service } = build({ ticks: [tick({ changeSign: '1' }), tick({ stockCode: '000660', changeSign: '4' })] });

    const prices = await service.getCurrentPrices(['041830', '000660'], { now: duringSession });

    expect(prices.get('041830')?.changeSign).toBe('1');
    expect(prices.get('000660')?.changeSign).toBe('2');
  });
});
