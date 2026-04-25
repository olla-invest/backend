import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PaymentService } from './payment.service';
import { PaymentStatus, SubscriptionStatus } from '../../../generated/prisma';

@Injectable()
export class PaymentScheduler {
    private readonly logger = new Logger( PaymentScheduler.name );

    constructor(
        private readonly prisma: PrismaService,
        private readonly paymentService: PaymentService,
        private readonly subscriptionService: SubscriptionService,
    ) {}

    /**
     * 매일 02:00 - 오늘 결제일인 구독 1차 정기결제 실행
     */
    @Cron( '0 2 * * *' )
    async runScheduledBilling() {
        this.logger.log( '정기결제 1차 스케줄러 시작' );

        const today = new Date();
        today.setHours( 0, 0, 0, 0 );
        const tomorrow = new Date( today );
        tomorrow.setDate( tomorrow.getDate() + 1 );

        const dueSubscriptions = await this.prisma.userSubscription.findMany( {
            where: {
                status: SubscriptionStatus.ACTIVE,
                nextBillingDate: { gte: today, lt: tomorrow },
            },
            select: { userId: true },
        } );

        this.logger.log( `1차 정기결제 대상: ${dueSubscriptions.length}건` );

        for ( const { userId } of dueSubscriptions ) {
            try {
                await this.paymentService.executeScheduledBilling( userId, 1 );
            } catch ( err ) {
                this.logger.error( `1차 정기결제 오류: userId=${userId}`, err );
            }
        }
    }

    /**
     * 매일 10:00 - 오늘 1차 실패한 구독 2차 재시도
     */
    @Cron( '0 10 * * *' )
    async runRetryBilling2nd() {
        this.logger.log( '정기결제 2차 재시도 스케줄러 시작' );
        const targets = await this.getTodayFailedUsers( 1 );
        this.logger.log( `2차 재시도 대상: ${targets.length}건` );

        for ( const userId of targets ) {
            try {
                await this.paymentService.executeScheduledBilling( userId, 2 );
            } catch ( err ) {
                this.logger.error( `2차 재시도 오류: userId=${userId}`, err );
            }
        }
    }

    /**
     * 매일 18:00 - 오늘 2차도 실패한 구독 3차 재시도 (실패 시 즉시 FREE 전환)
     */
    @Cron( '0 18 * * *' )
    async runRetryBilling3rd() {
        this.logger.log( '정기결제 3차 재시도 스케줄러 시작' );
        const targets = await this.getTodayFailedUsers( 2 );
        this.logger.log( `3차 재시도 대상: ${targets.length}건` );

        for ( const userId of targets ) {
            try {
                await this.paymentService.executeScheduledBilling( userId, 3 );
            } catch ( err ) {
                this.logger.error( `3차 재시도 오류: userId=${userId}`, err );
            }
        }
    }

    /**
     * 매일 01:00 - 해지/만료 구독 FREE 전환
     */
    @Cron( '0 1 * * *' )
    async runExpireSubscriptions() {
        this.logger.log( '구독 만료 처리 스케줄러 시작' );
        const count = await this.subscriptionService.expireSubscriptions();
        this.logger.log( `구독 만료 처리 완료: ${count}건` );
    }

    /**
     * 오늘 자동결제 실패 횟수가 정확히 failCount인 PAST_DUE 사용자 목록 반환
     */
    private async getTodayFailedUsers( failCount: number ): Promise<string[]> {
        const today = new Date();
        today.setHours( 0, 0, 0, 0 );
        const tomorrow = new Date( today );
        tomorrow.setDate( tomorrow.getDate() + 1 );

        const pastDueUsers = await this.prisma.userSubscription.findMany( {
            where: { status: SubscriptionStatus.PAST_DUE },
            select: { userId: true },
        } );

        const result: string[] = [];
        for ( const { userId } of pastDueUsers ) {
            const count = await this.prisma.payment.count( {
                where: {
                    userId,
                    status: PaymentStatus.FAILED,
                    orderId: { startsWith: 'olla-auto-' },
                    createdAt: { gte: today, lt: tomorrow },
                },
            } );
            if ( count === failCount ) result.push( userId );
        }

        return result;
    }
}
