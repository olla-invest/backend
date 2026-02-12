import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { redisStore } from 'cache-manager-redis-store';
import { RedisPubSubService } from './redis-pubsub.service';

@Module( {
    imports: [
        CacheModule.registerAsync( {
            imports: [ ConfigModule ],
            inject: [ ConfigService ],
            useFactory: async ( configService: ConfigService ) => ( {
                store: redisStore as any,
                host: configService.get( 'REDIS_HOST', 'localhost' ),
                port: configService.get( 'REDIS_PORT', 6379 ),
                password: configService.get( 'REDIS_PASSWORD' ),
                ttl: 3600, // 1 hour default TTL
            } ),
            isGlobal: true,
        } ),
    ],
    providers: [ RedisPubSubService ],
    exports: [ CacheModule, RedisPubSubService ],
} )
export class RedisModule {}
