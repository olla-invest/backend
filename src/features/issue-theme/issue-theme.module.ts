import { Module } from '@nestjs/common';
import { IssueThemeController } from './issue-theme.controller';
import { IssueThemeService } from './issue-theme.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RealTimeChartModule } from '../real-time-chart/real-time-chart.module';

@Module({
  imports: [PrismaModule, RealTimeChartModule],
  controllers: [IssueThemeController],
  providers: [IssueThemeService],
})
export class IssueThemeModule {}
