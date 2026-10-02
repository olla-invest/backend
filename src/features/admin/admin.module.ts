import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule } from '@nestjs/config';
import { EmailModule } from '../../common/email/email.module';
import { AdminAuthController } from './admin-auth.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminJwtStrategy } from './strategies/admin-jwt.strategy';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AdminRolesGuard } from './guards/admin-roles.guard';

@Module( {
    imports: [ ConfigModule, PassportModule, JwtModule.register( {} ), EmailModule ],
    controllers: [ AdminAuthController, AdminUsersController ],
    providers: [
        AdminAuthService,
        AdminUsersService,
        AdminAuditService,
        AdminJwtStrategy,
        AdminJwtGuard,
        AdminRolesGuard,
    ],
    exports: [ AdminAuditService ],
} )
export class AdminModule {}
