import { Module } from '@nestjs/common';
import { RealtimePriceCacheService } from './realtime-price-cache.service';

/**
 * 실시간 현재가 캐시 전용 모듈.
 *
 * RealTimeChartModule이 StockInfoModule을 import하고 있어, StockInfo 쪽에서
 * 실시간가가 필요할 때 역방향 import를 하면 순환 의존이 생긴다.
 * 캐시 서비스만 분리해 양쪽에서 공유한다. (이벤트 수신은 전역 EventEmitter 기반)
 */
@Module({
  providers: [RealtimePriceCacheService],
  exports: [RealtimePriceCacheService],
})
export class RealtimePriceCacheModule {}
