import { Module } from '@nestjs/common';
import { WatchlistService } from './watchlist.service';
import { WatchlistController } from './watchlist.controller';
import { RealTimeChartModule } from '../real-time-chart/real-time-chart.module';
import { IssueThemeModule } from '../issue-theme/issue-theme.module';

@Module({
  imports: [RealTimeChartModule, IssueThemeModule],
  controllers: [WatchlistController],
  providers: [WatchlistService],
  exports: [WatchlistService],
})
export class WatchlistModule {}
