import { PlanType, BillingCycle } from '../../../generated/prisma';

export const PLAN_PRICING: Record<PlanType, Record<BillingCycle, number>> = {
    [PlanType.FREE]: {
        [BillingCycle.MONTHLY]: 0,
        [BillingCycle.YEARLY]: 0,
    },
    [PlanType.BASIC]: {
        [BillingCycle.MONTHLY]: 9900,
        [BillingCycle.YEARLY]: 99000,
    },
    [PlanType.PRO]: {
        [BillingCycle.MONTHLY]: 19900,
        [BillingCycle.YEARLY]: 199000,
    },
    [PlanType.PREMIUM]: {
        [BillingCycle.MONTHLY]: 39900,
        [BillingCycle.YEARLY]: 399000,
    },
};

// 플랜 등급 순서 (숫자가 높을수록 상위 플랜)
export const PLAN_RANK: Record<PlanType, number> = {
    [PlanType.FREE]: 0,
    [PlanType.BASIC]: 1,
    [PlanType.PRO]: 2,
    [PlanType.PREMIUM]: 3,
};

export function isUpgrade( current: PlanType, target: PlanType ): boolean {
    return PLAN_RANK[ target ] > PLAN_RANK[ current ];
}

export function isDowngrade( current: PlanType, target: PlanType ): boolean {
    return PLAN_RANK[ target ] < PLAN_RANK[ current ];
}

/**
 * 업그레이드 차액 계산
 * = (업그레이드 플랜 월 요금 × 남은 기간 비율) - (현재 플랜 월 요금 × 남은 기간 비율)
 */
export function calculateUpgradeAmount(
    currentPlan: PlanType,
    targetPlan: PlanType,
    billingCycle: BillingCycle,
    periodStartDate: Date,
    periodEndDate: Date,
): number {
    const totalDays = Math.ceil(
        ( periodEndDate.getTime() - periodStartDate.getTime() ) / ( 1000 * 60 * 60 * 24 ),
    );
    const remainingDays = Math.ceil(
        ( periodEndDate.getTime() - new Date().getTime() ) / ( 1000 * 60 * 60 * 24 ),
    );
    const remainingRatio = Math.max( 0, Math.min( 1, remainingDays / totalDays ) );

    const currentMonthly = PLAN_PRICING[ currentPlan ][ BillingCycle.MONTHLY ];
    const targetMonthly = PLAN_PRICING[ targetPlan ][ BillingCycle.MONTHLY ];

    const amount = Math.round( ( targetMonthly - currentMonthly ) * remainingRatio );
    return Math.max( 0, amount );
}
