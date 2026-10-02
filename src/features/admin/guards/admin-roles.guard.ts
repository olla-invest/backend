import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminRole } from '../../../../generated/prisma';
import { ADMIN_ROLES_KEY } from '../decorators/admin-roles.decorator';
import { AuthenticatedAdmin } from '../decorators/current-admin.decorator';

@Injectable()
export class AdminRolesGuard implements CanActivate {
    constructor( private readonly reflector: Reflector ) {}

    canActivate( context: ExecutionContext ): boolean {
        const required = this.reflector.getAllAndOverride<AdminRole[]>( ADMIN_ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ] );

        if ( !required || required.length === 0 ) {
            return true;
        }

        const admin = context.switchToHttp().getRequest().user as AuthenticatedAdmin | undefined;
        if ( !admin ) {
            throw new ForbiddenException( '권한 정보를 확인할 수 없습니다.' );
        }

        if ( admin.role === AdminRole.SUPER_ADMIN || required.includes( admin.role ) ) {
            return true;
        }

        throw new ForbiddenException( '이 작업을 수행할 권한이 없습니다.' );
    }
}
