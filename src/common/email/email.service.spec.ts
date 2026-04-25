import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';

const mockSendMail = jest.fn().mockResolvedValue( { messageId: 'test-id' } );

jest.mock( 'nodemailer', () => ( {
    createTransport: jest.fn( () => ( { sendMail: mockSendMail } ) ),
} ) );

describe( 'EmailService', () => {
    let service: EmailService;

    beforeEach( async () => {
        jest.clearAllMocks();

        const module = await Test.createTestingModule( {
            providers: [
                EmailService,
                {
                    provide: ConfigService,
                    useValue: { get: jest.fn( ( key: string, def?: unknown ) => def ) },
                },
            ],
        } ).compile();

        service = module.get( EmailService );
    } );

    describe( 'sendPaymentFailureNotice', () => {
        const base = {
            to: 'user@test.com',
            name: '홍길동',
            amount: 19900,
            planType: 'PRO',
            failedAt: new Date( '2026-04-25T02:00:00' ),
            nextRetryTime: '오늘 10:00',
        };

        it( '1차 실패 - 올바른 제목으로 이메일을 발송한다', async () => {
            await service.sendPaymentFailureNotice( { ...base, attempt: 1 } );

            expect( mockSendMail ).toHaveBeenCalledTimes( 1 );
            const [ call ] = mockSendMail.mock.calls;
            expect( call[ 0 ].subject ).toBe( '[ olla ] 구독 결제 안내 - 결제 수단을 확인해 주세요.' );
            expect( call[ 0 ].to ).toBe( base.to );
            expect( call[ 0 ].html ).toContain( '1차' );
            expect( call[ 0 ].html ).toContain( '오늘 10:00' );
            expect( call[ 0 ].html ).toContain( '19,900원' );
        } );

        it( '2차 실패 - html에 2차 표시와 다음 재시도 시각이 포함된다', async () => {
            await service.sendPaymentFailureNotice( {
                ...base,
                attempt: 2,
                nextRetryTime: '오늘 18:00',
            } );

            const html: string = mockSendMail.mock.calls[ 0 ][ 0 ].html;
            expect( html ).toContain( '2차' );
            expect( html ).toContain( '오늘 18:00' );
        } );

        it( '발송 실패 시 예외를 던지지 않는다 (로그만)', async () => {
            mockSendMail.mockRejectedValueOnce( new Error( 'SMTP error' ) );
            await expect(
                service.sendPaymentFailureNotice( { ...base, attempt: 1 } ),
            ).resolves.not.toThrow();
        } );
    } );

    describe( 'sendPaymentFailureFinal', () => {
        const base = {
            to: 'user@test.com',
            name: '홍길동',
            amount: 19900,
            planType: 'PRO',
            failedAt: new Date( '2026-04-25T18:00:00' ),
            downgradeDate: new Date( '2026-04-26' ),
        };

        it( '3차 최종 실패 - 긴급 제목으로 이메일을 발송한다', async () => {
            await service.sendPaymentFailureFinal( base );

            expect( mockSendMail ).toHaveBeenCalledTimes( 1 );
            const [ call ] = mockSendMail.mock.calls;
            expect( call[ 0 ].subject ).toBe(
                '[ olla ] 긴급 : 구독 결제 실패로 인해 서비스가 제한됩니다.',
            );
            expect( call[ 0 ].html ).toContain( 'Free 요금제로 전환' );
            expect( call[ 0 ].html ).toContain( '2026년 04월 26일' );
        } );

        it( 'name이 null이면 "고객"으로 대체된다', async () => {
            await service.sendPaymentFailureFinal( { ...base, name: null } );
            const html: string = mockSendMail.mock.calls[ 0 ][ 0 ].html;
            expect( html ).toContain( '고객님' );
        } );

        it( '발송 실패 시 예외를 던지지 않는다 (로그만)', async () => {
            mockSendMail.mockRejectedValueOnce( new Error( 'SMTP error' ) );
            await expect( service.sendPaymentFailureFinal( base ) ).resolves.not.toThrow();
        } );
    } );
} );
