import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { isRealtimeEnabled } from '../../integrations/kiwoom/kiwoom-availability';

// Realtime recovery is necessary in secondary environments even when data/payment batches are disabled.
export function applySchedulerPolicy(
  registry: SchedulerRegistry,
  config: ConfigService,
): number {
  const batchesEnabled = config.get('SCHEDULER_ENABLED', 'true') !== 'false';
  // 키움을 끈 환경(KIWOOM_ENABLED=false)은 실시간 재연결·준비 크론도 멈춘다.
  const realtimeEnabled = isRealtimeEnabled(config);
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
