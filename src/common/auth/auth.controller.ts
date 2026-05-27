import { Body, Controller, Get, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { FindIdDto } from './dto/find-id.dto';
import { FindPasswordDto } from './dto/find-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { CompleteSocialProfileDto } from './dto/complete-social-profile.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { SocialProfile } from './types/social-profile.type';

@ApiTags( '인증 (Auth)' )
@Controller( 'auth' )
export class AuthController {
    constructor(
        private readonly authService: AuthService,
        private readonly configService: ConfigService,
    ) {}

    @Public()
    @Post( 'register' )
    @ApiOperation( { summary: '회원가입' } )
    @ApiResponse( { status: 201, description: '회원가입 성공' } )
    register( @Body() dto: RegisterDto ) {
        return this.authService.register( dto );
    }

    @Public()
    @Post( 'login' )
    @ApiOperation( { summary: '로그인', description: 'username/password로 로그인 후 JWT 토큰 반환' } )
    @ApiResponse( { status: 200, description: '로그인 성공, accessToken 반환' } )
    login( @Body() dto: LoginDto ) {
        return this.authService.login( dto );
    }

    @Public()
    @Post( 'find-id' )
    @ApiOperation( { summary: '아이디 찾기', description: '이름 + 이메일로 아이디 조회' } )
    findId( @Body() dto: FindIdDto ) {
        return this.authService.findId( dto );
    }

    @Public()
    @Post( 'find-password' )
    @ApiOperation( { summary: '비밀번호 찾기', description: '아이디 + 이메일로 임시 비밀번호 이메일 발송' } )
    findPassword( @Body() dto: FindPasswordDto ) {
        return this.authService.findPassword( dto );
    }

    @Public()
    @Get( 'naver' )
    @UseGuards( AuthGuard( 'naver' ) )
    @ApiOperation( { summary: '네이버 OAuth 로그인 시작' } )
    naverLogin() {
        // Passport가 Naver OAuth 페이지로 자동 리다이렉트
    }

    @Public()
    @Get( 'naver/callback' )
    @UseGuards( AuthGuard( 'naver' ) )
    @ApiOperation( { summary: '네이버 OAuth 콜백' } )
    async naverCallback( @Req() req: Request, @Res() res: Response ) {
        const { accessToken } = await this.authService.socialLogin( req.user as SocialProfile );
        const frontendUrl = this.configService.get<string>( 'FRONTEND_URL' );
        return res.redirect( `${frontendUrl}/auth/callback?token=${accessToken}` );
    }

    @Public()
    @Get( 'kakao' )
    @UseGuards( AuthGuard( 'kakao' ) )
    @ApiOperation( { summary: '카카오 OAuth 로그인 시작' } )
    kakaoLogin() {
        // Passport가 Kakao OAuth 페이지로 자동 리다이렉트
    }

    @Public()
    @Get( 'kakao/callback' )
    @UseGuards( AuthGuard( 'kakao' ) )
    @ApiOperation( { summary: '카카오 OAuth 콜백' } )
    async kakaoCallback( @Req() req: Request, @Res() res: Response ) {
        const { accessToken } = await this.authService.socialLogin( req.user as SocialProfile );
        const frontendUrl = this.configService.get<string>( 'FRONTEND_URL' );
        return res.redirect( `${frontendUrl}/auth/callback?token=${accessToken}` );
    }

    @Get( 'me' )
    @ApiBearerAuth( 'access-token' )
    @ApiOperation( { summary: '내 정보 조회 (로그인 필요)' } )
    async getMe( @CurrentUser( 'userId' ) userId: string ) {
        return this.authService.getMe( userId );
    }

    @Patch( 'social-profile' )
    @ApiBearerAuth( 'access-token' )
    @ApiOperation( { summary: 'SNS 가입 추가 정보 입력', description: 'SNS 최초 로그인 후 이름/휴대폰/약관동의를 저장합니다.' } )
    completeSocialProfile(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: CompleteSocialProfileDto,
    ) {
        return this.authService.completeSocialProfile( userId, dto );
    }

    @Patch( 'change-password' )
    @ApiBearerAuth( 'access-token' )
    @ApiOperation( { summary: '비밀번호 변경 (로그인 필요)' } )
    changePassword(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: ChangePasswordDto,
    ) {
        return this.authService.changePassword( userId, dto );
    }
}
