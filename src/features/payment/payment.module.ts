import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaymentScheduler } from './payment.scheduler';
import { TossPaymentsClient } from './toss-payments.client';
import { SubscriptionModule } from '../subscription/subscription.module';
import { EmailModule } from '../../common/email/email.module';

@Module( {
    imports: [ SubscriptionModule, EmailModule ],
    controllers: [ PaymentController ],
    providers: [ PaymentService, PaymentScheduler, TossPaymentsClient ],
    exports: [ PaymentService ],
} )
export class PaymentModule {}
