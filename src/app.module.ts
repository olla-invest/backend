import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { AuthModule } from './common/auth/auth.module';
import { JwtAuthGuard } from './common/auth/guards/jwt-auth.guard';
import { UsersModule } from './modules/users/users.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { WatchlistModule } from './modules/watchlist/watchlist.module';
import { TagsModule } from './modules/tags/tags.module';
import { StocksModule } from './modules/stocks/stocks.module';
import { MarketModule } from './modules/market/market.module';

@Module( {
    imports: [
        ConfigModule.forRoot( {
            isGlobal: true,
            envFilePath: '.env',
        } ),
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
