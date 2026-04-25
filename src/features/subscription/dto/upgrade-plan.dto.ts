import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanType, BillingCycle } from '../../../../generated/prisma';

export class UpgradePlanDto {
    @ApiProperty( { enum: PlanType, example: PlanType.PRO, description: '변경할 플랜' } )
    @IsEnum( PlanType )
    targetPlan: PlanType;

    @ApiProperty( { enum: BillingCycle, example: BillingCycle.MONTHLY, description: '결제 주기' } )
    @IsEnum( BillingCycle )
    billingCycle: BillingCycle;
}
