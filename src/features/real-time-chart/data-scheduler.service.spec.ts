import { DataSchedulerService } from './data-scheduler.service';

describe('DataSchedulerService end-of-day ranking finalization', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the closing rank from before same-day metrics and finalizes from it', async () => {
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
      closingSnapshotTime: jest.fn().mockReturnValue(new Date('2026-08-05T06:40:00.000Z')),
      createClosingSnapshot: jest.fn().mockImplementation(async () => {
        order.push('closing-snapshot');
      }),
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
      { get: (_k: string, d?: unknown) => d } as any,
    ) as any;
    jest.spyOn(service, 'runCatchUp').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMetricsFor').mockImplementation(async () => {
      order.push('metrics');
    });
    jest.spyOn(service, 'runMarketViewFor').mockResolvedValue(undefined);

    await service.collectEndOfDayData();

    expect(order).toEqual(['closing-snapshot', 'metrics', 'snapshot', 'finalize', 'theme-event']);
    // 당일 지표 스냅샷은 장 마감 스냅샷(06:40)을 덮어쓰지 않도록 그 뒤 시각에 남긴다.
    expect(currentRankService.createCurrentRankSnapshot.mock.calls[0][0]).toEqual(new Date('2026-08-05T06:50:00.000Z'));
  });

  it('finalizes the closing rank when the safety net recovers missed metrics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-05T08:00:00.000Z'));
    const order: string[] = [];
    const currentRankService = {
      finalizeDailyCurrentRank: jest.fn().mockImplementation(async () => {
        order.push('finalize');
      }),
    };
    const service = new DataSchedulerService(
      {} as any,
      {} as any,
      { withLock: jest.fn().mockImplementation(async (_key: string, _ttl: number, job: any) => job()) } as any,
      {} as any,
      {} as any,
      currentRankService as any,
      {} as any,
      { emitAsync: jest.fn() } as any,
      { get: (_k: string, d?: unknown) => d } as any,
    ) as any;
    jest.spyOn(service, 'runCatchUp').mockResolvedValue(undefined);
    jest.spyOn(service, 'hasMetricsForDate').mockResolvedValue(false);
    jest.spyOn(service, 'hasRequiredCandlesForDate').mockResolvedValue(true);
    jest.spyOn(service, 'runMetricsFor').mockImplementation(async () => {
      order.push('metrics');
    });
    jest.spyOn(service, 'runMarketViewFor').mockImplementation(async () => {
      order.push('market-view');
    });

    await service.runMetricsSafetyNet();

    expect(order).toEqual(['metrics', 'finalize', 'market-view']);
    expect(currentRankService.finalizeDailyCurrentRank).toHaveBeenCalledWith(new Date('2026-08-05T00:00:00.000Z'));
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
        closingSnapshotTime: jest.fn().mockReturnValue(new Date('2026-08-05T06:40:00.000Z')),
        createClosingSnapshot: jest.fn().mockResolvedValue(undefined),
        createCurrentRankSnapshot: jest.fn(),
        finalizeDailyCurrentRank: jest.fn().mockRejectedValue(new Error('finalize failed')),
      } as any,
      {} as any,
      eventEmitter as any,
      { get: (_k: string, d?: unknown) => d } as any,
    ) as any;
    jest.spyOn(service, 'runCatchUp').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMetricsFor').mockResolvedValue(undefined);
    jest.spyOn(service, 'runMarketViewFor').mockResolvedValue(undefined);

    await service.collectEndOfDayData();

    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });
});
