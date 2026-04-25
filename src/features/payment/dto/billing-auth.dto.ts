import { IsEnum, IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PlanType, BillingCycle } from '../../../../generated/prisma';

export class BillingAuthDto {
    @ApiProperty( { description: 'Toss Payments 빌링키 발급 인증 키 (클라이언트에서 발급)' } )
    @IsString()
    @IsNotEmpty()
    authKey: string;

    @ApiProperty( { description: '고객 키 (클라이언트에서 생성한 UUID)' } )
    @IsString()
    @IsNotEmpty()
    customerKey: string;

    @ApiProperty( { enum: PlanType, example: PlanType.PRO, description: '구독할 플랜' } )
    @IsEnum( PlanType )
    planType: PlanType;

    @ApiProperty( { enum: BillingCycle, example: BillingCycle.MONTHLY, description: '결제 주기' } )
    @IsEnum( BillingCycle )
    billingCycle: BillingCycle;
}
