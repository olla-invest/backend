import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StockInfoController } from './stock-info.controller';
import { StockInfoService } from './stock-info.service';
import { DartModule } from '../../integrations/dart/dart.module';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { RealtimePriceCacheModule } from '../real-time-chart/realtime-price-cache.module';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';

@Module({
  imports: [ConfigModule, DartModule, PrismaModule, KiwoomModule, RealtimePriceCacheModule],
  controllers: [StockInfoController],
  providers: [StockInfoService, AdminApiKeyGuard],
  exports: [StockInfoService],
})
export class StockInfoModule {}
