export type SocialProvider = 'NAVER' | 'KAKAO';

export interface SocialProfile {
    provider: SocialProvider;
    socialId: string;
    email: string;
    name: string | null;
    phone?: string | null;
}
