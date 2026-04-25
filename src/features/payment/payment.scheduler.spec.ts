import { Test } from '@nestjs/testing';
import { PaymentScheduler } from './payment.scheduler';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { PaymentService } from './payment.service';
import { PaymentStatus, SubscriptionStatus } from '../../../generated/prisma';

describe( 'PaymentScheduler', () => {
    let scheduler: PaymentScheduler;
    let prisma: jest.Mocked<PrismaService>;
    let paymentService: jest.Mocked<PaymentService>;
    let subscriptionService: jest.Mocked<SubscriptionService>;

    beforeEach( async () => {
        const module = await Test.createTestingModule( {
            providers: [
                PaymentScheduler,
                {
                    provide: PrismaService,
                    useValue: {
                        userSubscription: { findMany: jest.fn() },
                        payment: { count: jest.fn() },
                    },
                },
                {
                    provide: PaymentService,
                    useValue: { executeScheduledBilling: jest.fn() },
                },
                {
                    provide: SubscriptionService,
                    useValue: { expireSubscriptions: jest.fn().mockResolvedValue( 0 ) },
                },
            ],
        } ).compile();

        scheduler = module.get( PaymentScheduler );
        prisma = module.get( PrismaService ) as jest.Mocked<PrismaService>;
        paymentService = module.get( PaymentService ) as jest.Mocked<PaymentService>;
        subscriptionService = module.get( SubscriptionService ) as jest.Mocked<SubscriptionService>;
    } );

    describe( 'runScheduledBilling (1차 02:00)', () => {
        it( '오늘 결제일인 ACTIVE 구독을 attempt=1로 실행한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
                { userId: 'user-2' },
            ] );

            await scheduler.runScheduledBilling();

            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledTimes( 2 );
            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledWith( 'user-1', 1 );
            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledWith( 'user-2', 1 );
        } );

        it( '대상이 없으면 executeScheduledBilling을 호출하지 않는다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [] );

            await scheduler.runScheduledBilling();

            expect( paymentService.executeScheduledBilling ).not.toHaveBeenCalled();
        } );

        it( '개별 결제 오류가 발생해도 나머지 건은 계속 처리한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
                { userId: 'user-2' },
            ] );
            ( paymentService.executeScheduledBilling as jest.Mock )
                .mockRejectedValueOnce( new Error( 'Toss error' ) )
                .mockResolvedValueOnce( undefined );

            await scheduler.runScheduledBilling();

            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledTimes( 2 );
        } );
    } );

    describe( 'runRetryBilling2nd (2차 10:00)', () => {
        it( '오늘 1번 실패한 PAST_DUE 구독을 attempt=2로 재시도한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
                { userId: 'user-2' },
            ] );
            ( prisma.payment.count as jest.Mock )
                .mockResolvedValueOnce( 1 ) // user-1: 1번 실패 → 2차 대상
                .mockResolvedValueOnce( 0 ); // user-2: 0번 실패 → 제외

            await scheduler.runRetryBilling2nd();

            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledTimes( 1 );
            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledWith( 'user-1', 2 );
        } );

        it( '오늘 2번 실패한 구독은 2차 대상에서 제외한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
            ] );
            ( prisma.payment.count as jest.Mock ).mockResolvedValueOnce( 2 ); // 이미 2번 실패

            await scheduler.runRetryBilling2nd();

            expect( paymentService.executeScheduledBilling ).not.toHaveBeenCalled();
        } );
    } );

    describe( 'runRetryBilling3rd (3차 18:00)', () => {
        it( '오늘 2번 실패한 PAST_DUE 구독을 attempt=3으로 재시도한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
                { userId: 'user-2' },
            ] );
            ( prisma.payment.count as jest.Mock )
                .mockResolvedValueOnce( 2 ) // user-1: 2번 실패 → 3차 대상
                .mockResolvedValueOnce( 1 ); // user-2: 1번 실패 → 제외

            await scheduler.runRetryBilling3rd();

            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledTimes( 1 );
            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledWith( 'user-1', 3 );
        } );

        it( '3차 실패 이후에도 오류 없이 나머지 건을 처리한다', async () => {
            ( prisma.userSubscription.findMany as jest.Mock ).mockResolvedValue( [
                { userId: 'user-1' },
                { userId: 'user-2' },
            ] );
            ( prisma.payment.count as jest.Mock ).mockResolvedValue( 2 );
            ( paymentService.executeScheduledBilling as jest.Mock )
                .mockRejectedValueOnce( new Error( 'Force free failed' ) )
                .mockResolvedValueOnce( undefined );

            await scheduler.runRetryBilling3rd();

            expect( paymentService.executeScheduledBilling ).toHaveBeenCalledTimes( 2 );
        } );
    } );

    describe( 'runExpireSubscriptions', () => {
        it( '만료 처리 스케줄러가 expireSubscriptions를 호출한다', async () => {
            ( subscriptionService.expireSubscriptions as jest.Mock ).mockResolvedValue( 3 );

            await scheduler.runExpireSubscriptions();

            expect( subscriptionService.expireSubscriptions ).toHaveBeenCalledTimes( 1 );
        } );
    } );
} );
