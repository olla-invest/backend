import { Module } from '@nestjs/common';
import { IssueThemeController } from './issue-theme.controller';
import { IssueThemeService } from './issue-theme.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RealTimeChartModule } from '../real-time-chart/real-time-chart.module';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { ThemeMetricsService } from './theme-metrics.service';

@Module({
  imports: [PrismaModule, RealTimeChartModule, KiwoomModule],
  controllers: [IssueThemeController],
  providers: [IssueThemeService, ThemeMetricsService, AdminApiKeyGuard],
  exports: [IssueThemeService, ThemeMetricsService],
})
export class IssueThemeModule {}
