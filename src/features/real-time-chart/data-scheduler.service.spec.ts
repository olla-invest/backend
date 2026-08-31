import { DataSchedulerService } from './data-scheduler.service';

describe('DataSchedulerService end-of-day ranking finalization', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('calculates same-day metrics before creating and finalizing the closing rank', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T06:40:00.000Z'));
    const order: string[] = [];
    const chartService = {
      syncTradingStates: jest.fn().mockResolvedValue(undefined),
      collectIndexCandles: jest.fn().mockResolvedValue(undefined),
      collectAllDayCandles: jest.fn().mockResolvedValue({ success: 1, total: 1 }),
    };
    const cronRunLog = {
      run: jest.fn().mockImplementation(async (_name: string, _date: Date, job: () => Promise<unknown>) => job()),
    };
    const redisLock = {
      withLock: jest.fn().mockImplementation(async (_key: string, _ttl: number, job: () => Promise<unknown>) => job()),
    };
    const currentRankService = {
      createCurrentRankSnapshot: jest.fn().mockImplementation(async () => {
        order.push('snapshot');
      }),
      finalizeDailyCurrentRank: jest.fn().mockImplementation(async () => {
        order.push('finalize');
      }),
    };
    const eventEmitter = {
      emitAsync: jest.fn().mockImplementation(async () => {
        order.push('theme-event');
      }),
    };
    const service = new DataSchedulerService(
      chartService as any,
      {} as any,
      redisLock as any,
      cronRunLog as any,
      {} as any,
      currentRankService as any,
      {} as any,
      eventEmitter as any,
    ) as any;
    jest.spyOn(service, 'runCatchUp').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMetricsFor').mockImplementation(async () => {
      order.push('metrics');
    });
    jest.spyOn(service, 'runMarketViewFor').mockResolvedValue(undefined);

    await service.collectEndOfDayData();

    expect(order).toEqual(['metrics', 'snapshot', 'finalize', 'theme-event']);
  });

  it('does not request a theme snapshot when stock rank finalization fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T06:40:00.000Z'));
    const eventEmitter = { emitAsync: jest.fn() };
    const service = new DataSchedulerService(
      {
        syncTradingStates: jest.fn().mockResolvedValue(undefined),
        collectIndexCandles: jest.fn().mockResolvedValue(undefined),
        collectAllDayCandles: jest.fn().mockResolvedValue({ success: 1, total: 1 }),
      } as any,
      {} as any,
      { withLock: jest.fn().mockImplementation(async (_key: string, _ttl: number, job: any) => job()) } as any,
      { run: jest.fn().mockImplementation(async (_name: string, _date: Date, job: any) => job()) } as any,
      {} as any,
      {
        createCurrentRankSnapshot: jest.fn(),
        finalizeDailyCurrentRank: jest.fn().mockRejectedValue(new Error('finalize failed')),
      } as any,
      {} as any,
      eventEmitter as any,
    ) as any;
    jest.spyOn(service, 'runCatchUp').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMetricsFor').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMarketViewFor').mockResolvedValue(undefined);

    await service.collectEndOfDayData();

    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });
});
