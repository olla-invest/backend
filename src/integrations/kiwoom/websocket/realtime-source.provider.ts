import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IRealtimeSource, REALTIME_SOURCE_TOKEN } from './realtime-source.interface';
import { KiwoomWebSocketService } from './kiwoom-websocket.service';
import { RedisRealtimeSubscriberService } from './redis-realtime-subscriber.service';

/**
 * 실시간 데이터 소스 팩토리 프로바이더
 * REALTIME_SOURCE 환경 변수에 따라 WebSocket 또는 Redis 구현 선택
 */
export const RealtimeSourceProvider: Provider = {
  provide: REALTIME_SOURCE_TOKEN,
  useFactory: (
    configService: ConfigService,
    kiwoomWs: KiwoomWebSocketService,
    redisSubscriber: RedisRealtimeSubscriberService,
  ): IRealtimeSource => {
    const source = configService.get('REALTIME_SOURCE', 'websocket');

    if (source === 'redis') {
      return redisSubscriber;
    }

    return kiwoomWs;
  },
  inject: [ConfigService, KiwoomWebSocketService, RedisRealtimeSubscriberService],
};
