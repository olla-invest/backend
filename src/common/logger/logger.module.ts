import { Module } from '@nestjs/common';
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import * as path from 'path';
const DailyRotateFile = require('winston-daily-rotate-file');

const logDir = 'logs';

@Module( {
    imports: [
        WinstonModule.forRoot( {
            transports: [
                // Console transport
                new winston.transports.Console( {
                    format: winston.format.combine(
                        winston.format.timestamp( { format: 'YYYY-MM-DD HH:mm:ss' } ),
                        winston.format.colorize(),
                        winston.format.printf( ( { timestamp, level, message, context, ...meta } ) => {
                            const metaStr = Object.keys( meta ).length ? JSON.stringify( meta ) : '';
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
