import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-naver-v2';
import { SocialProfile } from '../types/social-profile.type';

@Injectable()
export class NaverStrategy extends PassportStrategy( Strategy, 'naver' ) {
    constructor( private readonly configService: ConfigService ) {
        super( {
            clientID: configService.get<string>( 'NAVER_OAUTH_CLIENT_ID' ),
            clientSecret: configService.get<string>( 'NAVER_OAUTH_CLIENT_SECRET' ),
            callbackURL: configService.get<string>( 'NAVER_OAUTH_CALLBACK_URL' ),
            state: true,
        } );
    }

    async validate(
        _accessToken: string,
        _refreshToken: string,
        profile: any,
    ): Promise<SocialProfile> {
        const email: string =
            profile._json?.email ??
            profile.emails?.[0]?.value ??
            `naver_${profile.id}@naver.social`;

        return {
            provider: 'NAVER',
            socialId: String( profile.id ),
            email,
            name: profile._json?.name ?? profile.displayName ?? null,
        };
    }
}
