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
      { getPrice: () => undefined } as any,
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
