import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { UserStatus } from '../../../../generated/prisma';

const STATUS_BLOCK_MESSAGES: Record<string, string> = {
    INACTIVE: '비활성화된 계정입니다. 고객센터로 문의해주세요.',
    DORMANT: '휴면 상태의 계정입니다. 휴면 해제 후 이용해주세요.',
    DELETED: '탈퇴한 계정입니다.',
};

export interface JwtPayload {
    sub: string; // user ID (UUID)
    username: string;
    email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy( Strategy ) {
    constructor(
        private readonly configService: ConfigService,
        private readonly prisma: PrismaService,
    ) {
        super( {
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: configService.get<string>( 'JWT_SECRET' ),
        } );
    }

    async validate( payload: JwtPayload ) {
        const user = await this.prisma.user.findUnique( {
            where: {
                userId: payload.sub,
                deletedAt: null,
            },
        } );

        if( !user ) {
            throw new UnauthorizedException( 'User not found or deleted' );
        }

        // 백오피스에서 비활성·휴면·탈퇴로 바꾼 계정은 기존 토큰이 남아 있어도 즉시 차단한다.
        if( user.status !== UserStatus.ACTIVE ) {
            throw new UnauthorizedException( STATUS_BLOCK_MESSAGES[ user.status ] );
        }

        return {
            userId: user.userId,
            username: user.username,
            email: user.email,
        };
    }
}
