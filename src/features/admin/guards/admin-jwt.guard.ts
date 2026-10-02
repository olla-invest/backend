import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ADMIN_JWT_STRATEGY } from '../strategies/admin-jwt.strategy';

@Injectable()
export class AdminJwtGuard extends AuthGuard( ADMIN_JWT_STRATEGY ) {
    canActivate( context: ExecutionContext ) {
        return super.canActivate( context );
    }

    handleRequest<TUser = any>( err: any, admin: any ): TUser {
        if ( err || !admin ) {
            throw err || new UnauthorizedException( '관리자 인증이 필요합니다.' );
        }

        return admin as TUser;
    }
}
