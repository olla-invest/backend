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
        const response = profile._json?.response ?? {};
        const socialId = String( response.id ?? profile.id );
        const email: string =
            response.email ??
            profile.email ??
            profile._json?.email ??
            profile.emails?.[0]?.value ??
            `naver_${socialId}@naver.social`;
        const phone = this.normalizePhone( response.mobile ?? profile._json?.mobile );

        return {
            provider: 'NAVER',
            socialId,
            email,
            name: response.name ?? profile._json?.name ?? profile.displayName ?? null,
            phone,
        };
    }

    private normalizePhone( phone?: string | null ): string | null {
        if ( !phone ) return null;
        const digits = phone.replace( /\D/g, '' );
        return /^01[0-9]{8,9}$/.test( digits ) ? digits : null;
    }
}
