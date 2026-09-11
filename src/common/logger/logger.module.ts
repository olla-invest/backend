import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import * as path from 'path';
const DailyRotateFile = require('winston-daily-rotate-file');

const logDir = 'logs';

/**
 * Error 는 message/stack 이 non-enumerable 이라 JSON.stringify 하면 {} 로 사라진다.
 * (`logger.error('...', err)` 가 `{"stack":[{}]}` 로만 남던 원인)
 * 모든 트랜스포트에서 원인이 보이도록 직렬화 가능한 형태로 치환한다.
 */
function toSerializable( value: unknown, seen: WeakSet<object> ): unknown {
    if ( value instanceof Error ) {
        const out: Record<string, unknown> = {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
        // axios 등이 Error 에 얹은 부가 정보 보존 (config/request 는 순환·과다 출력이라 제외)
        for ( const key of Object.keys( value ) ) {
            if ( key === 'config' || key === 'request' ) continue;
            const extra = ( value as unknown as Record<string, unknown> )[ key ];
            if ( key === 'response' && extra && typeof extra === 'object' ) {
                const res = extra as Record<string, unknown>;
                out.response = { status: res.status, data: toSerializable( res.data, seen ) };
                continue;
            }
            out[ key ] = toSerializable( extra, seen );
        }
        return out;
    }

    if ( typeof value === 'object' && value !== null ) {
        if ( seen.has( value ) ) return '[Circular]';
        seen.add( value );
        if ( Array.isArray( value ) ) return value.map( ( v ) => toSerializable( v, seen ) );
        const out: Record<string, unknown> = {};
        for ( const [ k, v ] of Object.entries( value ) ) out[ k ] = toSerializable( v, seen );
        return out;
    }

    return value;
}

/** info 를 제자리에서 정규화 (winston 내부 Symbol 키를 잃지 않도록 재생성하지 않는다) */
const expandErrors = winston.format( ( info ) => {
    const seen = new WeakSet<object>();
    for ( const key of Object.keys( info ) ) {
        ( info as Record<string, unknown> )[ key ] = toSerializable(
            ( info as Record<string, unknown> )[ key ],
            seen,
        );
    }
    return info;
} );

@Module( {
    imports: [
        WinstonModule.forRoot( {
            transports: [
                // Console transport
                new winston.transports.Console( {
                    format: winston.format.combine(
                        expandErrors(),
                        winston.format.timestamp( { format: 'YYYY-MM-DD HH:mm:ss' } ),
                        winston.format.colorize(),
                        winston.format.printf( ( { timestamp, level, message, context, ...meta } ) => {
                            let metaStr = '';
                            if ( Object.keys( meta ).length ) {
                                try {
                                    const seen = new WeakSet();
                                    metaStr = JSON.stringify( meta, ( _key, value ) => {
                                        if ( typeof value === 'object' && value !== null ) {
                                            if ( seen.has( value ) ) return '[Circular]';
                                            seen.add( value );
                                        }
                                        return value;
                                    } );
                                } catch {
                                    metaStr = '[Unserializable]';
                                }
                            }
                            return `${timestamp} [${context || 'Application'}] ${level}: ${message} ${metaStr}`;
                        } ),
                    ),
                } ),
                // Error log file with daily rotation
                new DailyRotateFile( {
                    dirname: logDir,
                    filename: '%DATE%-error.log',
                    datePattern: 'YYYY-MM-DD',
                    level: 'error',
                    maxFiles: '30d',
                    format: winston.format.combine(
                        expandErrors(),
                        winston.format.timestamp( { format: 'YYYY-MM-DD HH:mm:ss' } ),
                        winston.format.json(),
                    ),
                } ),
                // All logs file with daily rotation
                new DailyRotateFile( {
                    dirname: logDir,
                    filename: '%DATE%.log',
                    datePattern: 'YYYY-MM-DD',
                    maxFiles: '30d',
                    format: winston.format.combine(
                        expandErrors(),
                        winston.format.timestamp( { format: 'YYYY-MM-DD HH:mm:ss' } ),
                        winston.format.json(),
                    ),
                } ),
            ],
        } ),
    ],
    exports: [ WinstonModule ],
} )
export class LoggerModule {}
