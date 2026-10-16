import { RealtimePriceCacheService } from './realtime-price-cache.service';

const price = (timestamp = '2026-10-06T06:30:00Z') => ({
  stockCode: '020120',
  currentPrice: 8230,
  timestamp: new Date(timestamp),
});
describe('shared realtime price cache', () => {
  const makeStore = () => ({
    load: jest.fn().mockResolvedValue([]),
    save: jest.fn().mockResolvedValue(undefined),
    close: jest.fn(),
  });
  afterEach(() => jest.useRealTimers());
  it('restores prices after restart without claiming websocket subscriptions', async () => {
    jest.useFakeTimers();
    const store = makeStore();
    store.load.mockResolvedValue([price()]);
    const cache = new RealtimePriceCacheService(store as any);
    await cache.onModuleInit();
    expect(cache.getPrice('020120')?.currentPrice).toBe(8230);
    expect(cache.getSubscribedStocks()).toEqual([]);
    await cache.onModuleDestroy();
  });
  it('coalesces ticks, retries failed Redis writes, and retains prices on unsubscribe', async () => {
    jest.useFakeTimers();
    const store = makeStore();
    store.save.mockRejectedValueOnce(new Error('Redis unavailable'));
    const cache = new RealtimePriceCacheService(store as any);
    await cache.onModuleInit();
    cache.setPrice(price() as any);
    cache.setPrice({ ...price(), currentPrice: 8240 } as any);
    await cache.flushPrices();
    await cache.flushPrices();
    expect(store.save).toHaveBeenLastCalledWith([
      expect.objectContaining({ currentPrice: 8240 }),
    ]);
    cache.removeSubscription('020120');
    expect(cache.getPrice('020120')?.currentPrice).toBe(8240);
    await cache.onModuleDestroy();
  });
  it('ignores after-hours ticks so the closing tick is retained', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T10:00:00Z') });
    const store = makeStore();
    const cache = new RealtimePriceCacheService(store as any);
    await cache.onModuleInit();
    cache.setPrice(price() as any);
    cache.setPrice({ ...price('2026-10-06T07:30:00Z'), currentPrice: 8100 } as any);
    expect(cache.getPrice('020120')?.currentPrice).toBe(8230);
    await cache.onModuleDestroy();
  });
  it('refreshes shared prices without overwriting newer local ticks', async () => {
    jest.useFakeTimers();
    const store = makeStore();
    const cache = new RealtimePriceCacheService(store as any);
    await cache.onModuleInit();
    cache.setPrice(price() as any);
    store.load.mockResolvedValue([
      { ...price('2026-10-06T06:20:00Z'), currentPrice: 8090 },
    ]);
    await cache.refreshPrices();
    expect(cache.getPrice('020120')?.currentPrice).toBe(8230);
    store.load.mockResolvedValue([
      { ...price('2026-10-06T06:31:00Z'), currentPrice: 8250 },
    ]);
    await cache.refreshPrices();
    expect(cache.getPrice('020120')?.currentPrice).toBe(8250);
    await cache.onModuleDestroy();
  });
  it('drops released stocks from the subscribed ledger but keeps their last price', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-06T10:00:00Z') });
    const store = makeStore();
    const cache = new RealtimePriceCacheService(store as any);
    await cache.onModuleInit();
    cache.setPrice(price() as any);
    cache.handleSubscriptionConfirmed({ stockCodes: ['020120', '351320'] });
    cache.handleSubscriptionRemoved({ stockCodes: ['020120'] });
    expect(cache.getSubscribedStocks()).toEqual(['351320']);
    expect(cache.getPrice('020120')?.currentPrice).toBe(8230);
    await cache.onModuleDestroy();
  });
});

