import { applySchedulerPolicy } from './scheduler-policy';
describe('secondary environment scheduler policy', () => {
  it('keeps realtime recovery while stopping data/payment jobs', () => {
    const realtime = { stop: jest.fn() },
      batch = { stop: jest.fn() },
      payment = { stop: jest.fn() };
    const registry = {
      getCronJobs: () =>
        new Map([
          ['realtime:reconnect', realtime],
          ['collectEndOfDayData', batch],
          ['payment', payment],
        ]),
      getIntervals: () => [],
      getTimeouts: () => [],
    };
    applySchedulerPolicy(
      registry as any,
      {
        get: (key: string, fallback: string) =>
          key === 'SCHEDULER_ENABLED' ? 'false' : fallback,
      } as any,
    );
    expect(realtime.stop).not.toHaveBeenCalled();
    expect(batch.stop).toHaveBeenCalled();
    expect(payment.stop).toHaveBeenCalled();
  });
});
