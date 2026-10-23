import { KiwoomAuthService } from './auth/kiwoom-auth.service';
import { KiwoomDisabledError } from './kiwoom-availability';
import { KiwoomRestService } from './rest/kiwoom-rest.service';
import { KiwoomWebSocketService } from './websocket/kiwoom-websocket.service';

const disabledConfig = {
  get: (key: string, fallback?: unknown) => (key === 'KIWOOM_ENABLED' ? 'false' : fallback),
};

describe('KIWOOM_ENABLED=false', () => {
  it('rejects REST calls before issuing a token or writing an API log', async () => {
    const auth = { ensureValidToken: jest.fn() };
    const prisma = { kiwoomApiCallLog: { create: jest.fn() } };
    const rest = new KiwoomRestService(disabledConfig as any, auth as any, prisma as any);

    await expect(rest.getStockBasicInfo('005930')).rejects.toBeInstanceOf(KiwoomDisabledError);
    await expect(rest.getStockList('0')).rejects.toBeInstanceOf(KiwoomDisabledError);

    expect(rest.isEnabled()).toBe(false);
    expect(auth.ensureValidToken).not.toHaveBeenCalled();
    expect(prisma.kiwoomApiCallLog.create).not.toHaveBeenCalled();
  });

  it('issues no token at startup or on demand', async () => {
    const prisma = { kiwoomToken: { findFirst: jest.fn() } };
    const auth = new KiwoomAuthService(disabledConfig as any, prisma as any);

    await auth.onModuleInit();
    await expect(auth.ensureValidToken()).rejects.toBeInstanceOf(KiwoomDisabledError);

    expect(prisma.kiwoomToken.findFirst).not.toHaveBeenCalled();
  });

  it('opens no realtime connection and queues no subscriptions', async () => {
    const ws = new KiwoomWebSocketService(disabledConfig as any, {} as any, { emit: jest.fn() } as any);
    const connect = jest.spyOn(ws as any, 'connect');

    await ws.onModuleInit();
    await ws.subscribe('005930', ['0B']);
    await ws.subscribeBatch(['005930', '000660'], ['0B']);

    expect(connect).not.toHaveBeenCalled();
    expect((ws as any).subscriptionQueue).toHaveLength(0);
    expect((ws as any).subscriptions.size).toBe(0);
    expect(ws.isConnected()).toBe(false);
  });
});
