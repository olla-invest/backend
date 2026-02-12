import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { KiwoomAuthService } from './auth/kiwoom-auth.service';
import { KiwoomRestService } from './rest/kiwoom-rest.service';
import { KiwoomWebSocketService } from './websocket/kiwoom-websocket.service';
import { RedisRealtimeSubscriberService } from './websocket/redis-realtime-subscriber.service';
import { RealtimeSourceProvider } from './websocket/realtime-source.provider';
import { REALTIME_SOURCE_TOKEN } from './websocket/realtime-source.interface';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventEmitterModule.forRoot(),
    RedisModule,
  ],
  providers: [
    KiwoomAuthService,
    KiwoomRestService,
    KiwoomWebSocketService,
    RedisRealtimeSubscriberService,
    RealtimeSourceProvider,
  ],
  exports: [
    KiwoomAuthService,
    KiwoomRestService,
    KiwoomWebSocketService,
    RedisRealtimeSubscriberService,
    REALTIME_SOURCE_TOKEN,
  ],
})
export class KiwoomModule {}
