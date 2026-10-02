import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../../common/auth/decorators/public.decorator';
import { AdminAuthService } from './admin-auth.service';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminJwtGuard } from './guards/admin-jwt.guard';
import { AuthenticatedAdmin, CurrentAdmin } from './decorators/current-admin.decorator';

@ApiTags( '백오피스 - 관리자 인증' )
@Controller( 'admin/auth' )
export class AdminAuthController {
    constructor( private readonly adminAuthService: AdminAuthService ) {}

    @Post( 'login' )
    @Public()
    @HttpCode( HttpStatus.OK )
    @ApiOperation( { summary: '관리자 로그인', description: '로그인 ID / 비밀번호로 관리자 전용 JWT 를 발급한다.' } )
    login( @Body() dto: AdminLoginDto, @Req() request: Request ) {
        return this.adminAuthService.login( dto, request );
    }

    @Get( 'me' )
    @Public()
    @UseGuards( AdminJwtGuard )
    @ApiBearerAuth( 'access-token' )
    @ApiOperation( { summary: '로그인한 관리자 정보 조회' } )
    me( @CurrentAdmin() admin: AuthenticatedAdmin ) {
        return admin;
    }
}
