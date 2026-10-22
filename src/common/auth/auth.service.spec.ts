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

    const bypassConfig = { NODE_ENV: 'development', DEV_AUTH_BYPASS: 'true' };

    it( 'logs in as the submitted account without checking the password when enabled outside production', async () => {
        const huehue = { ...testUser, userId: 'huehue-id', username: 'huehue', email: 'huehue@example.com' };
        const findFirst = jest.fn().mockResolvedValue( huehue );
        const service = createService( bypassConfig, findFirst );

        const result = await service.login( { username: 'huehue', password: 'anything' } );

        // 예전에는 입력과 무관하게 공용 계정 하나로 로그인돼 테스터들의 관심종목이 섞였다.
        expect( findFirst ).toHaveBeenCalledWith( { where: { username: 'huehue', deletedAt: null } } );
        expect( result.user.username ).toBe( 'huehue' );
        expect( new JwtService( { secret: 'test-jwt-secret' } ).verify( result.accessToken ).sub ).toBe( 'huehue-id' );
    } );

    it( 'lets a social sign-up account in through the development bypass', async () => {
        const kakaoUser = { ...testUser, username: 'kakao_123', password: null, provider: AuthProvider.KAKAO };
        const service = createService( bypassConfig, jest.fn().mockResolvedValue( kakaoUser ) );

        const result = await service.login( { username: 'kakao_123', password: '' } );

        expect( result.user.username ).toBe( 'kakao_123' );
    } );

    it( 'still rejects an account that does not exist in bypass mode', async () => {
        const service = createService( bypassConfig, jest.fn().mockResolvedValue( null ) );

        await expect( service.login( { username: 'typo-user', password: 'anything' } ) ).rejects.toThrow( '가입된 계정이 없습니다' );
    } );

    it( 'uses normal password authentication in production even when bypass is enabled', async () => {
        const password = await bcrypt.hash( 'correct-password', 4 );
        const findFirst = jest.fn().mockResolvedValue( { ...testUser, password } );
        const service = createService(
            {
                NODE_ENV: 'production',
                DEV_AUTH_BYPASS: 'true',
            },
            findFirst,
        );

        await expect(
            service.login( { username: 'test', password: 'wrong-password' } ),
        ).rejects.toThrow( '비밀번호가 일치하지 않습니다.' );
    } );
} );
