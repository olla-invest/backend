import { Module } from '@nestjs/common';
import { IssueThemeController } from './issue-theme.controller';
import { IssueThemeService } from './issue-theme.service';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RealTimeChartModule } from '../real-time-chart/real-time-chart.module';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { ThemeMetricsService } from './theme-metrics.service';
import { ConfigModule } from '@nestjs/config';
import { ThemeNewsService } from './theme-news.service';
import { ThemeAiSummaryService } from './theme-ai-summary.service';
import { LLM_CLIENT } from './llm/llm-client.interface';
import { OpenAiLlmClient } from './llm/openai-llm.client';
import { ThemeSnapshotService } from './theme-snapshot.service';

@Module({
  imports: [ConfigModule, PrismaModule, RealTimeChartModule, KiwoomModule],
  controllers: [IssueThemeController],
  providers: [
    IssueThemeService,
    ThemeMetricsService,
    ThemeNewsService,
    ThemeAiSummaryService,
    ThemeSnapshotService,
    OpenAiLlmClient,
    { provide: LLM_CLIENT, useExisting: OpenAiLlmClient },
    AdminApiKeyGuard,
  ],
  exports: [IssueThemeService, ThemeMetricsService, ThemeAiSummaryService, ThemeSnapshotService],
})
export class IssueThemeModule {}
