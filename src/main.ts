import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';
import * as express from 'express';
import * as path from 'path';
import session = require( 'express-session' );
import { addDefaultResponseSchemas } from './common/swagger/default-response-schemas';

async function bootstrap() {
    const app = await NestFactory.create( AppModule, { rawBody: true } );

    // Use Winston logger
    app.useLogger( app.get( WINSTON_MODULE_NEST_PROVIDER ) );
    const configService = app.get( ConfigService );
    app.getHttpAdapter().getInstance().set( 'trust proxy', 1 );

    // OAuth CSRF 방어용 세션 (state 파라미터 검증에만 사용, 인증 세션 아님)
    app.use( session( {
        secret: configService.get<string>( 'SESSION_SECRET', 'olla-oauth-state-secret' ),
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: {
            httpOnly: true,
            secure: configService.get( 'NODE_ENV' ) === 'production',
            sameSite: 'lax',
            maxAge: 10 * 60 * 1000, // 10분 (OAuth 플로우 완료 시간)
        },
    } ) );

    // Enable validation
    app.useGlobalPipes(
        new ValidationPipe( {
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        } ),
    );

    // Enable CORS
    const corsOrigin = configService.get( 'CORS_ORIGIN', 'http://localhost:3000,http://localhost:5174' );
    const corsCredentials = configService.get( 'CORS_CREDENTIALS', 'true' ) === 'true';

    app.enableCors( {
        origin: corsOrigin === '*' ? true : corsOrigin.split( ',' ).map( ( origin: string ) => origin.trim() ),
        credentials: corsCredentials,
        methods: [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ],
        allowedHeaders: [ 'Content-Type', 'Authorization', 'X-Requested-With', 'x-admin-api-key', 'ngrok-skip-browser-warning' ],
    } );

    const stockImageDir = path.resolve(
        process.cwd(),
        configService.get<string>( 'STOCK_IMAGE_DIR', '../stock-image' ),
    );
    app.use(
        '/stock-image',
        express.static( stockImageDir, {
            maxAge: '7d',
            immutable: true,
            fallthrough: false,
        } ),
    );

    // Swagger
    const swaggerConfig = new DocumentBuilder()
        .setTitle( '주식 서비스 API' )
        .setDescription( '실시간 차트, 이슈테마, 관심종목, 종목정보, 인증 API 명세' )
        .setVersion( '1.0' )
        .addBearerAuth(
            { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
            'access-token',
        )
        .build();
    const document = addDefaultResponseSchemas( SwaggerModule.createDocument( app, swaggerConfig ) );
    SwaggerModule.setup( 'api-docs', app, document );
    const swaggerOutputPath = configService.get<string>( 'SWAGGER_OUTPUT_PATH', './swagger.json' );
    fs.mkdirSync( path.dirname( swaggerOutputPath ), { recursive: true } );
    fs.writeFileSync( swaggerOutputPath, JSON.stringify( document, null, 2 ) );

    // 스케줄러 등록은 onApplicationBootstrap 에서 일어난다. listen() 이 알아서 호출하지만
    // 그 전에 크론을 정지시켜야 하므로 여기서 명시적으로 초기화한다 (listen 은 재초기화하지 않는다).
    await app.init();

    // 보조 환경(develop 등)이 운영과 같은 크론을 이중 실행하는 것을 막는다.
    // 방치하면 키움 API를 두 배로 호출하고, 분산락이 걸린 잡은 develop이 락을 선점해
    // 운영 크론이 조용히 스킵된다.
    if ( configService.get( 'SCHEDULER_ENABLED', 'true' ) === 'false' ) {
        const schedulerRegistry = app.get( SchedulerRegistry );
        const cronJobs = schedulerRegistry.getCronJobs();
        cronJobs.forEach( ( job ) => job.stop() );
        schedulerRegistry.getIntervals().forEach( ( name ) => schedulerRegistry.deleteInterval( name ) );
        schedulerRegistry.getTimeouts().forEach( ( name ) => schedulerRegistry.deleteTimeout( name ) );
        new Logger( 'Bootstrap' ).warn( `SCHEDULER_ENABLED=false: 크론 ${cronJobs.size}개 정지됨` );
    }

    // Get port from environment or use default
    const port = configService.get( 'PORT', 3000 );

    await app.listen( port );

    const logger = app.get( WINSTON_MODULE_NEST_PROVIDER );
    logger.log( `Application is running on: http://localhost:${port}`, 'Bootstrap' );
}

bootstrap();
