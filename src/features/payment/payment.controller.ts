import * as crypto from 'crypto';
import { Body, Controller, Get, HttpCode, Patch, Post, Query, Req, UnauthorizedException } from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PaymentService } from './payment.service';
import { BillingAuthDto } from './dto/billing-auth.dto';
import { ChangeCardDto } from './dto/change-card.dto';
import { TossWebhookDto } from './dto/toss-webhook.dto';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';
import { IntRangePipe } from '../../common/pipes/input-validation.pipes';

@ApiTags( '마이페이지 - 결제' )
@ApiBearerAuth( 'access-token' )
@Controller( 'payment' )
export class PaymentController {
    constructor(
        private readonly paymentService: PaymentService,
        private readonly configService: ConfigService,
    ) {}

    @Post( 'billing-auth' )
    @ApiOperation( {
        summary: '카드 등록 + 첫 결제',
        description: '빌링키 발급 후 즉시 결제. 신규 구독 또는 무료→유료 전환 시 사용',
    } )
    registerCardAndPay(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: BillingAuthDto,
    ) {
        return this.paymentService.registerCardAndPay( userId, dto );
    }

    @Patch( 'card' )
    @ApiOperation( { summary: '결제 카드 변경', description: '빌링키 재발급 (즉시 결제 없음)' } )
    changeCard(
        @CurrentUser( 'userId' ) userId: string,
        @Body() dto: ChangeCardDto,
    ) {
        return this.paymentService.changeCard( userId, dto );
    }

    @Get( 'card' )
    @ApiOperation( { summary: '등록된 결제 카드 조회' } )
    getMyCard( @CurrentUser( 'userId' ) userId: string ) {
        return this.paymentService.getMyCard( userId );
    }

    @Get( 'history' )
    @ApiOperation( { summary: '결제 내역 조회' } )
    @ApiQuery( { name: 'limit', required: false, type: Number, description: '조회 건수 (기본: 10)' } )
    getPaymentHistory(
        @CurrentUser( 'userId' ) userId: string,
        @Query( 'limit', new IntRangePipe('limit', 1, 100, true) ) limit?: number,
    ) {
        return this.paymentService.getPaymentHistory( userId, limit ?? 10 );
    }

    @Public()
    @Post( 'webhook/toss' )
    @HttpCode( 200 )
    @ApiOperation( {
        summary: 'Toss Payments 웹훅 수신 (인증 불필요)',
        description: 'Toss 대시보드에 등록할 URL: POST /payment/webhook/toss',
    } )
    handleTossWebhook( @Req() req: RawBodyRequest<Request>, @Body() dto: TossWebhookDto ) {
        const signature = req.headers[ 'webhook-signature' ] as string;
        const secret = this.configService.get<string>( 'TOSS_WEBHOOK_SECRET' );
        if ( !secret ) {
            throw new UnauthorizedException( 'Webhook secret not configured' );
        }
        const rawBody = req.rawBody;
        if ( !rawBody ) {
            throw new UnauthorizedException( 'Raw body unavailable' );
        }
        const expected = crypto.createHmac( 'sha256', secret ).update( rawBody ).digest( 'base64' );
        const expectedBuffer = Buffer.from( expected );
        const signatureBuffer = Buffer.from( signature ?? '' );
        if ( !signature || expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual( expectedBuffer, signatureBuffer ) ) {
            throw new UnauthorizedException( 'Invalid webhook signature' );
        }
        return this.paymentService.handleTossWebhook( dto );
    }
}
