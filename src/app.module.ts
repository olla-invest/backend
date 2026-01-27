import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module( {
    imports: [
        ConfigModule.forRoot( {
            isGlobal: true,
            envFilePath: '.env',
        } ),
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
    ],
    providers: [
        {
            provide: APP_GUARD,
            useClass: JwtAuthGuard,
        },
    ],
} )
export class AppModule {}
