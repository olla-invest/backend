import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanType, BillingCycle } from '../../../../generated/prisma';

export class DowngradePlanDto {
    @ApiProperty( { enum: PlanType, example: PlanType.BASIC, description: '다운그레이드할 플랜' } )
    @IsEnum( PlanType )
    targetPlan: PlanType;

    @ApiProperty( { enum: BillingCycle, example: BillingCycle.MONTHLY, description: '결제 주기' } )
    @IsEnum( BillingCycle )
    billingCycle: BillingCycle;
}
