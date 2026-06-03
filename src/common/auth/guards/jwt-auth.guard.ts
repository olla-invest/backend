import { Injectable, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard( 'jwt' ) {
    constructor( private reflector: Reflector ) {
        super();
    }

    canActivate( context: ExecutionContext ) {
        const request = context.switchToHttp().getRequest();
        const path: string = request?.url ?? '';

        if( path.startsWith( '/api-docs' ) ) {
            return true;
        }

        const isPublic = this.reflector.getAllAndOverride<boolean>( IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ] );

        if( isPublic ) {
            return true;
        }

        return super.canActivate( context );
    }

    handleRequest<TUser = any>( err: any, user: any ): TUser {
        if ( err || !user ) {
            throw err || new UnauthorizedException( '인증 정보가 없습니다. Authorization Bearer 토큰을 전달해주세요.' );
        }

        return user as TUser;
    }
}
