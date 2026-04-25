import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PaymentService } from './payment.service';
import { BillingAuthDto } from './dto/billing-auth.dto';
import { ChangeCardDto } from './dto/change-card.dto';
import { TossWebhookDto } from './dto/toss-webhook.dto';
import { CurrentUser } from '../../common/auth/decorators/current-user.decorator';
import { Public } from '../../common/auth/decorators/public.decorator';

@ApiTags( '마이페이지 - 결제' )
@ApiBearerAuth( 'access-token' )
@Controller( 'payment' )
export class PaymentController {
    constructor( private readonly paymentService: PaymentService ) {}

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
        @Query( 'limit' ) limit?: number,
    ) {
        return this.paymentService.getPaymentHistory( userId, limit ? Number( limit ) : 10 );
    }

    @Public()
    @Post( 'webhook/toss' )
    @HttpCode( 200 )
    @ApiOperation( {
        summary: 'Toss Payments 웹훅 수신 (인증 불필요)',
        description: 'Toss 대시보드에 등록할 URL: POST /payment/webhook/toss',
    } )
    handleTossWebhook( @Body() dto: TossWebhookDto ) {
        return this.paymentService.handleTossWebhook( dto );
    }
}
