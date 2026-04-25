import { Body, Controller, Delete, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SubscriptionService } from './subscription.service';
import { UpgradePlanDto } from './dto/upgrade-plan.dto';
import { DowngradePlanDto } from './dto/downgrade-plan.dto';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';

@ApiTags( '마이페이지 - 구독' )
@ApiBearerAuth( 'access-token' )
@Controller( 'subscription' )
export class SubscriptionController {
    constructor( private readonly subscriptionService: SubscriptionService ) {}

    @Get( 'me' )
    @ApiOperation( { summary: '내 구독 정보 조회', description: '현재 플랜, 결제일, 상태, 등록 카드 반환' } )
    getMySubscription( @CurrentUser( 'userId' ) userId: string ) {
        return this.subscriptionService.getMySubscription( userId );
    }

    @Post( 'upgrade/preview' )
    @ApiOperation( { summary: '업그레이드 차액 미리보기', description: '결제 전 오늘 결제 금액 안내' } )
    previewUpgrade(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: UpgradePlanDto,
    ) {
        return this.subscriptionService.previewUpgrade( userId, dto );
    }

    @Post( 'downgrade' )
    @ApiOperation( {
        summary: '다운그레이드 예약',
        description: '현재 구독 기간 종료 후 하위 플랜으로 변경 예약',
    } )
    scheduleDowngrade(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: DowngradePlanDto,
    ) {
        return this.subscriptionService.scheduleDowngrade( userId, dto );
    }

    @Delete( 'downgrade' )
    @ApiOperation( { summary: '다운그레이드 예약 취소' } )
    cancelDowngrade( @CurrentUser( 'userId' ) userId: string ) {
        return this.subscriptionService.cancelDowngrade( userId );
    }

    @Post( 'cancel' )
    @ApiOperation( {
        summary: '구독 해지 예약',
        description: '현재 구독 기간 종료 후 FREE 플랜으로 전환 예약',
    } )
    cancelSubscription( @CurrentUser( 'userId' ) userId: string ) {
        return this.subscriptionService.cancelSubscription( userId );
    }
}
