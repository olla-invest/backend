import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import * as bcrypt from 'bcrypt';
import { AdminAuditAction } from '../../../generated/prisma';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminJwtPayload, resolveAdminJwtSecret } from './strategies/admin-jwt.strategy';

@Injectable()
export class AdminAuthService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly jwtService: JwtService,
        private readonly configService: ConfigService,
        private readonly auditService: AdminAuditService,
    ) {}

    async login( dto: AdminLoginDto, request: Request ) {
        const admin = await this.prisma.admin.findFirst( {
            where: { loginId: dto.loginId, deletedAt: null },
        } );

        // 계정 존재 여부가 드러나지 않도록 동일한 메시지를 사용한다.
        if ( !admin || !( await bcrypt.compare( dto.password, admin.password ) ) ) {
            throw new UnauthorizedException( '로그인 ID 또는 비밀번호가 올바르지 않습니다.' );
        }
        if ( !admin.isActive ) {
            throw new UnauthorizedException( '비활성화된 관리자 계정입니다.' );
        }

        const payload: AdminJwtPayload = {
            sub: admin.adminId,
            loginId: admin.loginId,
            role: admin.role,
        };

        const accessToken = this.jwtService.sign( payload, {
            secret: resolveAdminJwtSecret( this.configService ),
            expiresIn: this.configService.get<string>( 'ADMIN_JWT_EXPIRES_IN', '8h' ) as any,
        } );

        await this.prisma.admin.update( {
            where: { adminId: admin.adminId },
            data: { lastLoginAt: new Date() },
        } );

        await this.auditService.record( {
            adminId: admin.adminId,
            action: AdminAuditAction.LOGIN,
            request,
        } );

        return {
            accessToken,
            admin: {
                adminId: admin.adminId,
                loginId: admin.loginId,
                name: admin.name,
                role: admin.role,
            },
        };
    }
}
