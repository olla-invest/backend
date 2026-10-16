import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

// Realtime recovery is necessary in secondary environments even when data/payment batches are disabled.
export function applySchedulerPolicy(
  registry: SchedulerRegistry,
  config: ConfigService,
): number {
  const batchesEnabled = config.get('SCHEDULER_ENABLED', 'true') !== 'false';
  const realtimeEnabled = config.get('REALTIME_ENABLED', 'true') !== 'false';
  let stopped = 0;
  for (const [name, job] of registry.getCronJobs()) {
    if (name.startsWith('realtime:') ? !realtimeEnabled : !batchesEnabled) {
      job.stop();
      stopped++;
    }
  }
  if (!batchesEnabled) {
    registry.getIntervals().forEach((name) => registry.deleteInterval(name));
    registry.getTimeouts().forEach((name) => registry.deleteTimeout(name));
  }
  return stopped;
}
