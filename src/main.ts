import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

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
        origin: corsOrigin.split( ',' ).map( ( origin: string ) => origin.trim() ),
        credentials: corsCredentials,
        methods: [ 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS' ],
        allowedHeaders: [ 'Content-Type', 'Authorization', 'X-Requested-With' ],
    } );

    // Get port from environment or use default
    const port = configService.get( 'PORT', 3000 );

    await app.listen( port );

    const logger = app.get( WINSTON_MODULE_NEST_PROVIDER );
    logger.log( `Application is running on: http://localhost:${port}`, 'Bootstrap' );
}

bootstrap();
