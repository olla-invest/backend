import { RedisPriceStoreService } from './redis-price-store.service';
const mockClient = {
  isReady: true,
  isOpen: true,
  on: jest.fn(),
  connect: jest.fn(),
  hGetAll: jest.fn(),
  hmGet: jest.fn(),
  multi: jest.fn(),
  eval: jest.fn(),
  destroy: jest.fn(),
};
jest.mock('redis', () => ({ createClient: () => mockClient }));
describe('Redis price command recovery', () => {
  afterEach(() => jest.useRealTimers());
  it('bounds stalled commands and allows a subsequent refresh to reconnect', async () => {
    jest.useFakeTimers();
    mockClient.isReady = true;
    mockClient.isOpen = true;
    mockClient.destroy.mockImplementation(() => {
      mockClient.isReady = false;
      mockClient.isOpen = false;
    });
    mockClient.connect.mockImplementation(async () => {
      mockClient.isReady = true;
      mockClient.isOpen = true;
    });
    mockClient.hGetAll
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue({});
    const store = new RedisPriceStoreService({
      get: (_key: string, fallback?: unknown) => fallback,
    } as any);
    const result = store.load().catch((e) => e.message);
    await jest.advanceTimersByTimeAsync(6000);
    expect(mockClient.destroy).toHaveBeenCalled();
    expect(await result).toContain('timeout');
    expect(await store.load()).toEqual([]);
    expect(mockClient.connect).toHaveBeenCalled();
    await store.close();
  });

  it('reads and writes shared fallback prices in a per-date hash that expires', async () => {
    mockClient.isReady = true;
    mockClient.isOpen = true;
    const chain = { hSet: jest.fn(), expire: jest.fn(), exec: jest.fn().mockResolvedValue([]) };
    chain.hSet.mockReturnValue(chain);
    chain.expire.mockReturnValue(chain);
    mockClient.multi.mockReturnValue(chain);
    mockClient.hmGet.mockResolvedValue(['{"a":1}', null]);
    const store = new RedisPriceStoreService({
      get: (_key: string, fallback?: unknown) => fallback,
    } as any);

    const loaded = await store.loadFallbackPrices('2026-10-15', ['041830', '000660']);
    await store.saveFallbackPrices('2026-10-15', new Map([['041830', '{"a":2}']]));

    expect(mockClient.hmGet).toHaveBeenCalledWith('olla:realtime:prices:live:v1:fallback:2026-10-15', ['041830', '000660']);
    expect([...loaded]).toEqual([['041830', '{"a":1}']]);
    expect(chain.hSet).toHaveBeenCalledWith('olla:realtime:prices:live:v1:fallback:2026-10-15', { '041830': '{"a":2}' });
    expect(chain.expire).toHaveBeenCalledWith('olla:realtime:prices:live:v1:fallback:2026-10-15', 2 * 86400);
    await store.close();
  });
});
