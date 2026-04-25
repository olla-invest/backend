import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService {
    private readonly logger = new Logger( EmailService.name );
    private transporter: nodemailer.Transporter;

    constructor( private readonly configService: ConfigService ) {
        this.transporter = nodemailer.createTransport( {
            host: this.configService.get<string>( 'SMTP_HOST', 'smtp.gmail.com' ),
            port: this.configService.get<number>( 'SMTP_PORT', 587 ),
            secure: this.configService.get<boolean>( 'SMTP_SECURE', false ),
            auth: {
                user: this.configService.get<string>( 'SMTP_USER' ),
                pass: this.configService.get<string>( 'SMTP_PASS' ),
            },
        } );
    }

    async sendPaymentFailureNotice( params: {
        to: string;
        name: string | null;
        attempt: 1 | 2;
        amount: number;
        planType: string;
        failedAt: Date;
        nextRetryTime: string;
    } ): Promise<void> {
        const fromName = 'olla';
        const fromEmail = this.configService.get<string>( 'SMTP_USER', 'no-reply@olla.co.kr' );
        const { to, name, attempt, amount, planType, failedAt, nextRetryTime } = params;
        const displayName = name ?? '고객';
        const failedAtStr = this.formatDateTime( failedAt );
        const amountStr = amount.toLocaleString( 'ko-KR' );

        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to,
            subject: '[ olla ] 구독 결제 안내 - 결제 수단을 확인해 주세요.',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <p>안녕하세요,<br/><strong>olla</strong> 입니다. 언제나 저희 서비스를 이용해 주셔서 감사합니다.</p>
                    <p>${displayName}님, 안녕하세요.</p>
                    <p>요청하신 정기 구독 결제가 원활하게 처리되지 않았습니다.<br/>
                    서비스를 차질 없이 이용하실 수 있도록 아래 내용을 확인하시고 결제 수단을 업데이트해 주시기 바랍니다.</p>
                    <div style="margin: 24px 0; padding: 20px; background: #f5f5f5; border-radius: 8px;">
                        <p style="margin: 6px 0;"><strong>결제 시도 일시:</strong> ${failedAtStr}</p>
                        <p style="margin: 6px 0;"><strong>결제 금액:</strong> ${amountStr}원 (${planType} 플랜)</p>
                        <p style="margin: 6px 0;"><strong>다음 결제 예정:</strong> ${nextRetryTime}</p>
                    </div>
                    <p style="color: #888; font-size: 13px;">※ ${attempt}차 결제 실패 안내입니다. 결제 수단을 업데이트하지 않으실 경우 서비스 이용이 제한될 수 있습니다.</p>
                    <p>감사합니다.<br/>olla 드림</p>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail( mailOptions );
            this.logger.log( `Payment failure notice (${attempt}차) sent to ${to}` );
        } catch ( error ) {
            this.logger.error( `Payment failure email send failed for ${to}: ${error?.message || error}` );
        }
    }

    async sendPaymentFailureFinal( params: {
        to: string;
        name: string | null;
        amount: number;
        planType: string;
        failedAt: Date;
        downgradeDate: Date;
    } ): Promise<void> {
        const fromName = 'olla';
        const fromEmail = this.configService.get<string>( 'SMTP_USER', 'no-reply@olla.co.kr' );
        const { to, name, amount, planType, failedAt, downgradeDate } = params;
        const displayName = name ?? '고객';
        const failedAtStr = this.formatDateTime( failedAt );
        const downgradeDateStr = this.formatDate( downgradeDate );
        const amountStr = amount.toLocaleString( 'ko-KR' );

        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to,
            subject: '[ olla ] 긴급 : 구독 결제 실패로 인해 서비스가 제한됩니다.',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <p>안녕하세요,<br/><strong>olla</strong> 입니다. 언제나 저희 서비스를 이용해 주셔서 감사합니다.</p>
                    <p>등록하신 결제 수단으로 총 3차례 결제를 시도하였지만, 처리가 되지 않았습니다.<br/>
                    이에 따라 <strong>${downgradeDateStr}</strong>부터 ${displayName}님의 구독이 해지되며, <strong>Free 요금제로 전환</strong>됩니다.</p>
                    <div style="margin: 24px 0; padding: 20px; background: #fff3f3; border: 1px solid #ffcccc; border-radius: 8px;">
                        <p style="margin: 6px 0;"><strong>결제 시도 일시:</strong> ${failedAtStr}</p>
                        <p style="margin: 6px 0;"><strong>결제 금액:</strong> ${amountStr}원 (${planType} 플랜)</p>
                        <p style="margin: 6px 0;"><strong>구독 해지 및 전환일:</strong> ${downgradeDateStr}</p>
                    </div>
                    <p>구독 서비스를 중단 없이 계속 이용하시려면, 지금 바로 결제 수단을 업데이트하고 구독을 갱신하세요.</p>
                    <p>감사합니다.<br/>olla 드림</p>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail( mailOptions );
            this.logger.log( `Payment failure final notice sent to ${to}` );
        } catch ( error ) {
            this.logger.error( `Payment failure final email send failed for ${to}: ${error?.message || error}` );
        }
    }

    private formatDateTime( date: Date ): string {
        const y = date.getFullYear();
        const m = String( date.getMonth() + 1 ).padStart( 2, '0' );
        const d = String( date.getDate() ).padStart( 2, '0' );
        const h = String( date.getHours() ).padStart( 2, '0' );
        const min = String( date.getMinutes() ).padStart( 2, '0' );
        return `${y}년 ${m}월 ${d}일 ${h}:${min}`;
    }

    private formatDate( date: Date ): string {
        const y = date.getFullYear();
        const m = String( date.getMonth() + 1 ).padStart( 2, '0' );
        const d = String( date.getDate() ).padStart( 2, '0' );
        return `${y}년 ${m}월 ${d}일`;
    }

    async sendTempPassword( to: string, tempPassword: string ): Promise<void> {
        const fromName = 'olla';
        const fromEmail = this.configService.get<string>( 'SMTP_USER', 'no-reply@olla.co.kr' );

        const mailOptions = {
            from: `"${fromName}" <${fromEmail}>`,
            to,
            subject: '[ olla ] 임시 비밀번호가 발급되었습니다.',
            html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                    <p>안녕하세요,<br/><strong>olla</strong> 입니다.</p>
                    <p>임시 비밀번호를 발급합니다. 아래 발급된 임시비밀번호로 로그인해주세요.</p>
                    <div style="text-align: center; margin: 30px 0; padding: 20px; background: #f5f5f5; border-radius: 8px;">
                        <p style="font-size: 14px; color: #666;">임시 비밀번호:</p>
                        <p style="font-size: 22px; font-weight: bold; letter-spacing: 2px;">${tempPassword}</p>
                    </div>
                    <p>임시 비밀번호로 로그인하시면 자동으로 비밀번호 변경 페이지로 이동되며, 새 비밀번호를 설정하여 서비스 이용이 가능합니다.</p>
                    <p>※ 본인이 요청하지 않은 경우, 즉시 임시비밀번호를 재설정하거나 고객센터로 문의해 주세요.<br/>
                    olla는 어떠한 경우에도 비밀번호를 요구하지 않습니다.</p>
                    <p>감사합니다.<br/>olla 드림</p>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail( mailOptions );
            this.logger.log( `Temp password email sent to ${to}` );
        } catch ( error ) {
            this.logger.error( `Email send failed for ${to}: ${error?.message || error}` );
            throw error;
        }
    }
}
