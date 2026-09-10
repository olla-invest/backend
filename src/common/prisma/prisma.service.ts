import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const DEFAULT_SCHEMA = 'public';
const SCHEMA_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * 런타임 쿼리가 사용할 스키마를 결정한다.
 *
 * Prisma CLI(마이그레이션)는 DATABASE_URL 의 `?schema=` 를 직접 해석하지만,
 * driver adapter 경로에서는 `pg` 가 이 파라미터를 모르고 무시한다.
 * 그대로 두면 마이그레이션은 지정 스키마에, 런타임 쿼리는 public 에 나가면서
 * 다른 환경의 테이블을 조용히 건드리게 되므로 여기서 search_path 를 명시한다.
 *
 * 우선순위: DB_SCHEMA 환경변수 > DATABASE_URL 의 `?schema=` > public
 */
function resolveSchema( databaseUrl: string | undefined ): string {
    const fromEnv = process.env.DB_SCHEMA?.trim();
    if ( fromEnv ) {
        return assertValidSchema( fromEnv, 'DB_SCHEMA' );
    }

    if ( databaseUrl ) {
        try {
            const fromUrl = new URL( databaseUrl ).searchParams.get( 'schema' )?.trim();
            if ( fromUrl ) {
                return assertValidSchema( fromUrl, 'DATABASE_URL?schema' );
            }
        } catch {
            // URL 파싱 실패 시 기본 스키마로 폴백 (연결 자체는 pg 가 다시 검증한다)
        }
    }

    return DEFAULT_SCHEMA;
}

function assertValidSchema( schema: string, source: string ): string {
    if ( !SCHEMA_NAME_PATTERN.test( schema ) ) {
        throw new Error( `Invalid schema name from ${source}: "${schema}"` );
    }
    return schema;
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger( PrismaService.name );
    private readonly schema: string;

    constructor() {
        const schema = resolveSchema( process.env.DATABASE_URL );

        const pool = new Pool( {
            connectionString: process.env.DATABASE_URL,
            // startup 파라미터로 세션 search_path 고정 (pg 는 `?schema=` 를 해석하지 않는다)
            options: `-c search_path="${schema}"`,
            ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
        } );
        const adapter = new PrismaPg( pool );

        super( {
            adapter,
            log: [ 'error', 'warn' ],
        } );

        this.schema = schema;
    }

    async onModuleInit() {
        await this.$connect();
        // 환경 분리 사고를 조기에 발견하기 위해 실제 적용된 스키마를 남긴다
        this.logger.log( `Prisma connected (search_path=${this.schema})` );
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }
}
