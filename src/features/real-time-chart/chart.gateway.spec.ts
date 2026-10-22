import { ChartGateway } from './chart.gateway';

describe('ChartGateway releases', () => {
  const makeGateway = (managed: string[]) => {
    const realtimeSource = {
      subscribe: jest.fn().mockResolvedValue(undefined),
      unsubscribe: jest.fn().mockResolvedValue(undefined),
    };
    const subscriptionManager = { isManaged: (code: string) => managed.includes(code) };
    const gateway = new ChartGateway(
      realtimeSource as any,
      { getCurrentPrice: jest.fn().mockResolvedValue(undefined) } as any,
      subscriptionManager as any,
    );
    return { gateway, realtimeSource };
  };
  const client = (id: string) => ({ id, join: jest.fn(), leave: jest.fn(), emit: jest.fn() });

  it('keeps a realtime-chart stock registered when its last detail viewer leaves', async () => {
    const { gateway, realtimeSource } = makeGateway(['351320']);
    const viewer = client('a');
    gateway.handleConnection(viewer as any);
    await gateway.handleSubscribe(viewer as any, { stockCode: '351320' });

    await gateway.handleUnsubscribe(viewer as any, { stockCode: '351320' });
    await gateway.handleSubscribe(viewer as any, { stockCode: '351320' });
    gateway.handleDisconnect(viewer as any);

    expect(realtimeSource.unsubscribe).not.toHaveBeenCalled();
  });

  it('releases a detail-only stock once no viewer needs it', async () => {
    const { gateway, realtimeSource } = makeGateway([]);
    const first = client('a');
    const second = client('b');
    gateway.handleConnection(first as any);
    gateway.handleConnection(second as any);
    await gateway.handleSubscribe(first as any, { stockCode: '005930' });
    await gateway.handleSubscribe(second as any, { stockCode: '005930' });

    gateway.handleDisconnect(first as any);
    expect(realtimeSource.unsubscribe).not.toHaveBeenCalled();
    await gateway.handleUnsubscribe(second as any, { stockCode: '005930' });
    expect(realtimeSource.unsubscribe).toHaveBeenCalledWith('005930');
  });
});

describe('ChartGateway prices', () => {
  afterEach(() => jest.useRealTimers());

  const makeGateway = (price?: Record<string, unknown>) => {
    const currentPriceService = { getCurrentPrice: jest.fn().mockResolvedValue(price) };
    const gateway = new ChartGateway(
      { subscribe: jest.fn().mockResolvedValue(undefined) } as any,
      currentPriceService as any,
      { isManaged: () => false } as any,
    );
    const roomEmit = jest.fn();
    gateway.server = { to: jest.fn(() => ({ emit: roomEmit })), emit: jest.fn() } as any;
    return { gateway, currentPriceService, roomEmit };
  };
  const tick = { stockCode: '003010', type: '0B', values: { '10': '+10860', '11': '410', '12': '3.92', '20': '153000' } };

  it('sends the subscribe snapshot from the shared current price', async () => {
    const { gateway, currentPriceService } = makeGateway({
      currentPrice: 10860, changeRate: 3.92, changeAmount: 410, openPrice: 10540, highPrice: 12660, lowPrice: 10510, accVolume: 7459215n,
    });
    const client = { id: 'a', join: jest.fn(), emit: jest.fn() };
    gateway.handleConnection(client as any);

    await gateway.handleSubscribe(client as any, { stockCode: '003010' });

    expect(currentPriceService.getCurrentPrice).toHaveBeenCalledWith('003010', { fetchMissing: true });
    expect(client.emit).toHaveBeenCalledWith('snapshot', expect.objectContaining({ price: 10860, changeRate: 3.92, accVolume: 7459215 }));
  });

  it('broadcasts regular-session ticks only', () => {
    const { gateway, roomEmit } = makeGateway();

    jest.useFakeTimers().setSystemTime(new Date('2026-10-22T06:30:10.000Z'));
    gateway.handleRealtimeTick(tick);
    expect(roomEmit).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-10-22T07:10:00.000Z'));
    gateway.handleRealtimeTick(tick);
    expect(roomEmit).toHaveBeenCalledTimes(1);
    expect(gateway.server.emit).toHaveBeenCalledTimes(1);
  });
});
