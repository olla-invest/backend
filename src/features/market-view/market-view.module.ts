import { Module } from '@nestjs/common';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { RedisModule } from '../../common/redis/redis.module';
import { KiwoomModule } from '../../integrations/kiwoom/kiwoom.module';
import { MarketViewController } from './market-view.controller';
import { MarketViewService } from './market-view.service';

@Module( {
    imports: [ PrismaModule, RedisModule, KiwoomModule ],
    controllers: [ MarketViewController ],
    providers: [ MarketViewService, AdminApiKeyGuard ],
    exports: [ MarketViewService ],
} )
export class MarketViewModule {}
