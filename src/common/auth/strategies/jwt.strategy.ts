import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

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

        return {
            userId: user.userId,
            username: user.username,
            email: user.email,
        };
    }
}
