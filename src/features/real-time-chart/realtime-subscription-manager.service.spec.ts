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

describe('reconnect subscription restoration', () => {
  it('does not duplicate subscriptions already being restored by the websocket', async () => {
    const source = {isConnected: () => true, subscribeBatch: jest.fn()};
    const manager = new RealtimeSubscriptionManager(source as any, {getSubscribedStocks: () => []} as any, {getFilteredStockCodes: async () => ['020120']} as any);
    await manager.subscribeFilteredStocks({stockCodes: ['020120']});
    expect(source.subscribeBatch).not.toHaveBeenCalled();
  });
});

describe('server-managed realtime subscriptions', () => {
  const makeManager = (subscribed: string[]) => {
    const source = {
      isConnected: () => true,
      subscribe: jest.fn().mockResolvedValue(undefined),
      subscribeBatch: jest.fn().mockResolvedValue(undefined),
    };
    const cache = { getSubscribedStocks: jest.fn(() => subscribed) };
    const metrics = { getFilteredStockCodes: async () => ['000001', '000002'] };
    const manager = new RealtimeSubscriptionManager(source as any, cache as any, metrics as any);
    return { manager, source, cache };
  };

  it('marks realtime-chart stocks as managed but not detail-page auto-subscriptions', async () => {
    const { manager } = makeManager([]);
    await manager.subscribeFilteredStocks();
    await manager.ensureSubscribed(['000003']);
    await manager.ensureSubscribed(['000009'], { manage: false });

    expect(['000001', '000002', '000003'].every((code) => manager.isManaged(code))).toBe(true);
    expect(manager.isManaged('000009')).toBe(false);
  });

  it('re-subscribes a managed stock once it is no longer in the subscribed ledger', async () => {
    const { manager, source, cache } = makeManager(['000001', '000002']);
    await manager.ensureSubscribed(['000001', '000002']);
    expect(source.subscribeBatch).not.toHaveBeenCalled();

    // Kiwoom confirmed a REMOVE for 000002, so the ledger no longer lists it.
    cache.getSubscribedStocks.mockReturnValue(['000001']);
    await manager.ensureSubscribed(['000001', '000002']);
    expect(source.subscribeBatch).toHaveBeenCalledWith(['000002'], ['0B', '0D']);
  });
});

describe('RealtimeSubscriptionManager without Kiwoom', () => {
  it('skips subscriptions quietly when KIWOOM_ENABLED=false', async () => {
    const source = { isConnected: jest.fn(() => false), subscribeBatch: jest.fn() };
    const config = { get: (key: string, fallback: string) => (key === 'KIWOOM_ENABLED' ? 'false' : fallback) };
    const manager = new RealtimeSubscriptionManager(source as any, {} as any, {} as any, config as any);
    const warn = jest.spyOn((manager as any).logger, 'warn');

    await manager.ensureSubscribed(['005930']);

    expect(source.isConnected).not.toHaveBeenCalled();
    expect(source.subscribeBatch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
