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
            // SMTP 미설정 시 개발 환경에서는 콘솔에 출력
            this.logger.warn( `Email send failed (SMTP not configured?). Temp password for ${to}: ${tempPassword}` );
        }
    }
}
