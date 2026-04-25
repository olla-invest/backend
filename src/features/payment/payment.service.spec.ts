import { Test } from '@nestjs/testing';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { TossPaymentsClient } from './toss-payments.client';
import { EmailService } from '../../common/email/email.service';
import { PlanType, BillingCycle, PaymentStatus, SubscriptionStatus } from '../../../generated/prisma';

const mockUser = {
    userId: 'user-1',
    email: 'test@test.com',
    name: '홍길동',
    planType: PlanType.PRO,
};

const mockSubscription = {
    subscriptionId: 'sub-1',
    userId: 'user-1',
    planType: PlanType.PRO,
    billingCycle: BillingCycle.MONTHLY,
    status: SubscriptionStatus.ACTIVE,
    pendingPlanType: null,
    pendingBillingCycle: null,
    currentPeriodStart: new Date(),
    currentPeriodEnd: new Date(),
    nextBillingDate: new Date(),
    cancelledAt: null,
    cancelEffectiveAt: null,
};

const mockCard = {
    cardId: 'card-1',
    userId: 'user-1',
    billingKey: 'billing-key-123',
    cardNumber: '1234',
    cardType: 'CREDIT',
    issuerCode: '001',
    ownerType: 'PERSONAL',
    isDefault: true,
    deletedAt: null,
};

const mockPayment = { paymentId: 'pay-1', orderId: 'olla-auto-uuid' };

