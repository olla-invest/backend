import {
    BadRequestException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { TossPaymentsClient } from './toss-payments.client';
import { BillingAuthDto } from './dto/billing-auth.dto';
import { ChangeCardDto } from './dto/change-card.dto';
import { PlanType, BillingCycle, PaymentStatus, SubscriptionStatus } from '../../../generated/prisma';
import { PLAN_PRICING, isUpgrade, calculateUpgradeAmount } from '../subscription/plan-pricing.constant';
import { TossWebhookDto } from './dto/toss-webhook.dto';
import { EmailService } from '../../common/email/email.service';

@Injectable()
export class PaymentService {
    private readonly logger = new Logger( PaymentService.name );

    constructor(
        private readonly prisma: PrismaService,
        private readonly subscriptionService: SubscriptionService,
        private readonly toss: TossPaymentsClient,
        private readonly emailService: EmailService,
    ) {}

    /**
     * 빌링키 발급 + 즉시 결제 (첫 결제 또는 무료→유료 전환)
     */
    async registerCardAndPay( userId: string, dto: BillingAuthDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: { userId: true, email: true, name: true, planType: true },
        } );
        if ( !user ) throw new NotFoundException( '사용자를 찾을 수 없습니다.' );

        if ( dto.planType === PlanType.FREE ) {
            throw new BadRequestException( 'FREE 플랜은 결제가 필요하지 않습니다.' );
        }

        // 1. Toss 빌링키 발급
        const billingData = await this.toss.issueBillingKey( dto.authKey, dto.customerKey );

        // 2. 기존 카드 soft-delete 후 새 카드 저장
        await this.prisma.paymentCard.updateMany( {
            where: { userId, deletedAt: null },
            data: { deletedAt: new Date(), isDefault: false },
        } );

        const newCard = await this.prisma.paymentCard.create( {
            data: {
                userId,
                billingKey: billingData.billingKey,
                cardNumber: billingData.card.number,
                cardType: billingData.card.cardType,
                issuerCode: billingData.card.issuerCode,
                ownerType: billingData.card.ownerType,
                isDefault: true,
            },
        } );

        // 3. 결제 금액 결정
        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        let amount: number;
        if ( subscription && subscription.status === SubscriptionStatus.ACTIVE && isUpgrade( user.planType, dto.planType ) ) {
            // 업그레이드 차액
            amount = calculateUpgradeAmount(
                user.planType,
                dto.planType,
                subscription.billingCycle,
                subscription.currentPeriodStart,
                subscription.currentPeriodEnd,
            );
        } else {
            amount = PLAN_PRICING[ dto.planType ][ dto.billingCycle ];
        }

        // 4. 결제 기록 생성 (PENDING)
        const orderId = `olla-${uuidv4()}`;
        const payment = await this.prisma.payment.create( {
            data: {
                userId,
                subscriptionId: subscription?.subscriptionId ?? null,
                orderId,
                amount,
                planType: dto.planType,
                billingCycle: dto.billingCycle,
                status: PaymentStatus.PENDING,
            },
        } );

        // 5. Toss 빌링 결제 실행
        const orderName = `olla ${dto.planType} 플랜 (${dto.billingCycle === BillingCycle.MONTHLY ? '월간' : '연간'})`;
        const tossResult = await this.toss.chargeBilling( billingData.billingKey, {
            customerKey: dto.customerKey,
            amount,
            orderId,
            orderName,
            customerEmail: user.email,
            customerName: user.name ?? undefined,
        } );

        if ( tossResult.status === 'DONE' ) {
            // 6a. 결제 성공
            await this.prisma.payment.update( {
                where: { paymentId: payment.paymentId },
                data: {
                    tossPaymentKey: tossResult.paymentKey,
                    status: PaymentStatus.SUCCESS,
                    paymentMethod: tossResult.method,
                    cardInfo: tossResult.card ?? null,
                    paidAt: new Date(),
                },
            } );

            await this.subscriptionService.activateSubscription( userId, dto.planType, dto.billingCycle );

            return {
                success: true,
                orderId,
                amount,
                planType: dto.planType,
                billingCycle: dto.billingCycle,
            };
        } else {
            // 6b. 결제 실패
            await this.prisma.payment.update( {
                where: { paymentId: payment.paymentId },
                data: {
                    status: PaymentStatus.FAILED,
                    failureCode: tossResult.failureCode ?? null,
                    failureMessage: tossResult.failureMessage ?? null,
                },
            } );

            throw new BadRequestException(
                tossResult.failureMessage ?? '결제에 실패했습니다. 카드 정보를 확인해주세요.',
            );
        }
    }

    /**
     * 카드 변경 (빌링키 재발급만, 즉시 결제 없음)
     */
    async changeCard( userId: string, dto: ChangeCardDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
        } );
        if ( !user ) throw new NotFoundException( '사용자를 찾을 수 없습니다.' );

        const billingData = await this.toss.issueBillingKey( dto.authKey, dto.customerKey );

        await this.prisma.paymentCard.updateMany( {
            where: { userId, deletedAt: null },
            data: { deletedAt: new Date(), isDefault: false },
        } );

        const newCard = await this.prisma.paymentCard.create( {
            data: {
                userId,
                billingKey: billingData.billingKey,
                cardNumber: billingData.card.number,
                cardType: billingData.card.cardType,
                issuerCode: billingData.card.issuerCode,
                ownerType: billingData.card.ownerType,
                isDefault: true,
            },
        } );

        return {
            cardNumber: newCard.cardNumber,
            cardType: newCard.cardType,
        };
    }

    /**
     * 등록된 카드 조회
     */
    async getMyCard( userId: string ) {
        const card = await this.prisma.paymentCard.findFirst( {
            where: { userId, deletedAt: null, isDefault: true },
            select: {
                cardNumber: true,
                cardType: true,
                issuerCode: true,
                ownerType: true,
                createdAt: true,
            },
        } );

        return card ?? null;
    }

    /**
     * 결제 내역 조회 (최근 N건)
     */
    async getPaymentHistory( userId: string, limit = 10 ) {
        const payments = await this.prisma.payment.findMany( {
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            select: {
                paymentId: true,
                orderId: true,
                amount: true,
                planType: true,
                billingCycle: true,
                status: true,
                paymentMethod: true,
                cardInfo: true,
                failureMessage: true,
                paidAt: true,
                createdAt: true,
            },
        } );

        return payments;
    }

    /**
     * 정기 결제 실행 (스케줄러에서 호출)
     * attempt: 1=02:00 1차, 2=10:00 2차 재시도, 3=18:00 3차 재시도
     */
    async executeScheduledBilling( userId: string, attempt: 1 | 2 | 3 = 1 ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: { userId: true, email: true, name: true, planType: true },
        } );
        if ( !user ) return;

        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );
        if ( !subscription || subscription.status === SubscriptionStatus.CANCELLED ) {
            return;
        }

        const card = await this.prisma.paymentCard.findFirst( {
            where: { userId, deletedAt: null, isDefault: true },
        } );
        if ( !card ) {
            await this.subscriptionService.markSubscriptionPastDue( userId );
            this.logger.warn( `정기결제 실패 - 카드 없음: userId=${userId}` );
            return;
        }

        const billingCycle = subscription.pendingBillingCycle ?? subscription.billingCycle;
        const planType = subscription.pendingPlanType ?? subscription.planType;
        const amount = PLAN_PRICING[ planType ][ billingCycle ];
        const orderId = `olla-auto-${uuidv4()}`;
        const orderName = `olla ${planType} 플랜 정기결제`;

        const payment = await this.prisma.payment.create( {
            data: {
                userId,
                subscriptionId: subscription.subscriptionId,
                orderId,
                amount,
                planType,
                billingCycle,
                status: PaymentStatus.PENDING,
            },
        } );

        const tossResult = await this.toss.chargeBilling( card.billingKey, {
            customerKey: userId,
            amount,
            orderId,
            orderName,
            customerEmail: user.email,
            customerName: user.name ?? undefined,
        } );

        if ( tossResult.status === 'DONE' ) {
            await this.prisma.payment.update( {
                where: { paymentId: payment.paymentId },
                data: {
                    tossPaymentKey: tossResult.paymentKey,
                    status: PaymentStatus.SUCCESS,
                    paymentMethod: tossResult.method,
                    cardInfo: tossResult.card ?? null,
                    paidAt: new Date(),
                },
            } );
            await this.subscriptionService.renewSubscription( userId, billingCycle );
            this.logger.log( `정기결제 성공: userId=${userId}, amount=${amount}` );
        } else {
            const now = new Date();
            await this.prisma.payment.update( {
                where: { paymentId: payment.paymentId },
                data: {
                    status: PaymentStatus.FAILED,
                    failureCode: tossResult.failureCode ?? null,
                    failureMessage: tossResult.failureMessage ?? null,
                },
            } );

            if ( attempt < 3 ) {
                await this.subscriptionService.markSubscriptionPastDue( userId );
                const nextRetryTime = attempt === 1 ? '오늘 10:00' : '오늘 18:00';
                await this.emailService.sendPaymentFailureNotice( {
                    to: user.email,
                    name: user.name,
                    attempt: attempt as 1 | 2,
                    amount,
                    planType: String( planType ),
                    failedAt: now,
                    nextRetryTime,
                } );
            } else {
                // 3차 실패: 즉시 FREE 전환
                await this.subscriptionService.forceFreeConversion( userId );
                const tomorrow = new Date( now );
                tomorrow.setDate( tomorrow.getDate() + 1 );
                await this.emailService.sendPaymentFailureFinal( {
                    to: user.email,
                    name: user.name,
                    amount,
                    planType: String( planType ),
                    failedAt: now,
                    downgradeDate: tomorrow,
                } );
            }

            this.logger.warn( `정기결제 ${attempt}차 실패: userId=${userId}, reason=${tossResult.failureMessage}` );
        }
    }

    /**
     * Toss 웹훅 처리 (PAYMENT_STATUS_CHANGED)
     * - DONE: 결제 성공 → 이미 API 응답으로 처리됐지만, 누락 방지용 보정
     * - CANCELED / ABORTED / EXPIRED: 결제 취소/실패 → 구독 상태 반영
     */
    async handleTossWebhook( dto: TossWebhookDto ) {
        if ( dto.eventType !== 'PAYMENT_STATUS_CHANGED' ) {
            return { received: true };
        }

        const { orderId, status } = dto.data;

        const payment = await this.prisma.payment.findUnique( {
            where: { orderId },
        } );

        if ( !payment ) {
            this.logger.warn( `웹훅: 결제 내역 없음 orderId=${orderId}` );
            return { received: true };
        }

        // 이미 최종 상태면 무시 (멱등성)
        if ( payment.status === PaymentStatus.SUCCESS || payment.status === PaymentStatus.REFUNDED ) {
            return { received: true };
        }

        if ( status === 'DONE' ) {
            await this.prisma.payment.update( {
                where: { orderId },
                data: {
                    tossPaymentKey: dto.data.paymentKey,
                    status: PaymentStatus.SUCCESS,
                    paidAt: new Date(),
                },
            } );
            await this.subscriptionService.activateSubscription(
                payment.userId,
                payment.planType,
                payment.billingCycle,
            );
            this.logger.log( `웹훅 보정 - 결제 성공 반영: orderId=${orderId}` );
        } else if ( [ 'CANCELED', 'PARTIAL_CANCELED' ].includes( status ) ) {
            await this.prisma.payment.update( {
                where: { orderId },
                data: { status: PaymentStatus.CANCELLED },
            } );
        } else if ( [ 'ABORTED', 'EXPIRED' ].includes( status ) ) {
            await this.prisma.payment.update( {
                where: { orderId },
                data: { status: PaymentStatus.FAILED },
            } );
            await this.subscriptionService.markSubscriptionPastDue( payment.userId );
            this.logger.warn( `웹훅 - 결제 실패/만료: orderId=${orderId}, status=${status}` );
        }

        return { received: true };
    }
}
