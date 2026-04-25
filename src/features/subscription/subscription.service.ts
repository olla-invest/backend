import {
    BadRequestException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PlanType, BillingCycle, SubscriptionStatus } from '../../../generated/prisma';
import { UpgradePlanDto } from './dto/upgrade-plan.dto';
import { DowngradePlanDto } from './dto/downgrade-plan.dto';
import {
    PLAN_PRICING,
    PLAN_RANK,
    isUpgrade,
    isDowngrade,
    calculateUpgradeAmount,
} from './plan-pricing.constant';

@Injectable()
export class SubscriptionService {
    constructor( private readonly prisma: PrismaService ) {}

    async getMySubscription( userId: string ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: { planType: true },
        } );

        if ( !user ) throw new NotFoundException( '사용자를 찾을 수 없습니다.' );

        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        const card = await this.prisma.paymentCard.findFirst( {
            where: { userId, deletedAt: null, isDefault: true },
            select: {
                cardNumber: true,
                cardType: true,
            },
        } );

        return {
            planType: user.planType,
            subscription: subscription
                ? {
                      status: subscription.status,
                      billingCycle: subscription.billingCycle,
                      currentPeriodStart: subscription.currentPeriodStart,
                      currentPeriodEnd: subscription.currentPeriodEnd,
                      nextBillingDate: subscription.nextBillingDate,
                      cancelledAt: subscription.cancelledAt,
                      cancelEffectiveAt: subscription.cancelEffectiveAt,
                      pendingPlanType: subscription.pendingPlanType,
                  }
                : null,
            card,
        };
    }

    /**
     * 업그레이드 가능 여부 + 차액 미리 계산 (결제 전 안내용)
     */
    async previewUpgrade( userId: string, dto: UpgradePlanDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: { planType: true },
        } );

        if ( !user ) throw new NotFoundException( '사용자를 찾을 수 없습니다.' );

        if ( !isUpgrade( user.planType, dto.targetPlan ) ) {
            throw new BadRequestException( '상위 플랜으로만 업그레이드할 수 있습니다.' );
        }

        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        const targetAmount = PLAN_PRICING[ dto.targetPlan ][ dto.billingCycle ];
        let todayAmount = targetAmount;

        // 현재 활성 구독이 있는 경우 차액만 오늘 결제
        if ( subscription && subscription.status === SubscriptionStatus.ACTIVE ) {
            todayAmount = calculateUpgradeAmount(
                user.planType,
                dto.targetPlan,
                subscription.billingCycle,
                subscription.currentPeriodStart,
                subscription.currentPeriodEnd,
            );
        }

        return {
            currentPlan: user.planType,
            targetPlan: dto.targetPlan,
            billingCycle: dto.billingCycle,
            regularAmount: targetAmount,
            todayAmount,
            isFirstPayment: !subscription || subscription.status !== SubscriptionStatus.ACTIVE,
        };
    }

    /**
     * 다운그레이드 예약 (현재 기간 종료 후 적용)
     */
    async scheduleDowngrade( userId: string, dto: DowngradePlanDto ) {
        const user = await this.prisma.user.findUnique( {
            where: { userId, deletedAt: null },
            select: { planType: true },
        } );

        if ( !user ) throw new NotFoundException( '사용자를 찾을 수 없습니다.' );

        if ( !isDowngrade( user.planType, dto.targetPlan ) ) {
            throw new BadRequestException( '하위 플랜으로만 다운그레이드할 수 있습니다.' );
        }

        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        if ( !subscription || subscription.status !== SubscriptionStatus.ACTIVE ) {
            throw new BadRequestException( '활성 구독이 없습니다.' );
        }

        // 다운그레이드 예약 저장 (즉시 플랜 변경 아님)
        await this.prisma.userSubscription.update( {
            where: { userId },
            data: {
                pendingPlanType: dto.targetPlan,
                pendingBillingCycle: dto.billingCycle,
            },
        } );

        return {
            message: '다운그레이드가 예약되었습니다.',
            currentPlan: user.planType,
            pendingPlan: dto.targetPlan,
            effectiveDate: subscription.currentPeriodEnd,
        };
    }

    /**
     * 다운그레이드 예약 취소
     */
    async cancelDowngrade( userId: string ) {
        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        if ( !subscription || !subscription.pendingPlanType ) {
            throw new BadRequestException( '예약된 다운그레이드가 없습니다.' );
        }

        await this.prisma.userSubscription.update( {
            where: { userId },
            data: {
                pendingPlanType: null,
                pendingBillingCycle: null,
            },
        } );

        return { message: '다운그레이드 예약이 취소되었습니다.' };
    }

    /**
     * 구독 해지 예약 (기간 종료 후 FREE 전환)
     */
    async cancelSubscription( userId: string ) {
        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        if ( !subscription || subscription.status !== SubscriptionStatus.ACTIVE ) {
            throw new BadRequestException( '활성 구독이 없습니다.' );
        }

        if ( subscription.cancelledAt ) {
            throw new BadRequestException( '이미 해지 예약된 구독입니다.' );
        }

        const now = new Date();
        await this.prisma.userSubscription.update( {
            where: { userId },
            data: {
                status: SubscriptionStatus.CANCELLED,
                cancelledAt: now,
                cancelEffectiveAt: subscription.currentPeriodEnd,
            },
        } );

        return {
            message: '구독 해지가 예약되었습니다.',
            effectiveDate: subscription.currentPeriodEnd,
        };
    }

    /**
     * 정기 결제 성공 후 구독 갱신 (PaymentService에서 호출)
     */
    async renewSubscription( userId: string, billingCycle: BillingCycle ) {
        const subscription = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        if ( !subscription ) throw new NotFoundException( '구독 정보를 찾을 수 없습니다.' );

        const now = new Date();
        const nextPeriodEnd = this.calcNextPeriodEnd( now, billingCycle );

        // 다운그레이드 예약이 있으면 이번 갱신 시 적용
        if ( subscription.pendingPlanType ) {
            await this.prisma.$transaction( [
                this.prisma.user.update( {
                    where: { userId },
                    data: { planType: subscription.pendingPlanType },
                } ),
                this.prisma.userSubscription.update( {
                    where: { userId },
                    data: {
                        planType: subscription.pendingPlanType,
                        billingCycle: subscription.pendingBillingCycle ?? billingCycle,
                        status: SubscriptionStatus.ACTIVE,
                        currentPeriodStart: now,
                        currentPeriodEnd: nextPeriodEnd,
                        nextBillingDate: nextPeriodEnd,
                        pendingPlanType: null,
                        pendingBillingCycle: null,
                    },
                } ),
            ] );
        } else {
            await this.prisma.userSubscription.update( {
                where: { userId },
                data: {
                    status: SubscriptionStatus.ACTIVE,
                    currentPeriodStart: now,
                    currentPeriodEnd: nextPeriodEnd,
                    nextBillingDate: nextPeriodEnd,
                },
            } );
        }
    }

    /**
     * 정기 결제 실패 처리 (PaymentService에서 호출)
     */
    async markSubscriptionPastDue( userId: string ) {
        await this.prisma.userSubscription.update( {
            where: { userId },
            data: { status: SubscriptionStatus.PAST_DUE },
        } );
    }

    /**
     * 결제 3차 실패 시 즉시 FREE 전환 (PaymentService에서 호출)
     */
    async forceFreeConversion( userId: string ) {
        await this.prisma.$transaction( [
            this.prisma.user.update( {
                where: { userId },
                data: { planType: PlanType.FREE },
            } ),
            this.prisma.userSubscription.update( {
                where: { userId },
                data: { status: SubscriptionStatus.EXPIRED },
            } ),
        ] );
    }

    /**
     * 구독 만료 처리 - 해지 예약건 Free 전환 (스케줄러에서 호출)
     */
    async expireSubscriptions() {
        const now = new Date();

        const expiredSubscriptions = await this.prisma.userSubscription.findMany( {
            where: {
                status: SubscriptionStatus.CANCELLED,
                cancelEffectiveAt: { lte: now },
            },
        } );

        for ( const sub of expiredSubscriptions ) {
            await this.prisma.$transaction( [
                this.prisma.user.update( {
                    where: { userId: sub.userId },
                    data: { planType: PlanType.FREE },
                } ),
                this.prisma.userSubscription.update( {
                    where: { subscriptionId: sub.subscriptionId },
                    data: { status: SubscriptionStatus.EXPIRED },
                } ),
            ] );
        }

        return expiredSubscriptions.length;
    }

    /**
     * 첫 결제 또는 업그레이드 후 구독 생성/갱신 (PaymentService에서 호출)
     */
    async activateSubscription(
        userId: string,
        planType: PlanType,
        billingCycle: BillingCycle,
    ) {
        const now = new Date();
        const periodEnd = this.calcNextPeriodEnd( now, billingCycle );

        const existing = await this.prisma.userSubscription.findUnique( {
            where: { userId },
        } );

        await this.prisma.$transaction( [
            this.prisma.user.update( {
                where: { userId },
                data: { planType },
            } ),
            existing
                ? this.prisma.userSubscription.update( {
                      where: { userId },
                      data: {
                          planType,
                          billingCycle,
                          status: SubscriptionStatus.ACTIVE,
                          currentPeriodStart: now,
                          currentPeriodEnd: periodEnd,
                          nextBillingDate: periodEnd,
                          cancelledAt: null,
                          cancelEffectiveAt: null,
                          pendingPlanType: null,
                          pendingBillingCycle: null,
                      },
                  } )
                : this.prisma.userSubscription.create( {
                      data: {
                          userId,
                          planType,
                          billingCycle,
                          status: SubscriptionStatus.ACTIVE,
                          currentPeriodStart: now,
                          currentPeriodEnd: periodEnd,
                          nextBillingDate: periodEnd,
                      },
                  } ),
        ] );
    }

    private calcNextPeriodEnd( from: Date, billingCycle: BillingCycle ): Date {
        const date = new Date( from );
        if ( billingCycle === BillingCycle.MONTHLY ) {
            date.setMonth( date.getMonth() + 1 );
        } else {
            date.setFullYear( date.getFullYear() + 1 );
        }
        return date;
    }
}