describe( 'PaymentService - executeScheduledBilling', () => {
    let service: PaymentService;
    let prisma: jest.Mocked<PrismaService>;
    let subscriptionService: jest.Mocked<SubscriptionService>;
    let toss: jest.Mocked<TossPaymentsClient>;
    let emailService: jest.Mocked<EmailService>;

    beforeEach( async () => {
        const module = await Test.createTestingModule( {
            providers: [
                PaymentService,
                {
                    provide: PrismaService,
                    useValue: {
                        user: { findUnique: jest.fn() },
                        userSubscription: { findUnique: jest.fn() },
                        paymentCard: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
                        payment: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
                    },
                },
                {
                    provide: SubscriptionService,
                    useValue: {
                        renewSubscription: jest.fn(),
                        markSubscriptionPastDue: jest.fn(),
                        forceFreeConversion: jest.fn(),
                        activateSubscription: jest.fn(),
                    },
                },
                {
                    provide: TossPaymentsClient,
                    useValue: {
                        issueBillingKey: jest.fn(),
                        chargeBilling: jest.fn(),
                    },
                },
                {
                    provide: EmailService,
                    useValue: {
                        sendPaymentFailureNotice: jest.fn(),
                        sendPaymentFailureFinal: jest.fn(),
                    },
                },
            ],
        } ).compile();

        service = module.get( PaymentService );
        prisma = module.get( PrismaService ) as jest.Mocked<PrismaService>;
        subscriptionService = module.get( SubscriptionService ) as jest.Mocked<SubscriptionService>;
        toss = module.get( TossPaymentsClient ) as jest.Mocked<TossPaymentsClient>;
        emailService = module.get( EmailService ) as jest.Mocked<EmailService>;
    } );

    function setupMocks( tossStatus: 'DONE' | 'FAILED' = 'DONE' ) {
        ( prisma.user.findUnique as jest.Mock ).mockResolvedValue( mockUser );
        ( prisma.userSubscription.findUnique as jest.Mock ).mockResolvedValue( mockSubscription );
        ( prisma.paymentCard.findFirst as jest.Mock ).mockResolvedValue( mockCard );
        ( prisma.payment.create as jest.Mock ).mockResolvedValue( mockPayment );
        ( prisma.payment.update as jest.Mock ).mockResolvedValue( {} );
        ( toss.chargeBilling as jest.Mock ).mockResolvedValue(
            tossStatus === 'DONE'
                ? { status: 'DONE', paymentKey: 'toss-key', method: 'CARD', card: {} }
                : { status: 'FAILED', failureCode: 'REJECT', failureMessage: '잔액 부족' },
        );
    }

    it( '결제 성공 시 구독을 갱신하고 이메일을 발송하지 않는다', async () => {
        setupMocks( 'DONE' );

        await service.executeScheduledBilling( 'user-1', 1 );

        expect( subscriptionService.renewSubscription ).toHaveBeenCalledWith( 'user-1', BillingCycle.MONTHLY );
        expect( emailService.sendPaymentFailureNotice ).not.toHaveBeenCalled();
        expect( emailService.sendPaymentFailureFinal ).not.toHaveBeenCalled();
    } );

    it( '1차 결제 실패 시 PAST_DUE 처리 + 1차 이메일 발송, 다음 재시도 10:00 안내', async () => {
        setupMocks( 'FAILED' );

        await service.executeScheduledBilling( 'user-1', 1 );

        expect( subscriptionService.markSubscriptionPastDue ).toHaveBeenCalledWith( 'user-1' );
        expect( subscriptionService.forceFreeConversion ).not.toHaveBeenCalled();
        expect( emailService.sendPaymentFailureNotice ).toHaveBeenCalledWith(
            expect.objectContaining( { attempt: 1, nextRetryTime: '오늘 10:00', to: mockUser.email } ),
        );
    } );

    it( '2차 결제 실패 시 PAST_DUE 처리 + 2차 이메일 발송, 다음 재시도 18:00 안내', async () => {
        setupMocks( 'FAILED' );

        await service.executeScheduledBilling( 'user-1', 2 );

        expect( subscriptionService.markSubscriptionPastDue ).toHaveBeenCalledWith( 'user-1' );
        expect( emailService.sendPaymentFailureNotice ).toHaveBeenCalledWith(
            expect.objectContaining( { attempt: 2, nextRetryTime: '오늘 18:00' } ),
        );
    } );

    it( '3차 결제 실패 시 즉시 FREE 전환 + 최종 이메일 발송', async () => {
        setupMocks( 'FAILED' );

        await service.executeScheduledBilling( 'user-1', 3 );

        expect( subscriptionService.markSubscriptionPastDue ).not.toHaveBeenCalled();
        expect( subscriptionService.forceFreeConversion ).toHaveBeenCalledWith( 'user-1' );
        expect( emailService.sendPaymentFailureFinal ).toHaveBeenCalledWith(
            expect.objectContaining( { to: mockUser.email, planType: String( PlanType.PRO ) } ),
        );
        expect( emailService.sendPaymentFailureNotice ).not.toHaveBeenCalled();
    } );

    it( '카드가 없으면 Toss 호출 없이 PAST_DUE 처리만 한다', async () => {
        ( prisma.user.findUnique as jest.Mock ).mockResolvedValue( mockUser );
        ( prisma.userSubscription.findUnique as jest.Mock ).mockResolvedValue( mockSubscription );
        ( prisma.paymentCard.findFirst as jest.Mock ).mockResolvedValue( null );

        await service.executeScheduledBilling( 'user-1', 1 );

        expect( toss.chargeBilling ).not.toHaveBeenCalled();
        expect( subscriptionService.markSubscriptionPastDue ).toHaveBeenCalledWith( 'user-1' );
    } );

    it( '사용자가 존재하지 않으면 아무것도 하지 않는다', async () => {
        ( prisma.user.findUnique as jest.Mock ).mockResolvedValue( null );

        await service.executeScheduledBilling( 'user-x', 1 );

        expect( toss.chargeBilling ).not.toHaveBeenCalled();
    } );

    it( 'CANCELLED 구독은 처리하지 않는다', async () => {
        ( prisma.user.findUnique as jest.Mock ).mockResolvedValue( mockUser );
        ( prisma.userSubscription.findUnique as jest.Mock ).mockResolvedValue( {
            ...mockSubscription,
            status: SubscriptionStatus.CANCELLED,
        } );

        await service.executeScheduledBilling( 'user-1', 1 );

        expect( toss.chargeBilling ).not.toHaveBeenCalled();
    } );
} );
