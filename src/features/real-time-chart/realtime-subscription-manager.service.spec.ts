import { RealtimeSubscriptionManager } from './realtime-subscription-manager.service';

describe('RealtimeSubscriptionManager', () => {
  const realtimeSource = {
    isConnected: jest.fn(() => true),
    subscribe: jest.fn().mockResolvedValue(undefined),
    subscribeBatch: jest.fn().mockResolvedValue(undefined),
  };
  const realtimeCache = {
    getSubscribedStocks: jest.fn(() => ['000001']),
  };
  const metricsService = {
    getFilteredStockCodes: jest.fn().mockResolvedValue(['000001', '000002']),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    realtimeSource.isConnected.mockReturnValue(true);
    realtimeCache.getSubscribedStocks.mockReturnValue(['000001']);
    metricsService.getFilteredStockCodes.mockResolvedValue(['000001', '000002']);
  });

  it('deduplicates requested codes and subscribes only missing stocks', async () => {
    const manager = new RealtimeSubscriptionManager(
      realtimeSource as any,
      realtimeCache as any,
      metricsService as any,
    );

    await manager.ensureSubscribed(['000001', '000002', '000002', '000003']);

    expect(realtimeSource.subscribeBatch).toHaveBeenCalledWith(
      ['000002', '000003'],
      ['0B', '0D'],
    );
  });

  it('subscribes every static-filter candidate instead of truncating the set', async () => {
    const codes = Array.from({ length: 250 }, (_, index) => String(index).padStart(6, '0'));
    metricsService.getFilteredStockCodes.mockResolvedValue(codes);
    realtimeCache.getSubscribedStocks.mockReturnValue([]);
    const manager = new RealtimeSubscriptionManager(
      realtimeSource as any,
      realtimeCache as any,
      metricsService as any,
    );

    await manager.subscribeFilteredStocks();

    expect(realtimeSource.subscribeBatch).toHaveBeenCalledWith(codes, ['0B', '0D']);
  });

  it('does not submit subscriptions while the realtime source is disconnected', async () => {
    realtimeSource.isConnected.mockReturnValue(false);
    const manager = new RealtimeSubscriptionManager(
      realtimeSource as any,
      realtimeCache as any,
      metricsService as any,
    );

    await manager.ensureSubscribed(['000002']);

    expect(realtimeSource.subscribeBatch).not.toHaveBeenCalled();
  });
});
