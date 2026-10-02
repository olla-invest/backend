import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AdminRole } from '../../../../generated/prisma';

export interface AuthenticatedAdmin {
    adminId: string;
    loginId: string;
    name: string;
    role: AdminRole;
}

export const CurrentAdmin = createParamDecorator(
    ( data: keyof AuthenticatedAdmin | undefined, context: ExecutionContext ) => {
        const admin = context.switchToHttp().getRequest().user as AuthenticatedAdmin;
        return data ? admin?.[ data ] : admin;
    },
);
