import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { RealTimeChartController } from './real-time-chart.controller';
import { RealTimeChartService } from './real-time-chart.service';
import { ChartStorageService } from './chart-storage.service';
import { StockMetricsService } from './stock-metrics.service';
import { InitialSetupService } from './initial-setup.service';
import { ChartGateway } from './chart.gateway';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { PrismaModule } from '../../common/prisma/prisma.module';

@Module({
  imports: [
    KiwoomModule,
    PrismaModule,
    EventEmitterModule.forRoot(),
  ],
  controllers: [RealTimeChartController],
  providers: [
    RealTimeChartService,
    ChartStorageService,
    StockMetricsService,
    InitialSetupService,
    ChartGateway,
  ],
  exports: [RealTimeChartService],
})
export class RealTimeChartModule {}
