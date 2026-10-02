/**
 * 지정한 마이그레이션 폴더의 migration.sql 을 하나의 트랜잭션으로 적용한다.
 *
 *   DATABASE_URL="postgresql://..." npx ts-node scripts/apply-sql-migration.ts 20261002_add_backoffice_v1 [--dry-run]
 *
 * - 대상 DB 와 스키마를 먼저 출력하고, --dry-run 이면 SQL 만 보여주고 종료한다.
 * - prisma 의 _prisma_migrations 테이블이 있으면 적용 이력을 함께 기록한다.
 * - 중간에 실패하면 전부 롤백된다.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import 'dotenv/config';

async function main() {
    const args = process.argv.slice( 2 );
    const dryRun = args.includes( '--dry-run' );
    const migrationName = args.find( ( arg ) => !arg.startsWith( '--' ) );

    if ( !migrationName ) {
        console.error( 'usage: apply-sql-migration.ts <migration-folder> [--dry-run]' );
        process.exit( 1 );
    }

    const sqlPath = path.join( __dirname, '..', 'prisma', 'migrations', migrationName, 'migration.sql' );
    if ( !fs.existsSync( sqlPath ) ) {
        console.error( `migration.sql 을 찾을 수 없습니다: ${ sqlPath }` );
        process.exit( 1 );
    }

    const sql = fs.readFileSync( sqlPath, 'utf-8' );
    const databaseUrl = process.env.DATABASE_URL;
    if ( !databaseUrl ) {
        console.error( 'DATABASE_URL 이 필요합니다.' );
        process.exit( 1 );
    }

    const schema = process.env.DB_SCHEMA?.trim() || new URL( databaseUrl ).searchParams.get( 'schema' ) || 'public';
    console.log( `대상 : ${ redact( databaseUrl ) }` );
    console.log( `스키마: ${ schema }` );
    console.log( `적용  : ${ migrationName } (${ sql.split( '\n' ).length } lines)` );

    if ( dryRun ) {
        console.log( '\n--- dry-run, 실행하지 않음 ---\n' );
        console.log( sql );
        return;
    }

    const client = new Client( {
        connectionString: databaseUrl,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    } );
    await client.connect();

    try {
        await client.query( 'BEGIN' );
        await client.query( `SET search_path TO "${ schema }"` );

        const started = Date.now();
        await client.query( sql );
        await recordMigrationHistory( client, migrationName, sql );

        await client.query( 'COMMIT' );
        console.log( `\n적용 완료 (${ Date.now() - started }ms)` );
    } catch ( error ) {
        await client.query( 'ROLLBACK' );
        console.error( '\n적용 실패 — 전체 롤백했습니다.' );
        console.error( error );
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

/** prisma 가 관리하는 이력 테이블이 있을 때만 기록해, 이후 migrate deploy 가 중복 적용하지 않게 한다. */
async function recordMigrationHistory( client: Client, migrationName: string, sql: string ) {
    const exists = await client.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = '_prisma_migrations'`,
    );
    if ( exists.rowCount === 0 ) {
        console.log( '_prisma_migrations 테이블이 없어 이력 기록은 건너뜁니다.' );
        return;
    }

    const checksum = crypto.createHash( 'sha256' ).update( sql ).digest( 'hex' );
    await client.query(
        `INSERT INTO "_prisma_migrations"
            ( id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count )
         VALUES ( $1, $2, now(), $3, NULL, NULL, now(), 1 )
         ON CONFLICT (id) DO NOTHING`,
        [ crypto.randomUUID(), checksum, migrationName ],
    );
    console.log( '_prisma_migrations 에 적용 이력을 기록했습니다.' );
}

function redact( url: string ): string {
    return url.replace( /:\/\/([^:]+):[^@]+@/, '://$1:***@' );
}

main().catch( ( error ) => {
    console.error( error );
    process.exit( 1 );
} );
