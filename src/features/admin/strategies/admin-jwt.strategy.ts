import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AuthenticatedAdmin } from '../decorators/current-admin.decorator';

export interface AdminJwtPayload {
    sub: string; // admin ID (UUID)
    loginId: string;
    role: string;
}

export const ADMIN_JWT_STRATEGY = 'admin-jwt';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy( Strategy, ADMIN_JWT_STRATEGY ) {
    constructor(
        configService: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        super( {
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: resolveAdminJwtSecret( configService ),
        } );
    }

    async validate( payload: AdminJwtPayload ): Promise<AuthenticatedAdmin> {
        const admin = await this.prisma.admin.findFirst( {
            where: { adminId: payload.sub, deletedAt: null },
        } );

        if ( !admin ) {
            throw new UnauthorizedException( '관리자 계정을 찾을 수 없습니다.' );
        }
        if ( !admin.isActive ) {
            throw new UnauthorizedException( '비활성화된 관리자 계정입니다.' );
        }

        return {
            adminId: admin.adminId,
            loginId: admin.loginId,
            name: admin.name,
            role: admin.role,
        };
    }
}

/** 회원용 JWT 와 관리자용 JWT 를 서로 통용되지 않도록 분리한다. */
export function resolveAdminJwtSecret( configService: ConfigService ): string {
    const dedicated = configService.get<string>( 'ADMIN_JWT_SECRET' );
    if ( dedicated ) {
        return dedicated;
    }

    const base = configService.get<string>( 'JWT_SECRET' );
    if ( !base ) {
        throw new Error( 'ADMIN_JWT_SECRET 또는 JWT_SECRET 환경변수가 필요합니다.' );
    }

    return `${ base }:admin`;
}
