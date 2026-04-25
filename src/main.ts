import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as fs from 'fs';

async function bootstrap() {
    const app = await NestFactory.create( AppModule );

    // Use Winston logger
    app.useLogger( app.get( WINSTON_MODULE_NEST_PROVIDER ) );
    const configService = app.get( ConfigService );

    // Enable validation
    app.useGlobalPipes(
        new ValidationPipe( {
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: true,
        } ),
    );

    // Enable CORS
    const corsOrigin = configService.get( 'CORS_ORIGIN', 'http://localhost:3000' );
    const corsCredentials = configService.get( 'CORS_CREDENTIALS', 'true' ) === 'true';

    app.enableCors( {
        origin: corsOrigin === '*' ? true : corsOrigin.split( ',' ).map( ( origin: string ) => origin.trim() ),
        credentials: corsCredentials,
        methods: [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ],
        allowedHeaders: [ 'Content-Type', 'Authorization', 'X-Requested-With', 'ngrok-skip-browser-warning' ],
    } );

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
    const document = SwaggerModule.createDocument( app, swaggerConfig );
    SwaggerModule.setup( 'api-docs', app, document );
    const swaggerOutputPath = configService.get<string>( 'SWAGGER_OUTPUT_PATH', './swagger.json' );
    fs.mkdirSync( require( 'path' ).dirname( swaggerOutputPath ), { recursive: true } );
    fs.writeFileSync( swaggerOutputPath, JSON.stringify( document, null, 2 ) );

    // Get port from environment or use default
    const port = configService.get( 'PORT', 3000 );

    await app.listen( port );

    const logger = app.get( WINSTON_MODULE_NEST_PROVIDER );
    logger.log( `Application is running on: http://localhost:${port}`, 'Bootstrap' );
}

bootstrap();
