import * as crypto from 'crypto';
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class AdminApiKeyGuard implements CanActivate {
    constructor( private readonly configService: ConfigService ) {}

    canActivate( context: ExecutionContext ): boolean {
        const request = context.switchToHttp().getRequest<Request>();
        const provided = request.headers[ 'x-admin-api-key' ] as string | undefined;
        const valid = this.configService.get<string>( 'ADMIN_API_KEY' );

        if ( !valid || !provided ) {
            throw new UnauthorizedException( 'Admin API key required' );
        }
        if ( provided.length !== valid.length ) {
            throw new UnauthorizedException( 'Invalid admin API key' );
        }
        if ( !crypto.timingSafeEqual( Buffer.from( provided ), Buffer.from( valid ) ) ) {
            throw new UnauthorizedException( 'Invalid admin API key' );
        }
        return true;
    }
}
