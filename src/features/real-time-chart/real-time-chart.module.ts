import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RealTimeChartController } from './real-time-chart.controller';
import { RealTimeChartService } from './real-time-chart.service';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { InitialSetupService } from './initial-setup.service';
import { ChartGateway } from './chart.gateway';
import { RealtimePriceCacheService } from './realtime-price-cache.service';
import { DataSchedulerService } from './data-scheduler.service';
import { DetailController } from './detail.controller';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { StockInfoModule } from '../stock-info/stock-info.module';
import { RedisModule } from '../../common/redis/redis.module';
import { CronModule } from '../../common/cron/cron.module';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';

@Module({
  imports: [
    KiwoomModule,
    PrismaModule,
    StockInfoModule,
    RedisModule,
    CronModule,
    EventEmitterModule.forRoot(),
  ],
  controllers: [RealTimeChartController, DetailController],
  providers: [
    RealTimeChartService,
    ChartStorageService,
    StockMetricsService,
    InitialSetupService,
    ChartGateway,
    RealtimePriceCacheService,
    DataSchedulerService,
    AdminApiKeyGuard,
  ],
  exports: [RealTimeChartService, RealtimePriceCacheService],
})
export class RealTimeChartModule {}
