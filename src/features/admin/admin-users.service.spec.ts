import { AdminRole } from '../../../generated/prisma';
import { AdminUsersService } from './admin-users.service';

const admin = { adminId: 'admin-1', loginId: 'admin', role: AdminRole.SUPER_ADMIN } as any;

const user = {
    userId: '6c7f3b3e-1a2b-4c3d-8e9f-0a1b2c3d4e5f',
    username: 'ttaerin92',
    email: 'ttaerin92@gmail.com',
    name: '이태린',
    phone: '010-1234-5678',
    provider: 'KAKAO',
    planType: 'FREE',
    status: 'ACTIVE',
    marketingConsent: true,
    createdAt: new Date( '2026-09-17T23:30:00.000Z' ), // KST 2026-09-18 08:30
    updatedAt: new Date( '2026-09-18T05:22:16.000Z' ),
    deletedAt: null,
};

describe( 'AdminUsersService', () => {
    const build = () => {
        const prisma = {
            user: {
                count: jest.fn().mockResolvedValue( 1 ),
                findMany: jest.fn().mockResolvedValue( [ user ] ),
                findUnique: jest.fn().mockResolvedValue( user ),
            },
            userLoginHistory: { findMany: jest.fn().mockResolvedValue( [] ) },
            userPlanHistory: { findMany: jest.fn().mockResolvedValue( [] ) },
            userSubscription: { findUnique: jest.fn().mockResolvedValue( { nextBillingDate: new Date( '2026-11-01T00:00:00.000Z' ) } ) },
            rsFilterPreset: { count: jest.fn().mockResolvedValue( 0 ) },
            searchFilterPreset: { count: jest.fn().mockResolvedValue( 0 ) },
            userWatchlist: { count: jest.fn().mockResolvedValue( 0 ) },
        };
        const audit = { record: jest.fn(), findByTargetUser: jest.fn().mockResolvedValue( [] ) };
        const service = new AdminUsersService( prisma as any, audit as any, {} as any );
        return { service, prisma, audit };
    };

    it( 'filters the join period by KST day boundaries and by selected users', async () => {
        const { service, prisma } = build();

        await service.list( { joinedFrom: '2026-09-18', joinedTo: '2026-09-18', userIds: [ user.userId ] } );

        expect( prisma.user.count.mock.calls[ 0 ][ 0 ].where ).toMatchObject( {
            deletedAt: null,
            userId: { in: [ user.userId ] },
            createdAt: {
                gte: new Date( '2026-09-17T15:00:00.000Z' ),
                lte: new Date( '2026-09-18T14:59:59.999Z' ),
            },
        } );
    } );

    it( 'exports only the selected users with KST join times', async () => {
        const { service, prisma, audit } = build();

        const result = await service.exportCsv( admin, { userIds: [ user.userId ] }, {} as any );

        expect( prisma.user.findMany.mock.calls[ 0 ][ 0 ].where.userId ).toEqual( { in: [ user.userId ] } );
        expect( result.content ).toContain( '"2026-09-18 08:30"' );
        expect( result.content ).toContain( '"ttaerin92"' );
        expect( result.content ).not.toContain( 'ttaerin92@gmail.com' );
        expect( audit.record ).toHaveBeenCalledWith( expect.objectContaining( { action: 'USER_LIST_EXPORT' } ) );
    } );

    it( 'returns the next billing date used as the plan change start date', async () => {
        const { service } = build();

        const detail = await service.detail( admin, user.userId, {} as any );

        expect( detail.nextBillingDate ).toEqual( new Date( '2026-11-01T00:00:00.000Z' ) );
        expect( detail.basicInfo.email ).not.toBe( user.email );
    } );
} );
