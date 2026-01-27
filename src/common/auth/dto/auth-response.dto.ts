import { Exclude, Expose } from 'class-transformer';

@Exclude()
export class AuthResponseDto {
    @Expose()
    accessToken: string;

    @Expose()
    user: {
        userId: string;
        username: string;
        email: string;
    };
}
