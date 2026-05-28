import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { MarketingConsentDto } from './dto/marketing-consent.dto';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { AdminApiKeyGuard } from '../../common/auth/guards/admin-api-key.guard';
import { Public } from '../../common/auth/decorators/public.decorator';

@ApiTags( '마이페이지 - 사용자' )
@ApiBearerAuth( 'access-token' )
@Controller( 'users' )
export class UsersController {
    constructor( private readonly usersService: UsersService ) {}

    @Get( 'admin' )
    @Public()
    @UseGuards( AdminApiKeyGuard )
    @ApiOperation( { summary: '[Admin] User list' } )
    adminListUsers(
        @Query( 'page' ) page?: string,
        @Query( 'pageSize' ) pageSize?: string,
        @Query( 'search' ) search?: string,
        @Query( 'provider' ) provider?: any,
        @Query( 'planType' ) planType?: any,
        @Query( 'includeDeleted' ) includeDeleted?: string,
    ) {
        return this.usersService.adminListUsers( {
            page: page ? Number( page ) : undefined,
            pageSize: pageSize ? Number( pageSize ) : undefined,
            search,
            provider,
            planType,
            includeDeleted: includeDeleted === 'true',
        } );
    }

    @Post( 'admin' )
    @Public()
    @UseGuards( AdminApiKeyGuard )
    @ApiOperation( { summary: '[Admin] Create user' } )
    adminCreateUser( @Body() body: any ) {
        return this.usersService.adminCreateUser( body );
    }

    @Patch( 'admin/:userId' )
    @Public()
    @UseGuards( AdminApiKeyGuard )
    @ApiOperation( { summary: '[Admin] Update user' } )
    adminUpdateUser(
        @Param( 'userId' ) userId: string,
        @Body() body: any,
    ) {
        return this.usersService.adminUpdateUser( userId, body );
    }

    @Get( 'me' )
    @ApiOperation( { summary: '내 프로필 조회', description: '이름, 이메일, 휴대폰, 플랜 정보 반환' } )
    getMyProfile( @CurrentUser( 'userId' ) userId: string ) {
        return this.usersService.getMyProfile( userId );
    }

    @Patch( 'me' )
    @ApiOperation( { summary: '프로필 수정', description: '이름, 휴대폰 번호 수정' } )
    updateProfile(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: UpdateProfileDto,
    ) {
        return this.usersService.updateProfile( userId, dto );
    }

    @Patch( 'me/marketing' )
    @ApiOperation( { summary: '마케팅 수신 설정 변경', description: 'ON: 동의, OFF: 거부' } )
    updateMarketingConsent(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: MarketingConsentDto,
    ) {
        return this.usersService.updateMarketingConsent( userId, dto.consent );
    }
}
