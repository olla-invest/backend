import { KiwoomWebSocketService } from './kiwoom-websocket.service';
import WebSocket from 'ws';
describe('Kiwoom connection health', () => {
  it('does not report an unauthenticated open socket as connected', () => {
    const service = new KiwoomWebSocketService(
      { get: () => 'wss://example.test' } as any,
      {} as any,
      {} as any,
    ) as any;
    service.ws = { readyState: WebSocket.OPEN };
    expect(service.isConnected()).toBe(false);
    service.isLoggedIn = true;
    expect(service.isConnected()).toBe(true);
  });
});

describe('Kiwoom LOGIN protocol', () => {
  afterEach(() => jest.useRealTimers());
  const makeService = () => {
    const service = new KiwoomWebSocketService(
      { get: () => 'wss://example.test' } as any,
      {} as any,
      { emit: jest.fn() } as any,
    ) as any;
    service.ws = {
      readyState: WebSocket.OPEN,
      close: jest.fn(),
      terminate: jest.fn(),
      send: jest.fn(),
      ping: jest.fn(),
    };
    return service;
  };
  it('requires a successful LOGIN response, not a REG or REAL message', () => {
    const service = makeService();
    service.onMessage(
      Buffer.from(JSON.stringify({ trnm: 'REG', return_code: 0 })),
    );
    expect(service.isConnected()).toBe(false);
  });
  it('closes rejected LOGIN sockets so normal reconnection can recover', () => {
    const service = makeService();
    service.onMessage(
      Buffer.from(
        JSON.stringify({
          trnm: 'LOGIN',
          return_code: 1,
          return_msg: 'rejected',
        }),
      ),
    );
    expect(service.ws.terminate).toHaveBeenCalled();
    expect(service.isConnected()).toBe(false);
  });
  it('closes a socket whose LOGIN never completes', () => {
    jest.useFakeTimers();
    const service = makeService();
    service.onOpen();
    jest.advanceTimersByTime(15000);
    expect(service.ws.terminate).toHaveBeenCalled();
    service.onModuleDestroy();
  });
});

describe('socket replacement during restoration', () => {
  afterEach(() => jest.useRealTimers());
  it('does not send an old restoration batch into a replacement connection', async () => {
    jest.useFakeTimers();
    const service = new KiwoomWebSocketService({get: () => 'wss://example.test'} as any, {} as any, {emit: jest.fn()} as any) as any;
    const original = {readyState: WebSocket.OPEN};
    service.ws = original; service.isLoggedIn = true;
    service.subscriptions = new Map(Array.from({length: 101}, (_, i) => [String(i), new Set(['0B'])]));
    service.sendBatchSubscription = jest.fn().mockResolvedValue(undefined);
    const restore = service.resubscribeAll(original).catch((e: Error) => e.message);
    await Promise.resolve();
    service.ws = {readyState: WebSocket.OPEN}; service.isLoggedIn = false;
    await jest.advanceTimersByTimeAsync(500);
    await restore;
    expect(service.sendBatchSubscription).toHaveBeenCalledTimes(1);
  });
});

describe('subscription REMOVE acknowledgements', () => {
  const makeService = () => {
    const eventEmitter = { emit: jest.fn() };
    const service = new KiwoomWebSocketService(
      { get: () => 'wss://example.test' } as any,
      {} as any,
      eventEmitter as any,
    ) as any;
    service.isLoggedIn = true;
    return { service, eventEmitter };
  };

  it('reports fully released stocks so the subscribed ledger can drop them', () => {
    const { service, eventEmitter } = makeService();
    service.pendingRegAcks = [{ action: 'REMOVE', stockCodes: ['351320'], types: ['0B', '0D'] }];
    service.onMessage(Buffer.from(JSON.stringify({ trnm: 'REMOVE', return_code: 0 })));
    expect(eventEmitter.emit).toHaveBeenCalledWith('kiwoom.subscription.removed', { stockCodes: ['351320'] });
  });

  it('does not report a stock that is still registered after a partial REMOVE', () => {
    const { service, eventEmitter } = makeService();
    service.subscriptions.set('351320', new Set(['0B']));
    service.pendingRegAcks = [{ action: 'REMOVE', stockCodes: ['351320'], types: ['0D'] }];
    service.onMessage(Buffer.from(JSON.stringify({ trnm: 'REMOVE', return_code: 0 })));
    expect(eventEmitter.emit).not.toHaveBeenCalledWith('kiwoom.subscription.removed', expect.anything());
  });
});

