import { Module, Logger } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createKeyv } from '@keyv/redis';
import { RedisPubSubService } from './redis-pubsub.service';
import { RedisLockService } from './redis-lock.service';

@Module( {
    imports: [
        CacheModule.registerAsync( {
            imports: [ ConfigModule ],
            inject: [ ConfigService ],
            useFactory: async ( configService: ConfigService ) => {
                const host = configService.get( 'REDIS_HOST', 'localhost' );
                const port = configService.get( 'REDIS_PORT', 6379 );
                const password = configService.get<string>( 'REDIS_PASSWORD' );
                const url = password
                    ? `redis://:${encodeURIComponent( password )}@${host}:${port}`
                    : `redis://${host}:${port}`;

                const store = createKeyv( url, { namespace: 'olla-cache' } );
                // Redis 순단 시 unhandled 'error'로 프로세스가 죽지 않도록 로깅만 수행
                // (각 서비스의 get/set은 자체 try/catch로 폴백 처리)
                store.on( 'error', ( err ) => {
                    new Logger( 'RedisCacheStore' ).warn( `Redis cache error: ${( err as Error ).message}` );
                } );

                return {
                    stores: [ store ],
                    ttl: 3600 * 1000, // 기본 1시간 (ms)
                };
            },
            isGlobal: true,
        } ),
    ],
    providers: [ RedisPubSubService, RedisLockService ],
    exports: [ CacheModule, RedisPubSubService, RedisLockService ],
} )
export class RedisModule {}
