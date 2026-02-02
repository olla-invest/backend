import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { KiwoomAuthService } from './auth/kiwoom-auth.service';
import { KiwoomRestService } from './rest/kiwoom-rest.service';
import { KiwoomWebSocketService } from './websocket/kiwoom-websocket.service';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    EventEmitterModule.forRoot(),
  ],
  providers: [
    KiwoomAuthService,
    KiwoomRestService,
    KiwoomWebSocketService,
  ],
  exports: [
    KiwoomAuthService,
    KiwoomRestService,
    KiwoomWebSocketService,
  ],
})
export class KiwoomModule {}
