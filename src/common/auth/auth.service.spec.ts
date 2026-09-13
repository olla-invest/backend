import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { AuthProvider, PlanType } from '../../../generated/prisma';
import { AuthService } from './auth.service';

describe( 'AuthService login development bypass', () => {
    const testUser = {
        userId: 'test-user-id',
        username: 'test',
        email: 'test@example.com',
        password: 'not-used-by-development-bypass',
        name: 'Test User',
        phone: '01000000000',
        provider: AuthProvider.LOCAL,
        providerId: null,
        marketingConsent: false,
        isTempPassword: false,
        planType: PlanType.FREE,
        createdAt: new Date( '2026-01-01T00:00:00.000Z' ),
        updatedAt: new Date( '2026-01-01T00:00:00.000Z' ),
        deletedAt: null,
    };

    function createService( config: Record<string, string>, findFirst: jest.Mock ) {
        return new AuthService(
            { user: { findFirst } } as never,
            new JwtService( { secret: 'test-jwt-secret' } ),
            {} as never,
            new ConfigService( config ),
        );
    }

    it( 'logs in as the configured test user regardless of submitted credentials when explicitly enabled outside production', async () => {
        const findFirst = jest.fn().mockResolvedValue( testUser );
        const service = createService(
            {
                NODE_ENV: 'development',
                DEV_AUTH_BYPASS: 'true',
                DEV_AUTH_BYPASS_USERNAME: 'test',
            },
            findFirst,
        );

        const result = await service.login( { username: 'anything', password: 'anything' } );

        expect( result.user ).toEqual( {
            userId: 'test-user-id',
            username: 'test',
            email: 'test@example.com',
            name: 'Test User',
            isTempPassword: false,
        } );
        expect( new JwtService( { secret: 'test-jwt-secret' } ).verify( result.accessToken ).sub ).toBe( 'test-user-id' );
        expect( findFirst ).toHaveBeenCalledWith( {
            where: { username: 'test', deletedAt: null },
        } );
    } );

    it( 'uses normal password authentication in production even when bypass is enabled', async () => {
        const password = await bcrypt.hash( 'correct-password', 4 );
        const findFirst = jest.fn().mockResolvedValue( { ...testUser, password } );
        const service = createService(
            {
                NODE_ENV: 'production',
                DEV_AUTH_BYPASS: 'true',
                DEV_AUTH_BYPASS_USERNAME: 'test',
            },
            findFirst,
        );

        await expect(
            service.login( { username: 'test', password: 'wrong-password' } ),
        ).rejects.toThrow( '비밀번호가 일치하지 않습니다.' );
    } );
} );
