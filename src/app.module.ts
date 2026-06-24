import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { LoggerModule } from './common/logger/logger.module';
import { AuthModule } from './common/auth/auth.module';
import { JwtAuthGuard } from './common/auth/guards/jwt-auth.guard';
import { UsersModule } from './features/users/users.module';
import { CompaniesModule } from './features/companies/companies.module';
import { WatchlistModule } from './features/watchlist/watchlist.module';
import { TagsModule } from './features/tags/tags.module';
import { StocksModule } from './features/stocks/stocks.module';
import { MarketModule } from './features/market/market.module';
import { RealTimeChartModule } from './features/real-time-chart/real-time-chart.module';
import { StockInfoModule } from './features/stock-info/stock-info.module';
import { IssueThemeModule } from './features/issue-theme/issue-theme.module';
import { SubscriptionModule } from './features/subscription/subscription.module';
import { PaymentModule } from './features/payment/payment.module';
import { MarketViewModule } from './features/market-view/market-view.module';

@Module( {
    imports: [
        ConfigModule.forRoot( {
            isGlobal: true,
            envFilePath: '.env',
        } ),
        ScheduleModule.forRoot(),
        LoggerModule,
        PrismaModule,
        RedisModule,
        AuthModule,
        UsersModule,
        CompaniesModule,
        WatchlistModule,
        TagsModule,
        StocksModule,
        MarketModule,
        RealTimeChartModule,
        StockInfoModule,
        IssueThemeModule,
        SubscriptionModule,
        PaymentModule,
        MarketViewModule,
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
    ],
} )
export class AppModule {}
