import { RedisPriceStoreService } from './redis-price-store.service';
const mockClient = {
  isReady: true,
  isOpen: true,
  on: jest.fn(),
  connect: jest.fn(),
  hGetAll: jest.fn(),
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
});
