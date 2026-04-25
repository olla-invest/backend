import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { Strategy } from 'passport-kakao';
import { SocialProfile } from '../types/social-profile.type';

@Injectable()
export class KakaoStrategy extends PassportStrategy( Strategy, 'kakao' ) {
    constructor( private readonly configService: ConfigService ) {
        super( {
            clientID: configService.get<string>( 'KAKAO_CLIENT_ID' ),
            callbackURL: configService.get<string>( 'KAKAO_CALLBACK_URL' ),
        } );
    }

    async validate(
        _accessToken: string,
        _refreshToken: string,
        profile: any,
    ): Promise<SocialProfile> {
        const kakaoAccount = profile._json?.kakao_account ?? {};
        const email: string =
            kakaoAccount.email ?? `kakao_${String( profile.id )}@kakao.social`;
        const name: string | null =
            kakaoAccount.profile?.nickname ?? profile.username ?? null;

        return {
            provider: 'KAKAO',
            socialId: String( profile.id ),
            email,
            name,
        };
    }
}
