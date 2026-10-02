import { SetMetadata } from '@nestjs/common';
import { AdminRole } from '../../../../generated/prisma';

export const ADMIN_ROLES_KEY = 'adminRoles';

/** 핸들러 접근을 허용할 관리자 역할을 지정한다. 미지정 시 모든 로그인 관리자가 접근 가능하다. */
export const AdminRoles = ( ...roles: AdminRole[] ) => SetMetadata( ADMIN_ROLES_KEY, roles );
